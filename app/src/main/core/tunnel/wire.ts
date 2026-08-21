// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Austin

/**
 * The tunnel's wire format, and the encryption over it.
 *
 * A punched path is a bare UDP socket across the internet. Sunshine's own
 * protocol protects some of what runs on it and not all - the HTTP port is
 * plaintext - so carrying it unencrypted would be handing someone else's
 * network a copy of a desktop session. Everything here is sealed.
 *
 * AES-256-GCM with a key derived from an X25519 exchange, and a counter for the
 * nonce. The counter is the part worth being careful about: reusing a nonce
 * under GCM does not weaken the encryption, it destroys it - both plaintexts
 * and the authentication key fall out. So each direction gets its own counter
 * and its own key, and a sender that exhausts its counter stops rather than
 * wrapping.
 *
 * Frames are kept under a conservative MTU. A fragmented UDP datagram is lost
 * entirely if any fragment is, which for a video stream turns one dropped
 * packet into several lost frames.
 */

import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject
} from 'node:crypto'

/**
 * Payload ceiling per frame.
 *
 * 1200 leaves room for the IP and UDP headers, our own header, the GCM tag and
 * a tunnel or two along the way, inside the 1280-byte floor every path is
 * required to carry without fragmenting.
 */
export const MAX_PAYLOAD = 1100

export const FrameType = {
  /** Open a TCP stream to a port on the far side. */
  Open: 1,
  /** Bytes on an open TCP stream, in order. */
  Data: 2,
  /** The far side closed, or we are closing. */
  Close: 3,
  /** Everything up to and including this sequence number arrived. */
  Ack: 4,
  /** A datagram for a UDP port. Unreliable on purpose. */
  Datagram: 5,
  /** Liveness, and a round-trip measurement. */
  Ping: 6,
  Pong: 7
} as const

export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType]

export interface Frame {
  type: FrameTypeValue
  /** TCP stream id, or the port for a datagram. */
  id: number
  /** Sequence number for reliable frames; echo value for ping. */
  seq: number
  payload: Buffer
}

const HEADER_BYTES = 7 // type(1) + id(2) + seq(4)

export function encodeFrame(frame: Frame): Buffer {
  const buffer = Buffer.allocUnsafe(HEADER_BYTES + frame.payload.length)
  buffer.writeUInt8(frame.type, 0)
  buffer.writeUInt16BE(frame.id, 1)
  buffer.writeUInt32BE(frame.seq >>> 0, 3)
  frame.payload.copy(buffer, HEADER_BYTES)
  return buffer
}

export function decodeFrame(buffer: Buffer): Frame | null {
  if (buffer.length < HEADER_BYTES) return null
  const type = buffer.readUInt8(0) as FrameTypeValue
  if (!Object.values(FrameType).includes(type)) return null
  return {
    type,
    id: buffer.readUInt16BE(1),
    seq: buffer.readUInt32BE(3),
    payload: buffer.subarray(HEADER_BYTES)
  }
}

// --------------------------------------------------------------------------
// Keys
// --------------------------------------------------------------------------

export interface KeyPair {
  privateKey: KeyObject
  /** Raw 32-byte X25519 public key, base64 - what gets published. */
  publicKey: string
}

export function generateKeyPair(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('x25519')
  // The DER wrapper is 12 bytes of prefix on a 32-byte key. Publishing the raw
  // key keeps what the coordinator stores small and format-independent.
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(12)
  return { privateKey, publicKey: raw.toString('base64') }
}

/** PKCS8 DER, base64. The form that can be stored and read back. */
export function exportPrivateKey(pair: KeyPair): string {
  return pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
}

export function importPrivateKey(base64: string): KeyPair {
  const privateKey = createPrivateKey({
    key: Buffer.from(base64, 'base64'),
    format: 'der',
    type: 'pkcs8'
  })
  // Derive the public half rather than storing it twice and risking a pair
  // whose two halves disagree.
  const raw = createPublicKey(privateKey)
    .export({ type: 'spki', format: 'der' })
    .subarray(12)
  return { privateKey, publicKey: raw.toString('base64') }
}

function publicKeyFrom(base64: string): KeyObject {
  const raw = Buffer.from(base64, 'base64')
  if (raw.length !== 32) throw new Error('public key is not an X25519 key')
  const der = Buffer.concat([
    Buffer.from('302a300506032b656e032100', 'hex'), // SPKI prefix for X25519
    raw
  ])
  return createPublicKey({ key: der, format: 'der', type: 'spki' })
}

export interface SessionKeys {
  send: Buffer
  receive: Buffer
}

/**
 * Derive one key per direction from the shared secret.
 *
 * Two keys rather than one so that both sides can start their nonce counters at
 * zero without ever colliding. With a single key, two counters starting at the
 * same place is precisely the nonce reuse that breaks GCM.
 *
 * `initiator` decides which label is which, and both sides must agree - the one
 * that asked for the connection is the initiator.
 */
export function deriveKeys(
  privateKey: KeyObject,
  peerPublicKey: string,
  initiator: boolean
): SessionKeys {
  const shared = diffieHellman({ privateKey, publicKey: publicKeyFrom(peerPublicKey) })
  const a = Buffer.from(hkdfSync('sha256', shared, 'moonshine-tunnel', 'a->b', 32))
  const b = Buffer.from(hkdfSync('sha256', shared, 'moonshine-tunnel', 'b->a', 32))
  return initiator ? { send: a, receive: b } : { send: b, receive: a }
}

// --------------------------------------------------------------------------
// Sealing
// --------------------------------------------------------------------------

/** GCM's nonce is 12 bytes; 8 of counter is more than any session can spend. */
const NONCE_BYTES = 12
const TAG_BYTES = 16

/** Well below 2^64, and far beyond what a session could ever send. */
const MAX_COUNTER = 2n ** 48n

export class Sealer {
  private counter = 0n

  constructor(private readonly key: Buffer) {}

  seal(plaintext: Buffer): Buffer {
    if (this.counter >= MAX_COUNTER) {
      // Wrapping would reuse a nonce, which under GCM leaks both plaintexts and
      // the authentication key. Refusing is the only safe move.
      throw new Error('tunnel nonce space exhausted')
    }
    const nonce = Buffer.alloc(NONCE_BYTES)
    nonce.writeBigUInt64BE(this.counter, 4)
    this.counter += 1n

    const cipher = createCipheriv('aes-256-gcm', this.key, nonce)
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
    // nonce counter (8) || ciphertext || tag
    return Buffer.concat([nonce.subarray(4), body, cipher.getAuthTag()])
  }
}

export class Opener {
  /** Counters already accepted, to reject a replayed packet. */
  private readonly seen = new Set<bigint>()
  private highest = -1n

  constructor(private readonly key: Buffer) {}

  /** Returns null for anything that does not authenticate - including replays. */
  open(sealed: Buffer): Buffer | null {
    if (sealed.length < 8 + TAG_BYTES) return null

    const counter = sealed.readBigUInt64BE(0)
    // A 4096-packet replay window: old enough to tolerate reordering on a real
    // path, small enough that the set cannot grow without bound.
    if (counter <= this.highest - 4096n) return null
    if (this.seen.has(counter)) return null

    const nonce = Buffer.alloc(NONCE_BYTES)
    nonce.writeBigUInt64BE(counter, 4)
    const tag = sealed.subarray(sealed.length - TAG_BYTES)
    const body = sealed.subarray(8, sealed.length - TAG_BYTES)

    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, nonce)
      decipher.setAuthTag(tag)
      const plaintext = Buffer.concat([decipher.update(body), decipher.final()])

      this.seen.add(counter)
      if (counter > this.highest) this.highest = counter
      // Forget what has fallen out of the window.
      if (this.seen.size > 8192) {
        for (const value of this.seen) {
          if (value <= this.highest - 4096n) this.seen.delete(value)
        }
      }
      return plaintext
    } catch {
      // Failed authentication. Corrupt, forged, or from a different key - all
      // of which mean the same thing here.
      return null
    }
  }
}
