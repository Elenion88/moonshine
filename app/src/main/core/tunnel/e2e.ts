// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Austin

/**
 * The whole path, end to end, against a running coordinator.
 *
 * Two devices on one account, no shared state between them beyond what the
 * coordinator brokers: sign up, register with public keys, bind the rendezvous,
 * punch, agree roles, derive a shared key from the exchange, bring the tunnel
 * up, and move real bytes through it to a stand-in for Sunshine.
 *
 * This is the test that would have caught every mistake worth catching - a key
 * derived in the wrong direction, a role assigned to the wrong side, a punch
 * that succeeds while the tunnel talks to nobody.
 *
 *     node <bundle>.mjs http://127.0.0.1:8788
 */

import dgram from 'node:dgram'
import net from 'node:net'

import { Tunnel } from './endpoint'
import { deriveKeys, generateKeyPair } from './wire'

const BASE = process.argv[2] ?? 'http://127.0.0.1:8788'

/** Not Sunshine's real ports: this machine is running the real thing. */
const PORTS = { tcp: [57984, 57989, 58010], udp: [57998, 57999, 58000] }
const LOOPBACK = '127.0.0.3'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

async function api(
  path: string,
  body: unknown,
  token?: string
): Promise<Record<string, any>> {
  const response = await fetch(BASE + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  })
  return (await response.json()) as Record<string, any>
}

/** Stands in for Sunshine on the host machine. */
async function fakeSunshine(): Promise<() => void> {
  const servers: net.Server[] = []
  const sockets: dgram.Socket[] = []
  for (const port of PORTS.tcp) {
    const server = net.createServer((socket) => {
      socket.on('data', (chunk) => socket.write(Buffer.concat([Buffer.from('S:'), chunk])))
      socket.on('error', () => undefined)
    })
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
    servers.push(server)
  }
  for (const port of PORTS.udp) {
    const socket = dgram.createSocket('udp4')
    socket.on('message', (message, from) =>
      socket.send(Buffer.concat([Buffer.from('S:'), message]), from.port, from.address)
    )
    socket.on('error', () => undefined)
    await new Promise<void>((resolve) => socket.bind(port, '127.0.0.1', resolve))
    sockets.push(socket)
  }
  return () => {
    for (const server of servers) server.close()
    for (const socket of sockets) socket.close()
  }
}

/** One device: its own socket, its own keys, its own view of the world. */
class Device {
  socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  keys = generateKeyPair()
  deviceId = ''
  ticket = ''
  tunnel: Tunnel | null = null
  reflexive: { address: string; port: number } | null = null
  private readonly waiters = new Set<(m: any, from: dgram.RemoteInfo) => void>()

  constructor(
    readonly name: string,
    readonly coordinator: { address: string; port: number }
  ) {
    this.socket.on('message', (raw, from) => {
      if (raw.length > 0 && raw[0] !== 0x7b) {
        this.tunnel?.handleDatagram(raw)
        return
      }
      let message: any
      try {
        message = JSON.parse(raw.toString())
      } catch {
        return
      }
      for (const waiter of [...this.waiters]) waiter(message, from)
    })
  }

  bindSocket(): Promise<void> {
    return new Promise((resolve) => this.socket.bind(0, resolve))
  }

  send(message: unknown, to: { address: string; port: number }): void {
    this.socket.send(Buffer.from(JSON.stringify(message)), to.port, to.address)
  }

  wait(predicate: (m: any, from: dgram.RemoteInfo) => boolean, ms: number): Promise<any> {
    return new Promise((resolve) => {
      const waiter = (m: any, from: dgram.RemoteInfo): void => {
        if (!predicate(m, from)) return
        this.waiters.delete(waiter)
        clearTimeout(timer)
        resolve({ m, from })
      }
      const timer = setTimeout(() => {
        this.waiters.delete(waiter)
        resolve(null)
      }, ms)
      this.waiters.add(waiter)
    })
  }

  on(handler: (m: any, from: dgram.RemoteInfo) => void): void {
    this.waiters.add(handler)
  }
}

async function main(): Promise<void> {
  const stopSunshine = await fakeSunshine()
  const email = `e2e-${Date.now()}@example.com`
  const password = 'correcthorsebattery'

  const signup = await api('/v1/signup', { email, password })
  const token = signup.token as string
  check('account created', Boolean(token))

  const coordinator = { address: new URL(BASE).hostname, port: 0 }

  const client = new Device('laptop', coordinator)
  const host = new Device('tower', coordinator)
  await client.bindSocket()
  await host.bindSocket()

  for (const device of [client, host]) {
    const registered = await api(
      '/v1/devices',
      { name: device.name, os: 'windows', publicKey: device.keys.publicKey },
      token
    )
    device.deviceId = registered.deviceId as string
    const ticket = await api('/v1/punch/ticket', { deviceId: device.deviceId }, token)
    device.ticket = ticket.ticket as string
    coordinator.port = Number(ticket.udpPort)
  }
  check('both devices registered with keys', Boolean(client.deviceId && host.deviceId))

  // Each device asks the peer list for the other's published key, exactly as
  // the app does - nothing is passed between them in process.
  const listed = await fetch(`${BASE}/v1/devices`, {
    headers: { authorization: `Bearer ${token}` }
  })
  const devices = (await listed.json()) as { devices: Array<Record<string, any>> }
  const hostRecord = devices.devices.find((device) => device.id === host.deviceId)
  const clientRecord = devices.devices.find((device) => device.id === client.deviceId)
  check(
    'keys came back from the coordinator',
    hostRecord?.publicKey === host.keys.publicKey &&
      clientRecord?.publicKey === client.keys.publicKey
  )

  // Both bind the rendezvous, leaving a mapping behind.
  for (const device of [client, host]) {
    device.send({ t: 'bind', ticket: device.ticket }, coordinator)
    const bound = await device.wait((m) => m.t === 'bound', 3000)
    device.reflexive = bound ? { address: bound.m.address, port: bound.m.port } : null
  }
  check('both learned a reflexive address', Boolean(client.reflexive && host.reflexive))

  // The host answers probes and, when poked, starts sending back.
  host.on((m, from) => {
    if (m.t === 'probe') host.send({ t: 'probe-ack', nonce: m.nonce }, from)
    if (m.t === 'punch') host.send({ t: 'probe', nonce: 'host' }, { address: m.address, port: m.port })
    if (m.t === 'tunnel-open') {
      host.tunnel = new Tunnel({
        socket: host.socket,
        peer: { address: from.address, port: from.port },
        // The side that asked is the initiator; this side is not.
        keys: deriveKeys(host.keys.privateKey, clientRecord?.publicKey as string, false),
        role: 'host',
        ports: PORTS
      })
      void host.tunnel.start()
    }
  })

  // The client asks for the host, which also pokes the host.
  client.send({ t: 'connect', ticket: client.ticket, target: host.deviceId }, coordinator)
  const peer = await client.wait((m) => m.t === 'peer' || m.t === 'no-peer', 3000)
  check('coordinator introduced them', peer?.m.t === 'peer', peer?.m.t ?? 'no answer')
  if (peer?.m.t !== 'peer') {
    stopSunshine()
    process.exit(1)
  }

  const target = { address: peer.m.address as string, port: peer.m.port as number }
  client.send({ t: 'probe', nonce: 'n' }, target)
  const landed = await client.wait(
    (m, from) => (m.t === 'probe-ack' || m.t === 'probe') && from.port !== coordinator.port,
    4000
  )
  check('a probe landed', Boolean(landed))

  // Ask the far side to be the host, then bring our own end up.
  client.send({ t: 'tunnel-open', ticket: client.ticket, from: client.deviceId }, target)
  await new Promise((resolve) => setTimeout(resolve, 400))

  client.tunnel = new Tunnel({
    socket: client.socket,
    peer: target,
    keys: deriveKeys(client.keys.privateKey, hostRecord?.publicKey as string, true),
    role: 'client',
    loopback: LOOPBACK,
    ports: PORTS
  })
  await client.tunnel.start()
  check('tunnel started', true, `client listening on ${LOOPBACK}`)

  const rtt = await client.tunnel.ping(5000)
  check('tunnel round trip', rtt !== null, rtt === null ? 'no answer' : `${rtt} ms`)

  // The thing it is all for: a TCP connection through the tunnel to Sunshine.
  const tcp = await new Promise<string | null>((resolve) => {
    const socket = net.connect({ host: LOOPBACK, port: PORTS.tcp[1] as number }, () =>
      socket.write('GET /serverinfo')
    )
    socket.on('data', (chunk) => {
      socket.destroy()
      resolve(chunk.toString())
    })
    socket.on('error', () => resolve(null))
    setTimeout(() => {
      socket.destroy()
      resolve(null)
    }, 12_000)
  })
  check('TCP reached the host through the tunnel', tcp === 'S:GET /serverinfo', tcp ?? 'nothing')

  const udp = await new Promise<string | null>((resolve) => {
    const socket = dgram.createSocket('udp4')
    socket.on('message', (message) => {
      socket.close()
      resolve(message.toString())
    })
    socket.on('error', () => resolve(null))
    socket.send(Buffer.from('video'), PORTS.udp[0] as number, LOOPBACK)
    setTimeout(() => {
      try {
        socket.close()
      } catch {
        /* closed */
      }
      resolve(null)
    }, 8_000)
  })
  check('UDP reached the host through the tunnel', udp === 'S:video', udp ?? 'nothing')

  console.log(
    `\nclient frames ${client.tunnel.stats.framesSent}/${client.tunnel.stats.framesReceived}, ` +
      `host frames ${host.tunnel?.stats.framesSent}/${host.tunnel?.stats.framesReceived}, ` +
      `retransmits ${client.tunnel.stats.retransmits + (host.tunnel?.stats.retransmits ?? 0)}`
  )

  client.tunnel.stop()
  host.tunnel?.stop()
  client.socket.close()
  host.socket.close()
  stopSunshine()
  console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
