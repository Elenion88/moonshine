// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Austin

/**
 * The app mark, as vector.
 *
 * A moon throwing a beam onto a screen. The light is a cone in perspective:
 * the screen is its near face and its edges run back to a single apex at
 * (356, 159), which sits inside the moon's white - which is what makes the
 * beam read as coming from behind the moon rather than beside it.
 *
 * The moon is bitten from the lower left rather than the upper right. An
 * upper-right bite leaves the moon's mass in the lower left, exactly where the
 * screen is, and the two fuse into one blob at small sizes.
 *
 * Measured in a 512-unit grid, which is where every number below comes from.
 * The Python app draws the same geometry with Pillow; this is the same mark,
 * not a second one.
 */

// React 19 dropped the global JSX namespace, so the type is imported
// rather than assumed.
import type { JSX } from 'react'

interface MarkProps {
  /** Tile colour. Defaults to the accent; pass a status colour to carry health. */
  tile?: string
  className?: string
  title?: string
}

export function Mark({ tile = '#4C7DFF', className, title }: MarkProps): JSX.Element {
  // Unique per instance so two marks on one page cannot share a clip path.
  const id = `mark-${tile.replace('#', '')}`

  return (
    <svg
      viewBox="0 0 512 512"
      className={className}
      role={title ? 'img' : 'presentation'}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <defs>
        <clipPath id={`${id}-tile`}>
          <rect x="24" y="24" width="464" height="464" rx="112" />
        </clipPath>
        <mask id={`${id}-moon`}>
          <rect width="512" height="512" fill="#000" />
          <circle cx="317" cy="207" r="150" fill="#fff" />
          <circle cx="160" cy="302" r="218" fill="#000" />
        </mask>
      </defs>

      <rect x="24" y="24" width="464" height="464" rx="112" fill={tile} />

      {/* Beam and ray both run off the left edge, so they are clipped to the tile. */}
      <g clipPath={`url(#${id}-tile)`}>
        <path d="M356 159 L74 269 L74 408 L270 408 Z" fill="#fff" opacity=".42" />
        <path d="M-20 153 L356 159 L-20 166 Z" fill="#fff" opacity=".80" />
      </g>

      <rect x="74" y="269" width="196" height="139" rx="24" fill="#fff" />
      <circle cx="317" cy="207" r="150" fill="#fff" mask={`url(#${id}-moon)`} />
    </svg>
  )
}
