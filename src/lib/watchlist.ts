import { computed, ref } from 'vue'
import type { PathSegment } from './addon'
import { watchPathKey, type Db, type WatchEntry } from './db'
import { getDb } from './platform'

export type { WatchEntry }

const identity = (url: string, path: PathSegment[]) => `${url}\n${watchPathKey(path)}`

/** A path from the route, or null if it isn't one. */
export function parseWatchPath(raw: unknown): PathSegment[] | null {
  if (typeof raw !== 'string' || !raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    const valid =
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every((segment) => typeof segment?.key === 'string' && typeof segment?.label === 'string')
    return valid ? (parsed as PathSegment[]) : null
  } catch {
    return null
  }
}

export function createWatchlist(database: Promise<Db>) {
  const items = ref<WatchEntry[]>([])
  const error = ref<string | null>(null)
  const watched = computed(() => new Set(items.value.map((entry) => identity(entry.url, entry.path))))

  const ready = database.then(async (db) => {
    items.value = await db.watchlist()
    return db
  })
  ready.catch((cause) => {
    error.value = `Couldn't load the watchlist: ${cause instanceof Error ? cause.message : String(cause)}`
  })

  function has(url: string | null, path: PathSegment[]): boolean {
    return url !== null && watched.value.has(identity(url, path))
  }

  async function add(entry: WatchEntry) {
    const db = await ready
    await db.addWatch(entry)
    if (!has(entry.url, entry.path)) items.value = [...items.value, entry]
  }

  async function remove(url: string, path: PathSegment[]) {
    const db = await ready
    await db.removeWatch(url, path)
    const target = identity(url, path)
    items.value = items.value.filter((entry) => identity(entry.url, entry.path) !== target)
  }

  async function toggle(entry: WatchEntry) {
    await ready
    if (has(entry.url, entry.path)) await remove(entry.url, entry.path)
    else await add(entry)
  }

  return { items, error, has, add, remove, toggle }
}

let shared: ReturnType<typeof createWatchlist> | undefined

export function useWatchlist() {
  return (shared ??= createWatchlist(getDb()))
}
