import { describe, expect, it } from 'vitest'
import { storageDb, type HistoryEntry } from './db'
import { createUrlHistory, matchHistory } from './urlHistory'

const entry = (url: string, name: string): HistoryEntry => ({ url, name, lastUsedAt: 0 })
const CINE = entry('https://cine.test/manifest.json', 'Cinema')
const KIDS = entry('https://kids.test/manifest.json', 'Filmes')

describe('matchHistory', () => {
  it('matches url or name, ignoring case and keeping order', () => {
    expect(matchHistory([CINE, KIDS], 'KIDS')).toEqual([KIDS])
    expect(matchHistory([CINE, KIDS], 'filmes')).toEqual([KIDS])
    expect(matchHistory([CINE, KIDS], 'https')).toEqual([CINE, KIDS])
  })

  it('returns everything for empty text and nothing without a match', () => {
    expect(matchHistory([CINE, KIDS], ' ')).toEqual([CINE, KIDS])
    expect(matchHistory([CINE, KIDS], 'zzz')).toEqual([])
  })

  it('skips the url already typed in full', () => {
    expect(matchHistory([CINE, KIDS], CINE.url)).toEqual([])
  })

  it('caps the list', () => {
    expect(matchHistory([CINE, KIDS], 'https', 1)).toEqual([CINE])
  })
})

describe('createUrlHistory', () => {
  it('loads saved entries and moves a reused url to the front', async () => {
    const data = new Map<string, string>()
    const db = storageDb({ getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) })
    await db.recordHistory(CINE)
    await db.recordHistory(KIDS)

    const history = createUrlHistory(Promise.resolve(db), () => 5)
    await history.record(CINE.url, 'Cinema')
    expect(history.entries.value.map((e) => e.url)).toEqual([CINE.url, KIDS.url])
    expect(await db.history()).toEqual(history.entries.value)
  })

  it('removes an entry from the list and the database', async () => {
    const data = new Map<string, string>()
    const db = storageDb({ getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) })
    await db.recordHistory(CINE)
    await db.recordHistory(KIDS)

    const history = createUrlHistory(Promise.resolve(db))
    await history.remove(CINE.url)
    expect(history.entries.value).toEqual([KIDS])
    expect(await db.history()).toEqual([KIDS])
  })

  it('rejects record() when the database failed to open', async () => {
    const history = createUrlHistory(Promise.reject(new Error('disk gone')))
    await expect(history.record(CINE.url, 'Cinema')).rejects.toThrow('disk gone')
  })
})
