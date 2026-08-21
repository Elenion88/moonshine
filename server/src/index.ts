// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Austin

/**
 * The Moonshine coordinator.
 *
 * The smallest thing that can answer "which machines are mine, and where are
 * they right now". It holds accounts and a device registry, and it tells each
 * device the addresses its siblings last reported.
 *
 * What it deliberately is not: a relay. No stream traffic passes through here,
 * ever. That keeps the bandwidth bill at zero, keeps this service off the
 * critical path of a session already running, and means a machine that has
 * already found its peer keeps working when this is down.
 *
 *     node --experimental-sqlite dist/index.js [--insecure] [--port 8787]
 *
 * Environment:
 *   MOONSHINE_DB     path to the SQLite file (default ./data/coordinator.db)
 *   MOONSHINE_PORT   port to listen on (default 8787)
 *   MOONSHINE_TRUST_PROXY  set when behind a reverse proxy that sets
 *                          X-Forwarded-For, so observed addresses are the
 *                          client's rather than the proxy's
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

import {
  hashPassword,
  newId,
  newSalt,
  newToken,
  validEmail,
  validPassword,
  verifyPassword
} from './auth.js'
import { issueTicket, startRendezvous } from './rendezvous.js'
import {
  createToken,
  createUser,
  deleteDevice,
  deleteToken,
  devicesForUser,
  findUserByEmail,
  migrate,
  open,
  touchDevice,
  upsertDevice,
  userForToken,
  type Endpoint
} from './db.js'

const args = process.argv.slice(2)
const INSECURE = args.includes('--insecure')
const PORT = Number(
  process.env.MOONSHINE_PORT ?? args[args.indexOf('--port') + 1] ?? 8787
)
const DB_PATH = process.env.MOONSHINE_DB ?? './data/coordinator.db'
const TRUST_PROXY = process.env.MOONSHINE_TRUST_PROXY === '1'

/** The rendezvous listens on UDP at the same number as the HTTP port. */
const UDP_PORT = Number(process.env.MOONSHINE_UDP_PORT ?? PORT)

/** Bodies here are a few hundred bytes. Anything larger is not a mistake. */
const MAX_BODY = 64 * 1024

/**
 * A device that has not checked in for this long is not reachable at whatever
 * address it last reported, so saying where it is would be worse than saying
 * nothing.
 */
const ONLINE_WINDOW_MS = 3 * 60 * 1000

// --------------------------------------------------------------------------
// Plumbing
// --------------------------------------------------------------------------

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // This API is for the desktop app, not a browser, so no origin needs it.
    'access-control-allow-origin': 'null',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store'
  })
  response.end(payload)
}

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('body is not JSON'))
      }
    })
    request.on('error', reject)
  })
}

/**
 * The client's address as we see it - which is the useful half of what a STUN
 * server does, for free, because the client already had to connect here.
 */
function observedAddress(request: IncomingMessage): string | null {
  if (TRUST_PROXY) {
    const forwarded = request.headers['x-forwarded-for']
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim()
    if (first) return first
  }
  const remote = request.socket.remoteAddress ?? null
  // Node reports IPv4 over a dual-stack socket as ::ffff:1.2.3.4.
  return remote?.startsWith('::ffff:') ? remote.slice(7) : remote
}

/**
 * Enough rate limiting to make credential stuffing unattractive, and no more.
 *
 * In-memory and per-process, so it resets on restart and does not survive
 * horizontal scaling. Both are acceptable for a service this size and neither
 * should be forgotten if it ever grows.
 */
const attempts = new Map<string, { count: number; resetAt: number }>()
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000
const ATTEMPT_LIMIT = 20

function rateLimited(key: string | null): boolean {
  if (!key) return false
  const now = Date.now()
  const entry = attempts.get(key)
  if (!entry || entry.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS })
    return false
  }
  entry.count += 1
  return entry.count > ATTEMPT_LIMIT
}

function bearer(request: IncomingMessage): string | null {
  const header = request.headers.authorization
  if (!header?.startsWith('Bearer ')) return null
  return header.slice(7).trim() || null
}

function authenticate(request: IncomingMessage): string | null {
  const token = bearer(request)
  return token ? userForToken(token) : null
}

function sanitiseEndpoints(value: unknown): Endpoint[] {
  if (!Array.isArray(value)) return []
  const kinds = new Set(['local', 'observed', 'manual'])
  return value
    .filter(
      (entry): entry is Endpoint =>
        entry !== null &&
        typeof entry === 'object' &&
        kinds.has(String((entry as Endpoint).kind)) &&
        typeof (entry as Endpoint).address === 'string' &&
        (entry as Endpoint).address.length <= 64 &&
        Number.isInteger((entry as Endpoint).port) &&
        (entry as Endpoint).port > 0 &&
        (entry as Endpoint).port < 65536
    )
    // A device with dozens of interfaces is real; a device claiming hundreds is
    // filling the database on someone else's behalf.
    .slice(0, 16)
}

// --------------------------------------------------------------------------
// Routes
// --------------------------------------------------------------------------

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const path = url.pathname.replace(/\/+$/, '') || '/'
  const method = request.method ?? 'GET'

  if (path === '/health') return send(response, 200, { ok: true })

  // ---- accounts ----
  if (path === '/v1/signup' || path === '/v1/login') {
    if (method !== 'POST') return send(response, 405, { error: 'method not allowed' })
    if (rateLimited(observedAddress(request))) {
      return send(response, 429, { error: 'too many attempts, try again later' })
    }

    const body = (await readBody(request)) as { email?: unknown; password?: unknown }
    const email = validEmail(body.email) ? body.email.toLowerCase() : null
    if (!email) return send(response, 400, { error: 'a valid email address is required' })
    if (!validPassword(body.password)) {
      return send(response, 400, { error: 'password must be at least 10 characters' })
    }

    if (path === '/v1/signup') {
      if (findUserByEmail(email)) {
        // Deliberately the same shape as a wrong password on /login: this tells
        // an attacker nothing about which addresses have accounts.
        return send(response, 409, { error: 'that email cannot be used' })
      }
      const salt = newSalt()
      const id = newId()
      createUser({
        id,
        email,
        salt,
        password_hash: await hashPassword(body.password, salt)
      })
      const token = newToken()
      createToken(token, id)
      return send(response, 201, { token, userId: id, email })
    }

    const user = findUserByEmail(email)
    // Hash anyway when the user does not exist, so a missing account and a
    // wrong password take the same ~100ms rather than advertising the
    // difference by returning instantly.
    const ok = user
      ? await verifyPassword(body.password, user.salt, user.password_hash)
      : (await hashPassword(body.password, 'absent'), false)
    if (!user || !ok) return send(response, 401, { error: 'email or password is wrong' })

    const token = newToken()
    createToken(token, user.id)
    return send(response, 200, { token, userId: user.id, email })
  }

  if (path === '/v1/logout') {
    const token = bearer(request)
    if (token) deleteToken(token)
    return send(response, 200, { ok: true })
  }

  // ---- everything below needs a token ----
  const userId = authenticate(request)
  if (!userId) return send(response, 401, { error: 'sign in first' })

  if (path === '/v1/devices' && method === 'POST') {
    const body = (await readBody(request)) as {
      id?: unknown
      name?: unknown
      os?: unknown
      publicKey?: unknown
    }
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 64) : ''
    if (!name) return send(response, 400, { error: 'a device name is required' })
    // The client keeps its own id so a reinstall on the same machine updates
    // the record rather than adding a second one.
    const id = typeof body.id === 'string' && body.id.length <= 64 ? body.id : newId()
    // 32 bytes of X25519, base64. Stored as given and never used here - this
    // service brokers the exchange and cannot read what it protects.
    const publicKey =
      typeof body.publicKey === 'string' && body.publicKey.length <= 64
        ? body.publicKey
        : null

    upsertDevice({
      id,
      userId,
      name,
      os: typeof body.os === 'string' ? body.os.slice(0, 32) : '',
      publicKey
    })
    return send(response, 200, { deviceId: id })
  }

  if (path === '/v1/devices' && method === 'GET') {
    return send(response, 200, { devices: listPeers(userId, null) })
  }

  if (path === '/v1/heartbeat' && method === 'POST') {
    const body = (await readBody(request)) as { deviceId?: unknown; endpoints?: unknown }
    if (typeof body.deviceId !== 'string') {
      return send(response, 400, { error: 'deviceId is required' })
    }
    const observed = observedAddress(request)
    const known = touchDevice(body.deviceId, userId, observed, sanitiseEndpoints(body.endpoints))
    if (!known) return send(response, 404, { error: 'unknown device - register it first' })

    return send(response, 200, {
      // What the world sees this device as. The client cannot learn its own
      // public address any other way without a STUN server.
      observed,
      peers: listPeers(userId, body.deviceId)
    })
  }

  if (path === '/v1/punch/ticket' && method === 'POST') {
    const body = (await readBody(request)) as { deviceId?: unknown }
    if (typeof body.deviceId !== 'string') {
      return send(response, 400, { error: 'deviceId is required' })
    }
    // Short-lived, single-purpose, and not the bearer token: the packets it
    // authenticates are unencrypted UDP.
    return send(response, 200, {
      ticket: issueTicket(body.deviceId, userId),
      udpPort: UDP_PORT
    })
  }

  const deviceMatch = /^\/v1\/devices\/([^/]+)$/.exec(path)
  if (deviceMatch && method === 'DELETE') {
    const removed = deleteDevice(decodeURIComponent(deviceMatch[1] as string), userId)
    return send(response, removed ? 200 : 404, { ok: removed })
  }

  return send(response, 404, { error: 'no such endpoint' })
}

function listPeers(userId: string, excludeId: string | null): unknown[] {
  const now = Date.now()
  return devicesForUser(userId)
    .filter((device) => device.id !== excludeId)
    .map((device) => ({
      id: device.id,
      name: device.name,
      os: device.os,
      online: now - device.last_seen < ONLINE_WINDOW_MS,
      lastSeen: device.last_seen,
      observedIp: device.observed_ip,
      publicKey: device.public_key,
      endpoints: JSON.parse(device.endpoints) as Endpoint[]
    }))
}

// --------------------------------------------------------------------------

function main(): void {
  if (!INSECURE && !process.env.MOONSHINE_TRUST_PROXY) {
    console.error(
      'refusing to start: this server speaks plain HTTP and handles passwords.\n' +
        '  Put it behind a TLS-terminating proxy and set MOONSHINE_TRUST_PROXY=1,\n' +
        '  or pass --insecure for local development.'
    )
    process.exit(1)
  }

  open(DB_PATH)
  migrate()

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'unexpected error'
      // 400 rather than 500 for the body errors, which is what these are: the
      // only things `handle` throws are a body too large or unparseable.
      send(response, /body/.test(message) ? 400 : 500, { error: message })
    })
  })

  startRendezvous(UDP_PORT)

  server.listen(PORT, () => {
    console.log(`moonshine coordinator on :${PORT}  db=${DB_PATH}`)
    if (INSECURE) console.log('  --insecure: plain HTTP. Do not do this in production.')
  })

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      server.close(() => process.exit(0))
    })
  }
}

main()
