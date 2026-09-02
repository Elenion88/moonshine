// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Austin

/**
 * Starting a stream, recording it, and knowing when one is live.
 *
 * The gate is the point: never start a session over a relay by accident.
 * Streaming over a relay stutters regardless of encoder settings, and no amount
 * of bitrate makes up for a path through another city.
 */

import { EventEmitter } from 'node:events'
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync
} from 'node:fs'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { NAME } from './brand'
import { findBinary, spawnToLog } from './exec'
import { sessionMarkerPath, sessionsDir, stateDir } from './paths'
import { COMMON_FLAGS, PROFILES, type Profile } from './profiles'
import {
  SUNSHINE_PORT,
  describePath,
  isDirect,
  isIpLiteral,
  measurePath,
  portOpen,
  relayName
} from './tailscale'
import type { TransportId } from './transport'
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
  '/usr/local/bin/moonlight',
  // Linux. Arch and Omarchy install moonlight-qt as plain `moonlight`; Debian
  // and Fedora keep the package name. Flatpak exports a wrapper.
  '/usr/bin/moonlight',
  '/usr/bin/moonlight-qt',
  '/var/lib/flatpak/exports/bin/com.moonlight_stream.Moonlight',
  join(homedir(), '.local/share/flatpak/exports/bin/com.moonlight_stream.Moonlight')
]

const SUNSHINE_LOGS = [
  'C:\\Program Files\\Sunshine\\config\\sunshine.log',
  join(homedir(), '.config', 'sunshine', 'sunshine.log')
]

const SESSION_MARKER_RE = /CLIENT (CONNECTED|DISCONNECTED)/g

/**
 * A backstop, not the test.
 *
 * Liveness is decided by whether the recorded process still exists, which is
 * exact. This only guards against a pid being reused by something unrelated
 * long after the fact - no streaming session runs for twelve hours.
 */
const MARKER_MAX_AGE_MS = 12 * 60 * 60 * 1000

/**
 * Moonlight logs plenty of transient noise while it is still going to succeed -
 * hosts going "offline", serverinfo retries. This is the one line that means it
 * has given up, and it is what separates a slow start from a dead one.
 */
const CONNECT_FAILED_RE = /Failed to connect to (.+)/

/**
 * How long to watch a new session before assuming it worked.
 *
 * Long enough for a slow host to wake up, short enough that a dead one does not
 * sit there. Moonlight does not exit when a connection fails - it drops into
 * its own host picker and waits, which is exactly how three of them ended up
 * resident for hours holding 60-90 MB each.
 */
const WATCH_MS = 45_000
const WATCH_INTERVAL_MS = 500

/** Emits `failed` when a session dies on the way up. */
export const sessions = new EventEmitter()

export interface SessionFailure {
  host: string
  reason: string
  logPath: string
}

export interface ConnectRequest {
  /** The name a person recognises, used for the log and the window title. */
  host: string
  /** What to hand the stream client. A tailnet name, or an address. */
  address: string
  transport: TransportId
  os: string
  app?: string
  profile: string
  overlay?: boolean
  force?: boolean
}

export interface ConnectResult {
  started: boolean
  reason?: string
  pathSummary?: string
  target?: string
  logPath?: string
}

/**
 * Record that a session is running, and which process owns it.
 *
 * The pid is the part that matters. An earlier version wrote only a timestamp
 * and trusted it for twelve hours, which meant one marker left behind by a
 * process that died without cleaning up silently suppressed every status
 * measurement until the next day - the app looked like it had stopped working,
 * and the reason was invisible.
 *
 * A pid can be checked. If the process that owned the session is gone, so is
 * the session, whatever the file says.
 */
export async function markSession(active: boolean, pid?: number): Promise<void> {
  const path = sessionMarkerPath()
  try {
    if (active) {
      mkdirSync(stateDir(), { recursive: true })
      const marker = { pid: pid ?? process.pid, startedAt: new Date().toISOString() }
      await writeFile(path, `${JSON.stringify(marker)}\n`, 'utf8')
    } else {
      await unlink(path)
    }
  } catch {
    // Best effort. A missing marker means "no session", which is the safe
    // answer, and failing to write one must never stop a stream from starting.
  }
}

/** True if `pid` names a process that still exists. */
function processAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission and existence checks without delivering
    // anything. It throws ESRCH when there is no such process.
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
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
    const raw = await readFile(sessionMarkerPath(), 'utf8')
    const marker = JSON.parse(raw) as { pid?: number; startedAt?: string }
    const age = Date.now() - Date.parse(marker.startedAt ?? '')
    const fresh = Number.isFinite(age) && age >= 0 && age < MARKER_MAX_AGE_MS

    if (fresh && typeof marker.pid === 'number' && processAlive(marker.pid)) return true

    // The owner is gone, so the marker is a leftover. Clear it rather than
    // re-deciding this on every refresh for the rest of the day.
    await unlink(sessionMarkerPath()).catch(() => {})
  } catch {
    // No marker, or one written in a format this version does not understand.
    // Either way the host-side check below is the better answer.
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
 * Watch a new session's log and stop it if it reports it cannot connect.
 *
 * Left alone, a refused connection is oddly quiet. Moonlight does not exit; it
 * falls back to its own host picker and sits there. The session marker stays
 * set, the app keeps believing a stream is live and stops measuring, and the
 * only sign of trouble is a line buried in a log file - so from the outside it
 * looks like clicking the button did nothing at all.
 *
 * The log is tailed for the one line that means it gave up, and the process is
 * stopped rather than left to accumulate.
 */
function watchForFailure(
  logPath: string,
  child: { kill: (signal?: NodeJS.Signals) => boolean },
  host: string
): void {
  let offset = 0
  try {
    offset = statSync(logPath).size
  } catch {
    // The header write should have created it; if not, start from the top.
  }

  const started = Date.now()
  const timer = setInterval(() => {
    if (Date.now() - started > WATCH_MS) {
      clearInterval(timer)
      return
    }

    let chunk = ''
    try {
      const size = statSync(logPath).size
      if (size > offset) {
        const handle = openSync(logPath, 'r')
        try {
          const buffer = Buffer.alloc(size - offset)
          readSync(handle, buffer, 0, buffer.length, offset)
          chunk = buffer.toString('utf8')
          offset = size
        } finally {
          closeSync(handle)
        }
      }
    } catch {
      clearInterval(timer)
      return
    }

    const match = CONNECT_FAILED_RE.exec(chunk)
    if (!match) return

    clearInterval(timer)
    try {
      child.kill()
    } catch {
      // Already gone, which is the outcome we wanted anyway.
    }
    void markSession(false)
    sessions.emit('failed', {
      host,
      reason: (match[1] ?? '').trim() || 'the stream client could not connect',
      logPath
    } satisfies SessionFailure)
  }, WATCH_INTERVAL_MS)
  timer.unref?.()
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
  const target = request.address
  let pathSummary: string

  // The gate only applies to a route that can be relayed, and only Tailscale
  // can be. A direct address either answers or it does not - there is nothing
  // in the middle to be routed around, so re-measuring it before every session
  // would spend seconds to learn what one connect already said.
  if (request.transport === 'tailscale' && !isIpLiteral(target)) {
    const report = await measurePath(target, 10)

    if (report.unreachable) {
      return {
        started: false,
        reason:
          `${request.host} is unreachable over Tailscale. If Tailscale is down but ` +
          'you are on the same network, it may still be reachable directly.'
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
  } else {
    if (!(await portOpen(target, SUNSHINE_PORT, 2000))) {
      return {
        started: false,
        reason: `Nothing is answering Sunshine on ${target}:${SUNSHINE_PORT}.`
      }
    }
    pathSummary = `direct to ${target}, no tunnel`
  }

  const moonlight = await findBinary('moonlight', MOONLIGHT_CANDIDATES)
  const args = buildArgs(target, app, profile, request.overlay ?? false)
  const logPath = join(sessionsDir(), logName(request.host, profile.id))

  const header = [
    `host      : ${request.host}`,
    `transport : ${request.transport}`,
    `target    : ${target}`,
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

  const child = spawnToLog(moonlight, args, logPath)
  if (child.pid) await markSession(true, child.pid)

  child.once('exit', () => void markSession(false))
  child.once('error', () => void markSession(false))
  watchForFailure(logPath, child, request.host)

  return { started: true, pathSummary, target, logPath }
}
