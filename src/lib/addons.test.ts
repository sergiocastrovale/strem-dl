import { describe, expect, it } from 'vitest'
import { storageDb } from './db'
import { createAddons } from './addons'

function memory() {
  const data = new Map<string, string>()
  return storageDb({ getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) })
}

const URL_A = 'https://a.test/manifest.json'

describe('addons', () => {
  it('toggles and persists', async () => {
    const db = memory()
    const addons = createAddons(Promise.resolve(db))
    await addons.toggle(URL_A, 'A')
    expect(addons.has(URL_A)).toBe(true)
    expect(await db.addons()).toEqual([{ url: URL_A, name: 'A' }])
    await addons.toggle(URL_A, 'A')
    expect(addons.has(URL_A)).toBe(false)
    expect(await db.addons()).toEqual([])
  })

  it('loads the addons already added', async () => {
    const db = memory()
    await db.addAddon({ url: URL_A, name: 'A' })
    const addons = createAddons(Promise.resolve(db))
    await addons.toggle(URL_A, 'A')
    expect(addons.items.value).toEqual([])
  })

  it('treats query-string variants of one addon as the same addon', async () => {
    const addons = createAddons(Promise.resolve(memory()))
    await addons.add(URL_A, 'A')
    await addons.add(`${URL_A}?x=1`, 'A again')
    expect(addons.items.value).toHaveLength(1)
    expect(addons.has(`${URL_A}#frag`)).toBe(true)
  })

  it('rejects an address that is not an addon url', async () => {
    const addons = createAddons(Promise.resolve(memory()))
    await expect(addons.add('nope', 'X')).rejects.toThrow('Not a valid URL')
  })

  it('reports a database that fails to open, and rejects writes', async () => {
    const addons = createAddons(Promise.reject(new Error('disk gone')))
    await expect(addons.add(URL_A, 'A')).rejects.toThrow('disk gone')
    expect(addons.error.value).toBe("Couldn't load addons: disk gone")
    expect(addons.items.value).toEqual([])
  })
})
