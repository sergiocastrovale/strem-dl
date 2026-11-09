import { ref } from 'vue'
import { addonBase } from './addon'
import type { Db, SavedAddon } from './db'
import { getDb } from './platform'

export type { SavedAddon }

/** Canonical manifest URL, so the same addon pasted two ways is one saved addon. */
export function normalizeUrl(input: string): string {
  return `${addonBase(input)}/manifest.json`
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function createSaved(database: Promise<Db>) {
  const items = ref<SavedAddon[]>([])
  const error = ref<string | null>(null)

  const ready = database.then(async (db) => {
    items.value = await db.saved()
    return db
  })
  ready.catch((cause) => {
    error.value = `Couldn't load saved addons: ${messageOf(cause)}`
  })

  function keyOf(url: string | null): string | null {
    if (!url) return null
    try {
      return normalizeUrl(url)
    } catch {
      return null
    }
  }

  function has(url: string | null): boolean {
    const key = keyOf(url)
    return key !== null && items.value.some((f) => f.url === key)
  }

  async function add(url: string, name: string) {
    const key = normalizeUrl(url)
    const db = await ready
    await db.addSaved({ url: key, name })
    if (!has(key)) items.value = [...items.value, { url: key, name }]
  }

  async function remove(url: string) {
    const key = normalizeUrl(url)
    const db = await ready
    await db.removeSaved(key)
    items.value = items.value.filter((f) => f.url !== key)
  }

  async function toggle(url: string, name: string) {
    await ready
    if (has(url)) await remove(url)
    else await add(url, name)
  }

  return { items, error, has, add, remove, toggle }
}

let shared: ReturnType<typeof createSaved> | undefined

export function useSaved() {
  return (shared ??= createSaved(getDb()))
}
