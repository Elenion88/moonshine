// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Austin

/**
 * The status cache: what every host's path looks like, kept fresh in the
 * background so opening the window is instant.
 *
 * The important behaviour here is the pausing, and it was bought expensively.
 * Measuring a path means pinging every online host for a few seconds each -
 * about nine seconds of continuous probing per refresh. With a tray and a
 * window on each of two machines, four independent timers staggered against
 * each other put that on top of a live stream every thirty seconds or so.
 *
 * The symptom was picture and audio alternating clean and rough in 11-26 second
 * stretches, in both directions. It was not the network, the WiFi, the codec or
 * the audio tap. It was this software measuring the link it was streaming over.
 *
 * So refreshing pauses while a session is live. An explicit refresh still
 * measures, on the principle that a button the user pressed should do the thing
 * they pressed it for.
 */

import { EventEmitter } from 'node:events'

import { hiddenHosts } from './paths'
import { sessionActive } from './session'
import {
  type Health,
  type PathReport,
  type Peer,
  health,
  jitter,
  measurePath,
  median,
  peers,
  worst
} from './tailscale'

/** Quiet-time refresh interval. */
const REFRESH_MS = 60_000

/** Poll interval while a session is live - short, so status catches up quickly. */
const SESSION_POLL_MS = 15_000

export interface HostStatus {
  name: string
  hostname: string
  os: string
  ip: string
  online: boolean
  health: Health
  median: number | null
  jitter: number | null
  worst: number | null
  direct: boolean
  relay: string | null
  measuredAt: number | null
}

export interface StatusSnapshot {
  hosts: HostStatus[]
  overall: Health
  sessionLive: boolean
  refreshing: boolean
  measuredAt: number | null
  error: string | null
}

function toStatus(peer: Peer, report: PathReport | null): HostStatus {
  const relayed = report
    ? (report.samples.findLast(([route]) => route.startsWith('DERP'))?.[0] ?? null)
    : null
  return {
    name: peer.name,
    hostname: peer.hostname,
    os: peer.os,
    ip: peer.ip,
    online: peer.online,
    health: health(report, peer.online),
    median: report ? median(report) : null,
    jitter: report ? jitter(report) : null,
    worst: report ? worst(report) : null,
    direct: report !== null && !report.unreachable && relayed === null,
    relay: relayed,
    measuredAt: report ? Date.now() : null
  }
}

/**
 * Worst-first, because the icon carries one colour and a problem anywhere is
 * the thing worth knowing about.
 */
function overallHealth(hosts: HostStatus[]): Health {
  const usable = hosts.filter((host) => host.online)
  if (usable.length === 0) return 'offline'
  if (usable.some((host) => host.health === 'relayed')) return 'relayed'
  if (usable.some((host) => host.health === 'degraded')) return 'degraded'
  if (usable.some((host) => host.health === 'ok')) return 'ok'
  return 'offline'
}

export class StatusCache extends EventEmitter {
  private snapshot: StatusSnapshot = {
    hosts: [],
    overall: 'offline',
    sessionLive: false,
    refreshing: false,
    measuredAt: null,
    error: null
  }

  private timer: NodeJS.Timeout | null = null
  private running = false

  current(): StatusSnapshot {
    return this.snapshot
  }

  start(): void {
    if (this.timer) return
    void this.refresh(false)
    this.schedule()
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    const delay = this.snapshot.sessionLive ? SESSION_POLL_MS : REFRESH_MS
    this.timer = setTimeout(() => {
      void this.refresh(false).finally(() => this.schedule())
    }, delay)
  }

  private emitSnapshot(next: Partial<StatusSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next }
    this.emit('change', this.snapshot)
  }

  /**
   * @param manual true when a person pressed Refresh, which measures even
   *   during a session. Automatic refreshes never do.
   */
  async refresh(manual: boolean): Promise<StatusSnapshot> {
    if (this.running) return this.snapshot
    this.running = true
    this.emitSnapshot({ refreshing: true })

    try {
      const live = await sessionActive()

      // Peer listing is cheap - it reads local state and sends no packets - so
      // the host list stays current even mid-session. Only the pinging stops.
      const hidden = await hiddenHosts()
      const visible = (await peers()).filter((peer) => !hidden.has(peer.name))

      if (live && !manual) {
        const hosts = visible.map((peer) => {
          const previous = this.snapshot.hosts.find((host) => host.name === peer.name)
          return previous ? { ...previous, online: peer.online } : toStatus(peer, null)
        })
        this.emitSnapshot({
          hosts,
          overall: overallHealth(hosts),
          sessionLive: true,
          refreshing: false,
          error: null
        })
        return this.snapshot
      }

      const online = visible.filter((peer) => peer.online)
      const reports = await Promise.all(
        online.map(async (peer) => [peer.name, await measurePath(peer.name, 6)] as const)
      )
      const byName = new Map(reports)

      const hosts = visible.map((peer) => toStatus(peer, byName.get(peer.name) ?? null))
      this.emitSnapshot({
        hosts,
        overall: overallHealth(hosts),
        sessionLive: live,
        refreshing: false,
        measuredAt: Date.now(),
        error: null
      })
    } catch (error) {
      this.emitSnapshot({
        refreshing: false,
        error: error instanceof Error ? error.message : String(error)
      })
    } finally {
      this.running = false
    }

    return this.snapshot
  }
}
