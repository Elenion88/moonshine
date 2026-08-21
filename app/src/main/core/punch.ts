// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Austin

/**
 * Getting a UDP path through two routers.
 *
 * A NAT forwards an inbound packet only if something inside sent one outward to
 * that address first. So there is no "server" side to this: both machines have
 * to send at roughly the same moment, each one opening the mapping the other's
 * packet needs. The coordinator's job is only to tell them where and when; once
 * a packet lands, it is out of the loop and the two talk directly.
 *
 * What this gives you is a verified bidirectional UDP path between two ephemeral
 * ports, and its round-trip time. What it does not yet give you is a stream:
 * Sunshine listens on its own TCP and UDP ports, and carrying those over this
 * path means a tunnel. That is the next piece, and it builds on this one.
 *
 * Deliberately no reliance on the punch for anything a session needs yet - the
 * app uses it to answer "could these two machines talk directly?", which is a
 * real question with a real answer, and the honest limit of what is built.
 */

import dgram from 'node:dgram'

export interface PunchCandidate {
  address: string
  port: number
}

export interface PunchResult {
  ok: boolean
  /** The address that answered, when one did. */
  peer: PunchCandidate | null
  /** Round trip over the punched path, in milliseconds. */
  rttMs: number | null
  /** What this machine looks like from outside, as the coordinator saw it. */
  reflexive: PunchCandidate | null
  reason: string | null
}

/** How long to keep probing before giving up. */
const ATTEMPT_MS = 8_000

/**
 * Probes go out repeatedly, not once.
 *
 * The first packet each way is usually lost - it arrives at the far router
 * before that router has seen anything outbound, so it is dropped, and its only
 * job was to open the mapping on *this* side. Repeating is what makes the
 * second or third one land.
 */
const PROBE_INTERVAL_MS = 250

interface Message {
  t?: string
  address?: string
  port?: number
  from?: string
  error?: string
  nonce?: string
}

function parse(raw: Buffer): Message | null {
  try {
    return JSON.parse(raw.toString('utf8')) as Message
  } catch {
    return null
  }
}

/**
 * One socket, held open for the life of an attempt.
 *
 * The same socket has to talk to the coordinator and to the peer, because the
 * whole point is the mapping the router made for *this* source port. Opening a
 * second socket to talk to the peer would get a different mapping and undo the
 * work.
 */
export class Puncher {
  private socket: dgram.Socket | null = null
  private reflexive: PunchCandidate | null = null
  private readonly handlers = new Set<(message: Message, from: dgram.RemoteInfo) => void>()

  constructor(
    private readonly coordinator: PunchCandidate,
    private readonly ticket: string
  ) {}

  private send(message: Record<string, unknown>, to: PunchCandidate): void {
    this.socket?.send(Buffer.from(JSON.stringify(message)), to.port, to.address, () => {
      // Errors here are expected and uninteresting: an unreachable candidate is
      // exactly what we are trying to find out about.
    })
  }

  private wait(
    predicate: (message: Message, from: dgram.RemoteInfo) => boolean,
    timeoutMs: number
  ): Promise<{ message: Message; from: dgram.RemoteInfo } | null> {
    return new Promise((resolve) => {
      const handler = (message: Message, from: dgram.RemoteInfo): void => {
        if (!predicate(message, from)) return
        this.handlers.delete(handler)
        clearTimeout(timer)
        resolve({ message, from })
      }
      const timer = setTimeout(() => {
        this.handlers.delete(handler)
        resolve(null)
      }, timeoutMs)
      timer.unref?.()
      this.handlers.add(handler)
    })
  }

  async open(): Promise<PunchCandidate | null> {
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.socket.on('message', (raw, from) => {
      const message = parse(raw)
      if (!message) return
      for (const handler of [...this.handlers]) handler(message, from)
    })
    this.socket.on('error', () => {
      // Reported through the attempt result rather than thrown: a socket that
      // cannot be used is a failed attempt, not a crash.
    })

    await new Promise<void>((resolve) => this.socket?.bind(0, resolve))

    // Ask the coordinator what we look like from outside, and let it remember
    // the mapping. This packet is also what opens our own router's hole.
    this.send({ t: 'bind', ticket: this.ticket }, this.coordinator)
    const bound = await this.wait((message) => message.t === 'bound', 4000)
    if (!bound) return null

    this.reflexive = {
      address: String(bound.message.address ?? ''),
      port: Number(bound.message.port ?? 0)
    }
    return this.reflexive
  }

  /** Keep the router's mapping alive. They expire in as little as 30 seconds. */
  keepAlive(): NodeJS.Timeout {
    const timer = setInterval(() => {
      this.send({ t: 'bind', ticket: this.ticket }, this.coordinator)
    }, 20_000)
    timer.unref?.()
    return timer
  }

  /**
   * Try to reach `deviceId` directly.
   *
   * `extra` are addresses learned some other way - the peer's local interfaces,
   * say - which cost nothing to try and are the ones that work when both
   * machines happen to be on the same network.
   */
  async attempt(deviceId: string, extra: PunchCandidate[] = []): Promise<PunchResult> {
    if (!this.socket) {
      return { ok: false, peer: null, rttMs: null, reflexive: null, reason: 'not open' }
    }

    // Asking also causes the coordinator to poke the peer, which is what makes
    // both sides start sending at the same time.
    this.send({ t: 'connect', ticket: this.ticket, target: deviceId }, this.coordinator)
    const answer = await this.wait(
      (message) => message.t === 'peer' || message.t === 'no-peer' || message.t === 'error',
      4000
    )

    if (!answer || answer.message.t !== 'peer') {
      const reason =
        answer?.message.t === 'no-peer'
          ? 'that machine is not checked in with the coordinator right now'
          : (answer?.message.error ?? 'the coordinator did not answer')
      return { ok: false, peer: null, rttMs: null, reflexive: this.reflexive, reason }
    }

    const candidates: PunchCandidate[] = [
      { address: String(answer.message.address), port: Number(answer.message.port) },
      ...extra
    ]

    const nonce = Math.random().toString(36).slice(2)
    const startedAt = Date.now()

    // Answer any probe that arrives while we are sending our own - the peer is
    // doing exactly this at the same moment, and either side's probe landing
    // first is a success.
    const responder = (message: Message, from: dgram.RemoteInfo): void => {
      if (message.t === 'probe') {
        this.send({ t: 'probe-ack', nonce: message.nonce }, { address: from.address, port: from.port })
      }
    }
    this.handlers.add(responder)

    const probe = setInterval(() => {
      for (const candidate of candidates) this.send({ t: 'probe', nonce }, candidate)
    }, PROBE_INTERVAL_MS)
    probe.unref?.()
    for (const candidate of candidates) this.send({ t: 'probe', nonce }, candidate)

    const landed = await this.wait(
      (message, from) =>
        (message.t === 'probe-ack' && message.nonce === nonce) ||
        (message.t === 'probe' && from.address !== this.coordinator.address),
      ATTEMPT_MS
    )

    clearInterval(probe)
    this.handlers.delete(responder)

    if (!landed) {
      return {
        ok: false,
        peer: null,
        rttMs: null,
        reflexive: this.reflexive,
        reason: 'no reply from the other machine - both routers refused to open'
      }
    }

    return {
      ok: true,
      peer: { address: landed.from.address, port: landed.from.port },
      rttMs: Date.now() - startedAt,
      reflexive: this.reflexive,
      reason: null
    }
  }

  close(): void {
    this.handlers.clear()
    try {
      this.socket?.close()
    } catch {
      // Already closed.
    }
    this.socket = null
  }
}
