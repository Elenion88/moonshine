// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Austin

/**
 * Every user-visible name in one place.
 *
 * The Python app has a `brand.py` saying the same things. The two are
 * deliberately duplicated for as long as both exist: importing across the
 * boundary would mean shipping a Python runtime inside an Electron app to read
 * six strings. When the Python UI is retired, this becomes the only copy.
 */

export const NAME = 'Moonshine'

/** Directories, filenames, the CLI prog. Lowercase and path-safe on both platforms. */
export const APP_ID = 'moonshine'

export const VERSION = '0.1.0'

export const TAGLINE = 'Moonlight and Sunshine, tuned for your tailnet.'

export const SUBTITLE = 'Low-latency desktop over your tailnet'

/**
 * Reverse-DNS identifier. `dev.austin` is a placeholder - reverse-DNS is meant
 * to be a domain you control, and this one is not registered.
 *
 * Changing it is not free. macOS keys screen-recording and accessibility grants
 * to the bundle identifier, so a build with a new one is a new app to the
 * system and every permission has to be granted again by hand.
 */
export const BUNDLE_ID = `dev.austin.${APP_ID}`

/**
 * What Moonlight should call a machine, given its hostname.
 *
 * Sunshine defaults to the raw hostname, so a tower announces itself as
 * `The_Tower`. This keeps the machine identifiable while marking it as ours.
 */
export function hostDisplayName(hostname: string): string {
  return `${hostname.replace(/_/g, ' ').trim()} — ${NAME}`
}
