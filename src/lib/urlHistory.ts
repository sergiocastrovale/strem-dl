import { ref } from 'vue'
import type { Db, HistoryEntry } from './db'
import { getDb } from './platform'

const MAX_SUGGESTIONS = 8

/** Saved URLs matching what was typed, skipping one that is already typed in full. */
export function matchHistory(entries: HistoryEntry[], query: string, limit = MAX_SUGGESTIONS): HistoryEntry[] {
  const text = query.trim().toLowerCase()
  return entries
    .filter((entry) => {
      const url = entry.url.toLowerCase()
      return url !== text && (url.includes(text) || entry.name.toLowerCase().includes(text))
    })
    .slice(0, limit)
}

export function createUrlHistory(database: Promise<Db>, now: () => number = Date.now) {
  const entries = ref<HistoryEntry[]>([])

  // A failed load only costs suggestions; record() reports the failure when it's next used.
  const ready = database.then(async (db) => {
    entries.value = await db.history()
    return db
  })
  ready.catch(() => {})

  async function record(url: string, name: string) {
    const db = await ready
    const entry = { url, name, lastUsedAt: now() }
    await db.recordHistory(entry)
    entries.value = [entry, ...entries.value.filter((item) => item.url !== url)]
  }

  async function remove(url: string) {
    const db = await ready
    await db.removeHistory(url)
    entries.value = entries.value.filter((item) => item.url !== url)
  }

  return { entries, record, remove }
}

let shared: ReturnType<typeof createUrlHistory> | undefined

export function useUrlHistory() {
  return (shared ??= createUrlHistory(getDb()))
}
