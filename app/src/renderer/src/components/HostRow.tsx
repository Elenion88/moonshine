// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Austin

import type { JSX } from 'react'

import type { HostStatus, Profile } from '../types'

interface HostRowProps {
  host: HostStatus
  profiles: Profile[]
  busy: string | null
  onConnect: (host: HostStatus, profile: Profile) => void
}

/**
 * One line of detail per host, and it is the same line the whole project is
 * about: is the path direct, and is it fast enough for a frame.
 */
function detail(host: HostStatus): JSX.Element {
  if (!host.online) return <span>offline</span>

  if (host.health === 'relayed') {
    return (
      <span className="bad">
        relayed via {host.relay ?? 'DERP'} — will stutter
        {host.median !== null && ` · ${host.median.toFixed(0)} ms`}
      </span>
    )
  }

  if (host.median === null) {
    return <span>online · not measured yet</span>
  }

  const timing = (
    <>
      {host.median.toFixed(0)} ms
      {host.jitter !== null && ` · ${host.jitter.toFixed(1)} ms jitter`}
    </>
  )

  // Past one 60fps frame the path itself is eating frames, whatever the
  // encoder is doing, so it is worth calling out rather than just colouring.
  return host.health === 'degraded' ? (
    <span className="warn">direct · {timing} — above one frame</span>
  ) : (
    <span>direct · {timing}</span>
  )
}

export function HostRow({ host, profiles, busy, onConnect }: HostRowProps): JSX.Element {
  const disabled = !host.online || busy !== null

  return (
    <div className={`host${host.online ? '' : ' offline'}`}>
      <span className={`dot ${host.health}`} aria-hidden="true" />

      <div className="host-text">
        <span className="host-name">{host.name}</span>
        <span className="host-detail">{detail(host)}</span>
      </div>

      <div className="host-actions">
        {profiles.map((profile, index) => (
          <button
            key={profile.id}
            className={`btn${index === 0 ? ' primary' : ''}`}
            disabled={disabled}
            title={`${profile.description} — ${profile.resolution} @ ${profile.fps}fps, ${Math.round(
              profile.bitrate / 1000
            )} Mbps`}
            onClick={() => onConnect(host, profile)}
          >
            {busy === `${host.name}:${profile.id}` ? 'Starting…' : profile.label}
          </button>
        ))}
      </div>
    </div>
  )
}
