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
import { Puncher, type PunchCandidate, type PunchResult } from './punch'
import {
  closeAllTunnels,
  localKeyPair,
  openTunnel,
  tunnelFor,
  useKeyPair
} from './tunnel/manager'
import { exportPrivateKey, importPrivateKey } from './tunnel/wire'
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
  publicKey: string | null
  endpoints: Endpoint[]
}

export interface AccountState {
  signedIn: boolean
  peers: AccountPeer[]
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
  /** This machine's tunnel key, encrypted the same way the token is. */
  deviceKey?: string
  deviceKeyEncrypted?: boolean
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

/**
 * One puncher for the whole app, held open while signed in.
 *
 * It must be one socket and it must stay open: the router's mapping belongs to
 * a source port, so opening a fresh socket per attempt would get a fresh
 * mapping and throw away the hole that was already made. Keeping it alive is
 * also what lets the coordinator poke this machine when a peer asks for it.
 */
let puncher: Puncher | null = null
let punchKeepAlive: NodeJS.Timeout | null = null
/** The ticket the current puncher is using, for messages we send by hand. */
let currentTicket = ''

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

/**
 * Load this machine's tunnel key, or make one and keep it.
 *
 * Called before anything publishes a public key, because publishing one and
 * then holding a different one is the failure this exists to prevent.
 */
async function loadKeyPair(): Promise<void> {
  const account = await stored()

  if (account.deviceKey) {
    try {
      const raw = account.deviceKeyEncrypted
        ? safeStorage.decryptString(Buffer.from(account.deviceKey, 'base64'))
        : account.deviceKey
      useKeyPair(importPrivateKey(raw))
      return
    } catch {
      // Unreadable - a different machine, a reset keychain, a corrupt file. A
      // fresh key is recoverable; a broken one is not.
    }
  }

  const pair = localKeyPair()
  const exported = exportPrivateKey(pair)
  await store(
    safeStorage.isEncryptionAvailable()
      ? {
          deviceKey: safeStorage.encryptString(exported).toString('base64'),
          deviceKeyEncrypted: true
        }
      : { deviceKey: exported, deviceKeyEncrypted: false }
  )
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
    peers,
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
    await loadKeyPair()
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
    body: {
      id,
      name: hostname(),
      os: process.platform === 'win32' ? 'windows' : 'macos',
      // Published so a peer can derive a shared key with us. The coordinator
      // stores it and cannot use it - it brokers the exchange and cannot read
      // what the exchange protects.
      publicKey: localKeyPair().publicKey
    }
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
  void startPunching()
  heartbeat = setInterval(() => void beat(), HEARTBEAT_MS)
  heartbeat.unref?.()
}

export function stopHeartbeat(): void {
  if (heartbeat) clearInterval(heartbeat)
  heartbeat = null
  stopPunching()
}

// --------------------------------------------------------------------------
// Hole punching
// --------------------------------------------------------------------------

function coordinatorHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return '127.0.0.1'
  }
}

/**
 * Open the UDP side and keep it open.
 *
 * Nothing streams over this yet. What it buys today is the ability to answer
 * "could these two machines reach each other directly?" - and, more
 * importantly, it keeps this machine's mapping current so that when the far
 * side asks, the coordinator has somewhere to poke.
 */
async function startPunching(): Promise<void> {
  if (puncher) return
  const account = await stored()
  const token = decrypt(account)
  if (!token || !account.deviceId) return

  try {
    const ticketResponse = await call('/v1/punch/ticket', {
      method: 'POST',
      token,
      body: { deviceId: account.deviceId }
    })
    if (ticketResponse.status >= 400) return

    const next = new Puncher(
      {
        address: coordinatorHost(account.serverUrl ?? DEFAULT_SERVER),
        port: Number(ticketResponse.body.udpPort ?? 8787)
      },
      String(ticketResponse.body.ticket)
    )
    currentTicket = String(ticketResponse.body.ticket)
    if (!(await next.open())) {
      next.close()
      return
    }
    puncher = next
    punchKeepAlive = next.keepAlive()

    // Two things arrive on this socket now: punch protocol, and tunnel frames.
    next.onForeign((datagram) => {
      for (const peer of peers) {
        const handle = tunnelFor(peer.id)
        if (handle) handle.tunnel.handleDatagram(datagram)
      }
    })

    // The far side asking us to be the host. It runs Moonlight; we run
    // Sunshine, and this side opens connections to 127.0.0.1 on its behalf.
    next.onMessage((message, from) => {
      void (async () => {
        if (message.t !== 'tunnel-open') return
        const peerId = String(message.from ?? '')
        const peer = peers.find((candidate) => candidate.id === peerId)
        if (!peer?.publicKey) return
        const socket = next.raw
        if (!socket) return
        await openTunnel({
          socket,
          peer: { address: from.address, port: from.port },
          peerDeviceId: peerId,
          peerPublicKey: peer.publicKey,
          role: 'host'
        })
      })()
    })
  } catch {
    // No rendezvous available. Everything else still works; only the direct
    // test does not, and it reports that for itself.
  }
}

function stopPunching(): void {
  if (punchKeepAlive) clearInterval(punchKeepAlive)
  punchKeepAlive = null
  currentTicket = ''
  closeAllTunnels()
  puncher?.close()
  puncher = null
}

export interface DirectResult extends PunchResult {
  /** The address to hand the stream client, once a tunnel is carrying it. */
  tunnelAddress: string | null
  /** Round trip measured through the tunnel itself. */
  tunnelRttMs: number | null
}

/**
 * Punch a path to a peer and bring a tunnel up over it.
 *
 * After this, that machine is reachable at a loopback address on this one, and
 * everything Sunshine listens on is carried across the single punched socket.
 * Moonlight is pointed at the loopback address and never learns the difference.
 */
export async function connectDirect(deviceId: string): Promise<DirectResult> {
  const punched = await testDirect(deviceId)
  const failed: DirectResult = { ...punched, tunnelAddress: null, tunnelRttMs: null }
  if (!punched.ok || !punched.peer || !puncher?.raw) return failed

  const peer = peers.find((candidate) => candidate.id === deviceId)
  if (!peer?.publicKey) {
    return {
      ...failed,
      reason: 'that machine has not published a key yet - it may be on an older version'
    }
  }

  // Tell it to take the other role before we start sending frames it would not
  // otherwise know what to do with.
  const target: PunchCandidate = punched.peer
  puncher.tell({ t: 'tunnel-open', ticket: currentTicket, from: (await stored()).deviceId }, target)

  try {
    const handle = await openTunnel({
      socket: puncher.raw,
      peer: target,
      peerDeviceId: deviceId,
      peerPublicKey: peer.publicKey,
      role: 'client'
    })
    // A tunnel that binds but cannot reach the far side is worse than none: it
    // would accept a connection from Moonlight and then hang. Prove it first.
    const rtt = await handle.tunnel.ping(5_000)
    if (rtt === null) {
      handle.tunnel.stop()
      return { ...failed, reason: 'the tunnel came up but the far side never answered' }
    }
    return { ...punched, tunnelAddress: handle.address, tunnelRttMs: rtt }
  } catch (error) {
    return {
      ...failed,
      reason: error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * Can we reach this peer directly, through whatever routers are in the way?
 *
 * A real answer, and an honestly limited one: it establishes a UDP path between
 * two ephemeral ports. Carrying a stream over that path needs a tunnel, which
 * is not built yet.
 */
export async function testDirect(deviceId: string): Promise<PunchResult> {
  if (!puncher) await startPunching()
  if (!puncher) {
    return {
      ok: false,
      peer: null,
      rttMs: null,
      reflexive: null,
      reason: 'the coordinator has no rendezvous, or it could not be reached'
    }
  }

  const peer = peers.find((candidate) => candidate.id === deviceId)
  // The peer's own interface addresses cost nothing to try and are what works
  // when both machines happen to be on the same network.
  const extra = (peer?.endpoints ?? [])
    .filter((endpoint) => endpoint.kind === 'local')
    .map((endpoint) => ({ address: endpoint.address, port: endpoint.port }))

  return puncher.attempt(deviceId, extra)
}

/** Called once at startup, so a signed-in machine starts checking in. */
export async function resume(): Promise<void> {
  const account = await stored()
  if (!decrypt(account) || !account.deviceId) return

  await loadKeyPair()
  // Re-publish on every start. The key is stable now, but the name and
  // operating system are not guaranteed to be, and one call is cheaper than a
  // class of bug where what the coordinator hands out is not what we hold.
  await registerDevice()
  startHeartbeat()
}
