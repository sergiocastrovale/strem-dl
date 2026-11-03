// The only place that chooses between Tauri and a plain browser.
import { isTauri } from '@tauri-apps/api/core'
import { sqliteDb, storageDb, type Db } from './db'
import type { DependencyEngine, DependencyProgress } from './dependencies'
import type { CaptureEvent, TransferEngine, TransferEvent } from './transfer'

export const isDesktop = () => isTauri()

async function invokeCommand<T>(command: string, args?: Record<string, unknown>) {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command, args)
}

const BLOCKED =
  'Request blocked or host unreachable. The addon may not allow browser requests; try the desktop app.'

export async function platformFetch(url: string, init: RequestInit): Promise<Response> {
  if (isTauri()) {
    const { fetch } = await import('@tauri-apps/plugin-http')
    return fetch(url, init)
  }
  try {
    return await globalThis.fetch(url, init)
  } catch (cause) {
    // Browsers report CORS blocks and network failures as a bare TypeError.
    if (cause instanceof TypeError) throw new Error(BLOCKED)
    throw cause
  }
}

export async function copyText(text: string): Promise<void> {
  if (isTauri()) {
    const { writeText } = await import('@tauri-apps/plugin-clipboard-manager')
    await writeText(text)
    return
  }
  await navigator.clipboard.writeText(text)
}

export async function openLink(link: string): Promise<void> {
  if (isTauri()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(link)
    return
  }
  window.open(link, '_blank', 'noopener')
}

/** Downloads inside the app need the desktop: browsers won't let a page read other hosts' files. */
export function getTransferEngine(): TransferEngine | null {
  if (!isTauri()) return null
  return {
    start: (job) => invokeCommand('download_start', { job }),
    pause: (id) => invokeCommand('download_pause', { id }),
    cancel: (id, filePath) => invokeCommand('download_cancel', { id, filePath }),
    async listen(handler) {
      const { listen } = await import('@tauri-apps/api/event')
      await listen<TransferEvent>('transfer', (event) => handler(event.payload))
    },
    probe: (url) => invokeCommand('media_probe', { url }),
    captureOpen: (id, url, visible) => invokeCommand('capture_open', { id, url, visible }),
    captureShow: (id) => invokeCommand('capture_show', { id }),
    captureClose: (id) => invokeCommand('capture_close', { id }),
    async captureListen(handler) {
      const { listen } = await import('@tauri-apps/api/event')
      await listen<CaptureEvent>('capture', (event) => handler(event.payload))
    },
  }
}

/** The programs stream downloads run on. Null in a browser, which can't run them. */
export function getDependencyEngine(): DependencyEngine | null {
  if (!isTauri()) return null
  return {
    status: () => invokeCommand('deps_status'),
    check: () => invokeCommand('deps_check'),
    install: (id) => invokeCommand('deps_install', { id }),
    async listen(handler) {
      const { listen } = await import('@tauri-apps/api/event')
      await listen<DependencyProgress>('dependency', (event) => handler(event.payload))
    },
  }
}

export interface WindowControls {
  minimize(): Promise<void>
  toggleMaximize(): Promise<void>
  close(): Promise<void>
}

/** The app draws its own title bar. Null in a browser, which has its own. */
export function getWindowControls(): WindowControls | null {
  if (!isTauri()) return null
  const current = async () => (await import('@tauri-apps/api/window')).getCurrentWindow()
  return {
    minimize: async () => (await current()).minimize(),
    toggleMaximize: async () => (await current()).toggleMaximize(),
    close: async () => (await current()).close(),
  }
}

export const canPickFolder = () => isTauri()

/** The system's downloads folder. Not every Linux setup declares one, so `~/Downloads` if not. */
export async function systemDownloadFolder(): Promise<string | null> {
  if (!isTauri()) return null
  const { downloadDir, homeDir, join } = await import('@tauri-apps/api/path')
  try {
    return await downloadDir()
  } catch {
    return homeDir()
      .then((home) => join(home, 'Downloads'))
      .catch(() => null)
  }
}

export async function pickFolder(current: string | null): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog')
  return open({ directory: true, defaultPath: current ?? undefined })
}

/** Rejects, with a message to display, if downloads can't be saved there. */
export async function checkFolder(path: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('check_download_folder', { path })
}

export async function showInFolder(path: string): Promise<void> {
  await invokeCommand('show_in_folder', { path })
}

async function openDb(): Promise<Db> {
  if (isTauri()) {
    const { default: Database } = await import('@tauri-apps/plugin-sql')
    // Migrations are registered in src-tauri/src/main.rs and run on load.
    return sqliteDb(await Database.load('sqlite:strem-dl.db'))
  }
  return storageDb(globalThis.localStorage)
}

let database: Promise<Db> | undefined

export function getDb(): Promise<Db> {
  return (database ??= openDb())
}
