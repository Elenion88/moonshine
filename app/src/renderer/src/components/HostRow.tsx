// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Austin

import { useState, type JSX } from 'react'

import type { HostStatus, Profile } from '../types'

interface HostRowProps {
  host: HostStatus
  profiles: Profile[]
  busy: string | null
  onConnect: (host: HostStatus, profile: Profile) => void
  onForget: (address: string) => void
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

  // Listed as online by whatever found it, but nothing answered when we asked.
  // Saying "not measured yet" there is wrong twice: it was measured, and the
  // result is the interesting part.
  //
  // This has to come before the stream-host check: a machine we could not reach
  // at all has not told us whether it hosts anything, and "not a stream host"
  // would be a guess dressed up as a finding.
  if (host.median === null) {
    return host.measuredAt === null ? (
      <span>online · not measured yet</span>
    ) : (
      <span className="bad">listed as online, but nothing answered</span>
    )
  }

  // Reachable, and hosting nothing - a phone, a server, a machine where
  // Sunshine is not running. Worth saying plainly rather than offering a button
  // that cannot work.
  if (!host.streamable) return <span>online · not a stream host</span>

  // A connect time includes the server's accept latency, so it is an upper
  // bound on the round trip rather than a measurement of it. Say so with the
  // number instead of quietly presenting it as the same kind of figure.
  const bound = host.method === 'connect' ? 'under ' : ''
  const timing = (
    <>
      {bound}
      {host.median.toFixed(0)} ms
      {host.jitter !== null && ` · ${host.jitter.toFixed(1)} ms jitter`}
    </>
  )

  if (host.health !== 'degraded') return <span>direct · {timing}</span>

  // Past one 60fps frame the path itself is eating frames, whatever the encoder
  // is doing. Which figure crossed the line depends on how it was measured.
  return (
    <span className="warn">
      direct · {timing} —{' '}
      {host.method === 'icmp' ? 'above one frame' : 'unstable'}
    </span>
  )
}

export function HostRow({
  host,
  profiles,
  busy,
  onConnect,
  onForget
}: HostRowProps): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const disabled = !host.online || !host.streamable || busy !== null
  const alternatives = host.routes.length > 1

  return (
    <div className={`host${host.online ? '' : ' offline'}`}>
      <div className="host-main">
        <span className={`dot ${host.health}`} aria-hidden="true" />

        <div className="host-text">
          <span className="host-name">
            {host.name}
            <span className="via" title={`Reached over ${host.transportLabel}`}>
              {host.transportLabel}
            </span>
          </span>
          <span className="host-detail">{detail(host)}</span>
        </div>

        <div className="host-actions">
          {alternatives && (
            <button
              className="btn ghost"
              aria-expanded={expanded}
              title="Other ways to reach this machine"
              onClick={() => setExpanded((open) => !open)}
            >
              {host.routes.length} routes
            </button>
          )}
          {host.online && !host.streamable && (
            <span className="host-note">no Sunshine here</span>
          )}
          {host.streamable &&
            profiles.map((profile, index) => (
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

      {expanded && (
        <div className="routes">
          {host.routes.map((route) => (
            <div className="route" key={`${route.transport}:${route.address}`}>
              <span className={`dot ${route.health}`} aria-hidden="true" />
              <span className="route-label">{route.label}</span>
              <span className="route-address">{route.address}</span>
              <span className="route-timing">
                {route.health === 'offline'
                  ? 'no answer'
                  : route.median === null
                    ? '—'
                    : `${route.method === 'connect' ? 'under ' : ''}${route.median.toFixed(0)} ms`}
              </span>
              {route.transport === 'manual' && (
                <button className="btn ghost" onClick={() => onForget(route.address)}>
                  Forget
                </button>
              )}
            </div>
          ))}
          <p className="routes-note">
            The local network wins when it answers — fewer things in the middle
            than the same packets tunnelled. A relayed route is only used when
            nothing direct is available.
          </p>
        </div>
      )}
    </div>
  )
}
