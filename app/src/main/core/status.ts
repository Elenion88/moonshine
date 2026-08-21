// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Austin

/**
 * The status cache: every machine we can reach, by every way we can reach it,
 * kept fresh in the background so opening the window is instant.
 *
 * The important behaviour here is the pausing, and it was bought expensively.
 * Measuring means probing every online host for a few seconds each - about nine
 * seconds of continuous traffic per refresh. With a tray and a window on each of
 * two machines, four independent timers staggered against each other put that on
 * top of a live stream every thirty seconds or so.
 *
 * The symptom was picture and audio alternating clean and rough in 11-26 second
 * stretches, in both directions. It was not the network, the wifi, the codec or
 * the audio tap. It was this software measuring the link it was streaming over.
 *
 * So refreshing pauses while a session is live. An explicit refresh still
 * measures, on the principle that a button someone pressed should do the thing
 * they pressed it for.
 */

import { EventEmitter } from 'node:events'

import { hiddenHosts } from './paths'
import { sessionActive } from './session'
import type { Health } from './tailscale'
import {
  type Candidate,
  type Route,
  type TransportId,
  discoverAll,
  measure,
  rank
} from './transport'

/** Quiet-time refresh interval. */
const REFRESH_MS = 60_000

/** Poll interval while a session is live - short, so status catches up quickly. */
const SESSION_POLL_MS = 15_000

export interface RouteSummary {
  transport: TransportId
  method: 'icmp' | 'connect'
  label: string
  address: string
  health: Health
  median: number | null
  direct: boolean
  relay: string | null
}

export interface HostStatus {
  name: string
  os: string
  online: boolean
  /** The best route we found, flattened for the UI. */
  transport: TransportId
  transportLabel: string
  method: 'icmp' | 'connect'
  address: string
  health: Health
  median: number | null
  jitter: number | null
  worst: number | null
  direct: boolean
  relay: string | null
  /** Every way we can reach this machine, best first. */
  routes: RouteSummary[]
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

function summarise(route: Route): RouteSummary {
  return {
    transport: route.transport,
    method: route.method,
    label: route.label,
    address: route.address,
    health: route.health,
    median: route.median,
    direct: route.direct,
    relay: route.relay
  }
}

function toStatus(routes: Route[]): HostStatus {
  const ranked = rank(routes)
  const best = ranked[0] as Route
  return {
    name: best.name,
    // mDNS does not report an operating system, so take it from whichever
    // route knows. Tailscale does; the local network does not.
    os: ranked.find((route) => route.os)?.os ?? '',
    online: ranked.some((route) => route.online),
    transport: best.transport,
    transportLabel: best.label,
    method: best.method,
    address: best.address,
    health: best.health,
    median: best.median,
    jitter: best.jitter,
    worst: best.worst,
    direct: best.direct,
    relay: best.relay,
    routes: ranked.map(summarise),
    measuredAt: Date.now()
  }
}

/**
 * Worst-first, because the tray icon carries one colour and a problem anywhere
 * is the thing worth knowing about.
 */
function overallHealth(hosts: HostStatus[]): Health {
  const usable = hosts.filter((host) => host.online)
  if (usable.length === 0) return 'offline'
  if (usable.some((host) => host.health === 'relayed')) return 'relayed'
  if (usable.some((host) => host.health === 'degraded')) return 'degraded'
  if (usable.some((host) => host.health === 'ok')) return 'ok'
  return 'offline'
}

/**
 * One machine can answer on several transports, and they are the same machine.
 *
 * Matching has to be loose, because the transports do not agree on spelling.
 * Tailscale reports the node name `macbook-air`; mDNS reports whatever Sunshine
 * was configured to announce, which is a name written for people - `MacBook
 * Air`. Comparing them literally listed one laptop twice, once with a route and
 * once without.
 *
 * So: lowercase, drop a trailing `.local`, and remove everything that is not a
 * letter or a digit. Both spellings collapse to `macbookair`.
 *
 * It is not airtight - two genuinely different machines named alike would merge
 * - but that failure is visible, as a host whose routes disagree wildly, rather
 * than silent. The alternative is asking people to reconcile duplicates by hand.
 */
function identity(candidate: Candidate): string {
  return candidate.name
    .toLowerCase()
    .replace(/\.local$/, '')
    .replace(/[^a-z0-9]/g, '')
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
  /** The refresh currently in flight, so a second caller can wait for it. */
  private running: Promise<StatusSnapshot> | null = null

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
    if (this.running) {
      // Someone pressed Refresh while a scheduled one was already running.
      // Returning the current snapshot looks like the button did nothing - and
      // during a session it is worse than that, because the scheduled run
      // deliberately measured nothing and its result is a set of placeholders.
      // Wait for it to finish, then actually measure.
      if (!manual) return this.snapshot
      await this.running.catch(() => undefined)
      return this.refresh(true)
    }

    const run = this.run(manual)
    this.running = run
    try {
      return await run
    } finally {
      this.running = null
    }
  }

  private async run(manual: boolean): Promise<StatusSnapshot> {
    this.emitSnapshot({ refreshing: true })

    try {
      const live = await sessionActive()

      // Discovery is cheap - local state and one multicast packet - so the host
      // list stays current mid-session. Only the measuring stops.
      const hidden = await hiddenHosts()
      const candidates = (await discoverAll()).filter(
        (candidate) => !hidden.has(candidate.name)
      )

      const grouped = new Map<string, Candidate[]>()
      for (const candidate of candidates) {
        const key = identity(candidate)
        grouped.set(key, [...(grouped.get(key) ?? []), candidate])
      }

      if (live && !manual) {
        const hosts = [...grouped.values()].map((group) => {
          const key = identity(group[0] as Candidate)
          const previous = this.snapshot.hosts.find(
            (host) =>
              host.name.toLowerCase().replace(/[^a-z0-9]/g, '') === key
          )
          return (
            previous ?? {
              ...toStatus(
                group.map((candidate) => ({
                  ...candidate,
                  method: 'connect' as const,
                  label: '',
                  report: null,
                  health: 'offline' as Health,
                  median: null,
                  jitter: null,
                  worst: null,
                  direct: false,
                  relay: null
                }))
              ),
              measuredAt: null
            }
          )
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

      const hosts = await Promise.all(
        [...grouped.values()].map(async (group) =>
          toStatus(await Promise.all(group.map((candidate) => measure(candidate, 6))))
        )
      )
      hosts.sort((a, b) => {
        if (a.online !== b.online) return a.online ? -1 : 1
        return a.name.localeCompare(b.name)
      })

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
    }

    return this.snapshot
  }
}
