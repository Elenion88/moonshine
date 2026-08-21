// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Austin

/**
 * The rendezvous: what makes two machines behind routers able to reach each
 * other at all.
 *
 * A NAT will forward a packet inward only if something inside sent one outward
 * to that address first. So neither side can be the one that "accepts" a
 * connection - both have to send at roughly the same moment, each opening the
 * mapping the other's packet needs. The hard part is not the sending; it is
 * knowing where to send and agreeing on when.
 *
 * This is the part that answers both. It is a UDP socket that:
 *
 *   1. tells a device what address its packets appear to come from, which is
 *      the one thing a machine behind a router cannot work out for itself;
 *   2. remembers that address, because the router will only hold the mapping
 *      open while traffic keeps flowing;
 *   3. when one device asks for another, tells *both* of them to start sending
 *      now - which is the synchronisation the whole technique depends on.
 *
 * No stream traffic passes through here. Once the two sides have punched
 * through, they talk directly and this service is out of the loop entirely.
 *
 * Authentication is a short-lived ticket rather than the bearer token: these
 * packets are unencrypted UDP, and putting a long-lived credential in them
 * would trade a session for a session's worth of eavesdropping.
 */

import dgram from 'node:dgram'
import { randomBytes } from 'node:crypto'

/** How long a device's mapping is treated as current. Routers expire theirs
 *  in 30 seconds upward, so anything older is probably already closed. */
const BINDING_TTL_MS = 90_000

/** Tickets are used within a second or two of being issued. */
const TICKET_TTL_MS = 60_000

interface Binding {
  deviceId: string
  userId: string
  address: string
  port: number
  lastSeen: number
}

interface Ticket {
  deviceId: string
  userId: string
  expiresAt: number
}

const bindings = new Map<string, Binding>()
const tickets = new Map<string, Ticket>()

let socket: dgram.Socket | null = null

export function issueTicket(deviceId: string, userId: string): string {
  const ticket = randomBytes(24).toString('base64url')
  tickets.set(ticket, { deviceId, userId, expiresAt: Date.now() + TICKET_TTL_MS })
  return ticket
}

function redeem(ticket: unknown): Ticket | null {
  if (typeof ticket !== 'string') return null
  const found = tickets.get(ticket)
  if (!found) return null
  if (found.expiresAt < Date.now()) {
    tickets.delete(ticket)
    return null
  }
  return found
}

function sweep(): void {
  const now = Date.now()
  for (const [key, binding] of bindings) {
    if (now - binding.lastSeen > BINDING_TTL_MS) bindings.delete(key)
  }
  for (const [key, ticket] of tickets) {
    if (ticket.expiresAt < now) tickets.delete(key)
  }
}

function reply(to: dgram.RemoteInfo, message: Record<string, unknown>): void {
  const payload = Buffer.from(JSON.stringify(message))
  socket?.send(payload, to.port, to.address)
}

function handle(raw: Buffer, from: dgram.RemoteInfo): void {
  let message: Record<string, unknown>
  try {
    message = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
  } catch {
    return // Not ours. Silence is the right answer to a stray packet.
  }

  const ticket = redeem(message.ticket)
  if (!ticket) return reply(from, { t: 'error', error: 'ticket is missing or expired' })

  if (message.t === 'bind') {
    bindings.set(ticket.deviceId, {
      deviceId: ticket.deviceId,
      userId: ticket.userId,
      address: from.address,
      port: from.port,
      lastSeen: Date.now()
    })
    // The address it appears to come from. A device behind a router cannot
    // learn this any other way without asking someone outside.
    return reply(from, { t: 'bound', address: from.address, port: from.port })
  }

  if (message.t === 'connect') {
    const targetId = String(message.target ?? '')
    const target = bindings.get(targetId)

    // Same account only. Without this check, knowing a device id would be
    // enough to have this service point a stranger at someone else's machine.
    if (!target || target.userId !== ticket.userId) {
      return reply(from, { t: 'no-peer', target: targetId })
    }
    if (Date.now() - target.lastSeen > BINDING_TTL_MS) {
      return reply(from, { t: 'no-peer', target: targetId })
    }

    // Both sides are told to start now. The one that asked gets an answer; the
    // one that did not is poked through the mapping it has been keeping open,
    // which is the only reason it can be reached at all.
    reply(from, {
      t: 'peer',
      target: targetId,
      address: target.address,
      port: target.port
    })

    const requester = bindings.get(ticket.deviceId)
    if (requester) {
      reply(
        { address: target.address, port: target.port } as dgram.RemoteInfo,
        {
          t: 'punch',
          from: ticket.deviceId,
          address: requester.address,
          port: requester.port
        }
      )
    }
    return
  }
}

export function startRendezvous(port: number): dgram.Socket {
  socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  socket.on('message', handle)
  socket.on('error', (error) => {
    console.error(`rendezvous socket error: ${error.message}`)
  })
  socket.bind(port, () => {
    console.log(`rendezvous on udp/${port}`)
  })

  const timer = setInterval(sweep, 30_000)
  timer.unref()
  return socket
}

export function stopRendezvous(): void {
  socket?.close()
  socket = null
}

/** For tests and diagnostics: how many devices are currently mapped. */
export function boundCount(): number {
  return bindings.size
}
