// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Austin

/**
 * How two machines find and reach each other.
 *
 * Tailscale was the only answer for most of this project's life, and the code
 * assumed it everywhere - discovery, addressing and measurement were all
 * `tailscale` shelling out to `tailscale`. That was fine while it was the only
 * way in, and wrong the moment it stopped being.
 *
 * A transport is three things: it finds hosts, it says what address to hand the
 * stream client, and it measures the path. Everything above this file works in
 * those terms, so adding a way to connect means adding a file here rather than
 * editing the app.
 *
 * Four exist. The account one is the answer to "what about someone who has
 * never heard of Tailscale": sign in on two machines and they find each other
 * through our coordinator, which holds a device registry and nothing else.
 *
 * What is still missing from it is NAT traversal. The coordinator exchanges
 * addresses; it does not punch holes and it does not relay. So the account
 * transport reaches peers on the same network, and peers that are reachable at
 * the address they reported, and not yet anything behind two NATs.
 */

import net from 'node:net'

import { knownPeers } from './account'
import { NVSTREAM_SERVICE, browse } from './mdns'
import { loadConfig, saveConfig } from './paths'
import {
  FRAME_MS,
  SUNSHINE_PORT,
  type Health,
  type PathReport,
  isDirect,
  jitter,
  lanEndpoint,
  measurePath,
  median,
  peers,
  portOpen,
  relayName,
  worst
} from './tailscale'

export type TransportId = 'tailscale' | 'lan' | 'manual' | 'account'

export interface Candidate {
  transport: TransportId
  /** The address to hand the stream client. */
  address: string
  /** The name a person recognises this machine by. */
  name: string
  os: string
  online: boolean
}

/**
 * How a route's timing was obtained, because the two are not comparable and
 * pretending otherwise produces confident nonsense.
 *
 * `icmp` is a tailnet ping: a real round trip, directly comparable to a frame
 * budget. `connect` is the time to complete a TCP handshake against Sunshine's
 * port, which is one round trip *plus* however long the server takes to accept
 * - unbounded, not ours to measure, and in practice several times the RTT.
 */
export type Method = 'icmp' | 'connect'

export interface Route extends Candidate {
  method: Method
  /** Sunshine answered on this address. Without it there is nothing to stream. */
  streamable: boolean
  label: string
  report: PathReport | null
  health: Health
  median: number | null
  jitter: number | null
  worst: number | null
  direct: boolean
  relay: string | null
}

export const TRANSPORT_LABELS: Record<TransportId, string> = {
  tailscale: 'Tailscale',
  lan: 'Local network',
  manual: 'Saved address',
  account: 'Your account'
}

/**
 * Time TCP connects as a latency proxy where there is no tunnel to ping.
 *
 * Not comparable to an ICMP round trip - a connect is a handshake plus an
 * accept - but it is measured against the exact port the stream uses, and the
 * spread across samples is what actually matters for judging jitter.
 */
async function measureConnects(address: string, count: number): Promise<PathReport> {
  const report: PathReport = { host: address, samples: [], unreachable: false }

  for (let i = 0; i < count; i += 1) {
    const started = performance.now()
    const open = await portOpen(address, SUNSHINE_PORT, 3000)
    if (open) report.samples.push(['direct', Math.round(performance.now() - started)])
  }

  report.unreachable = report.samples.length === 0
  return report
}

// --------------------------------------------------------------------------
// Tailscale
// --------------------------------------------------------------------------

async function discoverTailscale(): Promise<Candidate[]> {
  const found: Candidate[] = []
  for (const peer of await peers()) {
    // Prefer the LAN address when the host is on this network. Same machine,
    // same session - just without userspace WireGuard in the middle, which
    // measured about 4ms and nearly all of the jitter.
    const lan = peer.online ? await lanEndpoint(peer) : null
    found.push({
      transport: 'tailscale',
      address: lan ?? peer.name,
      name: peer.name,
      os: peer.os,
      online: peer.online
    })
  }
  return found
}

// --------------------------------------------------------------------------
// The local network
// --------------------------------------------------------------------------

/**
 * Sunshine advertises itself over mDNS, which is how Moonlight finds hosts
 * without being told an address. Nothing about this needs Tailscale, an
 * account, or the internet - two machines on the same wifi is the whole
 * requirement, and it is the fastest path there is.
 */
async function discoverLan(): Promise<Candidate[]> {
  const found: Candidate[] = []
  for (const instance of await browse(NVSTREAM_SERVICE)) {
    const address = instance.addresses[0]
    if (!address) continue
    found.push({
      transport: 'lan',
      address,
      // Sunshine advertises whatever `sunshine_name` is set to, which is the
      // name our own branding writes - so a host we set up announces itself
      // under the name we gave it.
      name: instance.name || instance.target.replace(/\.local$/, ''),
      // mDNS does not say. Unknown is honest, and the profile list falls back
      // to the general pair rather than guessing macOS.
      os: '',
      online: true
    })
  }
  return found
}

// --------------------------------------------------------------------------
// The account
// --------------------------------------------------------------------------

/**
 * Peers the coordinator told us about, at every address they reported.
 *
 * One candidate per address rather than one per peer, because which of them
 * works is not knowable without trying: a peer on the same network answers on
 * its local address, one behind a router answers on its observed address only
 * if something forwarded the port, and measuring is how we find out. They
 * collapse into one host with several routes, and the ranking picks.
 */
function discoverAccount(): Candidate[] {
  const found: Candidate[] = []

  for (const peer of knownPeers()) {
    const addresses = [
      ...peer.endpoints.filter((endpoint) => endpoint.kind === 'local').map((e) => e.address),
      ...(peer.observedIp ? [peer.observedIp] : [])
    ]

    for (const address of [...new Set(addresses)].slice(0, 4)) {
      found.push({
        transport: 'account',
        address,
        name: peer.name,
        os: peer.os,
        // Online here means "checked in recently", which is a claim about the
        // coordinator's view, not about whether we can reach it. Measurement
        // is what settles that.
        online: peer.online
      })
    }
  }
  return found
}

// --------------------------------------------------------------------------
// Saved addresses
// --------------------------------------------------------------------------

export interface ManualHost {
  name: string
  address: string
  os?: string
}

async function discoverManual(): Promise<Candidate[]> {
  const config = await loadConfig()
  const saved = (config.manual as ManualHost[] | undefined) ?? []
  const found: Candidate[] = []

  for (const entry of saved) {
    if (!entry?.address) continue
    // A saved address is only useful if something is listening, and checking is
    // one connect. Offline is a real state worth showing, not a reason to hide.
    const reachable = await portOpen(entry.address, SUNSHINE_PORT, 1500)
    found.push({
      transport: 'manual',
      address: entry.address,
      name: entry.name || entry.address,
      os: entry.os ?? '',
      online: reachable
    })
  }
  return found
}

export async function addManualHost(host: ManualHost): Promise<void> {
  const config = await loadConfig()
  const saved = (config.manual as ManualHost[] | undefined) ?? []
  const rest = saved.filter(
    (entry) => entry.address.toLowerCase() !== host.address.toLowerCase()
  )
  config.manual = [...rest, host]
  await saveConfig(config)
}

export async function removeManualHost(address: string): Promise<void> {
  const config = await loadConfig()
  const saved = (config.manual as ManualHost[] | undefined) ?? []
  config.manual = saved.filter(
    (entry) => entry.address.toLowerCase() !== address.toLowerCase()
  )
  await saveConfig(config)
}

// --------------------------------------------------------------------------

/**
 * Drop candidates that are literally the same path found twice.
 *
 * Tailscale already prefers a peer's LAN address when it has one, so its route
 * and the one mDNS advertises are often the same address - and measuring the
 * same socket twice to list it twice is noise, not choice. The first candidate
 * wins, which is Tailscale's, because it is the one that knows the operating
 * system.
 */
function dedupe(candidates: Candidate[]): Candidate[] {
  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    const key = `${candidate.name.toLowerCase()}|${candidate.address.toLowerCase()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export async function discoverAll(): Promise<Candidate[]> {
  // In parallel, and never letting one failure take the others down: a machine
  // with no Tailscale should still see its LAN, and a machine with no multicast
  // route should still see its tailnet.
  const results = await Promise.allSettled([
    discoverTailscale(),
    discoverLan(),
    discoverManual(),
    // Already in memory - the heartbeat keeps it current on its own timer -
    // so this costs nothing and cannot fail.
    Promise.resolve(discoverAccount())
  ])
  return dedupe(
    results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
  )
}

export async function measure(candidate: Candidate, count: number): Promise<Route> {
  const label = TRANSPORT_LABELS[candidate.transport]

  if (!candidate.online) {
    return {
      ...candidate,
      method: 'connect',
      streamable: false,
      label,
      report: null,
      health: 'offline',
      median: null,
      jitter: null,
      worst: null,
      direct: false,
      relay: null
    }
  }

  // Only Tailscale can be relayed, so only Tailscale needs the relay check.
  // Everything else is by definition a direct address - if it answers at all,
  // there is nothing in the middle to be routed around.
  const pingable = candidate.transport === 'tailscale' && !net.isIP(candidate.address)
  const method: Method = pingable ? 'icmp' : 'connect'
  const report = pingable
    ? await measurePath(candidate.name, count)
    : await measureConnects(candidate.address, Math.min(count, 6))

  const direct = !report.unreachable && isDirect(report)
  const mid = median(report)
  const spread = jitter(report)

  // The frame budget is a statement about round-trip latency, so it is only
  // applied to a round-trip measurement. A connect time carries the server's
  // accept latency inside it - a healthy LAN host measured 19ms by connect and
  // 7ms by ping, and calling that "above one frame" was simply wrong.
  //
  // What a connect *can* say is whether the path is unstable, because the
  // spread across samples is not inflated by a constant overhead the way the
  // median is. So jitter is what judges a connect-measured route.
  const degraded =
    method === 'icmp'
      ? mid !== null && mid > FRAME_MS
      : spread !== null && spread > FRAME_MS

  const health: Health = report.unreachable
    ? 'offline'
    : !direct
      ? 'relayed'
      : degraded
        ? 'degraded'
        : 'ok'

  // Reachable is not the same as streamable. A phone on the tailnet answers a
  // ping perfectly well and hosts nothing - and offering it a Start button was
  // how a Moonlight process ended up running against an Android device, failing,
  // and sitting in its own host picker for hours.
  //
  // A connect-measured route already proved this by answering on Sunshine's
  // port. A pinged one has to be asked separately.
  const streamable = pingable
    ? !report.unreachable && (await portOpen(candidate.address, SUNSHINE_PORT, 1500))
    : !report.unreachable

  return {
    ...candidate,
    method,
    streamable,
    label,
    report,
    health,
    median: mid,
    jitter: jitter(report),
    worst: worst(report),
    direct,
    relay: relayName(report)
  }
}

/**
 * Rank routes to the same machine, best first.
 *
 * Health decides first: a relayed path is worse than any direct one no matter
 * how it times, because the relay is the thing that will stutter.
 *
 * Then the local network wins outright, and that is a deliberate rule rather
 * than a measurement. The two numbers are not comparable - a tailnet route is
 * timed with ICMP through the tunnel, a local one by TCP connects, and a
 * connect is a handshake plus an accept, so it reads slower than the path
 * actually is. Ranking them against each other by raw median would penalise the
 * faster route for being measured more honestly.
 *
 * There is no need to guess. When a machine answers on the local network, the
 * packets have less to go through than the same packets tunnelled: no userspace
 * WireGuard, no encryption, no relay to fall back to. Measured against one
 * machine reachable both ways, the tunnel cost about 4ms and nearly all of the
 * jitter. Prefer it and say why.
 *
 * Only then does the median break ties, between routes measured the same way.
 */
export function rank(routes: Route[]): Route[] {
  const health = (route: Route): number => {
    if (route.health === 'offline') return 3
    if (route.health === 'relayed') return 2
    return route.health === 'degraded' ? 1 : 0
  }
  // Nothing else is ordered here: a saved address may be across the internet,
  // so it gets no advantage over a tailnet route it cannot be compared with.
  const locality = (route: Route): number => (route.transport === 'lan' ? 0 : 1)

  return [...routes].sort((a, b) => {
    const byHealth = health(a) - health(b)
    if (byHealth !== 0) return byHealth
    const byLocality = locality(a) - locality(b)
    if (byLocality !== 0) return byLocality
    return (a.median ?? Infinity) - (b.median ?? Infinity)
  })
}
