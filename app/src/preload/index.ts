// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Austin

/**
 * The bridge. Context isolation is on, so this is the only surface the page
 * has - a fixed list of named calls, no `ipcRenderer`, no `require`.
 */

import { contextBridge, ipcRenderer } from 'electron'

const api = {
  info: () => ipcRenderer.invoke('app:info'),

  status: {
    get: () => ipcRenderer.invoke('status:get'),
    refresh: () => ipcRenderer.invoke('status:refresh'),
    /** Returns an unsubscribe, so React effects can clean up properly. */
    subscribe: (handler: (snapshot: unknown) => void) => {
      const listener = (_event: unknown, snapshot: unknown): void => handler(snapshot)
      ipcRenderer.on('status:changed', listener)
      return () => ipcRenderer.removeListener('status:changed', listener)
    }
  },

  hosts: {
    profiles: (os: string) => ipcRenderer.invoke('hosts:profiles', os),
    hide: (host: string, hidden: boolean) => ipcRenderer.invoke('hosts:hide', host, hidden),
    addManual: (host: unknown) => ipcRenderer.invoke('hosts:addManual', host),
    removeManual: (address: string) => ipcRenderer.invoke('hosts:removeManual', address)
  },

  profiles: {
    all: () => ipcRenderer.invoke('profiles:all')
  },

  session: {
    connect: (request: unknown) => ipcRenderer.invoke('session:connect', request)
  },

  account: {
    state: () => ipcRenderer.invoke('account:state'),
    setServer: (url: string) => ipcRenderer.invoke('account:setServer', url),
    signUp: (email: string, password: string) =>
      ipcRenderer.invoke('account:signUp', email, password),
    signIn: (email: string, password: string) =>
      ipcRenderer.invoke('account:signIn', email, password),
    signOut: () => ipcRenderer.invoke('account:signOut')
  },

  setup: {
    checks: () => ipcRenderer.invoke('setup:checks'),
    action: (id: string) => ipcRenderer.invoke('setup:action', id)
  },

  logs: {
    recent: () => ipcRenderer.invoke('logs:recent'),
    open: (path?: string) => ipcRenderer.invoke('logs:open', path),
    reveal: (path: string) => ipcRenderer.invoke('logs:reveal', path)
  }
}

contextBridge.exposeInMainWorld('moonshine', api)

export type MoonshineApi = typeof api
