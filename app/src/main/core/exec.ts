// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Austin

/**
 * Running other programs, which is most of what this app does.
 *
 * Everything here is a child process: `tailscale` for the network picture,
 * Moonlight for the stream. Two things that bit the Python version and are
 * handled once, here, rather than at every call site.
 */

import { execFile, spawn } from 'node:child_process'
import type { SpawnOptions } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface RunResult {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
}

/**
 * Run a command and collect its output.
 *
 * Never rejects. A missing binary, a non-zero exit and a timeout all come back
 * as a result to inspect, because every caller here treats them the same way -
 * as "no answer", not as an exception to unwind through.
 */
export async function run(
  file: string,
  args: string[],
  options: { timeoutMs?: number; maxBuffer?: number } = {}
): Promise<RunResult> {
  const { timeoutMs = 60_000, maxBuffer = 8 * 1024 * 1024 } = options
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      timeout: timeoutMs,
      maxBuffer,
      windowsHide: true,
      encoding: 'utf8'
    })
    return { code: 0, stdout, stderr, timedOut: false }
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string
      stderr?: string
      code?: number | string
      killed?: boolean
      signal?: string | null
    }
    // execFile reports a timeout as a kill, not as an error code, so the two
    // have to be told apart by `killed` rather than by the exit status.
    const timedOut = Boolean(err.killed) && err.signal !== null
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? String(err.message ?? error),
      timedOut
    }
  }
}

/**
 * Detached launch, for things that outlive us.
 *
 * A stream should not die because the window that started it was closed, and on
 * Windows it must not inherit a console - the app is a GUI process and a
 * console window flashing up mid-launch is the kind of detail that makes
 * software feel unfinished.
 */
export function spawnDetached(
  file: string,
  args: string[],
  options: SpawnOptions = {}
): ReturnType<typeof spawn> {
  const child = spawn(file, args, {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    ...options
  })
  child.unref()
  return child
}

/**
 * The first of `candidates` that exists and is executable, else the bare name
 * for PATH to resolve.
 *
 * Full paths are tried before PATH on purpose, and the order within them
 * matters: on macOS, Homebrew's `moonlight` is a symlink into the app bundle,
 * and Qt resolves its plugin directory relative to the executable path - so
 * launching through the symlink makes it look in the wrong place and die
 * instantly. The bundle has to come first.
 *
 * PATH itself is unreliable here anyway: launchd and the Finder hand a GUI app
 * a minimal one that has neither Homebrew nor Tailscale in it.
 */
export async function findBinary(name: string, candidates: string[]): Promise<string> {
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // Next candidate. A missing tool is normal, not exceptional.
    }
  }
  return name
}
