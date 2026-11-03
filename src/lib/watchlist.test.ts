import { describe, expect, it } from 'vitest'
import { storageDb } from './db'
import { createWatchlist, parseWatchPath } from './watchlist'

function memory() {
  const data = new Map<string, string>()
  return storageDb({ getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) })
}

const URL_A = 'https://a.test/manifest.json'
const PATH = [{ key: 'label:Movies', label: 'Movies' }, { key: 'meta:movie:m1', label: 'Film' }]
const ENTRY = { url: URL_A, addonName: 'A', path: PATH }

describe('watchlist', () => {
  it('toggles, persists and reloads', async () => {
    const db = memory()
    const list = createWatchlist(Promise.resolve(db))
    await list.toggle(ENTRY)
    expect(list.has(URL_A, PATH)).toBe(true)
    expect(createWatchlist(Promise.resolve(db)).has(URL_A, PATH)).toBe(false) // Not loaded yet.
    const reloaded = createWatchlist(Promise.resolve(db))
    await reloaded.toggle(ENTRY)
    expect(reloaded.items.value).toEqual([])
    expect(await db.watchlist()).toEqual([])
  })

  it('identifies a folder by key, so a renamed folder is still the same one', async () => {
    const list = createWatchlist(Promise.resolve(memory()))
    await list.add(ENTRY)
    expect(list.has(URL_A, [PATH[0], { key: 'meta:movie:m1', label: 'Renamed' }])).toBe(true)
    expect(list.has(URL_A, [PATH[0]])).toBe(false)
    expect(list.has('https://b.test/manifest.json', PATH)).toBe(false)
    expect(list.has(null, PATH)).toBe(false)
  })

  it('reports a database that fails to open', async () => {
    const list = createWatchlist(Promise.reject(new Error('disk gone')))
    await expect(list.add(ENTRY)).rejects.toThrow('disk gone')
    expect(list.error.value).toBe("Couldn't load the watchlist: disk gone")
  })
})

describe('parseWatchPath', () => {
  it('accepts a path and rejects anything else', () => {
    expect(parseWatchPath(JSON.stringify(PATH))).toEqual(PATH)
    for (const bad of [undefined, '', '{nope', '[]', '{}', '[{"key":"a"}]', ['x']]) {
      expect(parseWatchPath(bad)).toBeNull()
    }
  })
})
