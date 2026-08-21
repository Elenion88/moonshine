// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Austin

/**
 * The account: sign in once on two machines and they can see each other.
 *
 * This is the part that does not need Tailscale, a LAN, or knowing an address.
 * The coordinator holds a device registry; each device says where it thinks it
 * is, and gets told where its siblings said they were.
 *
 * What the coordinator is *not* is a relay. No stream traffic passes through
 * it. That keeps the bandwidth bill at zero and keeps a running session
 * unaffected by the service being down - but it also means this transport can
 * only reach a peer whose address is actually reachable. On one network that is
 * every peer. Across the internet it is the ones that are port-forwarded, until
 * hole punching lands.
 *
 * The token is encrypted with the OS keychain via Electron's safeStorage, so it
 * is not sitting in a JSON file in the clear.
 */

import { hostname, networkInterfaces } from 'node:os'
import { randomUUID } from 'node:crypto'

import { safeStorage } from 'electron'

import { loadConfig, saveConfig } from './paths'
import { SUNSHINE_PORT } from './tailscale'

export interface Endpoint {
  kind: 'local' | 'observed' | 'manual'
  address: string
  port: number
}

export interface AccountPeer {
  id: string
  name: string
  os: string
  online: boolean
  lastSeen: number
  observedIp: string | null
  endpoints: Endpoint[]
}

export interface AccountState {
  signedIn: boolean
  email: string | null
  serverUrl: string
  deviceId: string | null
  deviceName: string
  /** What the coordinator says this machine looks like from outside. */
  observed: string | null
  error: string | null
}

interface StoredAccount {
  serverUrl?: string
  email?: string
  userId?: string
  deviceId?: string
  /** base64 of the safeStorage ciphertext, or the raw token if unavailable. */
  token?: string
  tokenEncrypted?: boolean
}

export const DEFAULT_SERVER = 'http://127.0.0.1:8787'

/** How often to tell the coordinator we are still here. */
const HEARTBEAT_MS = 60_000

let peers: AccountPeer[] = []
let observed: string | null = null
let lastError: string | null = null
let heartbeat: NodeJS.Timeout | null = null

async function stored(): Promise<StoredAccount> {
  const config = await loadConfig()
  return (config.account as StoredAccount | undefined) ?? {}
}

async function store(next: StoredAccount): Promise<void> {
  const config = await loadConfig()
  config.account = { ...((config.account as StoredAccount) ?? {}), ...next }
  await saveConfig(config)
}

function encrypt(token: string): { token: string; tokenEncrypted: boolean } {
  // Not available on a Linux box with no keyring, and not worth failing over -
  // the fallback is what every other desktop app does with a config file.
  if (!safeStorage.isEncryptionAvailable()) return { token, tokenEncrypted: false }
  return { token: safeStorage.encryptString(token).toString('base64'), tokenEncrypted: true }
}

function decrypt(account: StoredAccount): string | null {
  if (!account.token) return null
  if (!account.tokenEncrypted) return account.token
  try {
    return safeStorage.decryptString(Buffer.from(account.token, 'base64'))
  } catch {
    // A keychain that has moved on - a restored machine, a new OS user. The
    // token is unusable, which is the same as not being signed in.
    return null
  }
}

async function serverUrl(): Promise<string> {
  return (await stored()).serverUrl ?? DEFAULT_SERVER
}

async function call(
  path: string,
  options: { method?: string; body?: unknown; token?: string | null } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const base = await serverUrl()
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (options.token) headers.authorization = `Bearer ${options.token}`

  // A coordinator that is slow is a coordinator that is down, as far as the UI
  // is concerned. Nothing here is worth blocking a refresh for.
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(10_000)
  })

  let body: Record<string, unknown> = {}
  try {
    body = (await response.json()) as Record<string, unknown>
  } catch {
    // A non-JSON body from a proxy or an error page. The status still means
    // something; the body does not.
  }
  return { status: response.status, body }
}

/**
 * The addresses this machine can be reached at, as far as it can tell.
 *
 * Only IPv4, only non-internal: a loopback address tells a peer nothing, and
 * link-local addresses are noise. The coordinator adds the address it observes
 * from outside, which is the half this machine cannot work out for itself.
 */
function localEndpoints(): Endpoint[] {
  const found: Endpoint[] = []
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue
      if (address.address.startsWith('169.254.')) continue
      found.push({ kind: 'local', address: address.address, port: SUNSHINE_PORT })
    }
  }
  return found.slice(0, 8)
}

export async function state(): Promise<AccountState> {
  const account = await stored()
  return {
    signedIn: Boolean(decrypt(account)),
    email: account.email ?? null,
    serverUrl: account.serverUrl ?? DEFAULT_SERVER,
    deviceId: account.deviceId ?? null,
    deviceName: hostname(),
    observed,
    error: lastError
  }
}

export async function setServerUrl(url: string): Promise<void> {
  await store({ serverUrl: url.replace(/\/+$/, '') })
}

async function authenticate(
  path: '/v1/signup' | '/v1/login',
  email: string,
  password: string
): Promise<{ ok: boolean; message: string }> {
  try {
    const result = await call(path, { method: 'POST', body: { email, password } })
    if (result.status >= 400) {
      return { ok: false, message: String(result.body.error ?? `request failed (${result.status})`) }
    }
    await store({
      email: String(result.body.email ?? email),
      userId: String(result.body.userId ?? ''),
      ...encrypt(String(result.body.token))
    })
    lastError = null
    await registerDevice()
    return { ok: true, message: path === '/v1/signup' ? 'Account created.' : 'Signed in.' }
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error && error.name === 'TimeoutError'
          ? 'The coordinator did not answer. Is the address right, and is it running?'
          : `Could not reach the coordinator: ${error instanceof Error ? error.message : error}`
    }
  }
}

export function signUp(email: string, password: string): Promise<{ ok: boolean; message: string }> {
  return authenticate('/v1/signup', email, password)
}

export function signIn(email: string, password: string): Promise<{ ok: boolean; message: string }> {
  return authenticate('/v1/login', email, password)
}

export async function signOut(): Promise<void> {
  const account = await stored()
  const token = decrypt(account)
  stopHeartbeat()
  peers = []
  observed = null
  lastError = null
  // Revoke server-side first; if that fails the local token is still cleared,
  // because a sign-out that leaves you signed in is not a sign-out.
  if (token) {
    try {
      await call('/v1/logout', { method: 'POST', token })
    } catch {
      // Offline. The token stays valid until it is used from somewhere else,
      // which is a real if minor cost of not being able to reach the server.
    }
  }
  await store({ token: undefined, tokenEncrypted: undefined, email: undefined, userId: undefined })
}

/**
 * Tell the coordinator this machine exists, keeping the id we were given.
 *
 * Reusing the id is what makes a reinstall update the record rather than adding
 * a second copy of the same machine to the list.
 */
async function registerDevice(): Promise<void> {
  const account = await stored()
  const token = decrypt(account)
  if (!token) return

  const id = account.deviceId ?? randomUUID()
  const result = await call('/v1/devices', {
    method: 'POST',
    token,
    body: { id, name: hostname(), os: process.platform === 'win32' ? 'windows' : 'macos' }
  })
  if (result.status < 400) {
    await store({ deviceId: String(result.body.deviceId ?? id) })
    startHeartbeat()
  }
}

/** One check-in: report where we are, learn where everyone else is. */
export async function beat(): Promise<AccountPeer[]> {
  const account = await stored()
  const token = decrypt(account)
  if (!token || !account.deviceId) {
    peers = []
    return peers
  }

  try {
    const result = await call('/v1/heartbeat', {
      method: 'POST',
      token,
      body: { deviceId: account.deviceId, endpoints: localEndpoints() }
    })

    if (result.status === 404) {
      // The device was removed from another machine. Re-register rather than
      // silently going quiet, which would look like the account being broken.
      await registerDevice()
      return peers
    }
    if (result.status === 401) {
      lastError = 'Signed out by the coordinator.'
      await store({ token: undefined, tokenEncrypted: undefined })
      peers = []
      return peers
    }
    if (result.status >= 400) {
      lastError = String(result.body.error ?? `heartbeat failed (${result.status})`)
      return peers
    }

    observed = (result.body.observed as string | null) ?? null
    peers = (result.body.peers as AccountPeer[] | undefined) ?? []
    lastError = null
  } catch (error) {
    // Keep the last known peer list. A coordinator that is briefly unreachable
    // should not empty the host list of machines that are still there.
    lastError = error instanceof Error ? error.message : String(error)
  }
  return peers
}

export function knownPeers(): AccountPeer[] {
  return peers
}

export function startHeartbeat(): void {
  if (heartbeat) return
  void beat()
  heartbeat = setInterval(() => void beat(), HEARTBEAT_MS)
  heartbeat.unref?.()
}

export function stopHeartbeat(): void {
  if (heartbeat) clearInterval(heartbeat)
  heartbeat = null
}

/** Called once at startup, so a signed-in machine starts checking in. */
export async function resume(): Promise<void> {
  const account = await stored()
  if (decrypt(account) && account.deviceId) startHeartbeat()
}
