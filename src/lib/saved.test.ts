import { describe, expect, it } from 'vitest'
import { storageDb } from './db'
import { createSaved } from './saved'

function memory() {
  const data = new Map<string, string>()
  return storageDb({ getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) })
}

const URL_A = 'https://a.test/manifest.json'

describe('saved', () => {
  it('toggles and persists', async () => {
    const db = memory()
    const saved = createSaved(Promise.resolve(db))
    await saved.toggle(URL_A, 'A')
    expect(saved.has(URL_A)).toBe(true)
    expect(await db.saved()).toEqual([{ url: URL_A, name: 'A' }])
    await saved.toggle(URL_A, 'A')
    expect(saved.has(URL_A)).toBe(false)
    expect(await db.saved()).toEqual([])
  })

  it('loads what is already saved', async () => {
    const db = memory()
    await db.addSaved({ url: URL_A, name: 'A' })
    const saved = createSaved(Promise.resolve(db))
    await saved.toggle(URL_A, 'A')
    expect(saved.items.value).toEqual([])
  })

  it('treats query-string variants of one addon as the same saved addon', async () => {
    const saved = createSaved(Promise.resolve(memory()))
    await saved.add(URL_A, 'A')
    await saved.add(`${URL_A}?x=1`, 'A again')
    expect(saved.items.value).toHaveLength(1)
    expect(saved.has(`${URL_A}#frag`)).toBe(true)
  })

  it('rejects an address that is not an addon url', async () => {
    const saved = createSaved(Promise.resolve(memory()))
    await expect(saved.add('nope', 'X')).rejects.toThrow('Not a valid URL')
  })

  it('reports a database that fails to open, and rejects writes', async () => {
    const saved = createSaved(Promise.reject(new Error('disk gone')))
    await expect(saved.add(URL_A, 'A')).rejects.toThrow('disk gone')
    expect(saved.error.value).toBe("Couldn't load saved addons: disk gone")
    expect(saved.items.value).toEqual([])
  })
})
