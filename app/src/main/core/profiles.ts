// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Austin

/**
 * Streaming profiles.
 *
 * Shared across all of them: HEVC (the reference host is an Ampere card, so
 * NVENC has no AV1 encoder), hardware decode, and V-Sync plus frame pacing off
 * - both buffer a frame to smooth output, which is the opposite of the goal.
 *
 * These are the only place stream settings are configured. The stream client
 * must never grow a settings screen of its own; two places to set the same
 * thing is how they end up disagreeing.
 */

export interface Profile {
  id: string
  label: string
  description: string
  fps: number
  /** Kilobits per second, matching Moonlight's --bitrate. */
  bitrate: number
  resolution: string
  displayMode: 'windowed' | 'fullscreen' | 'borderless'
  flags: string[]
}

export const COMMON_FLAGS = [
  '--video-codec',
  'HEVC',
  '--video-decoder',
  'hardware',
  '--no-vsync',
  '--no-frame-pacing',
  '--keep-awake'
]

export const PROFILES: Record<string, Profile> = {
  desktop: {
    id: 'desktop',
    label: 'Desktop',
    description: 'Dev and desktop work - sharp text, precise pointer',
    fps: 60,
    bitrate: 40_000,
    resolution: '1920x1200',
    // A real resizable window, not "borderless" - borderless is still a
    // screen-filling window and reads as fullscreen even though you can
    // alt-tab out of it. Desktop work means having the remote machine
    // alongside local windows, so windowed is the honest default.
    displayMode: 'windowed',
    flags: [
      // 4:4:4 keeps small text legible. It costs roughly 30-50% more bandwidth
      // than 4:2:0, affordable on a LAN, and it is the single biggest quality
      // factor when reading code.
      '--yuv444',
      // Absolute mouse maps the pointer 1:1 instead of capturing it, so the
      // cursor behaves like a normal remote desktop.
      '--absolute-mouse',
      '--no-game-optimization',
      '--audio-config',
      'stereo'
    ]
  },
  mac: {
    id: 'mac',
    label: 'Mac',
    description: 'Control a macOS host - Command key forwarded',
    fps: 60,
    // Was briefly dropped to 20 Mbps on the theory that video airtime was
    // starving audio packets. The session logs did not support it: 7 audio
    // events across 27 minutes cannot produce audio breaking up every minute,
    // and the host logged no audio errors at all. Put back to 30.
    bitrate: 30_000,
    resolution: '1920x1200',
    displayMode: 'windowed',
    flags: [
      '--yuv444',
      '--absolute-mouse',
      '--no-game-optimization',
      // The whole reason this profile exists. Moonlight swallows the left GUI
      // key locally unless system key capture is on; Sunshine's macOS side
      // already maps it to Command. This one flag is what makes Cmd-C, Cmd-Tab
      // and Cmd-Space reach the Mac instead of the local machine.
      //
      // Trade-off: while streaming, the Windows key and alt-tab go to the Mac.
      // That is intended, and Ctrl+Alt+Shift+K turns it off mid-session.
      '--capture-system-keys',
      'always',
      '--audio-config',
      'stereo'
    ]
  },
  gaming: {
    id: 'gaming',
    label: 'Gaming',
    description: 'Games - relative mouse, controllers, headroom for motion',
    // 120, not 60. The reference host was capped at 60 only because Windows
    // had a 165Hz panel set to 59Hz, and Sunshine cannot capture faster than
    // the desktop is running.
    fps: 120,
    // More frames need more bits to stay clean in motion. 50 Mbps at 60fps is
    // ~830 Kbit/frame; holding that at 120fps means roughly doubling it.
    bitrate: 80_000,
    resolution: '1920x1080',
    // Exclusive fullscreen: lowest-latency path for games, and switching away
    // mid-game is not the common case.
    displayMode: 'fullscreen',
    flags: [
      // 4:2:0 spends the bitrate on motion rather than chroma detail.
      '--no-yuv444',
      '--no-absolute-mouse',
      '--game-optimization',
      '--multi-controller',
      '--audio-config',
      'stereo'
    ]
  }
}

/**
 * Which profiles to offer for a host, by its operating system.
 *
 * Offering "Gaming" for a macOS host is noise - that machine is something you
 * drive a desktop on, and the profile it needs is the one that forwards the
 * Command key.
 */
export function profilesFor(os: string): Profile[] {
  if (os.toLowerCase() === 'macos') return [PROFILES.mac as Profile]
  return [PROFILES.desktop as Profile, PROFILES.gaming as Profile]
}

/** In-session shortcuts, all Ctrl+Alt+Shift and a letter. */
export const SHORTCUTS: Array<[string, string]> = [
  ['D', 'minimize the session, leaving it running'],
  ['K', 'toggle system key capture (hand alt-tab back)'],
  ['Z', 'release the mouse'],
  ['M', 'switch absolute / relative mouse'],
  ['X', 'toggle fullscreen'],
  ['S', 'stats overlay'],
  ['V', 'paste local clipboard as keystrokes'],
  ['Q', 'quit the session']
]
