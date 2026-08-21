// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Austin

/**
 * App lifecycle: one window, one tray icon, and the status cache behind both.
 *
 * The window is closeable without quitting. A remote desktop launcher that
 * exits when you close its window cannot carry status in the tray, and the tray
 * status is the point - a bad path should be visible before you click anything.
 */

import { join } from 'node:path'

import { BrowserWindow, Menu, Tray, app, nativeImage, nativeTheme, shell } from 'electron'

import { NAME, SUBTITLE } from './core/brand'
import { sessionsDir } from './core/paths'
import { profilesFor } from './core/profiles'
import { connect } from './core/session'
import { StatusCache, type StatusSnapshot } from './core/status'
import { registerIpc } from './ipc'

const status = new StatusCache()

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
/** Set on macOS when the user really means quit, so `close` can stay "hide". */
let quitting = false

function resourcePath(...parts: string[]): string {
  // Packaged, resources sit beside the asar; in dev they are in the repo.
  return app.isPackaged
    ? join(process.resourcesPath, ...parts)
    : join(__dirname, '../../resources', ...parts)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 720,
    height: 620,
    minWidth: 560,
    minHeight: 460,
    show: false,
    title: NAME,
    icon: resourcePath('icon.png'),
    // A dark-by-default app on a light title bar looks like two applications.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#111317' : '#F2F4F7',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Show only once painted. A window that appears empty and then fills in reads
  // as slow even when it is not.
  mainWindow.once('ready-to-show', () => mainWindow?.show())

  mainWindow.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    mainWindow?.hide()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Anything that is not this app opens in the real browser, never in here.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) void mainWindow.loadURL(devUrl)
  else void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
}

function showWindow(): void {
  if (!mainWindow) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function trayImage(health: string): Electron.NativeImage {
  const image = nativeImage.createFromPath(resourcePath('tray', `${health}.png`))
  // macOS wants a small template-sized image; Windows scales from 16 fine.
  return process.platform === 'darwin' ? image.resize({ width: 18, height: 18 }) : image
}

function buildTrayMenu(snapshot: StatusSnapshot): Electron.Menu {
  const dot: Record<string, string> = {
    ok: '●',
    degraded: '●',
    relayed: '●',
    offline: '○'
  }

  const hosts = snapshot.hosts.filter((host) => host.online)
  const hostItems: Electron.MenuItemConstructorOptions[] = hosts.length
    ? hosts.map((host) => ({
        label: `${dot[host.health] ?? '○'}  ${host.name}${
          host.median === null ? '' : `   ${host.median.toFixed(0)} ms`
        }   ${host.transportLabel}`,
        submenu: profilesFor(host.os).map((profile) => ({
          label: profile.label,
          click: () => {
            void connect({
              host: host.name,
              address: host.address,
              transport: host.transport,
              os: host.os,
              profile: profile.id
            })
          }
        }))
      }))
    : [{ label: 'Nothing online', enabled: false }]

  return Menu.buildFromTemplate([
    { label: `${NAME} — ${SUBTITLE}`, enabled: false },
    { type: 'separator' },
    ...hostItems,
    { type: 'separator' },
    ...(snapshot.sessionLive
      ? [{ label: 'Session running — not measuring', enabled: false } as const]
      : []),
    { label: 'Refresh now', click: () => void status.refresh(true) },
    { label: `Open ${NAME}`, click: showWindow },
    { label: 'Session logs', click: () => void shell.openPath(sessionsDir()) },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        quitting = true
        app.quit()
      }
    }
  ])
}

function createTray(): void {
  tray = new Tray(trayImage('offline'))
  tray.setToolTip(NAME)
  tray.setContextMenu(buildTrayMenu(status.current()))
  // Windows opens the menu on right-click already; a left click should open the
  // thing the icon represents.
  tray.on('click', showWindow)
}

function applySnapshot(snapshot: StatusSnapshot): void {
  if (tray) {
    tray.setImage(trayImage(snapshot.overall))
    tray.setContextMenu(buildTrayMenu(snapshot))
    const summary = snapshot.sessionLive ? 'session running' : `${snapshot.overall}`
    tray.setToolTip(`${NAME} — ${summary}`)
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status:changed', snapshot)
  }
}

// One instance. A second tray icon for the same machine is confusing, and two
// status caches would double the probing this app works hard to avoid.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showWindow)

  void app.whenReady().then(() => {
    app.setName(NAME)
    registerIpc(status)
    createWindow()
    createTray()

    status.on('change', applySnapshot)
    status.start()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      else showWindow()
    })
  })

  app.on('before-quit', () => {
    quitting = true
    status.stop()
  })

  // Deliberately no window-all-closed quit: closing the window leaves the tray
  // running, which is the whole reason there is a tray.
}
