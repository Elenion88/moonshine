// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Austin

/**
 * Where state lives on disk.
 *
 * Deliberately the same locations the Python app uses - `%APPDATA%\moonshine`
 * and `~/.config/moonshine` - so this app inherits an existing hide list and
 * every recorded session log rather than starting empty beside them.
 */

import { existsSync, mkdirSync } from 'node:fs'
import { readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { APP_ID } from './brand'

export interface Config {
  hide?: string[]
  [key: string]: unknown
}

export function stateDir(): string {
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || homedir()
    return join(base, APP_ID)
  }
  return join(homedir(), '.config', APP_ID)
}

export function configPath(): string {
  return join(stateDir(), 'config.json')
}

export function sessionsDir(): string {
  const path = join(stateDir(), 'sessions')
  mkdirSync(path, { recursive: true })
  return path
}

/**
 * Written by whichever process owns a session, so "is a stream running" is
 * recorded rather than inferred. Guessing from process names was wrong twice:
 * Moonlight lingers for hours after a session ends.
 */
export function sessionMarkerPath(): string {
  return join(stateDir(), 'active-session')
}

export async function loadConfig(): Promise<Config> {
  try {
    return JSON.parse(await readFile(configPath(), 'utf8')) as Config
  } catch {
    // Absent or corrupt both mean the same thing: no preferences yet.
    return {}
  }
}

export async function saveConfig(config: Config): Promise<void> {
  mkdirSync(stateDir(), { recursive: true })
  await writeFile(configPath(), `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

export async function hiddenHosts(): Promise<Set<string>> {
  const config = await loadConfig()
  return new Set(config.hide ?? [])
}

export async function setHidden(host: string, hidden: boolean): Promise<void> {
  const config = await loadConfig()
  const current = new Set(config.hide ?? [])
  if (hidden) current.add(host)
  else current.delete(host)
  config.hide = [...current].sort()
  await saveConfig(config)
}

export interface SessionLog {
  name: string
  path: string
  modified: number
  size: number
}

export async function recentSessions(limit = 25): Promise<SessionLog[]> {
  const dir = sessionsDir()
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }

  const entries = await Promise.all(
    names
      .filter((name) => name.endsWith('.log'))
      .map(async (name) => {
        const path = join(dir, name)
        try {
          const info = await stat(path)
          return { name, path, modified: info.mtimeMs, size: info.size }
        } catch {
          return null
        }
      })
  )

  return entries
    .filter((entry): entry is SessionLog => entry !== null)
    .sort((a, b) => b.modified - a.modified)
    .slice(0, limit)
}

export function fileExists(path: string): boolean {
  return existsSync(path)
}
