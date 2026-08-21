// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Austin

import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'

import { AccountPanel } from './components/AccountPanel'
import { HostRow } from './components/HostRow'
import { Mark } from './components/Mark'
import { SetupPanel } from './components/SetupPanel'
import type {
  AppInfo,
  HostStatus,
  Profile,
  StatusSnapshot,
  TransportId
} from './types'

interface Notice {
  kind: 'info' | 'warn' | 'bad'
  title: string
  body: string
  /** Set when a relayed path was refused, so the notice can offer to override. */
  retry?: {
    host: string
    address: string
    transport: TransportId
    os: string
    profile: string
  }
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
  const [showAccount, setShowAccount] = useState(false)
  const [adding, setAdding] = useState(false)
  const [manualName, setManualName] = useState('')
  const [manualAddress, setManualAddress] = useState('')
  // Re-render the "measured Ns ago" line without re-measuring anything.
  const [, setTick] = useState(0)

  useEffect(() => {
    void window.moonshine.info().then(setInfo)
    void window.moonshine.profiles.all().then(setProfiles)
    void window.moonshine.status.get().then(setSnapshot)
    const unsubscribeStatus = window.moonshine.status.subscribe(setSnapshot)
    const unsubscribeFailure = window.moonshine.session.onFailed((failure) => {
      setNotice({
        kind: 'bad',
        title: 'Session ended before it started.',
        body: `${failure.host} did not accept the connection, so the stream client was closed rather than left running. ${failure.reason}`
      })
    })
    return () => {
      unsubscribeStatus()
      unsubscribeFailure()
    }
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
          address: host.address,
          transport: host.transport,
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
              ? {
                  host: host.name,
                  address: host.address,
                  transport: host.transport,
                  os: host.os,
                  profile: profile.id
                }
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

  const addManual = useCallback(async () => {
    const address = manualAddress.trim()
    if (!address) return
    setAdding(false)
    setManualAddress('')
    setManualName('')
    await window.moonshine.hosts.addManual({
      name: manualName.trim() || address,
      address
    })
  }, [manualAddress, manualName])

  const hosts = useMemo(() => snapshot.hosts, [snapshot.hosts])

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
            onClick={() => {
              setShowAccount((open) => !open)
              setShowSetup(false)
            }}
            title="Sign in so your machines can find each other"
          >
            {showAccount ? 'Hosts' : 'Account'}
          </button>
          <button
            className="btn ghost"
            onClick={() => setAdding((open) => !open)}
            title="Reach a machine by address, without Tailscale"
          >
            Add host
          </button>
          <button
            className="btn ghost"
            onClick={() => {
              setShowSetup((open) => !open)
              setShowAccount(false)
            }}
            title="Check Sunshine, the firewall and capture permissions on this machine"
          >
            {showSetup ? 'Hosts' : 'Set up'}
          </button>
          <button
            className="btn"
            disabled={snapshot.refreshing || showSetup || showAccount}
            onClick={() => void window.moonshine.status.refresh()}
          >
            {snapshot.refreshing ? 'Measuring…' : 'Refresh'}
          </button>
        </div>
      </header>

      {adding && (
        <form
          className="add-host"
          onSubmit={(event) => {
            event.preventDefault()
            void addManual()
          }}
        >
          <input
            autoFocus
            placeholder="Address or hostname"
            value={manualAddress}
            onChange={(event) => setManualAddress(event.target.value)}
          />
          <input
            placeholder="Name (optional)"
            value={manualName}
            onChange={(event) => setManualName(event.target.value)}
          />
          <button className="btn primary" type="submit" disabled={!manualAddress.trim()}>
            Add
          </button>
          <button className="btn ghost" type="button" onClick={() => setAdding(false)}>
            Cancel
          </button>
        </form>
      )}

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

      {showAccount ? (
        <main className="hosts">
          <AccountPanel
            onClose={() => setShowAccount(false)}
            onChanged={() => void window.moonshine.status.get().then(setSnapshot)}
          />
        </main>
      ) : showSetup ? (
        <main className="hosts">
          <SetupPanel onClose={() => setShowSetup(false)} />
        </main>
      ) : (
      <main className="hosts">
        {hosts.length === 0 ? (
          <div className="empty">
            <strong>No machines yet</strong>
            <span>
              Nothing on your tailnet, nothing advertising itself on this network, and
              no saved addresses. Any one of the three is enough.
            </span>
          </div>
        ) : (
          hosts.map((host) => (
            <HostRow
              key={host.name}
              host={host}
              profiles={profilesFor(profiles, host.os)}
              busy={busy}
              onConnect={(target, profile) => void start(target, profile)}
              onForget={(address) => void window.moonshine.hosts.removeManual(address)}
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
