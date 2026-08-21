// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Austin

import { useCallback, useEffect, useState, type JSX } from 'react'

import type { AccountState } from '../types'

interface AccountPanelProps {
  onClose: () => void
  onChanged: () => void
}

export function AccountPanel({ onClose, onChanged }: AccountPanelProps): JSX.Element {
  const [state, setState] = useState<AccountState | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [server, setServer] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(async () => {
    const next = await window.moonshine.account.state()
    setState(next)
    setServer((current) => current || next.serverUrl)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const submit = useCallback(
    async (mode: 'signIn' | 'signUp') => {
      setBusy(true)
      setMessage(null)
      try {
        await window.moonshine.account.setServer(server.trim())
        const result = await window.moonshine.account[mode](email.trim(), password)
        setMessage({ ok: result.ok, text: result.message })
        if (result.ok) {
          setPassword('')
          onChanged()
        }
        await load()
      } finally {
        setBusy(false)
      }
    },
    [email, password, server, load, onChanged]
  )

  const signOut = useCallback(async () => {
    setBusy(true)
    try {
      await window.moonshine.account.signOut()
      setMessage({ ok: true, text: 'Signed out on this machine.' })
      onChanged()
      await load()
    } finally {
      setBusy(false)
    }
  }, [load, onChanged])

  return (
    <div className="setup">
      <div className="setup-head">
        <div>
          <h2>Your account</h2>
          <p>
            Sign in on two machines and they can find each other — no tailnet, no
            addresses to remember.
          </p>
        </div>
        <div className="setup-head-actions">
          <button className="btn ghost" onClick={onClose}>
            Done
          </button>
        </div>
      </div>

      {message && (
        <div className={`banner ${message.ok ? 'info' : 'bad'}`}>
          <div>{message.text}</div>
          <button className="close" aria-label="Dismiss" onClick={() => setMessage(null)}>
            ×
          </button>
        </div>
      )}

      {state?.signedIn ? (
        <div className="checks">
          <div className="check">
            <span className="check-glyph ok" aria-hidden="true">
              ✓
            </span>
            <div className="check-body">
              <div className="check-line">
                <span className="check-label">Signed in</span>
                <span className="check-detail">{state.email}</span>
              </div>
              <p className="check-note">
                This machine is registered as <strong>{state.deviceName}</strong>
                {state.observed && (
                  <>
                    , and the coordinator sees it at <strong>{state.observed}</strong>
                  </>
                )}
                .
              </p>
            </div>
            <button className="btn" disabled={busy} onClick={() => void signOut()}>
              {busy ? 'Working…' : 'Sign out'}
            </button>
          </div>

          <div className="check">
            <span className="check-glyph info" aria-hidden="true">
              i
            </span>
            <div className="check-body">
              <div className="check-line">
                <span className="check-label">What this reaches</span>
                <span className="check-detail">directly reachable machines only</span>
              </div>
              <p className="check-note">
                The coordinator swaps addresses between your machines. It never carries
                the stream, so nothing to pay for and nothing to go down mid-session — but
                it also cannot yet get through two routers. On one network, or with the
                port forwarded, this works. Hole punching is the next piece.
              </p>
            </div>
          </div>
        </div>
      ) : (
        <form
          className="account-form"
          onSubmit={(event) => {
            event.preventDefault()
            void submit('signIn')
          }}
        >
          <label>
            <span>Coordinator</span>
            <input
              value={server}
              onChange={(event) => setServer(event.target.value)}
              placeholder="https://…"
              spellCheck={false}
            />
          </label>
          <label>
            <span>Email</span>
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              spellCheck={false}
            />
          </label>
          <label>
            <span>Password</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>

          <div className="account-actions">
            <button className="btn primary" type="submit" disabled={busy || !email || !password}>
              {busy ? 'Working…' : 'Sign in'}
            </button>
            <button
              className="btn"
              type="button"
              disabled={busy || !email || !password}
              onClick={() => void submit('signUp')}
            >
              Create account
            </button>
          </div>
          <p className="check-note">
            At least 10 characters. Length is the only rule — the usual demands for a
            digit and a symbol push people towards worse passwords, not better ones.
          </p>
        </form>
      )}

      {state?.error && (
        <div className="banner bad">
          <div>{state.error}</div>
        </div>
      )}
    </div>
  )
}
