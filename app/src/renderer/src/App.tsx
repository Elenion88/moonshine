// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Austin

import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'

import { HostRow } from './components/HostRow'
import { Mark } from './components/Mark'
import { SetupPanel } from './components/SetupPanel'
import type { AppInfo, HostStatus, Profile, StatusSnapshot } from './types'

interface Notice {
  kind: 'info' | 'warn' | 'bad'
  title: string
  body: string
  /** Set when a relayed path was refused, so the notice can offer to override. */
  retry?: { host: string; os: string; profile: string }
}

const EMPTY: StatusSnapshot = {
  hosts: [],
  overall: 'offline',
  sessionLive: false,
  refreshing: false,
  measuredAt: null,
  error: null
}

/** Which profiles to offer for a host. Mirrors profilesFor() in the main process. */
function profilesFor(all: Profile[], os: string): Profile[] {
  const byId = new Map(all.map((profile) => [profile.id, profile]))
  const ids = os.toLowerCase() === 'macos' ? ['mac'] : ['desktop', 'gaming']
  return ids.map((id) => byId.get(id)).filter((profile): profile is Profile => Boolean(profile))
}

function agoLabel(at: number | null): string {
  if (at === null) return 'not measured yet'
  const seconds = Math.round((Date.now() - at) / 1000)
  if (seconds < 5) return 'measured just now'
  if (seconds < 90) return `measured ${seconds}s ago`
  return `measured ${Math.round(seconds / 60)}m ago`
}

export function App(): JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [snapshot, setSnapshot] = useState<StatusSnapshot>(EMPTY)
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [showSetup, setShowSetup] = useState(false)
  // Re-render the "measured Ns ago" line without re-measuring anything.
  const [, setTick] = useState(0)

  useEffect(() => {
    void window.moonshine.info().then(setInfo)
    void window.moonshine.profiles.all().then(setProfiles)
    void window.moonshine.status.get().then(setSnapshot)
    return window.moonshine.status.subscribe(setSnapshot)
  }, [])

  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 10_000)
    return () => clearInterval(timer)
  }, [])

  const start = useCallback(
    async (host: HostStatus, profile: Profile, force = false) => {
      const key = `${host.name}:${profile.id}`
      setBusy(key)
      setNotice(null)
      try {
        const result = await window.moonshine.session.connect({
          host: host.name,
          os: host.os,
          profile: profile.id,
          force
        })
        if (!result.started) {
          setNotice({
            kind: 'bad',
            title: 'Session not started',
            body: result.reason ?? 'Unknown problem.',
            // Only offer the override for a refusal that forcing can fix.
            retry: result.reason?.includes('relayed')
              ? { host: host.name, os: host.os, profile: profile.id }
              : undefined
          })
        }
      } catch (error) {
        setNotice({
          kind: 'bad',
          title: 'Session not started',
          body: error instanceof Error ? error.message : String(error)
        })
      } finally {
        setBusy(null)
      }
    },
    []
  )

  const forceRetry = useCallback(async (retry: NonNullable<Notice['retry']>) => {
    setNotice(null)
    setBusy(`${retry.host}:${retry.profile}`)
    try {
      await window.moonshine.session.connect({ ...retry, force: true })
    } finally {
      setBusy(null)
    }
  }, [])

  const sorted = useMemo(
    () =>
      [...snapshot.hosts].sort((a, b) => {
        if (a.online !== b.online) return a.online ? -1 : 1
        return a.name.localeCompare(b.name)
      }),
    [snapshot.hosts]
  )

  return (
    <div className="app">
      <header className="header">
        <Mark className="mark" title={info?.name ?? 'Moonshine'} />
        <div className="header-text">
          <h1>{info?.name ?? 'Moonshine'}</h1>
          <p>{info?.subtitle ?? 'Low-latency desktop over your tailnet'}</p>
        </div>
        <div className="header-actions">
          <button
            className="btn ghost"
            onClick={() => void window.moonshine.logs.open()}
            title="Open the folder every session records itself into"
          >
            Session logs
          </button>
          <button
            className="btn ghost"
            onClick={() => setShowSetup((open) => !open)}
            title="Check Sunshine, the firewall and capture permissions on this machine"
          >
            {showSetup ? 'Hosts' : 'Set up'}
          </button>
          <button
            className="btn"
            disabled={snapshot.refreshing || showSetup}
            onClick={() => void window.moonshine.status.refresh()}
          >
            {snapshot.refreshing ? 'Measuring…' : 'Refresh'}
          </button>
        </div>
      </header>

      {snapshot.sessionLive && (
        <div className="banner info">
          <div>
            <strong>Session running.</strong> Status is not being measured — probing the
            link mid-stream is what made it stutter.
          </div>
        </div>
      )}

      {snapshot.error && (
        <div className="banner bad">
          <div>
            <strong>Could not read the tailnet.</strong> {snapshot.error}
          </div>
        </div>
      )}

      {notice && (
        <div className={`banner ${notice.kind}`}>
          <div>
            <strong>{notice.title}</strong> {notice.body}
            {notice.retry && (
              <>
                {' '}
                <button
                  className="btn ghost"
                  style={{ padding: '2px 8px', fontSize: 12 }}
                  onClick={() => void forceRetry(notice.retry as NonNullable<Notice['retry']>)}
                >
                  Connect anyway
                </button>
              </>
            )}
          </div>
          <button className="close" aria-label="Dismiss" onClick={() => setNotice(null)}>
            ×
          </button>
        </div>
      )}

      {showSetup ? (
        <main className="hosts">
          <SetupPanel onClose={() => setShowSetup(false)} />
        </main>
      ) : (
      <main className="hosts">
        {sorted.length === 0 ? (
          <div className="empty">
            <strong>No machines yet</strong>
            <span>
              Nothing is showing up on your tailnet. Check Tailscale is signed in on both
              machines, then refresh.
            </span>
          </div>
        ) : (
          sorted.map((host) => (
            <HostRow
              key={host.name}
              host={host}
              profiles={profilesFor(profiles, host.os)}
              busy={busy}
              onConnect={(target, profile) => void start(target, profile)}
            />
          ))
        )}
      </main>
      )}

      <footer className="footer">
        <span>{agoLabel(snapshot.measuredAt)}</span>
        <span className="spacer" />
        <span>
          {info?.name ?? 'Moonshine'} {info?.version ?? ''}
        </span>
      </footer>
    </div>
  )
}
