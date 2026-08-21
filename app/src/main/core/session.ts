// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Austin

/**
 * Starting a stream, recording it, and knowing when one is live.
 *
 * The gate is the point: never start a session over a relay by accident.
 * Streaming over a relay stutters regardless of encoder settings, and no amount
 * of bitrate makes up for a path through another city.
 */

import { existsSync, readFileSync } from 'node:fs'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { NAME } from './brand'
import { findBinary, spawnDetached } from './exec'
import { sessionMarkerPath, sessionsDir, stateDir } from './paths'
import { COMMON_FLAGS, PROFILES, type Profile } from './profiles'
import {
  SUNSHINE_PORT,
  describePath,
  isDirect,
  isIpLiteral,
  lanEndpoint,
  measurePath,
  peers,
  portOpen,
  relayName
} from './tailscale'
import { mkdirSync } from 'node:fs'

/**
 * Order matters. The macOS app bundle must come before Homebrew's `moonlight`,
 * which is only a symlink into it: Qt resolves its plugin directory relative to
 * the executable path, so launching through the symlink makes it look in the
 * wrong place and die instantly. `pair` and `list` survive that because they
 * never start the GUI - only `stream` does.
 *
 * This list disappears entirely when the stream client becomes ours.
 */
export const MOONLIGHT_CANDIDATES = [
  '/Applications/Moonlight.app/Contents/MacOS/Moonlight',
  'C:\\Program Files\\Moonlight Game Streaming\\Moonlight.exe',
  '/opt/homebrew/bin/moonlight',
  '/usr/local/bin/moonlight'
]

const SUNSHINE_LOGS = [
  'C:\\Program Files\\Sunshine\\config\\sunshine.log',
  join(homedir(), '.config', 'sunshine', 'sunshine.log')
]

const SESSION_MARKER_RE = /CLIENT (CONNECTED|DISCONNECTED)/g

/**
 * A marker older than this is stale rather than live.
 *
 * The marker is removed in a finally block, so it normally outlives its session
 * by milliseconds - but a process killed outright never gets there, and a stale
 * marker would suppress status refreshes forever.
 */
const MARKER_MAX_AGE_MS = 12 * 60 * 60 * 1000

export interface ConnectRequest {
  host: string
  os: string
  app?: string
  profile: string
  overlay?: boolean
  force?: boolean
  noLan?: boolean
}

export interface ConnectResult {
  started: boolean
  reason?: string
  pathSummary?: string
  target?: string
  logPath?: string
}

export async function markSession(active: boolean): Promise<void> {
  const path = sessionMarkerPath()
  try {
    if (active) {
      mkdirSync(stateDir(), { recursive: true })
      await writeFile(path, new Date().toISOString(), 'utf8')
    } else {
      await unlink(path)
    }
  } catch {
    // Best effort. A missing marker means "no session", which is the safe
    // answer, and failing to write one must never stop a stream from starting.
  }
}

/** True if Sunshine on this machine currently has a client connected. */
export function hostSessionActive(): boolean {
  for (const path of SUNSHINE_LOGS) {
    if (!existsSync(path)) continue
    try {
      // Only the tail matters, and these logs grow without bound.
      const text = readFileSync(path, 'utf8').slice(-200_000)
      const markers = [...text.matchAll(SESSION_MARKER_RE)].map((match) => match[1])
      if (markers.at(-1) === 'CONNECTED') return true
    } catch {
      continue
    }
  }
  return false
}

/**
 * True if this machine is either end of a live session.
 *
 * Two checks, because a machine can be either end. The marker covers sessions
 * this app started; Sunshine's log covers sessions where this machine is the
 * host, including ones started from somewhere else entirely.
 *
 * Note what is deliberately *not* here: "is Moonlight running". Moonlight
 * lingers for hours after a session ends - three processes were once still
 * resident holding 60-90 MB each - so process name reports a session almost
 * permanently.
 */
export async function sessionActive(): Promise<boolean> {
  try {
    const stamp = await readFile(sessionMarkerPath(), 'utf8')
    const age = Date.now() - Date.parse(stamp)
    if (Number.isFinite(age) && age >= 0 && age < MARKER_MAX_AGE_MS) return true
  } catch {
    // No marker. Fall through to the host-side check.
  }
  return hostSessionActive()
}

function buildArgs(target: string, app: string, profile: Profile, overlay: boolean): string[] {
  const args = ['stream', target, app, ...COMMON_FLAGS, ...profile.flags]
  args.push('--resolution', profile.resolution)
  args.push('--fps', String(profile.fps))
  args.push('--bitrate', String(profile.bitrate))
  args.push('--display-mode', profile.displayMode)
  if (overlay) args.push('--performance-overlay')
  return args
}

function logName(host: string, profile: string): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${stamp}-${host.replace(/\./g, '_')}-${profile}.log`
}

/**
 * Start a session, refusing a relayed path unless forced.
 *
 * Returns rather than throws when it refuses: a blocked session is an expected
 * outcome with something to say, not an error.
 */
export async function connect(request: ConnectRequest): Promise<ConnectResult> {
  const profile = PROFILES[request.profile]
  if (!profile) return { started: false, reason: `unknown profile "${request.profile}"` }

  const app = request.app ?? 'Desktop'
  let target = request.host
  let pathSummary: string

  if (isIpLiteral(request.host)) {
    // A literal address bypasses Tailscale entirely - useful on your own LAN,
    // and the fallback for when Tailscale itself is what is broken.
    if (!(await portOpen(request.host, SUNSHINE_PORT, 2000))) {
      return {
        started: false,
        reason: `Nothing is answering Sunshine on ${request.host}:${SUNSHINE_PORT}.`
      }
    }
    pathSummary = 'direct by address, no Tailscale'
  } else {
    const report = await measurePath(request.host, 10)

    if (report.unreachable) {
      return {
        started: false,
        reason:
          `${request.host} is unreachable over Tailscale. If Tailscale is down but ` +
          'you are on the same network, connect by address instead.'
      }
    }

    pathSummary = describePath(report)

    if (!isDirect(report) && !request.force) {
      return {
        started: false,
        pathSummary,
        reason:
          `The path to ${request.host} is relayed through ${relayName(report)}, not direct. ` +
          'Streaming over a relay will stutter regardless of encoder settings.'
      }
    }

    // Prefer the LAN address when the host is on this network. Same machine,
    // same session, just without the tunnel in the middle.
    if (!request.noLan) {
      const peer = (await peers()).find((candidate) => candidate.name === request.host)
      if (peer) {
        const lan = await lanEndpoint(peer)
        if (lan) target = lan
      }
    }
  }

  const moonlight = await findBinary('moonlight', MOONLIGHT_CANDIDATES)
  const args = buildArgs(target, app, profile, request.overlay ?? false)
  const logPath = join(sessionsDir(), logName(request.host, profile.id))

  const header = [
    `host      : ${request.host}`,
    `target    : ${target}${target !== request.host ? '  (LAN-direct)' : ''}`,
    `app       : ${app}`,
    `profile   : ${profile.id}`,
    `started   : ${new Date().toISOString()}`,
    `path      : ${pathSummary}`,
    `client    : ${NAME} ${process.platform}`,
    `command   : ${moonlight} ${args.join(' ')}`,
    '',
    '--- stream client output ---',
    ''
  ].join('\n')
  await writeFile(logPath, header, 'utf8')

  await markSession(true)
  const child = spawnDetached(moonlight, args)
  child.once('exit', () => {
    void markSession(false)
  })
  child.once('error', () => {
    void markSession(false)
  })

  return { started: true, pathSummary, target, logPath }
}
