import { ref } from 'vue'
import { addonBase, parseManifest } from './addon'
import type { Db, Favorite } from './db'
import { getDb } from './platform'

export type { Favorite }

/** Canonical manifest URL, so the same addon pasted two ways is one favorite. */
export function normalizeUrl(input: string): string {
  return `${addonBase(input)}/manifest.json`
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function createFavorites(database: Promise<Db>) {
  const items = ref<Favorite[]>([])
  const error = ref<string | null>(null)

  const ready = database.then(async (db) => {
    items.value = await db.favorites()
    return db
  })
  ready.catch((cause) => {
    error.value = `Couldn't load favorites: ${messageOf(cause)}`
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
    await db.addFavorite({ url: key, name })
    if (!has(key)) items.value = [...items.value, { url: key, name }]
  }

  async function remove(url: string) {
    const key = normalizeUrl(url)
    const db = await ready
    await db.removeFavorite(key)
    items.value = items.value.filter((f) => f.url !== key)
  }

  async function toggle(url: string, name: string) {
    await ready
    if (has(url)) await remove(url)
    else await add(url, name)
  }

  /** Fetch the manifest to learn the addon's name, then add it. Returns that name. */
  async function addFromUrl(input: string, fetchJson: (url: string) => Promise<unknown>): Promise<string> {
    const key = normalizeUrl(input)
    const { name } = parseManifest(await fetchJson(key))
    await add(key, name)
    return name
  }

  return { items, error, has, add, remove, toggle, addFromUrl }
}

let shared: ReturnType<typeof createFavorites> | undefined

export function useFavorites() {
  return (shared ??= createFavorites(getDb()))
}
