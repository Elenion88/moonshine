// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Austin

/**
 * Talking to Sunshine on this machine: is it alive, did its encoder come up,
 * and does it wear our name.
 *
 * Sunshine is a separate program on its own upstream release. Nothing here
 * patches it. The only things written are inside its *config* directory, which
 * is user data and survives an upgrade - unlike everything under Program Files,
 * which every update replaces.
 */

import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { app } from 'electron'

import { hostDisplayName } from './brand'
import { run } from './exec'
import { hostSessionActive } from './session'

export const SUNSHINE_CONFIG_DIRS = [
  'C:\\Program Files\\Sunshine\\config',
  join(homedir(), '.config', 'sunshine')
]

export const SUNSHINE_MACOS_CANDIDATES = [
  '/opt/homebrew/opt/sunshine/bin/sunshine',
  '/usr/local/opt/sunshine/bin/sunshine'
]

/**
 * Sunshine runs from a LaunchAgent on macOS, not a brew service - the tap it
 * came from is untrusted by current Homebrew, so `brew services` cannot even
 * read the formula. This label is what launchctl answers to.
 */
export const MACOS_AGENT = 'homebrew.mxcl.sunshine'

export const SUNSHINE_LINUX_CANDIDATES = [
  '/usr/bin/sunshine',
  '/usr/local/bin/sunshine',
  '/var/lib/flatpak/exports/bin/dev.lizardbyte.app.Sunshine'
]

/**
 * The distro packages ship a user unit, so Sunshine runs inside the graphical
 * session where it can see the compositor - it has to, to capture it.
 */
export const LINUX_UNIT = 'sunshine'

export const SETTINGS_PANES: Record<string, string> = {
  screen:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
}

/**
 * Box art for the apps Sunshine defines out of the box, keyed by the `name` in
 * apps.json. Value is the file in resources/covers.
 */
const COVERS: Record<string, string> = {
  Desktop: 'cover-desktop.png',
  'Steam Big Picture': 'cover-steam.png'
}

export function configDir(): string | null {
  return SUNSHINE_CONFIG_DIRS.find((dir) => existsSync(dir)) ?? null
}

export function macosBinary(): string | null {
  return SUNSHINE_MACOS_CANDIDATES.find((path) => existsSync(path)) ?? null
}

export function linuxBinary(): string | null {
  return SUNSHINE_LINUX_CANDIDATES.find((path) => existsSync(path)) ?? null
}

function coversResourceDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'covers')
    : join(__dirname, '../../resources/covers')
}

export function logPath(): string | null {
  const paths = [
    'C:\\Program Files\\Sunshine\\config\\sunshine.log',
    join(homedir(), '.config', 'sunshine', 'sunshine.log')
  ]
  return paths.find((path) => existsSync(path)) ?? null
}

function logTail(bytes = 20_000): string {
  const path = logPath()
  if (!path) return ''
  try {
    return readFileSync(path, 'utf8').slice(-bytes)
  } catch {
    return ''
  }
}

export interface Verdict {
  ok: boolean
  detail: string
}

/**
 * Did a hardware encoder actually initialise?
 *
 * Sunshine starting is not the same as Sunshine working. On macOS a missing
 * Screen Recording grant leaves it running and encoding nothing, which from
 * every other machine looks exactly like a network fault.
 */
export function encoderVerdict(): Verdict {
  const tail = logTail()
  if (!tail) return { ok: false, detail: 'no log yet — has Sunshine run?' }

  const afterEncoder = tail.split('Found H.264 encoder').at(-1) ?? ''
  if (afterEncoder.includes('Unable to find display or encoder')) {
    return { ok: false, detail: 'encoders failing — Screen Recording not granted' }
  }
  if (tail.includes('Found H.264 encoder') || tail.includes('Found HEVC encoder')) {
    return { ok: true, detail: 'hardware encoder initialised' }
  }
  return { ok: false, detail: 'no encoder result in the log' }
}

// dyld names the first library it could not find, and Homebrew's layout puts
// the formula name right there in the path: /opt/homebrew/opt/<formula>/lib/...
const DYLD_MISSING_RE = /Library not loaded:\s*(\S+)/
const HOMEBREW_FORMULA_RE = /\/opt\/homebrew\/opt\/([^/]+)\//

/**
 * Check Sunshine can actually start, and name the formula if it cannot.
 *
 * This exists because Sunshine was once silently dead for days, and the only
 * symptom was that the Mac stopped answering on 47989 - which looks exactly
 * like the Tailscale and firewall failures this project had already hit, so
 * those got checked first. launchd knew all along and had filed it under
 * OS_REASON_DYLD, where nobody was looking. One `--version` reproduces it in a
 * second, and dyld names the missing library.
 */
export async function librariesVerdict(binary: string): Promise<Verdict> {
  const result = await run(binary, ['--version'], { timeoutMs: 30_000 })
  const match = DYLD_MISSING_RE.exec(`${result.stdout}${result.stderr}`)
  if (!match) return { ok: true, detail: 'libraries resolve' }

  const library = match[1] as string
  const formula = HOMEBREW_FORMULA_RE.exec(library)
  const remedy = formula
    ? `brew install ${formula[1]}`
    : `reinstall whatever provides ${library}`
  return { ok: false, detail: `cannot load ${library.split('/').pop()} — ${remedy}` }
}

/**
 * Will Homebrew read Sunshine's formula? `brew autoremove` depends on it.
 *
 * Sunshine comes from the third-party tap `lizardbyte/homebrew`. Current
 * Homebrew refuses to read formulae from untrusted taps, and an unreadable
 * formula has no visible dependencies - so `brew autoremove` concludes nothing
 * needs curl or miniupnpc and deletes them. That is the root cause of the
 * failure above, and it fires on whatever schedule the machine cleans up on.
 */
export async function tapTrusted(): Promise<Verdict> {
  const result = await run('brew', ['deps', '--installed', 'sunshine'], {
    timeoutMs: 60_000
  })
  // No brew on PATH is not this check's business to report.
  if (result.code === 127) return { ok: true, detail: 'homebrew not present' }
  if (`${result.stdout}${result.stderr}`.includes('untrusted tap')) {
    return {
      ok: false,
      detail:
        "Homebrew distrusts Sunshine's tap, so `brew autoremove` cannot see its " +
        'dependencies and will delete them.'
    }
  }
  return { ok: true, detail: 'tap trusted' }
}

export interface BrandingResult {
  changed: boolean
  covers: number
  displayName: string | null
  problem: string | null
}

/**
 * Put our box art and host name into Sunshine's config.
 *
 * Moonlight is Qt compiled into one executable and cannot be skinned, and
 * Sunshine's own art lives under Program Files where every update replaces it.
 * What is left is the config directory - apps.json, sunshine.conf, and the
 * covers folder - which is user data, survives upgrades, and is enough to own
 * both the tiles and the name Moonlight puts on this machine.
 */
export async function brandSunshine(): Promise<BrandingResult> {
  const config = configDir()
  if (!config) {
    return { changed: false, covers: 0, displayName: null, problem: 'no Sunshine config directory' }
  }

  let changed = false
  const coversDir = join(config, 'covers')
  await mkdir(coversDir, { recursive: true })

  const installed = new Map<string, string>()
  for (const [appName, filename] of Object.entries(COVERS)) {
    const source = join(coversResourceDir(), filename)
    if (!existsSync(source)) continue
    const target = join(coversDir, filename)
    await copyFile(source, target)
    installed.set(appName, target)
  }

  const appsPath = join(config, 'apps.json')
  let problem: string | null = null
  try {
    const apps = JSON.parse(await readFile(appsPath, 'utf8')) as {
      apps?: Array<Record<string, unknown>>
    }
    if (Array.isArray(apps.apps)) {
      for (const entry of apps.apps) {
        const target = installed.get(String(entry.name ?? ''))
        if (target && entry['image-path'] !== target) {
          entry['image-path'] = target
          changed = true
        }
      }
      if (changed) await writeFile(appsPath, `${JSON.stringify(apps, null, 2)}\n`, 'utf8')
    } else {
      problem = `could not read ${appsPath}`
    }
  } catch {
    problem = `could not read ${appsPath}`
  }

  // Sunshine falls back to the raw hostname, so a machine called The_Tower
  // announces itself that way. An existing setting is left alone - that would
  // be someone's deliberate choice, and this runs on every setup.
  const confPath = join(config, 'sunshine.conf')
  let displayName: string | null = null
  try {
    const conf = await readFile(confPath, 'utf8')
    if (!/^\s*sunshine_name\s*=/m.test(conf)) {
      displayName = hostDisplayName(hostname())
      await writeFile(
        confPath,
        `${conf}\n# The name Moonlight shows for this machine.\nsunshine_name = ${displayName}\n`,
        'utf8'
      )
      changed = true
    }
  } catch {
    // No sunshine.conf yet. Sunshine writes one on first run; nothing to do.
  }

  return { changed, covers: installed.size, displayName, problem }
}

/** Reload Sunshine so config changes take effect - unless someone is on it. */
export async function restartSunshine(): Promise<Verdict> {
  if (hostSessionActive()) {
    return {
      ok: false,
      detail: 'a client is connected — restart later to pick up the new branding'
    }
  }
  if (process.platform === 'win32') {
    const result = await run(
      'powershell',
      ['-NoProfile', '-Command', 'Restart-Service SunshineService -Force'],
      { timeoutMs: 90_000 }
    )
    return result.code === 0
      ? { ok: true, detail: 'Sunshine restarted' }
      : { ok: false, detail: result.stderr.trim() || 'could not restart the service' }
  }
  if (process.platform === 'linux') {
    const result = await run('systemctl', ['--user', 'restart', LINUX_UNIT], {
      timeoutMs: 60_000
    })
    return result.code === 0
      ? { ok: true, detail: 'Sunshine restarted' }
      : { ok: false, detail: result.stderr.trim() || 'systemctl could not restart it' }
  }
  const result = await run(
    'launchctl',
    ['kickstart', '-k', `gui/${process.getuid?.() ?? 501}/${MACOS_AGENT}`],
    { timeoutMs: 60_000 }
  )
  return result.code === 0
    ? { ok: true, detail: 'Sunshine restarted' }
    : { ok: false, detail: result.stderr.trim() || 'launchctl could not restart it' }
}
