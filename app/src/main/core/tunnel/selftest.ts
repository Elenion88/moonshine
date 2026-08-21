// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Austin

/**
 * Runs the tunnel against a stand-in for Sunshine and checks that what went in
 * comes out.
 *
 * Not a unit test of the pieces - a test of the thing that matters: a TCP
 * connection to the fake host's port, made through the tunnel, carrying more
 * bytes than fit in one datagram, and a UDP datagram doing the round trip the
 * way video does. Plus the two properties that are easy to claim and easy to
 * get wrong: that a forged packet is rejected, and that a replayed one is too.
 *
 *     npx esbuild src/main/core/tunnel/selftest.ts --bundle --platform=node \
 *       --format=esm --outfile=<out>.mjs && node <out>.mjs
 */

import dgram from 'node:dgram'
import net from 'node:net'

import { Tunnel, LOOPBACK } from './endpoint'
import { deriveKeys, generateKeyPair, Sealer } from './wire'

/**
 * Not Sunshine's real ports. This machine is usually running Sunshine, which
 * already owns 47984 and friends - so a test that used them would be testing
 * whether Sunshine happens to be stopped.
 */
const TCP_PORTS = [57984, 57989, 58010]
const UDP_PORTS = [57998, 57999, 58000]
const PORTS = { tcp: TCP_PORTS, udp: UDP_PORTS }

const results: Array<{ name: string; ok: boolean; detail: string }> = []

function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Stands in for Sunshine: echoes TCP, and echoes UDP with a marker. */
async function startFakeHost(): Promise<() => void> {
  const servers: net.Server[] = []
  const sockets: dgram.Socket[] = []

  for (const port of TCP_PORTS) {
    const server = net.createServer((socket) => {
      socket.on('data', (chunk) => socket.write(chunk))
      socket.on('error', () => undefined)
    })
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
    servers.push(server)
  }

  for (const port of UDP_PORTS) {
    const socket = dgram.createSocket('udp4')
    socket.on('message', (message, from) => {
      socket.send(Buffer.concat([Buffer.from('echo:'), message]), from.port, from.address)
    })
    socket.on('error', () => undefined)
    await new Promise<void>((resolve) => socket.bind(port, '127.0.0.1', resolve))
    sockets.push(socket)
  }

  return () => {
    for (const server of servers) server.close()
    for (const socket of sockets) socket.close()
  }
}

async function main(): Promise<void> {
  const stopHost = await startFakeHost()

  // Two sockets standing in for the punched path.
  const clientSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  const hostSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  await new Promise<void>((resolve) => clientSocket.bind(0, '127.0.0.1', resolve))
  await new Promise<void>((resolve) => hostSocket.bind(0, '127.0.0.1', resolve))
  const clientPort = clientSocket.address().port
  const hostPort = hostSocket.address().port

  // The key exchange the coordinator would broker.
  const a = generateKeyPair()
  const b = generateKeyPair()
  const clientKeys = deriveKeys(a.privateKey, b.publicKey, true)
  const hostKeys = deriveKeys(b.privateKey, a.publicKey, false)

  const client = new Tunnel({
    socket: clientSocket,
    peer: { address: '127.0.0.1', port: hostPort },
    keys: clientKeys,
    role: 'client',
    loopback: LOOPBACK,
    ports: PORTS
  })
  const host = new Tunnel({
    socket: hostSocket,
    peer: { address: '127.0.0.1', port: clientPort },
    keys: hostKeys,
    role: 'host',
    ports: PORTS
  })

  // Kept so the replay test can re-deliver a genuine packet rather than
  // manufacturing one - a fresh Sealer starts its counter at zero, which the
  // replay window has already seen, so a forged "genuine" packet proves nothing.
  let lastToHost: Buffer | null = null

  clientSocket.on('message', (message) => client.handleDatagram(message))
  hostSocket.on('message', (message) => {
    lastToHost = Buffer.from(message)
    host.handleDatagram(message)
  })
  client.on('error', (error) => console.log('client error:', String(error)))
  host.on('error', (error) => console.log('host error:', String(error)))

  try {
    await client.start()
    await host.start()
  } catch (error) {
    check('bind loopback ports', false, String(error))
    stopHost()
    process.exit(1)
  }
  check('tunnel started', true, `client listening on ${client.address}`)

  // -- liveness ------------------------------------------------------------
  const rtt = await client.ping()
  check('ping crosses the tunnel', rtt !== null, rtt === null ? 'no pong' : `${rtt} ms`)

  // -- TCP, larger than one datagram ---------------------------------------
  // 40 KB forces chunking, ordering and acknowledgement to all be right; a
  // payload that fits in one frame would prove none of them.
  const payload = Buffer.alloc(40_000)
  for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251

  const echoed = await new Promise<Buffer | null>((resolve) => {
    const chunks: Buffer[] = []
    let total = 0
    const socket = net.connect({ host: LOOPBACK, port: TCP_PORTS[1] as number }, () => socket.write(payload))
    socket.on('data', (chunk) => {
      chunks.push(chunk)
      total += chunk.length
      if (total >= payload.length) {
        socket.destroy()
        resolve(Buffer.concat(chunks))
      }
    })
    socket.on('error', () => resolve(null))
    setTimeout(() => {
      socket.destroy()
      resolve(chunks.length ? Buffer.concat(chunks) : null)
    }, 20_000)
  })

  check(
    'TCP round trip, 40 KB',
    echoed !== null && echoed.length === payload.length && echoed.equals(payload),
    echoed === null ? 'nothing came back' : `${echoed.length} of ${payload.length} bytes`
  )

  // -- a second port, to prove streams are independent ----------------------
  const second = await new Promise<string | null>((resolve) => {
    const socket = net.connect({ host: LOOPBACK, port: TCP_PORTS[2] as number }, () => socket.write('RTSP/1.0'))
    socket.on('data', (chunk) => {
      socket.destroy()
      resolve(chunk.toString())
    })
    socket.on('error', () => resolve(null))
    setTimeout(() => {
      socket.destroy()
      resolve(null)
    }, 8_000)
  })
  check('second TCP port', second === 'RTSP/1.0', second ?? 'nothing came back')

  // -- UDP, the way video goes ---------------------------------------------
  const datagram = await new Promise<string | null>((resolve) => {
    const socket = dgram.createSocket('udp4')
    socket.on('message', (message) => {
      socket.close()
      resolve(message.toString())
    })
    socket.on('error', () => resolve(null))
    socket.send(Buffer.from('frame-1'), UDP_PORTS[0] as number, LOOPBACK)
    setTimeout(() => {
      try {
        socket.close()
      } catch {
        /* already closed */
      }
      resolve(null)
    }, 8_000)
  })
  check('UDP round trip', datagram === 'echo:frame-1', datagram ?? 'nothing came back')

  // -- forgery -------------------------------------------------------------
  const before = host.stats.framesReceived
  const forged = new Sealer(Buffer.alloc(32, 7)).seal(Buffer.from([1, 0, 1, 0, 0, 0, 0]))
  clientSocket.send(forged, hostPort, '127.0.0.1')
  await delay(300)
  check(
    'a packet under the wrong key is rejected',
    host.stats.framesReceived === before,
    `frames received unchanged at ${host.stats.framesReceived}`
  )

  // -- replay --------------------------------------------------------------
  // Take a packet the host genuinely accepted and hand it over a second time.
  await client.ping(1_000)
  await delay(200)
  const captured = lastToHost
  const beforeReplay = host.stats.framesReceived
  if (captured) host.handleDatagram(captured)
  check(
    'a replayed packet is rejected',
    captured !== null && host.stats.framesReceived === beforeReplay,
    captured === null
      ? 'nothing captured to replay'
      : `frames received unchanged at ${host.stats.framesReceived}`
  )

  // And the counter that made that work is not reusable by anyone else: a
  // fresh sealer under the same key starts at zero, which is already spent.
  const restarted = new Sealer(clientKeys.send).seal(Buffer.from([6, 0, 0, 0, 0, 0, 1]))
  const beforeRestart = host.stats.framesReceived
  host.handleDatagram(restarted)
  check(
    'a restarted nonce counter is rejected',
    host.stats.framesReceived === beforeRestart,
    `frames received unchanged at ${host.stats.framesReceived}`
  )

  console.log(
    `\nframes: client sent ${client.stats.framesSent}, host sent ${host.stats.framesSent}; ` +
      `retransmits ${client.stats.retransmits + host.stats.retransmits}, ` +
      `dropped ${client.stats.dropped + host.stats.dropped}`
  )

  client.stop()
  host.stop()
  clientSocket.close()
  hostSocket.close()
  stopHost()

  const failed = results.filter((result) => !result.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length === 0 ? 0 : 1)
}

void main()
