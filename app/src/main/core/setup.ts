// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Austin

/**
 * Setting this machine up as a stream host.
 *
 * The Python version printed this as a console report, and put real work into
 * making that console readable, because a terminal was the only surface it had.
 * It is not any more. Every check here returns structure - a state, a detail, a
 * command to copy or a button the app can press - and the UI decides how to
 * show it.
 *
 * What this deliberately does not do is grant the macOS permissions. Screen
 * Recording and Accessibility live behind TCC, which no process can grant to
 * itself or to another - not as your user, not with your password. The only
 * non-interactive path is a profile pushed by device management. Everything
 * around that one click is automated; the click is not ours to make.
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { shell } from 'electron'

import { run } from './exec'
import {
  SETTINGS_PANES,
  brandSunshine,
  encoderVerdict,
  librariesVerdict,
  macosBinary,
  restartSunshine,
  tapTrusted
} from './sunshine'
import { TAILSCALE_CANDIDATES, tailscaleBinary } from './tailscale'

export type CheckState = 'ok' | 'warn' | 'bad' | 'info'

export interface Check {
  id: string
  label: string
  state: CheckState
  detail: string
  /** A command to copy, when the fix has to be run by hand. */
  command?: string
  /** Something this app can do about it. */
  action?: { id: string; label: string }
  /** Why it matters, when that is not obvious from the detail. */
  note?: string
}

export interface SetupReport {
  platform: string
  checks: Check[]
  /** True when nothing is in a `bad` state. */
  ready: boolean
}

const TCC_DBS = [
  '/Library/Application Support/com.apple.TCC/TCC.db',
  join(homedir(), 'Library/Application Support/com.apple.TCC/TCC.db')
]

/**
 * What Sunshine needs on macOS, and what breaks without each.
 *
 * PostEvent is the subtle one: it governs posting to the HID tap, which is how
 * mouse input is injected - so losing it kills the pointer while the keyboard
 * keeps working through the session tap.
 */
const REQUIRED_TCC: Record<string, string> = {
  kTCCServiceScreenCapture: 'Screen Recording — video capture',
  kTCCServiceAccessibility: 'Accessibility — input injection',
  kTCCServicePostEvent: 'Post Event — mouse movement'
}

/**
 * Granted TCC services for a binary, or null when the databases cannot be read.
 *
 * They are usually protected. Where they can be read, this turns "I cannot
 * detect this, go and check" into an actual answer.
 */
async function tccGrants(binary: string): Promise<Record<string, number> | null> {
  const grants: Record<string, number> = {}
  let readable = false

  for (const db of TCC_DBS) {
    if (!existsSync(db)) continue
    const result = await run(
      'sqlite3',
      [db, `select service, auth_value from access where client = '${binary}';`],
      { timeoutMs: 20_000 }
    )
    if (result.code !== 0) continue
    readable = true
    for (const line of result.stdout.split('\n')) {
      const index = line.lastIndexOf('|')
      if (index === -1) continue
      const value = Number(line.slice(index + 1))
      if (!Number.isNaN(value)) grants[line.slice(0, index)] = value
    }
  }
  return readable ? grants : null
}

async function tailscaleCheck(): Promise<Check> {
  const ts = await tailscaleBinary()
  if (ts === 'tailscale' && !TAILSCALE_CANDIDATES.some((path) => existsSync(path))) {
    return {
      id: 'tailscale',
      label: 'Tailscale',
      state: 'bad',
      detail: 'not found',
      command:
        process.platform === 'win32'
          ? 'winget install tailscale.tailscale'
          : 'brew install --cask tailscale'
    }
  }

  const status = await run(ts, ['status', '--json'], { timeoutMs: 20_000 })
  if (status.code !== 0) {
    return {
      id: 'tailscale',
      label: 'Tailscale',
      state: 'bad',
      detail: 'installed, but not signed in or not running',
      command: 'tailscale up'
    }
  }
  return { id: 'tailscale', label: 'Tailscale', state: 'ok', detail: 'signed in' }
}

async function windowsChecks(): Promise<Check[]> {
  const checks: Check[] = []

  const service = await run(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      "(Get-Service SunshineService -ErrorAction SilentlyContinue).Status"
    ],
    { timeoutMs: 30_000 }
  )
  const status = service.stdout.trim()

  if (!status) {
    checks.push({
      id: 'sunshine',
      label: 'Sunshine',
      state: 'bad',
      detail: 'not installed',
      command: 'winget install LizardByte.Sunshine'
    })
    return checks
  }

  checks.push(
    status === 'Running'
      ? { id: 'sunshine', label: 'Sunshine', state: 'ok', detail: 'service running' }
      : {
          id: 'sunshine',
          label: 'Sunshine',
          state: 'warn',
          detail: `service is ${status}`,
          action: { id: 'sunshine:restart', label: 'Start it' }
        }
  )

  // The firewall is the difference between "reachable from my tailnet" and
  // "reachable from the coffee shop's wifi". Worth checking on every setup,
  // because a Sunshine update rewrites the rule.
  const firewall = await run(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      "(Get-NetFirewallRule -DisplayName 'Sunshine' | Get-NetFirewallAddressFilter).RemoteAddress -join ','"
    ],
    { timeoutMs: 30_000 }
  )
  const remote = firewall.stdout.trim()
  checks.push(
    remote.includes('100.64.0.0')
      ? { id: 'firewall', label: 'Firewall', state: 'ok', detail: 'scoped to the tailnet' }
      : {
          id: 'firewall',
          label: 'Firewall',
          state: 'warn',
          detail: `open to ${remote || 'Any'}`,
          action: { id: 'firewall:scope', label: 'Scope to tailnet' },
          note:
            'Needs administrator rights, so this opens an elevation prompt. ' +
            'Until then this machine accepts stream connections from any network it is on.'
        }
  )

  const encoder = encoderVerdict()
  checks.push({
    id: 'encoder',
    label: 'Encoder',
    state: encoder.ok ? 'ok' : 'warn',
    detail: encoder.detail
  })

  checks.push({
    id: 'permissions',
    label: 'Capture permission',
    state: 'ok',
    detail: 'Windows needs none — nothing to grant'
  })

  return checks
}

async function macosChecks(): Promise<Check[]> {
  const checks: Check[] = []

  const binary = macosBinary()
  if (!binary) {
    checks.push({
      id: 'sunshine',
      label: 'Sunshine',
      state: 'bad',
      detail: 'not installed',
      command: 'brew tap LizardByte/homebrew && brew install sunshine'
    })
    return checks
  }
  checks.push({ id: 'sunshine', label: 'Sunshine', state: 'ok', detail: binary })

  const libraries = await librariesVerdict(binary)
  checks.push({
    id: 'libraries',
    label: 'Libraries',
    state: libraries.ok ? 'ok' : 'bad',
    detail: libraries.detail,
    note: libraries.ok
      ? undefined
      : 'Sunshine cannot start at all until that is installed, and from every ' +
        'other machine it looks exactly like a network fault.'
  })

  const tap = await tapTrusted()
  if (!tap.ok) {
    checks.push({
      id: 'tap',
      label: 'Homebrew tap',
      state: 'warn',
      detail: tap.detail,
      command: 'brew trust lizardbyte/homebrew'
    })
  }

  const encoder = encoderVerdict()
  checks.push({
    id: 'encoder',
    label: 'Encoder',
    state: encoder.ok ? 'ok' : 'bad',
    detail: encoder.detail
  })

  const grants = await tccGrants(binary)
  if (grants === null) {
    checks.push({
      id: 'permissions',
      label: 'Permissions',
      state: 'info',
      detail: 'the TCC databases are not readable here, so these cannot be verified',
      action: { id: 'tcc:open', label: 'Open settings' },
      note:
        'Check by hand if something misbehaves: no video means Screen Recording, ' +
        'a dead mouse means Accessibility.'
    })
  } else {
    const missing = Object.keys(REQUIRED_TCC).filter((service) => grants[service] !== 2)
    for (const [service, description] of Object.entries(REQUIRED_TCC)) {
      checks.push({
        id: `tcc:${service}`,
        label: description.split(' — ')[0] as string,
        state: grants[service] === 2 ? 'ok' : 'bad',
        detail: grants[service] === 2 ? 'granted' : 'not granted'
      })
    }
    if (missing.length > 0) {
      checks.push({
        id: 'permissions',
        label: 'Grant them',
        state: 'info',
        detail: `Add this binary to the list(s): ${binary}`,
        action: { id: 'tcc:open', label: 'Open settings' },
        note:
          'These cannot be granted by any program, including this one — macOS ' +
          'requires a person to click. Everything around that click is done.'
      })
    }
  }

  return checks
}

export async function runChecks(): Promise<SetupReport> {
  const checks: Check[] = [await tailscaleCheck()]

  checks.push(
    ...(process.platform === 'win32'
      ? await windowsChecks()
      : process.platform === 'darwin'
        ? await macosChecks()
        : [
            {
              id: 'sunshine',
              label: 'Sunshine',
              state: 'info' as CheckState,
              detail: `no setup routine for ${process.platform} yet`
            }
          ])
  )

  // Branding last: it is the only check that changes anything by running, and
  // it should not run before we know Sunshine is even there.
  if (checks.some((check) => check.id === 'sunshine' && check.state === 'ok')) {
    checks.push({
      id: 'branding',
      label: 'Branding',
      state: 'info',
      detail: 'box art and host name, written into Sunshine’s config',
      action: { id: 'brand:install', label: 'Install' },
      note:
        'Config is user data and survives a Sunshine update. Its own artwork ' +
        'lives under Program Files and does not.'
    })
  }

  return {
    platform: process.platform,
    checks,
    ready: !checks.some((check) => check.state === 'bad')
  }
}

export interface ActionResult {
  ok: boolean
  message: string
}

export async function runAction(id: string): Promise<ActionResult> {
  switch (id) {
    case 'sunshine:restart': {
      const verdict = await restartSunshine()
      return { ok: verdict.ok, message: verdict.detail }
    }

    case 'firewall:scope': {
      // Elevation cannot be inherited, so this launches a second, elevated
      // PowerShell. The user sees a UAC prompt; that is the point of it.
      const command =
        "Get-NetFirewallRule -DisplayName 'Sunshine' | " +
        'Set-NetFirewallRule -RemoteAddress 100.64.0.0/10'
      const result = await run(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-Command','${command}'`
        ],
        { timeoutMs: 120_000 }
      )
      return result.code === 0
        ? { ok: true, message: 'Firewall scoped to the tailnet.' }
        : { ok: false, message: result.stderr.trim() || 'Elevation was declined.' }
    }

    case 'brand:install': {
      const branding = await brandSunshine()
      if (branding.problem) return { ok: false, message: branding.problem }
      if (!branding.changed) {
        return { ok: true, message: 'Already branded — nothing to change.' }
      }
      const restart = await restartSunshine()
      const named = branding.displayName ? ` Moonlight will show this host as “${branding.displayName}”.` : ''
      return {
        ok: true,
        message: `Box art installed for ${branding.covers} apps.${named} ${restart.detail}.`
      }
    }

    case 'tcc:open': {
      await shell.openExternal(SETTINGS_PANES.screen as string)
      await shell.openExternal(SETTINGS_PANES.accessibility as string)
      return { ok: true, message: 'Opened the permission panes. Re-run setup to verify.' }
    }

    default:
      return { ok: false, message: `Unknown action "${id}".` }
  }
}
