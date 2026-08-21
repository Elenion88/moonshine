// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Austin

/**
 * The shapes that cross the bridge.
 *
 * Mirrored from `src/main/core` rather than imported: the renderer compiles
 * against DOM libs and the main process against Node's, so they are separate
 * TypeScript projects on purpose. Anything added on one side has to be added
 * here too - which is the point, because it makes widening the bridge a
 * deliberate act.
 */

export type Health = 'ok' | 'degraded' | 'relayed' | 'offline'

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

export interface Profile {
  id: string
  label: string
  description: string
  fps: number
  bitrate: number
  resolution: string
  displayMode: 'windowed' | 'fullscreen' | 'borderless'
  flags: string[]
}

export interface ConnectResult {
  started: boolean
  reason?: string
  pathSummary?: string
  target?: string
  logPath?: string
}

export interface SessionLog {
  name: string
  path: string
  modified: number
  size: number
}

export type CheckState = 'ok' | 'warn' | 'bad' | 'info'

export interface Check {
  id: string
  label: string
  state: CheckState
  detail: string
  command?: string
  action?: { id: string; label: string }
  note?: string
}

export interface SetupReport {
  platform: string
  checks: Check[]
  ready: boolean
}

export interface ActionResult {
  ok: boolean
  message: string
}

export interface AppInfo {
  name: string
  subtitle: string
  version: string
  platform: string
  shortcuts: Array<[string, string]>
}

export interface MoonshineApi {
  info(): Promise<AppInfo>
  status: {
    get(): Promise<StatusSnapshot>
    refresh(): Promise<StatusSnapshot>
    subscribe(handler: (snapshot: StatusSnapshot) => void): () => void
  }
  hosts: {
    profiles(os: string): Promise<Profile[]>
    hide(host: string, hidden: boolean): Promise<void>
  }
  profiles: { all(): Promise<Profile[]> }
  session: {
    connect(request: {
      host: string
      os: string
      profile: string
      app?: string
      overlay?: boolean
      force?: boolean
    }): Promise<ConnectResult>
  }
  setup: {
    checks(): Promise<SetupReport>
    action(id: string): Promise<ActionResult>
  }
  logs: {
    recent(): Promise<SessionLog[]>
    open(path?: string): Promise<string>
    reveal(path: string): Promise<void>
  }
}

declare global {
  interface Window {
    moonshine: MoonshineApi
  }
}
