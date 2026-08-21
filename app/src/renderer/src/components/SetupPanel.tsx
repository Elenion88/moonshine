// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Austin

import { useCallback, useEffect, useState, type JSX } from 'react'

import type { Check, SetupReport } from '../types'

const GLYPH: Record<Check['state'], string> = {
  ok: '✓',
  warn: '!',
  bad: '✕',
  info: 'i'
}

interface SetupPanelProps {
  onClose: () => void
}

function CheckRow({
  check,
  busy,
  onAction,
  onCopy,
  copied
}: {
  check: Check
  busy: string | null
  onAction: (id: string) => void
  onCopy: (command: string) => void
  copied: string | null
}): JSX.Element {
  return (
    <div className="check">
      <span className={`check-glyph ${check.state}`} aria-hidden="true">
        {GLYPH[check.state]}
      </span>

      <div className="check-body">
        <div className="check-line">
          <span className="check-label">{check.label}</span>
          <span className="check-detail">{check.detail}</span>
        </div>

        {check.note && <p className="check-note">{check.note}</p>}

        {check.command && (
          <button
            className="check-command"
            title="Copy"
            onClick={() => onCopy(check.command as string)}
          >
            <code>{check.command}</code>
            <span className="copy-hint">{copied === check.command ? 'copied' : 'copy'}</span>
          </button>
        )}
      </div>

      {check.action && (
        <button
          className="btn"
          disabled={busy !== null}
          onClick={() => onAction((check.action as { id: string }).id)}
        >
          {busy === check.action.id ? 'Working…' : check.action.label}
        </button>
      )}
    </div>
  )
}

export function SetupPanel({ onClose }: SetupPanelProps): JSX.Element {
  const [report, setReport] = useState<SetupReport | null>(null)
  const [checking, setChecking] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const check = useCallback(async () => {
    setChecking(true)
    try {
      setReport(await window.moonshine.setup.checks())
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    void check()
  }, [check])

  const act = useCallback(
    async (id: string) => {
      setBusy(id)
      setMessage(null)
      try {
        const result = await window.moonshine.setup.action(id)
        setMessage({ ok: result.ok, text: result.message })
        // Every action changes something a check reads, so re-run them all
        // rather than trusting the one result.
        await check()
      } finally {
        setBusy(null)
      }
    },
    [check]
  )

  const copy = useCallback((command: string) => {
    void navigator.clipboard.writeText(command)
    setCopied(command)
    setTimeout(() => setCopied(null), 1600)
  }, [])

  return (
    <div className="setup">
      <div className="setup-head">
        <div>
          <h2>Set up this machine as a host</h2>
          <p>
            Everything that can be automated is. What cannot is named, with the exact
            command or the exact pane.
          </p>
        </div>
        <div className="setup-head-actions">
          <button className="btn" disabled={checking} onClick={() => void check()}>
            {checking ? 'Checking…' : 'Re-check'}
          </button>
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

      {report === null ? (
        <p className="setup-empty">Checking this machine…</p>
      ) : (
        <div className="checks">
          {report.checks.map((item) => (
            <CheckRow
              key={item.id}
              check={item}
              busy={busy}
              onAction={(id) => void act(id)}
              onCopy={copy}
              copied={copied}
            />
          ))}
        </div>
      )}

      {report?.ready && (
        <p className="setup-ready">
          Nothing is blocking a session on this machine.
        </p>
      )}
    </div>
  )
}
