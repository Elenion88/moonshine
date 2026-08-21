// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Austin

/**
 * The renderer's entire view of the machine.
 *
 * Everything that touches the network, the filesystem or another process lives
 * on this side of the bridge. The renderer gets these handlers and nothing
 * else - no Node, no shell, no direct access to the status cache.
 */

import { ipcMain, shell } from 'electron'

import * as account from './core/account'
import { NAME, SUBTITLE, VERSION } from './core/brand'
import { recentSessions, sessionsDir, setHidden } from './core/paths'
import { PROFILES, SHORTCUTS, profilesFor } from './core/profiles'
import { runAction, runChecks } from './core/setup'
import { connect, type ConnectRequest } from './core/session'
import { addManualHost, removeManualHost, type ManualHost } from './core/transport'
import type { StatusCache } from './core/status'

export function registerIpc(status: StatusCache): void {
  ipcMain.handle('app:info', () => ({
    name: NAME,
    subtitle: SUBTITLE,
    version: VERSION,
    platform: process.platform,
    shortcuts: SHORTCUTS
  }))

  ipcMain.handle('status:get', () => status.current())
  ipcMain.handle('status:refresh', () => status.refresh(true))

  ipcMain.handle('hosts:profiles', (_event, os: string) => profilesFor(os))
  ipcMain.handle('hosts:hide', (_event, host: string, hidden: boolean) =>
    setHidden(host, hidden)
  )

  ipcMain.handle('hosts:addManual', async (_event, host: ManualHost) => {
    await addManualHost(host)
    return status.refresh(true)
  })
  ipcMain.handle('hosts:removeManual', async (_event, address: string) => {
    await removeManualHost(address)
    return status.refresh(true)
  })

  ipcMain.handle('profiles:all', () => Object.values(PROFILES))

  ipcMain.handle('session:connect', async (_event, request: ConnectRequest) => {
    const result = await connect(request)
    // A refused session changes nothing worth re-measuring, but a started one
    // means the cache should learn there is a session before its next tick.
    if (result.started) void status.refresh(false)
    return result
  })

  ipcMain.handle('account:state', () => account.state())
  ipcMain.handle('account:setServer', (_event, url: string) => account.setServerUrl(url))
  ipcMain.handle('account:signUp', async (_event, email: string, password: string) => {
    const result = await account.signUp(email, password)
    if (result.ok) void status.refresh(true)
    return result
  })
  ipcMain.handle('account:signIn', async (_event, email: string, password: string) => {
    const result = await account.signIn(email, password)
    if (result.ok) void status.refresh(true)
    return result
  })
  ipcMain.handle('account:signOut', async () => {
    await account.signOut()
    return status.refresh(true)
  })

  ipcMain.handle('account:testDirect', (_event, deviceId: string) =>
    account.testDirect(deviceId)
  )

  ipcMain.handle('setup:checks', () => runChecks())
  ipcMain.handle('setup:action', async (_event, id: string) => {
    const result = await runAction(id)
    // Anything that restarts Sunshine changes what the host list should say.
    if (result.ok) void status.refresh(false)
    return result
  })

  ipcMain.handle('logs:recent', () => recentSessions())
  ipcMain.handle('logs:open', (_event, path?: string) =>
    shell.openPath(path ?? sessionsDir())
  )
  ipcMain.handle('logs:reveal', (_event, path: string) => {
    shell.showItemInFolder(path)
  })
}
