// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Austin

/**
 * The network picture: who is reachable, and how well.
 *
 * This is the reason the project exists. Tailscale prefers a direct UDP path
 * between two machines and silently falls back to a shared relay when it cannot
 * get one. Nothing surfaces that - the peer still shows as online, the internet
 * still works, and every remote desktop tool just feels bad. Measuring the path
 * before a session starts is what turns an unexplained bad feeling into a fact.
 */

import net from 'node:net'

import { findBinary, run } from './exec'

export const SUNSHINE_PORT = 47989

export const TAILSCALE_CANDIDATES = [
  'C:\\Program Files\\Tailscale\\tailscale.exe',
  '/opt/homebrew/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/usr/bin/tailscale'
]

/**
 * Latency past this reads as "direct but degraded" rather than healthy. One
 * frame at 60fps is 16.7ms, so a median above it means the path itself is
 * eating frames before the encoder has done anything wrong.
 */
export const FRAME_MS = 16.7

export type Health = 'ok' | 'degraded' | 'relayed' | 'offline'

export interface Peer {
  name: string
  hostname: string
  os: string
  online: boolean
  ip: string
  curAddr: string
}

export interface PathReport {
  host: string
  /** [route, milliseconds] in the order tailscale reported them. */
  samples: Array<[string, number]>
  unreachable: boolean
}

export async function tailscaleBinary(): Promise<string> {
  return findBinary('tailscale', TAILSCALE_CANDIDATES)
}

export async function peers(): Promise<Peer[]> {
  const ts = await tailscaleBinary()
  const result = await run(ts, ['status', '--json'], { timeoutMs: 20_000 })
  if (result.code !== 0) return []

  let data: { Peer?: Record<string, Record<string, unknown>> }
  try {
    data = JSON.parse(result.stdout)
  } catch {
    return []
  }

  const found: Peer[] = []
  for (const entry of Object.values(data.Peer ?? {})) {
    const ips = (entry.TailscaleIPs as string[] | undefined) ?? []
    found.push({
      name: String(entry.DNSName ?? '').split('.')[0] ?? '',
      hostname: String(entry.HostName ?? ''),
      os: String(entry.OS ?? ''),
      online: Boolean(entry.Online),
      ip: ips[0] ?? '',
      curAddr: String(entry.CurAddr ?? '')
    })
  }

  // Unnamed entries are shared devices that cannot be addressed by name.
  return found.filter((peer) => peer.name).sort((a, b) => a.name.localeCompare(b.name))
}

const PONG_RE = /via\s+(DERP\([a-z]+\)|[\d.]+:\d+)\s+in\s+(\d+)ms/g

/**
 * Ping a peer `count` times and summarise the route and timing.
 *
 * One `tailscale ping -c N` rather than N calls of `-c 1`: same samples, one
 * process instead of N, and it lets tailscale report the route settling from
 * relayed to direct within a single run.
 */
export async function measurePath(host: string, count = 10): Promise<PathReport> {
  const ts = await tailscaleBinary()
  const report: PathReport = { host, samples: [], unreachable: false }

  // --until-direct=false is essential. By default `tailscale ping` stops the
  // moment it establishes a direct path, so -c N returns a single sample and
  // any jitter computed from it is meaningless.
  const result = await run(ts, ['ping', '--until-direct=false', '-c', String(count), host], {
    timeoutMs: (15 + 3 * count) * 1000
  })

  if (result.timedOut) {
    report.unreachable = true
    return report
  }

  for (const match of result.stdout.matchAll(PONG_RE)) {
    report.samples.push([match[1] as string, Number(match[2])])
  }
  report.unreachable = report.samples.length === 0
  return report
}

function directSamples(report: PathReport): number[] {
  return report.samples.filter(([route]) => !route.startsWith('DERP')).map(([, ms]) => ms)
}

/** The samples worth summarising: direct ones if there are any, else all of them. */
function pool(report: PathReport): number[] {
  const direct = directSamples(report)
  return direct.length > 0 ? direct : report.samples.map(([, ms]) => ms)
}

/**
 * Direct if the path *settled* on a direct route.
 *
 * Tailscale often relays the first packets while NAT traversal completes, so
 * the tail of the run reflects the steady state and the head does not. Judging
 * by the first sample reports a relay on almost every healthy connection.
 */
export function isDirect(report: PathReport): boolean {
  const last = report.samples.at(-1)
  return last !== undefined && !last[0].startsWith('DERP')
}

export function relayName(report: PathReport): string | null {
  for (let i = report.samples.length - 1; i >= 0; i -= 1) {
    const route = report.samples[i]?.[0]
    if (route?.startsWith('DERP')) return route
  }
  return null
}

export function median(report: PathReport): number | null {
  const values = [...pool(report)].sort((a, b) => a - b)
  if (values.length === 0) return null
  const mid = Math.floor(values.length / 2)
  if (values.length % 2 === 1) return values[mid] as number
  return ((values[mid - 1] as number) + (values[mid] as number)) / 2
}

/** Sample standard deviation, matching what the Python CLI reports. */
export function jitter(report: PathReport): number | null {
  const values = pool(report)
  if (values.length < 2) return null
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

export function worst(report: PathReport): number | null {
  const values = pool(report)
  return values.length > 0 ? Math.max(...values) : null
}

export function health(report: PathReport | null, online: boolean): Health {
  if (!online || !report || report.unreachable) return 'offline'
  if (!isDirect(report)) return 'relayed'
  const mid = median(report)
  if (mid !== null && mid > FRAME_MS) return 'degraded'
  return 'ok'
}

export function describePath(report: PathReport): string {
  if (report.unreachable) return 'unreachable'
  const mid = median(report)
  const spread = jitter(report)
  const timing =
    mid === null
      ? 'no timing'
      : `${mid.toFixed(0)} ms median${spread === null ? '' : `, ${spread.toFixed(1)} ms jitter`}`
  return isDirect(report) ? `direct, ${timing}` : `relayed via ${relayName(report)}, ${timing}`
}

function isPrivate(address: string): boolean {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return false
  const [a, b] = parts as [number, number, number, number]
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  return false
}

export function isIpLiteral(value: string): boolean {
  return net.isIP(value) !== 0
}

/** Resolve within a timeout, without throwing on refusal - closed is an answer. */
export function portOpen(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    const done = (open: boolean): void => {
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
    socket.connect(port, host)
  })
}

/**
 * The peer's LAN address, when it has one and Sunshine is answering on it.
 *
 * Even on a direct path Tailscale still moves every packet through userspace
 * WireGuard. Measured against one machine reachable both ways, the tunnel cost
 * about 4ms of latency and nearly all of the jitter. Tailscale already reports
 * the LAN address it is using, so this needs no discovery of its own - only
 * that we notice and use it.
 */
export async function lanEndpoint(peer: Peer): Promise<string | null> {
  const [address] = peer.curAddr.split(':')
  if (!address || !isPrivate(address)) return null
  return (await portOpen(address, SUNSHINE_PORT, 1000)) ? address : null
}
