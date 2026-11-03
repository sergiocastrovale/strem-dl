import { computed, ref } from 'vue'
import { getDependencyEngine } from './platform'

export type DependencyId = 'yt-dlp' | 'ffmpeg'

/** See src-tauri/src/deps.rs. */
export interface DependencyStatus {
  id: DependencyId
  installed: boolean
  version: string | null
}

export interface LatestVersion {
  id: DependencyId
  version: string
  updateAvailable: boolean
}

export interface DependencyProgress {
  id: DependencyId
  stage: 'downloading' | 'installing'
  done: number
  total: number | null
}

export interface DependencyEngine {
  status(): Promise<DependencyStatus[]>
  check(): Promise<LatestVersion[]>
  install(id: DependencyId): Promise<DependencyStatus>
  listen(handler: (progress: DependencyProgress) => void): Promise<void>
}

export interface Dependency extends DependencyStatus {
  /** Known after checking for updates. */
  latest: LatestVersion | null
  progress: DependencyProgress | null
  error: string | null
}

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

export const DEPENDENCY_PURPOSE: Record<DependencyId, string> = {
  'yt-dlp': 'Saves video streams.',
  ffmpeg: 'Joins video and audio into one file.',
}

export function createDependencies(engine: DependencyEngine) {
  const items = ref<Dependency[]>([])
  const loaded = ref(false)
  const loadError = ref<string | null>(null)
  const checking = ref(false)
  const checkError = ref<string | null>(null)
  const ready = computed(() => loaded.value && items.value.every((item) => item.installed))
  const busy = computed(() => items.value.some((item) => item.progress))
  const find = (id: DependencyId) => items.value.find((item) => item.id === id)

  let listening: Promise<void> | undefined

  async function load() {
    loadError.value = null
    try {
      listening ??= engine.listen((progress) => {
        const item = find(progress.id)
        if (item) item.progress = progress
      })
      await listening
      const list = await engine.status()
      items.value = list.map((status) => ({ ...status, latest: null, progress: null, error: null }))
      loaded.value = true
    } catch (cause) {
      listening = undefined
      loadError.value = `Couldn't read what's installed: ${messageOf(cause)}`
    }
  }

  /** Installs or updates. A failure leaves whatever was already installed in place. */
  async function install(id: DependencyId) {
    const item = find(id)
    if (!item || item.progress) return
    item.error = null
    item.progress = { id, stage: 'downloading', done: 0, total: null }
    try {
      const status = await engine.install(id)
      item.installed = status.installed
      item.version = status.version
      if (item.latest) item.latest = { ...item.latest, version: status.version ?? item.latest.version, updateAvailable: false }
    } catch (cause) {
      item.error = messageOf(cause)
    } finally {
      item.progress = null
    }
  }

  async function checkForUpdates() {
    if (checking.value) return
    checking.value = true
    checkError.value = null
    try {
      for (const latest of await engine.check()) {
        const item = find(latest.id)
        if (item) item.latest = latest
      }
    } catch (cause) {
      checkError.value = messageOf(cause)
    } finally {
      checking.value = false
    }
  }

  return { items, loaded, loadError, ready, busy, checking, checkError, load, install, checkForUpdates }
}

let shared: ReturnType<typeof createDependencies> | null | undefined

/** Null in a browser, which runs none of these programs. */
export function useDependencies() {
  if (shared === undefined) {
    const engine = getDependencyEngine()
    shared = engine ? createDependencies(engine) : null
  }
  return shared
}
