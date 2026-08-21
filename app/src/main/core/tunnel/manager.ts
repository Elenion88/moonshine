// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Austin

/**
 * Bringing a tunnel up over a punched path, from both ends.
 *
 * The punch produces a socket. The tunnel needs that exact socket - the
 * router's mapping belongs to a source port, and opening another would throw
 * the hole away - so the two share it, and this decides which arriving datagram
 * belongs to which.
 *
 * The asymmetry is decided by who wants to watch whom. The machine starting a
 * session runs Moonlight and is the tunnel's client; the machine being watched
 * runs Sunshine and is the host. That is also what decides the direction of the
 * key derivation, so both sides have to agree, and they do: the one that asked
 * is the initiator.
 */

import type dgram from 'node:dgram'

import { Tunnel, usableLoopback } from './endpoint'
import { deriveKeys, generateKeyPair, type KeyPair } from './wire'

export interface TunnelHandle {
  tunnel: Tunnel
  /** What to hand the stream client instead of a real host address. */
  address: string
  peerDeviceId: string
}

/**
 * This machine's long-term key.
 *
 * It has to survive a restart, and an earlier version generated it per run -
 * which was quietly broken. The coordinator keeps whatever public key was last
 * published, so a restart left every peer deriving a shared secret from a key
 * this machine no longer held. The punch would succeed, the tunnel would start,
 * and every frame would fail to authenticate: a failure that looks exactly like
 * a network problem and is not one.
 *
 * Stored through the same keychain-backed encryption as the account token, so a
 * config file on its own is not an identity.
 */
let identity: KeyPair | null = null

export function localKeyPair(): KeyPair {
  identity ??= generateKeyPair()
  return identity
}

/** Adopt a previously stored key, or keep the one just generated. */
export function useKeyPair(pair: KeyPair): void {
  identity = pair
}

const tunnels = new Map<string, TunnelHandle>()

/** Punch-protocol messages are JSON; a sealed frame never begins with `{`. */
export function looksLikeTunnelFrame(datagram: Buffer): boolean {
  return datagram.length > 0 && datagram[0] !== 0x7b
}

interface OpenOptions {
  socket: dgram.Socket
  peer: { address: string; port: number }
  peerDeviceId: string
  peerPublicKey: string
  role: 'client' | 'host'
}

export async function openTunnel(options: OpenOptions): Promise<TunnelHandle> {
  const existing = tunnels.get(options.peerDeviceId)
  if (existing) return existing

  // Only the client end binds anything locally, so only it needs an address.
  const loopback = options.role === 'client' ? await usableLoopback() : undefined
  if (options.role === 'client' && !loopback) {
    throw new Error(
      'no loopback address is available for the tunnel - on macOS, add the alias ' +
        'from the Set up screen'
    )
  }

  const tunnel = new Tunnel({
    socket: options.socket,
    peer: options.peer,
    ...(loopback ? { loopback } : {}),
    // The client asked, so the client is the initiator. Getting this backwards
    // gives each side the other's key and nothing decrypts.
    keys: deriveKeys(localKeyPair().privateKey, options.peerPublicKey, options.role === 'client'),
    role: options.role
  })

  await tunnel.start()

  const handle: TunnelHandle = {
    tunnel,
    address: tunnel.address,
    peerDeviceId: options.peerDeviceId
  }
  tunnel.once('stopped', () => tunnels.delete(options.peerDeviceId))
  tunnels.set(options.peerDeviceId, handle)
  return handle
}

export function tunnelFor(peerDeviceId: string): TunnelHandle | undefined {
  return tunnels.get(peerDeviceId)
}

export function closeTunnel(peerDeviceId: string): void {
  const handle = tunnels.get(peerDeviceId)
  handle?.tunnel.stop()
  tunnels.delete(peerDeviceId)
}

export function closeAllTunnels(): void {
  for (const handle of tunnels.values()) handle.tunnel.stop()
  tunnels.clear()
}

export function activeTunnels(): TunnelHandle[] {
  return [...tunnels.values()]
}
