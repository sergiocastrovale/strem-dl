import { describe, expect, it } from 'vitest'
import { storageDb } from './db'
import { createFavorites } from './favorites'

function memory() {
  const data = new Map<string, string>()
  return storageDb({ getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) })
}

const URL_A = 'https://a.test/manifest.json'

describe('favorites', () => {
  it('toggles and persists', async () => {
    const db = memory()
    const favs = createFavorites(Promise.resolve(db))
    await favs.toggle(URL_A, 'A')
    expect(favs.has(URL_A)).toBe(true)
    expect(await db.favorites()).toEqual([{ url: URL_A, name: 'A' }])
    await favs.toggle(URL_A, 'A')
    expect(favs.has(URL_A)).toBe(false)
    expect(await db.favorites()).toEqual([])
  })

  it('loads what is already saved', async () => {
    const db = memory()
    await db.addFavorite({ url: URL_A, name: 'A' })
    const favs = createFavorites(Promise.resolve(db))
    await favs.toggle(URL_A, 'A')
    expect(favs.items.value).toEqual([])
  })

  it('treats query-string variants of one addon as the same favorite', async () => {
    const favs = createFavorites(Promise.resolve(memory()))
    await favs.add(URL_A, 'A')
    await favs.add(`${URL_A}?x=1`, 'A again')
    expect(favs.items.value).toHaveLength(1)
    expect(favs.has(`${URL_A}#frag`)).toBe(true)
  })

  it('adds from a url using the manifest name', async () => {
    const favs = createFavorites(Promise.resolve(memory()))
    await favs.addFromUrl(URL_A, async () => ({ id: 'a', name: 'Addon A', resources: [] }))
    expect(favs.items.value).toEqual([{ url: URL_A, name: 'Addon A' }])
    await expect(favs.addFromUrl('nope', async () => ({}))).rejects.toThrow('Not a valid URL')
  })

  it('reports a database that fails to open, and rejects writes', async () => {
    const favs = createFavorites(Promise.reject(new Error('disk gone')))
    await expect(favs.add(URL_A, 'A')).rejects.toThrow('disk gone')
    expect(favs.error.value).toBe("Couldn't load favorites: disk gone")
    expect(favs.items.value).toEqual([])
  })
})
