// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Austin

/**
 * Carrying Sunshine over a punched path.
 *
 * A punched hole is one UDP socket between two ephemeral ports. Sunshine
 * listens on six fixed ports, three of them TCP, so something has to stand in
 * front of Moonlight, look exactly like a host, and move that traffic across
 * the single socket that actually exists.
 *
 * The two halves are not symmetric:
 *
 *   client - the machine running Moonlight. Binds Sunshine's ports on a
 *            loopback address of its own and forwards everything it receives.
 *   host   - the machine running Sunshine. Opens connections to 127.0.0.1 on
 *            the port the other side asked for.
 *
 * TCP and UDP are treated deliberately differently, and that difference is the
 * whole design. The TCP ports carry pairing, app lists and RTSP setup - small,
 * order-sensitive, and fatal to lose - so they get sequencing, acknowledgement
 * and retransmission. The UDP ports carry video, audio and control input, where
 * a retransmitted packet arrives too late to use and only makes the next one
 * later. Those are forwarded once and forgotten, which is what the protocol on
 * top already expects: Sunshine sends video with its own forward error
 * correction precisely because it assumes loss.
 *
 * Adding reliability to a real-time stream is the classic way to make it worse.
 */

import dgram from 'node:dgram'
import net from 'node:net'
import { EventEmitter } from 'node:events'

import {
  FrameType,
  MAX_PAYLOAD,
  Opener,
  Sealer,
  decodeFrame,
  encodeFrame,
  type Frame,
  type SessionKeys
} from './wire'

/** Sunshine's TCP ports: HTTPS, HTTP, RTSP. */
export const TCP_PORTS = [47984, 47989, 48010]

/** Sunshine's UDP ports: video, control, audio. */
export const UDP_PORTS = [47998, 47999, 48000]

/**
 * A loopback address that is not 127.0.0.1.
 *
 * It has to be separate, because the machine running Moonlight may also be
 * running Sunshine - and Moonlight addresses a host by one address and fixed
 * port numbers, so binding 47989 on 127.0.0.1 would collide with the local
 * Sunshine and the tunnel would end up talking to itself.
 *
 * On Windows and Linux every 127.x.x.x address is already local. macOS binds
 * only 127.0.0.1 unless an alias is added, which is why `usableLoopback()`
 * below checks rather than assumes.
 */
export const LOOPBACK = '127.0.0.2'

/** The command that makes LOOPBACK usable on macOS. */
export const MACOS_ALIAS_COMMAND = `ifconfig lo0 alias ${LOOPBACK} up`

/** Can a socket actually bind this address? */
export function canBind(address: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', () => resolve(false))
    probe.listen(0, address, () => probe.close(() => resolve(true)))
  })
}

/**
 * The loopback address to hand the stream client, or null if there is not one.
 *
 * Prefers the separate address. Falls back to 127.0.0.1 when that is not
 * available *and* nothing is already using Sunshine's ports there - which is
 * the common case on a Mac that has never had the alias added and is a client
 * rather than a host. Returning null is the honest answer when neither works,
 * and is what the setup check exists to explain.
 */
export async function usableLoopback(): Promise<string | null> {
  if (await canBind(LOOPBACK)) return LOOPBACK

  const localSunshine = await new Promise<boolean>((resolve) => {
    const probe = net.createConnection({ host: '127.0.0.1', port: 47989 })
    probe.setTimeout(700)
    const done = (inUse: boolean): void => {
      probe.destroy()
      resolve(inUse)
    }
    probe.once('connect', () => done(true))
    probe.once('timeout', () => done(false))
    probe.once('error', () => done(false))
  })
  return localSunshine ? null : '127.0.0.1'
}

const RETRANSMIT_MS = 300
const MAX_RETRANSMIT_MS = 2_000
const MAX_TRIES = 24

/** Unacknowledged frames allowed in flight before the local socket is paused. */
const WINDOW = 64

interface Outgoing {
  frame: Frame
  sentAt: number
  tries: number
  timeout: number
}

/** One TCP connection being carried. */
class Stream {
  readonly outgoing = new Map<number, Outgoing>()
  readonly incoming = new Map<number, Frame>()
  nextSendSeq = 0
  expectedSeq = 0
  socket: net.Socket | null = null
  /** Bytes that arrived before the local socket existed. */
  pending: Buffer[] = []
  closed = false

  constructor(readonly id: number) {}
}

export interface TunnelStats {
  streams: number
  framesSent: number
  framesReceived: number
  retransmits: number
  dropped: number
}

export interface TunnelOptions {
  socket: dgram.Socket
  peer: { address: string; port: number }
  keys: SessionKeys
  role: 'client' | 'host'
  /** Client only. The address Moonlight will be pointed at. */
  loopback?: string
  /**
   * Which ports to carry. Defaults to Sunshine's.
   *
   * Configurable because a machine running Sunshine already owns those ports,
   * which makes them impossible to use for anything that wants to test this
   * without stopping the thing it exists to serve.
   */
  ports?: { tcp: number[]; udp: number[] }
}

export class Tunnel extends EventEmitter {
  private readonly sealer: Sealer
  private readonly opener: Opener
  private readonly streams = new Map<number, Stream>()
  private readonly servers: net.Server[] = []
  private readonly udpLocal = new Map<number, dgram.Socket>()
  /** Client: where Moonlight's datagrams for a port came from, so replies land. */
  private readonly udpReturn = new Map<number, { address: string; port: number }>()
  private nextStreamId = 1
  private timer: NodeJS.Timeout | null = null
  private stopped = false

  readonly stats: TunnelStats = {
    streams: 0,
    framesSent: 0,
    framesReceived: 0,
    retransmits: 0,
    dropped: 0
  }

  private readonly tcpPorts: number[]
  private readonly udpPorts: number[]

  constructor(private readonly options: TunnelOptions) {
    super()
    this.sealer = new Sealer(options.keys.send)
    this.opener = new Opener(options.keys.receive)
    this.tcpPorts = options.ports?.tcp ?? TCP_PORTS
    this.udpPorts = options.ports?.udp ?? UDP_PORTS
  }

  get address(): string {
    return this.options.loopback ?? LOOPBACK
  }

  // ---- transport ---------------------------------------------------------

  private sendFrame(frame: Frame): void {
    if (this.stopped) return
    try {
      const sealed = this.sealer.seal(encodeFrame(frame))
      this.options.socket.send(sealed, this.options.peer.port, this.options.peer.address, () => {
        // A send error on a punched path is a lost packet, which the layers
        // above already handle - reliably for TCP, by design for UDP.
      })
      this.stats.framesSent += 1
    } catch (error) {
      this.emit('error', error)
      this.stop()
    }
  }

  /** Send and remember, for anything that must arrive. */
  private sendReliable(stream: Stream, type: Frame['type'], payload: Buffer): void {
    const frame: Frame = { type, id: stream.id, seq: stream.nextSendSeq, payload }
    stream.nextSendSeq += 1
    stream.outgoing.set(frame.seq, {
      frame,
      sentAt: Date.now(),
      tries: 1,
      timeout: RETRANSMIT_MS
    })
    this.sendFrame(frame)
    this.applyBackpressure(stream)
  }

  private applyBackpressure(stream: Stream): void {
    if (!stream.socket) return
    // Reading faster than the far side acknowledges just fills memory with
    // frames nobody has confirmed. Stop reading until it catches up.
    if (stream.outgoing.size >= WINDOW) stream.socket.pause()
    else stream.socket.resume()
  }

  private onTick(): void {
    const now = Date.now()
    for (const stream of this.streams.values()) {
      for (const [seq, out] of stream.outgoing) {
        if (now - out.sentAt < out.timeout) continue
        if (out.tries >= MAX_TRIES) {
          // The path is gone. Nothing above this can recover a TCP stream whose
          // bytes never arrived, so close it and let the session fail cleanly.
          stream.outgoing.delete(seq)
          this.stats.dropped += 1
          this.closeStream(stream, false)
          continue
        }
        out.tries += 1
        out.sentAt = now
        out.timeout = Math.min(out.timeout * 2, MAX_RETRANSMIT_MS)
        this.stats.retransmits += 1
        this.sendFrame(out.frame)
      }
    }
  }

  // ---- receiving ---------------------------------------------------------

  handleDatagram(sealed: Buffer): void {
    const plaintext = this.opener.open(sealed)
    if (!plaintext) return // Not authentic, or a replay. Silence is correct.
    const frame = decodeFrame(plaintext)
    if (!frame) return
    this.stats.framesReceived += 1

    switch (frame.type) {
      case FrameType.Ping:
        this.sendFrame({ type: FrameType.Pong, id: frame.id, seq: frame.seq, payload: Buffer.alloc(0) })
        return
      case FrameType.Pong:
        this.emit('pong', frame.seq)
        return
      case FrameType.Datagram:
        this.deliverDatagram(frame)
        return
      case FrameType.Ack: {
        const stream = this.streams.get(frame.id)
        if (!stream) return
        // Cumulative: everything up to and including this arrived.
        for (const seq of [...stream.outgoing.keys()]) {
          if (seq <= frame.seq) stream.outgoing.delete(seq)
        }
        this.applyBackpressure(stream)
        return
      }
      default:
        this.deliverReliable(frame)
    }
  }

  private deliverReliable(frame: Frame): void {
    let stream = this.streams.get(frame.id)

    if (!stream) {
      // Only the host opens streams on demand, and only for an Open frame -
      // anything else naming an unknown stream is late traffic for one that has
      // already gone.
      if (this.options.role !== 'host' || frame.type !== FrameType.Open) return
      stream = new Stream(frame.id)
      this.streams.set(frame.id, stream)
      this.stats.streams += 1
    }

    if (frame.seq < stream.expectedSeq) {
      // Already had it; the ack was lost. Re-ack rather than ignore, or the far
      // side keeps retransmitting until it gives up.
      this.sendFrame({
        type: FrameType.Ack,
        id: stream.id,
        seq: stream.expectedSeq - 1,
        payload: Buffer.alloc(0)
      })
      return
    }

    stream.incoming.set(frame.seq, frame)

    // Drain everything that is now contiguous.
    for (;;) {
      const next = stream.incoming.get(stream.expectedSeq)
      if (!next) break
      stream.incoming.delete(stream.expectedSeq)
      stream.expectedSeq += 1
      this.applyFrame(stream, next)
    }

    this.sendFrame({
      type: FrameType.Ack,
      id: stream.id,
      seq: stream.expectedSeq - 1,
      payload: Buffer.alloc(0)
    })
  }

  private applyFrame(stream: Stream, frame: Frame): void {
    if (frame.type === FrameType.Open) {
      const port = frame.payload.readUInt16BE(0)
      // Only the ports this tunnel exists to carry. Without the check, the
      // far side could ask for a connection to anything on this machine.
      if (!this.tcpPorts.includes(port)) return this.closeStream(stream, true)
      this.connectLocal(stream, port)
      return
    }

    if (frame.type === FrameType.Data) {
      if (stream.socket && !stream.socket.destroyed) stream.socket.write(frame.payload)
      else stream.pending.push(frame.payload)
      return
    }

    if (frame.type === FrameType.Close) this.closeStream(stream, false)
  }

  /** Host side: the far end asked for a port, so open it locally. */
  private connectLocal(stream: Stream, port: number): void {
    const socket = net.connect({ host: '127.0.0.1', port })
    stream.socket = socket
    socket.setNoDelay(true)

    socket.on('connect', () => {
      for (const chunk of stream.pending) socket.write(chunk)
      stream.pending = []
    })
    socket.on('data', (chunk) => this.writeChunks(stream, chunk))
    socket.on('close', () => this.closeStream(stream, true))
    socket.on('error', () => this.closeStream(stream, true))
  }

  /** Split at the MTU: one datagram per frame, never a fragmented one. */
  private writeChunks(stream: Stream, chunk: Buffer): void {
    for (let offset = 0; offset < chunk.length; offset += MAX_PAYLOAD) {
      this.sendReliable(
        stream,
        FrameType.Data,
        chunk.subarray(offset, Math.min(offset + MAX_PAYLOAD, chunk.length))
      )
    }
  }

  private closeStream(stream: Stream, tellPeer: boolean): void {
    if (stream.closed) return
    stream.closed = true
    if (tellPeer) this.sendReliable(stream, FrameType.Close, Buffer.alloc(0))
    stream.socket?.destroy()
    stream.socket = null
    // Kept briefly so a late retransmission does not look like a new stream.
    setTimeout(() => this.streams.delete(stream.id), 5_000).unref?.()
  }

  private deliverDatagram(frame: Frame): void {
    const port = frame.id

    if (this.options.role === 'host') {
      // Forward to Sunshine, from a socket kept per port so its replies come
      // back somewhere we recognise.
      let socket = this.udpLocal.get(port)
      if (!socket) {
        socket = dgram.createSocket('udp4')
        socket.on('message', (reply) => {
          this.sendFrame({ type: FrameType.Datagram, id: port, seq: 0, payload: reply })
        })
        socket.on('error', () => undefined)
        socket.bind()
        this.udpLocal.set(port, socket)
      }
      socket.send(frame.payload, port, '127.0.0.1')
      return
    }

    // Client side: back to wherever Moonlight sent from.
    const back = this.udpReturn.get(port)
    const local = this.udpLocal.get(port)
    if (back && local) local.send(frame.payload, back.port, back.address)
  }

  // ---- starting ----------------------------------------------------------

  /**
   * Client side: bind Sunshine's ports locally so Moonlight can be pointed at
   * this machine and never know the difference.
   */
  private async listenLocally(): Promise<void> {
    const address = this.address

    for (const port of this.tcpPorts) {
      const server = net.createServer((socket) => {
        const stream = new Stream(this.nextStreamId++)
        if (this.nextStreamId > 65_000) this.nextStreamId = 1
        this.streams.set(stream.id, stream)
        this.stats.streams += 1
        stream.socket = socket
        socket.setNoDelay(true)

        const portBuffer = Buffer.allocUnsafe(2)
        portBuffer.writeUInt16BE(port, 0)
        this.sendReliable(stream, FrameType.Open, portBuffer)

        socket.on('data', (chunk) => this.writeChunks(stream, chunk))
        socket.on('close', () => this.closeStream(stream, true))
        socket.on('error', () => this.closeStream(stream, true))
      })
      server.on('error', (error) => this.emit('error', error))
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, address, resolve)
      })
      this.servers.push(server)
    }

    for (const port of this.udpPorts) {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
      socket.on('message', (message, from) => {
        this.udpReturn.set(port, { address: from.address, port: from.port })
        this.sendFrame({ type: FrameType.Datagram, id: port, seq: 0, payload: message })
      })
      socket.on('error', (error) => this.emit('error', error))
      await new Promise<void>((resolve) => socket.bind(port, address, resolve))
      this.udpLocal.set(port, socket)
    }
  }

  async start(): Promise<void> {
    if (this.options.role === 'client') await this.listenLocally()
    this.timer = setInterval(() => this.onTick(), 100)
    this.timer.unref?.()
  }

  /** Round trip over the tunnel itself, or null if nothing came back. */
  ping(timeoutMs = 3_000): Promise<number | null> {
    const nonce = Math.floor(Math.random() * 0xffffffff)
    const startedAt = Date.now()
    return new Promise((resolve) => {
      const onPong = (seq: number): void => {
        if (seq !== nonce) return
        this.off('pong', onPong)
        clearTimeout(timer)
        resolve(Date.now() - startedAt)
      }
      const timer = setTimeout(() => {
        this.off('pong', onPong)
        resolve(null)
      }, timeoutMs)
      timer.unref?.()
      this.on('pong', onPong)
      this.sendFrame({ type: FrameType.Ping, id: 0, seq: nonce, payload: Buffer.alloc(0) })
    })
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    for (const server of this.servers) server.close()
    for (const socket of this.udpLocal.values()) {
      try {
        socket.close()
      } catch {
        // Already closed.
      }
    }
    for (const stream of this.streams.values()) stream.socket?.destroy()
    this.streams.clear()
    this.udpLocal.clear()
    this.emit('stopped')
  }
}
