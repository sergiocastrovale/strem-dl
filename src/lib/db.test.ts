/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { sqliteDb, storageDb, type Db } from './db'

// Runs the migration the desktop app ships, on a real SQLite engine.
function sqlite(): Db {
  const db = new DatabaseSync(':memory:')
  for (const file of ['001_init.sql', '002_watchlist.sql', '003_downloads.sql', '004_transfers_settings.sql', '005_media.sql', '006_copies.sql', '007_watch_poster.sql', '008_saved.sql']) {
    db.exec(readFileSync(`src-tauri/migrations/${file}`, 'utf8'))
  }
  return sqliteDb({
    select: async <T>(query: string, params: unknown[] = []) =>
      db.prepare(query).all(...(params as SQLInputValue[])) as T,
    execute: async (query, params = []) => db.prepare(query).run(...(params as SQLInputValue[])),
  })
}

function storage(): Db {
  const data = new Map<string, string>()
  return storageDb({
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  })
}

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value))

describe.each([
  ['sqlite', sqlite],
  ['storage', storage],
])('%s db', (_, create) => {
  it('adds saved addons in order, ignores duplicates, removes', async () => {
    const db = create()
    await db.addSaved({ url: 'a', name: 'A' })
    await db.addSaved({ url: 'b', name: 'B' })
    await db.addSaved({ url: 'a', name: 'A again' })
    expect(plain(await db.saved())).toEqual([
      { url: 'a', name: 'A' },
      { url: 'b', name: 'B' },
    ])
    await db.removeSaved('a')
    expect(plain(await db.saved())).toEqual([{ url: 'b', name: 'B' }])
  })

  it('keeps one history entry per url, most recent first', async () => {
    const db = create()
    await db.recordHistory({ url: 'a', name: 'A', lastUsedAt: 1 })
    await db.recordHistory({ url: 'b', name: 'B', lastUsedAt: 2 })
    await db.recordHistory({ url: 'a', name: 'A renamed', lastUsedAt: 3 })
    expect(plain(await db.history())).toEqual([
      { url: 'a', name: 'A renamed', lastUsedAt: 3 },
      { url: 'b', name: 'B', lastUsedAt: 2 },
    ])
  })

  it('keeps one watchlist entry per folder and removes by key', async () => {
    const db = create()
    const movies = { key: 'label:Movies', label: 'Movies' }
    const film = { key: 'meta:movie:m1', label: 'Film' }
    await db.addWatch({ url: 'a', addonName: 'A', path: [movies] })
    await db.addWatch({ url: 'a', addonName: 'A', path: [movies, film] })
    await db.addWatch({ url: 'b', addonName: 'B', path: [movies] })
    await db.addWatch({ url: 'a', addonName: 'A', path: [movies, { ...film, label: 'Renamed' }] })
    expect((await db.watchlist()).map((e) => [e.url, e.path.length])).toEqual([
      ['a', 1],
      ['a', 2],
      ['b', 1],
    ])
    expect((await db.watchlist())[1].path).toEqual([movies, film])

    await db.removeWatch('a', [movies, { ...film, label: 'Other' }])
    expect((await db.watchlist()).map((e) => [e.url, e.path.length])).toEqual([
      ['a', 1],
      ['b', 1],
    ])
  })

  it('keeps one download per link, most recently opened first, and removes', async () => {
    const db = create()
    const path = [{ key: 'label:Movies', label: 'Movies' }]
    const entry = {
      url: 'a',
      name: 'A',
      addonUrl: 's',
      addonName: 'S',
      path,
      openedAt: 1,
      status: 'paused' as const,
      totalBytes: 100,
      doneBytes: 40,
      filePath: '/d/a.mkv',
      validator: '"v1"',
      error: null,
      mediaUrl: 'https://c.test/a.m3u8',
      mediaKind: 'stream' as const,
      referer: 'https://h.test/e/1',
      userAgent: 'UA',
      alternates: [{ url: 'b2', name: 'B 2' }],
      attempts: [{ name: 'B 0', error: 'HTTP 404' }],
    }
    await db.recordDownload(entry)
    await db.recordDownload({ ...entry, url: 'b', name: 'B', openedAt: 2 })
    await db.recordDownload({ ...entry, name: 'A again', openedAt: 3 })
    expect(plain(await db.downloads())).toEqual([
      { ...entry, name: 'A again', openedAt: 3 },
      { ...entry, url: 'b', name: 'B', openedAt: 2 },
    ])
    await db.removeDownload('a')
    expect((await db.downloads()).map((e) => e.url)).toEqual(['b'])
  })

  it('sets, replaces and removes a setting', async () => {
    const db = create()
    expect(await db.setting('folder')).toBeNull()
    await db.setSetting('folder', '/a')
    await db.setSetting('folder', '/b')
    expect(await db.setting('folder')).toBe('/b')
    await db.setSetting('folder', null)
    expect(await db.setting('folder')).toBeNull()
  })

  it('removes a history entry', async () => {
    const db = create()
    await db.recordHistory({ url: 'a', name: 'A', lastUsedAt: 1 })
    await db.recordHistory({ url: 'b', name: 'B', lastUsedAt: 2 })
    await db.removeHistory('a')
    await db.removeHistory('missing')
    expect(plain(await db.history())).toEqual([{ url: 'b', name: 'B', lastUsedAt: 2 }])
  })
})

describe('storage db', () => {
  it('fills in downloads saved before they had progress', async () => {
    const old = { url: 'a', name: 'A', addonUrl: 's', addonName: 'S', path: [], openedAt: 1 }
    const db = storageDb({ getItem: () => JSON.stringify([old]), setItem: () => {}, removeItem: () => {} })
    expect(await db.downloads()).toEqual([
      {
        ...old,
        status: 'opened',
        totalBytes: null,
        doneBytes: 0,
        filePath: null,
        validator: null,
        error: null,
        mediaUrl: null,
        mediaKind: null,
        referer: null,
        userAgent: null,
        alternates: [],
        attempts: [],
      },
    ])
  })

  it('reads addon details saved under their old names, and saves only the new ones', async () => {
    const data = new Map<string, string>([
      ['strem-dl:watchlist', JSON.stringify([{ url: 'u', sourceName: 'Kids', path: [] }])],
      ['strem-dl:downloads', JSON.stringify([{ url: 'd', name: 'n', sourceUrl: 'u', sourceName: 'Kids', path: [] }])],
    ])
    const db = storageDb({
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => void data.set(key, value),
      removeItem: (key) => void data.delete(key),
    })
    expect((await db.watchlist())[0]).toEqual({ url: 'u', addonName: 'Kids', path: [] })
    const [entry] = await db.downloads()
    expect(entry).toMatchObject({ addonUrl: 'u', addonName: 'Kids' })
    expect(entry).not.toHaveProperty('sourceUrl')
    expect(entry).not.toHaveProperty('sourceName')
    await db.recordDownload({ ...entry, url: 'e' })
    expect(data.get('strem-dl:downloads')).not.toContain('sourceUrl')
    expect(data.get('strem-dl:downloads')).not.toContain('sourceName')
  })

  it('moves addons saved under the old favorites key', async () => {
    const data = new Map<string, string>([['strem-dl:favorites', JSON.stringify([{ url: 'a', name: 'A' }])]])
    const db = storageDb({
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => void data.set(k, v),
      removeItem: (k) => void data.delete(k),
    })
    expect(await db.saved()).toEqual([{ url: 'a', name: 'A' }])
    expect(data.has('strem-dl:favorites')).toBe(false)
    expect(data.has('strem-dl:saved')).toBe(true)
  })

  it('treats corrupt data as empty', async () => {
    const db = storageDb({ getItem: () => '{nope', setItem: () => {}, removeItem: () => {} })
    expect(await db.saved()).toEqual([])
    expect(await db.history()).toEqual([])
  })
})
