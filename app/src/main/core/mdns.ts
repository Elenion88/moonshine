// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Austin

/**
 * Just enough mDNS to find Sunshine on the local network.
 *
 * Sunshine advertises `_nvstream._tcp` over multicast DNS - it is how Moonlight
 * finds hosts without being told an address - so discovering them needs no
 * subnet scanning, no port sweeping and no cooperation from Tailscale.
 *
 * This is written out rather than pulled from a package because the query is
 * one packet and the reply is one well-specified format. A dependency here
 * would be about 3,000 lines to send 34 bytes and read a few records, and
 * dependencies in this project have to be load-bearing.
 *
 * What it does not do: caching, continuous browsing, conflict resolution,
 * IPv6, or unicast responses. It asks once, listens briefly, and returns what
 * answered. That is the whole requirement.
 */

import dgram from 'node:dgram'

const MULTICAST_ADDRESS = '224.0.0.251'
const MULTICAST_PORT = 5353

const TYPE_A = 1
const TYPE_PTR = 12
const TYPE_TXT = 16
const TYPE_SRV = 33

export interface ServiceInstance {
  /** The instance name, e.g. "tower" from "tower._nvstream._tcp.local". */
  name: string
  /** The advertised host name, e.g. "tower.local". */
  target: string
  port: number
  /** IPv4 addresses that arrived in the same response. */
  addresses: string[]
}

function encodeName(name: string): Buffer {
  const parts = name.split('.').filter(Boolean)
  const chunks: Buffer[] = []
  for (const part of parts) {
    const label = Buffer.from(part, 'utf8')
    chunks.push(Buffer.from([label.length]), label)
  }
  chunks.push(Buffer.from([0]))
  return Buffer.concat(chunks)
}

function query(service: string): Buffer {
  const header = Buffer.alloc(12)
  // id 0: mDNS responses are multicast to everyone, so there is nothing to
  // correlate a reply against. Flags 0 is a standard query.
  header.writeUInt16BE(1, 4) // one question
  const question = Buffer.concat([
    encodeName(service),
    Buffer.from([0x00, TYPE_PTR, 0x00, 0x01]) // PTR, IN
  ])
  return Buffer.concat([header, question])
}

interface Reader {
  buffer: Buffer
  offset: number
}

/**
 * Read a DNS name, following compression pointers.
 *
 * Pointers are the reason this cannot be a naive parser: a response repeats
 * long names constantly and every repeat is a two-byte back-reference, so a
 * reader that does not follow them sees garbage from the second record on.
 */
function readName(reader: Reader): string {
  const parts: string[] = []
  let offset = reader.offset
  let jumped = false
  // A malformed packet can point in a loop; this is the guard against it.
  let hops = 0

  for (;;) {
    if (offset >= reader.buffer.length || hops > 64) break
    const length = reader.buffer[offset] as number

    if ((length & 0xc0) === 0xc0) {
      const pointer = ((length & 0x3f) << 8) | (reader.buffer[offset + 1] as number)
      if (!jumped) reader.offset = offset + 2
      offset = pointer
      jumped = true
      hops += 1
      continue
    }

    offset += 1
    if (length === 0) break
    parts.push(reader.buffer.subarray(offset, offset + length).toString('utf8'))
    offset += length
  }

  if (!jumped) reader.offset = offset
  return parts.join('.')
}

interface Record {
  name: string
  type: number
  data: Buffer
  reader: Reader
  dataOffset: number
}

function parse(buffer: Buffer): Record[] {
  if (buffer.length < 12) return []
  const reader: Reader = { buffer, offset: 12 }

  const counts = {
    questions: buffer.readUInt16BE(4),
    answers: buffer.readUInt16BE(6),
    authorities: buffer.readUInt16BE(8),
    additionals: buffer.readUInt16BE(10)
  }

  for (let i = 0; i < counts.questions; i += 1) {
    readName(reader)
    reader.offset += 4
  }

  const total = counts.answers + counts.authorities + counts.additionals
  const records: Record[] = []
  for (let i = 0; i < total; i += 1) {
    if (reader.offset + 10 > buffer.length) break
    const name = readName(reader)
    const type = buffer.readUInt16BE(reader.offset)
    const length = buffer.readUInt16BE(reader.offset + 8)
    const dataOffset = reader.offset + 10
    if (dataOffset + length > buffer.length) break
    records.push({
      name,
      type,
      data: buffer.subarray(dataOffset, dataOffset + length),
      reader,
      dataOffset
    })
    reader.offset = dataOffset + length
  }
  return records
}

/**
 * Ask for a service and collect what answers within `timeoutMs`.
 *
 * Resolves rather than rejects when the socket cannot be set up - no multicast
 * route, a firewall, a machine with no network - because "nothing on the LAN"
 * is a normal answer and should not be an error the UI has to handle.
 */
export function browse(service: string, timeoutMs = 2500): Promise<ServiceInstance[]> {
  return new Promise((resolve) => {
    const instances = new Map<string, ServiceInstance>()
    const addresses = new Map<string, string[]>()
    let socket: dgram.Socket

    const finish = (): void => {
      try {
        socket.close()
      } catch {
        // Already closed, or never opened. Either way there is nothing to do.
      }
      // A record only tells us the address of a *host name*, so the join to an
      // instance happens here, once everything has arrived.
      for (const instance of instances.values()) {
        instance.addresses = addresses.get(instance.target) ?? []
      }
      resolve([...instances.values()].filter((instance) => instance.addresses.length > 0))
    }

    try {
      socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    } catch {
      resolve([])
      return
    }

    const timer = setTimeout(finish, timeoutMs)
    timer.unref?.()

    socket.on('error', () => {
      clearTimeout(timer)
      finish()
    })

    socket.on('message', (message) => {
      for (const record of parse(message)) {
        if (record.type === TYPE_SRV && record.name.endsWith(service)) {
          const sub: Reader = { buffer: record.reader.buffer, offset: record.dataOffset + 6 }
          instances.set(record.name, {
            name: record.name.slice(0, -(service.length + 1)),
            target: readName(sub),
            port: record.data.readUInt16BE(4),
            addresses: []
          })
        } else if (record.type === TYPE_A && record.data.length === 4) {
          const address = [...record.data].join('.')
          const list = addresses.get(record.name) ?? []
          if (!list.includes(address)) list.push(address)
          addresses.set(record.name, list)
        }
        // PTR and TXT are parsed past but unused: the instance name comes from
        // the SRV record's own name, and Sunshine's TXT carries nothing we need.
        void TYPE_PTR
        void TYPE_TXT
      }
    })

    socket.bind(0, () => {
      try {
        socket.setMulticastTTL(255)
        socket.send(query(service), MULTICAST_PORT, MULTICAST_ADDRESS, (error) => {
          if (error) {
            clearTimeout(timer)
            finish()
          }
        })
      } catch {
        clearTimeout(timer)
        finish()
      }
    })
  })
}

/** Sunshine's service type. Moonlight browses for exactly this. */
export const NVSTREAM_SERVICE = '_nvstream._tcp.local'
