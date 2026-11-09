import { computed, ref } from 'vue'
import type { Db } from './db'
import { checkFolder, getDb, systemDownloadFolder } from './platform'

const DOWNLOAD_FOLDER = 'download-folder'
const MAX_DOWNLOADS = 'max-downloads'
const WEB_NOTICE_DISMISSED = 'web-notice-dismissed'
const SETUP_SKIPPED = 'setup-skipped'
// Saved under its original name, so the choice survives.
const BULK_SOURCE = 'bulk-copy'
const HOME_VIEW = 'home-view'

/** Which source of each title a bulk download takes. */
export type SourceChoice = 'first' | 'best' | 'smallest' | 'all'
export const SOURCE_CHOICES: { id: SourceChoice; label: string }[] = [
  { id: 'first', label: 'First copy' },
  { id: 'best', label: 'Best quality' },
  { id: 'smallest', label: 'Smallest file' },
  { id: 'all', label: 'All copies' },
]

export type HomeViewMode = 'list' | 'grid'

export const DEFAULT_MAX_DOWNLOADS = 4
export const MAX_DOWNLOADS_LIMIT = 10
/** The most that could be saved before the limit came down. */
const OLD_MAX_DOWNLOADS_LIMIT = 20

function parseMaxDownloads(raw: string | null, limit = MAX_DOWNLOADS_LIMIT): number | null {
  if (raw === null || !/^\d+$/.test(raw)) return null
  const value = Number(raw)
  return value >= 1 && value <= limit ? value : null
}

function savedMaxDownloads(raw: string | null): number {
  const value = parseMaxDownloads(raw, OLD_MAX_DOWNLOADS_LIMIT)
  return value === null ? DEFAULT_MAX_DOWNLOADS : Math.min(value, MAX_DOWNLOADS_LIMIT)
}

interface Options {
  systemFolder: () => Promise<string | null>
  /** Rejects with a message to display if the folder can't be used. */
  validate: (path: string) => Promise<void>
}

export function createSettings(database: Promise<Db>, { systemFolder, validate }: Options) {
  /** Null when using the system's folder. */
  const customFolder = ref<string | null>(null)
  const defaultFolder = ref<string | null>(null)
  const maxDownloads = ref(DEFAULT_MAX_DOWNLOADS)
  const error = ref<string | null>(null)
  /** Starts dismissed, so it can't flash for someone who dismissed it before. */
  const webNoticeDismissed = ref(true)
  const setupSkipped = ref(false)
  const bulkSource = ref<SourceChoice>('first')
  const homeView = ref<HomeViewMode>('grid')
  const downloadFolder = computed(() => customFolder.value ?? defaultFolder.value)

  const ready = Promise.all([database, systemFolder()]).then(async ([db, system]) => {
    defaultFolder.value = system
    customFolder.value = await db.setting(DOWNLOAD_FOLDER)
    maxDownloads.value = savedMaxDownloads(await db.setting(MAX_DOWNLOADS))
    webNoticeDismissed.value = (await db.setting(WEB_NOTICE_DISMISSED)) === 'true'
    setupSkipped.value = (await db.setting(SETUP_SKIPPED)) === 'true'
    const source = await db.setting(BULK_SOURCE)
    bulkSource.value = SOURCE_CHOICES.find((choice) => choice.id === source)?.id ?? 'first'
    homeView.value = (await db.setting(HOME_VIEW)) === 'list' ? 'list' : 'grid'
    return db
  })
  ready.catch((cause) => {
    webNoticeDismissed.value = false
    error.value = `Couldn't load the settings: ${cause instanceof Error ? cause.message : String(cause)}`
  })

  async function setDownloadFolder(path: string) {
    const db = await ready
    const trimmed = path.trim()
    if (!trimmed) throw new Error('Enter a folder')
    await validate(trimmed)
    await db.setSetting(DOWNLOAD_FOLDER, trimmed)
    customFolder.value = trimmed
  }

  async function resetDownloadFolder() {
    const db = await ready
    await db.setSetting(DOWNLOAD_FOLDER, null)
    customFolder.value = null
  }

  async function setMaxDownloads(raw: string | number) {
    const db = await ready
    const value = parseMaxDownloads(String(raw).trim())
    if (value === null) throw new Error(`Enter a whole number from 1 to ${MAX_DOWNLOADS_LIMIT}`)
    await db.setSetting(MAX_DOWNLOADS, String(value))
    maxDownloads.value = value
  }

  /** For choices whose only cost, if they can't be saved, is making them again next time. */
  async function remember(key: string, value: string) {
    try {
      const db = await ready
      await db.setSetting(key, value)
    } catch {
      // Nothing to report.
    }
  }

  async function dismissWebNotice() {
    webNoticeDismissed.value = true
    await remember(WEB_NOTICE_DISMISSED, 'true')
  }

  async function skipSetup() {
    setupSkipped.value = true
    await remember(SETUP_SKIPPED, 'true')
  }

  async function setBulkSource(choice: SourceChoice) {
    bulkSource.value = choice
    await remember(BULK_SOURCE, choice)
  }

  async function setHomeView(view: HomeViewMode) {
    homeView.value = view
    await remember(HOME_VIEW, view)
  }

  return {
    ready,
    error,
    webNoticeDismissed,
    dismissWebNotice,
    setupSkipped,
    skipSetup,
    bulkSource,
    setBulkSource,
    homeView,
    setHomeView,
    customFolder,
    defaultFolder,
    downloadFolder,
    maxDownloads,
    setDownloadFolder,
    resetDownloadFolder,
    setMaxDownloads,
  }
}

let shared: ReturnType<typeof createSettings> | undefined

export function useSettings() {
  return (shared ??= createSettings(getDb(), { systemFolder: systemDownloadFolder, validate: checkFolder }))
}
