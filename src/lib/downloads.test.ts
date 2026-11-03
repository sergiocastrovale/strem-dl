import { describe, expect, it, vi } from 'vitest'
import { storageDb, type Db } from './db'
import {
  bulkSummary,
  createDownloads,
  displayName,
  downloadStateText,
  entryMeta,
  pickSources,
  savedName,
  formatBytes,
  formatDuration,
  kindFromAddress,
  kindFromHeaders,
  percentOf,
  selectFiles,
  type DownloadEntry,
  type LinkKind,
} from './downloads'
import type { FindOptions, FoundVideo } from './capture'
import type { TransferEngine, TransferEvent, TransferJob } from './transfer'

function memory() {
  const data = new Map<string, string>()
  return storageDb({
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  })
}

const opened = (url: string) => ({
  url,
  name: 'Film',
  addonUrl: 'https://a.test/manifest.json',
  addonName: 'A',
  path: [{ key: 'label:Movies', label: 'Movies' }],
})

const tick = () => new Promise((resolve) => setTimeout(resolve))

function fakeEngine() {
  const started: TransferJob[] = []
  let handler: (event: TransferEvent) => void = () => {}
  const engine: TransferEngine = {
    start: vi.fn(async (job: TransferJob) => void started.push(job)),
    pause: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    listen: async (next) => void (handler = next),
    probe: vi.fn(async () => false),
    captureOpen: vi.fn(async () => {}),
    captureShow: vi.fn(async () => {}),
    captureClose: vi.fn(async () => {}),
    captureListen: vi.fn(async () => {}),
  }
  return { engine, started, emit: (event: TransferEvent) => handler(event) }
}

function managed(db: Db = memory(), folder: string | null = '/dl', maxActive = () => 3) {
  const fake = fakeEngine()
  const list = createDownloads(Promise.resolve(db), {
    engine: fake.engine,
    folder: async () => folder,
    maxActive,
    classify: async () => 'file',
  })
  return { ...fake, list, db }
}

const statusOf = (list: ReturnType<typeof createDownloads>, url: string) => list.find(url)?.status

describe('kindFromAddress', () => {
  it('knows files by extension, ignoring case and query', () => {
    expect(kindFromAddress('https://cdn.io/a/Film.MKV?token=1')).toBe('file')
    expect(kindFromAddress('https://cdn.io/1.mp4')).toBe('file')
  })

  it('tells streams from files', () => {
    expect(kindFromAddress('https://cdn.io/live/index.m3u8')).toBe('stream')
    expect(kindFromAddress('https://cdn.io/a.mpd')).toBe('stream')
  })

  it('knows pages and things that are not files', () => {
    expect(kindFromAddress('https://a.io/watch.html')).toBe('page')
    expect(kindFromAddress('magnet:?xt=urn:btih:abc')).toBe('external')
    expect(kindFromAddress('nonsense')).toBe('external')
  })

  it('leaves the rest to the server', () => {
    expect(kindFromAddress('https://www.youtube.com/watch?v=abc')).toBeNull()
    expect(kindFromAddress('https://a.io/e/6h')).toBeNull()
    expect(kindFromAddress('https://a.io/v1.2/stream')).toBeNull()
  })

  it('looks through redirect wrappers', () => {
    const wrap = (target: string) => `https://addon.app/go?u=${encodeURIComponent(target)}&t=movie`
    expect(kindFromAddress(wrap('https://cdn.io/1.mp4'))).toBe('file')
    expect(kindFromAddress(wrap('https://playmogo.com/e/6h'))).toBeNull()
    expect(kindFromAddress(wrap('https://a.io/embed.html'))).toBe('page')
    expect(kindFromAddress(wrap('javascript:alert(1).mp4'))).toBeNull()
  })
})

describe('kindFromHeaders', () => {
  const check = (headers: Record<string, string>) => kindFromHeaders(new Headers(headers))

  it('goes by attachment, then by type', () => {
    expect(check({ 'Content-Type': 'text/html', 'Content-Disposition': 'attachment; filename="a.mp4"' })).toBe('file')
    expect(check({ 'Content-Type': 'video/mp4' })).toBe('file')
    expect(check({ 'Content-Type': 'application/octet-stream' })).toBe('file')
    expect(check({ 'Content-Type': 'application/vnd.apple.mpegurl' })).toBe('stream')
    expect(check({ 'Content-Type': 'application/dash+xml' })).toBe('stream')
    expect(check({ 'Content-Type': 'text/html; charset=utf-8' })).toBe('page')
    expect(check({ 'Content-Type': 'application/xhtml+xml' })).toBe('page')
    expect(check({ 'Content-Disposition': 'inline' })).toBe('page')
    expect(check({})).toBe('page')
  })
})

describe('formatting', () => {
  it('formats sizes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(150 * 1024 * 1024)).toBe('150 MB')
    expect(formatBytes(1.4 * 1024 ** 3)).toBe('1.4 GB')
  })

  it('formats durations', () => {
    expect(formatDuration(0.2)).toBe('1s')
    expect(formatDuration(70)).toBe('1m 10s')
    expect(formatDuration(3700)).toBe('1h 1m')
  })

  it('works out percent, without a total and never above 100', () => {
    expect(percentOf({ doneBytes: 62, totalBytes: 100 })).toBe(62)
    expect(percentOf({ doneBytes: 62, totalBytes: null })).toBeNull()
    expect(percentOf({ doneBytes: 200, totalBytes: 100 })).toBe(100)
  })
})

describe('selectFiles', () => {
  const link = (url: string) => ({ url })

  it('keeps what might be saved in order, whatever order the answers come in', async () => {
    const classify = async (url: string) => {
      await new Promise((resolve) => setTimeout(resolve, url === 'a' ? 15 : 1))
      return (url === 'm' ? 'external' : url === 'p' ? 'page' : url === 's' ? 'stream' : 'file') as LinkKind
    }
    const { files, skipped } = await selectFiles(['a', 'p', 'm', 'b', 's', 'c'].map(link), classify)
    expect(files.map((file) => file.url)).toEqual(['a', 'p', 'b', 's', 'c'])
    expect(skipped).toBe(1)
  })

  it('stops asking when told to', async () => {
    let live = true
    const classify = vi.fn(async () => {
      live = false
      return 'file' as const
    })
    await selectFiles(Array.from({ length: 50 }, (_, i) => link(String(i))), classify, () => live)
    expect(classify.mock.calls.length).toBeLessThanOrEqual(4)
  })
})

describe('bulkSummary', () => {
  const base = { label: 'Season 1', added: 0, skipped: 0, failed: 0, limited: false }

  it('says what happened, and only what matters', () => {
    expect(bulkSummary({ ...base, added: 1 })).toBe('Queued 1 file from Season 1.')
    expect(bulkSummary({ ...base })).toBe('Nothing new to queue from Season 1.')
    expect(bulkSummary({ ...base, added: 2, source: 'best' })).toBe(
      "Queued 2 files from Season 1. Taking the best quality copy of each title, and trying the others if it's unavailable.",
    )
    expect(bulkSummary({ ...base, added: 2, source: 'all' })).toBe('Queued 2 files from Season 1.')
    expect(bulkSummary({ ...base, added: 2, skipped: 1, failed: 2, limited: true })).toBe(
      "Queued 2 files from Season 1. Skipped 1 link that can't be saved. 2 parts couldn't be loaded. Stopped early: this addon is too big to scan in one go.",
    )
  })
})

describe('links handed to the browser', () => {
  it('records files and streams only, and they survive a reload', async () => {
    const db = memory()
    const kinds: Record<string, 'file' | 'stream' | 'page'> = { p: 'page', f: 'file', s: 'stream' }
    const list = createDownloads(Promise.resolve(db), { classify: async (link) => kinds[link] })
    for (const url of ['p', 'f', 's']) await list.recordOpened(opened(url))
    expect(list.items.value.map((e) => [e.url, e.status])).toEqual([
      ['s', 'opened'],
      ['f', 'opened'],
    ])
    expect(list.find('p')).toBeUndefined()
    expect(list.find(undefined)).toBeUndefined()
    expect((await db.downloads()).map((e) => e.url)).toEqual(['s', 'f'])
    expect(list.managed).toBe(false)
  })

  it('moves a link opened again to the top without asking again', async () => {
    const classify = vi.fn(async () => 'file' as const)
    const list = createDownloads(Promise.resolve(memory()), { classify })
    for (const url of ['a', 'b', 'a']) await list.recordOpened(opened(url))
    expect(list.items.value.map((e) => e.url)).toEqual(['a', 'b'])
    expect(classify).toHaveBeenCalledTimes(2)
  })

  it('uses a kind the caller already knows', async () => {
    const classify = vi.fn(async () => 'page' as const)
    const list = createDownloads(Promise.resolve(memory()), { classify })
    await list.recordOpened(opened('a'), 'stream')
    expect(classify).not.toHaveBeenCalled()
    expect(statusOf(list, 'a')).toBe('opened')
  })

  it('removes, clearing the mark', async () => {
    const db = memory()
    const list = createDownloads(Promise.resolve(db), { classify: async () => 'file' })
    await list.recordOpened(opened('a'))
    await list.remove('a')
    expect(list.find('a')).toBeUndefined()
    expect(await db.downloads()).toEqual([])
  })

  it('reports a database that fails to open', async () => {
    const list = createDownloads(Promise.reject(new Error('disk gone')), { classify: async () => 'file' })
    await expect(list.recordOpened(opened('a'))).rejects.toThrow('disk gone')
    expect(list.error.value).toBe("Couldn't load the downloads: disk gone")
  })
})

describe('downloads in the app', () => {
  it('starts a new download in the folder from settings', async () => {
    const { list, started } = managed()
    await list.download(opened('a'))
    await tick()
    expect(started).toEqual([
      {
        id: 'a',
        url: 'a',
        fallbackName: 'Film',
        folder: '/dl',
        filePath: null,
        validator: null,
        mode: 'file',
        referer: null,
        userAgent: null,
        exactName: false,
      },
    ])
    expect(statusOf(list, 'a')).toBe('downloading')
  })

  it('fails with a clear message when no folder is set', async () => {
    const { list, started } = managed(memory(), null)
    await list.download(opened('a'))
    await tick()
    expect(started).toEqual([])
    expect(statusOf(list, 'a')).toBe('failed')
    expect(list.find('a')?.error).toContain('Settings')
  })

  it('runs up to the limit, oldest first, and moves on as they end', async () => {
    const { list, started, emit } = managed()
    for (const url of ['a', 'b', 'c', 'd', 'e']) await list.download(opened(url))
    await tick()
    expect(started.map((job) => job.url)).toEqual(['a', 'b', 'c'])
    expect(statusOf(list, 'd')).toBe('queued')
    emit({ kind: 'finished', id: 'b', filePath: '/dl/b', done: 5 })
    await tick()
    expect(started.map((job) => job.url)).toEqual(['a', 'b', 'c', 'd'])
    emit({ kind: 'failed', id: 'a', done: 1, error: 'HTTP 500', expired: false })
    await tick()
    expect(started.map((job) => job.url)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('follows the limit as it changes', async () => {
    let limit = 1
    const { list, started, emit } = managed(memory(), '/dl', () => limit)
    for (const url of ['a', 'b', 'c', 'd']) await list.download(opened(url))
    await tick()
    expect(started.map((job) => job.url)).toEqual(['a'])

    limit = 3
    list.refill()
    await tick()
    expect(started.map((job) => job.url)).toEqual(['a', 'b', 'c'])

    // Lowering it leaves running ones alone and just holds back the next.
    limit = 1
    list.refill()
    emit({ kind: 'finished', id: 'a', filePath: '/dl/a', done: 1 })
    await tick()
    expect(started.map((job) => job.url)).toEqual(['a', 'b', 'c'])
  })

  it('queues many in order, continuing stopped ones and skipping the rest', async () => {
    const { list, started, emit } = managed(memory(), '/dl', () => 2)
    await list.download(opened('paused'))
    await tick()
    emit({ kind: 'paused', id: 'paused', done: 1 })
    await list.download(opened('over'))
    await tick()
    emit({ kind: 'finished', id: 'over', filePath: '/dl/over', done: 1 })
    await tick()
    started.length = 0

    const added = await list.downloadMany(['one', 'over', 'paused', 'two', 'one', 'three'].map(opened))
    await tick()
    expect(added).toBe(4)
    expect(started.map((job) => job.url)).toEqual(['paused', 'one'])
    expect(statusOf(list, 'over')).toBe('done')
    expect(statusOf(list, 'two')).toBe('queued')

    emit({ kind: 'finished', id: 'one', filePath: '/dl/one', done: 1 })
    await tick()
    expect(started.at(-1)?.url).toBe('two')
  })

  it('queues many in the same order after a restart', async () => {
    const db = memory()
    const first = managed(db, '/dl', () => 0)
    await first.list.downloadMany(['one', 'two', 'three'].map(opened))
    await first.list.saved()
    const second = managed(db, '/dl', () => 1)
    await tick()
    await tick()
    expect(second.started.map((job) => job.url)).toEqual(['one'])
  })

  it('tracks progress, speed and the end of a download', async () => {
    const { list, emit, db } = managed()
    await list.download(opened('a'))
    emit({ kind: 'started', id: 'a', filePath: '/dl/a.mkv', total: 100, validator: '"v"', done: 0, restarted: false })
    emit({ kind: 'progress', id: 'a', done: 40, total: 100, speed: 2048 })
    expect(list.find('a')).toMatchObject({ doneBytes: 40, totalBytes: 100, filePath: '/dl/a.mkv', validator: '"v"' })
    expect(list.speedOf('a')).toBe(2048)

    emit({ kind: 'finished', id: 'a', filePath: '/dl/a (1).mkv', done: 100 })
    await list.saved()
    expect(list.find('a')).toMatchObject({ status: 'done', doneBytes: 100, filePath: '/dl/a (1).mkv' })
    expect(list.speedOf('a')).toBe(0)
    expect((await db.downloads())[0]).toMatchObject({ status: 'done', filePath: '/dl/a (1).mkv' })
  })

  it('pauses when the engine confirms, and resumes from the saved file', async () => {
    const { list, engine, emit, started } = managed()
    await list.download(opened('a'))
    emit({ kind: 'started', id: 'a', filePath: '/dl/a.mkv', total: 100, validator: '"v"', done: 0, restarted: false })
    await list.pause('a')
    expect(engine.pause).toHaveBeenCalledWith('a')
    expect(statusOf(list, 'a')).toBe('downloading')
    emit({ kind: 'paused', id: 'a', done: 40 })
    expect(list.find('a')).toMatchObject({ status: 'paused', doneBytes: 40 })

    await list.resume('a')
    await tick()
    expect(started.at(-1)).toMatchObject({ filePath: '/dl/a.mkv', validator: '"v"' })
    expect(statusOf(list, 'a')).toBe('downloading')
  })

  it('pauses a queued download without bothering the engine', async () => {
    const { list, engine } = managed()
    for (const url of ['a', 'b', 'c', 'd']) await list.download(opened(url))
    await list.pause('d')
    expect(statusOf(list, 'd')).toBe('paused')
    expect(engine.pause).not.toHaveBeenCalled()
  })

  it('retries a failure, clearing its error', async () => {
    const { list, emit, started } = managed()
    await list.download(opened('a'))
    await tick()
    emit({ kind: 'failed', id: 'a', done: 10, error: 'Connection lost', expired: false })
    expect(list.find('a')).toMatchObject({ status: 'failed', error: 'Connection lost', doneBytes: 10 })
    await list.download(opened('a'))
    await tick()
    expect(list.find('a')).toMatchObject({ status: 'downloading', error: null })
    expect(started).toHaveLength(2)
  })

  it('leaves a running or finished download alone when asked again', async () => {
    const { list, emit, started } = managed()
    await list.download(opened('a'))
    await tick()
    await list.download(opened('a'))
    await tick()
    expect(started).toHaveLength(1)
    emit({ kind: 'finished', id: 'a', filePath: '/dl/a', done: 1 })
    await list.download(opened('a'))
    await tick()
    expect(started).toHaveLength(1)
    expect(statusOf(list, 'a')).toBe('done')
  })

  it('opening a downloading link outside the app keeps its status', async () => {
    const { list } = managed()
    await list.download(opened('a'))
    await list.recordOpened(opened('a'))
    expect(statusOf(list, 'a')).toBe('downloading')
  })

  it('downloads a link that was only opened before', async () => {
    const { list, started } = managed()
    await list.recordOpened(opened('a'), 'file')
    expect(statusOf(list, 'a')).toBe('opened')
    await list.download(opened('a'))
    await tick()
    expect(started).toHaveLength(1)
  })

  it('removing an unfinished download deletes its partial file, a finished one only the row', async () => {
    const { list, engine, emit, db } = managed()
    await list.download(opened('a'))
    emit({ kind: 'started', id: 'a', filePath: '/dl/a.mkv', total: 9, validator: null, done: 0, restarted: false })
    await list.remove('a')
    expect(engine.cancel).toHaveBeenCalledWith('a', '/dl/a.mkv')

    await list.download(opened('b'))
    emit({ kind: 'finished', id: 'b', filePath: '/dl/b.mkv', done: 1 })
    await list.remove('b')
    expect(engine.cancel).toHaveBeenCalledTimes(1)
    expect(await db.downloads()).toEqual([])
  })

  it('moves to the next one after a removal, and ignores late events for it', async () => {
    const { list, started, emit } = managed()
    for (const url of ['a', 'b', 'c', 'd']) await list.download(opened(url))
    await tick()
    await list.remove('a')
    await tick()
    expect(started.map((job) => job.url)).toEqual(['a', 'b', 'c', 'd'])
    expect(() => emit({ kind: 'progress', id: 'a', done: 1, total: 2, speed: 1 })).not.toThrow()
    expect(list.find('a')).toBeUndefined()
  })

  it('says when the server made a download start over', async () => {
    const { list, emit } = managed()
    await list.download(opened('a'))
    emit({ kind: 'started', id: 'a', filePath: '/dl/a', total: 9, validator: null, done: 0, restarted: true })
    emit({ kind: 'progress', id: 'a', done: 1, total: 9, speed: 1 })
    expect(list.noteOf('a')).toContain('started over')
  })

  it('reports an engine that refuses to start', async () => {
    const { engine, list } = managed()
    engine.start = vi.fn(async () => Promise.reject(new Error('refused')))
    await list.download(opened('a'))
    await tick()
    expect(list.find('a')).toMatchObject({ status: 'failed', error: 'refused' })
  })

  it('resumes after the app closed mid-transfer, but leaves paused ones paused', async () => {
    const db = memory()
    const entry = (url: string, status: DownloadEntry['status']): DownloadEntry => ({
      ...opened(url),
      openedAt: 1,
      status,
      totalBytes: 100,
      doneBytes: 10,
      filePath: `/dl/${url}`,
      validator: '"v"',
      error: null,
      mediaUrl: null,
      mediaKind: null,
      referer: null,
      userAgent: null,
      alternates: [],
      attempts: [],
    })
    await db.recordDownload(entry('running', 'downloading'))
    await db.recordDownload(entry('waiting', 'queued'))
    await db.recordDownload(entry('stopped', 'paused'))
    await db.recordDownload(entry('over', 'done'))
    const { list, started } = managed(db)
    await tick()
    await tick()
    expect(started.map((job) => job.url).sort()).toEqual(['running', 'waiting'])
    expect(started.find((job) => job.url === 'running')).toMatchObject({ filePath: '/dl/running', validator: '"v"' })
    expect(statusOf(list, 'stopped')).toBe('paused')
    expect(statusOf(list, 'over')).toBe('done')
  })
})

describe('pickSources', () => {
  const link = (url: string, title: string | null) => ({ ...opened(url), name: url.toUpperCase(), title })
  const film = [link('a1', 'a'), link('a2', 'a'), link('a3', 'a'), link('b1', 'b'), link('b2', 'b'), link('c1', 'c')]

  it('takes the first of each title, in order, with the rest to fall back on', () => {
    const links = pickSources(film, 'first')
    expect(links.map((l) => l.url)).toEqual(['a1', 'b1', 'c1'])
    expect(links[0].alternates).toEqual([
      { url: 'a2', name: 'A2' },
      { url: 'a3', name: 'A3' },
    ])
    expect(links[2].alternates).toEqual([])
  })

  const sized = (url: string, resolution?: string, sizeBytes?: number) => ({ ...link(url, 't'), meta: { resolution, sizeBytes } })

  it('takes the best quality: the highest resolution, then the biggest file', () => {
    const links = pickSources([sized('a', '720p', 9e9), sized('b', '1080p', 2e9), sized('c', '1080p', 6e9), sized('d', '480p')], 'best')
    expect(links.map((l) => l.url)).toEqual(['c'])
    expect(links[0].alternates?.map((c) => c.url)).toEqual(['d', 'a', 'b'])
  })

  it('takes the smallest file, leaving those of unknown size for last', () => {
    expect(pickSources([sized('a'), sized('b', '1080p', 6e9), sized('c', '720p', 1e9)], 'smallest').map((l) => l.url)).toEqual(['c'])
    expect(pickSources([sized('a'), sized('b')], 'smallest').map((l) => l.url)).toEqual(['a'])
  })

  it('keeps the first when nothing says which is better', () => {
    expect(pickSources([sized('a'), sized('b')], 'best').map((l) => l.url)).toEqual(['a'])
  })

  it('takes everything for all copies, with nothing to fall back on', () => {
    const links = pickSources(film, 'all')
    expect(links.map((l) => l.url)).toEqual(['a1', 'a2', 'a3', 'b1', 'b2', 'c1'])
    expect(links[0].alternates).toBeUndefined()
  })

  it('leaves links that are not sources of anything alone', () => {
    const links = pickSources([link('x', null), link('a1', 'a'), link('y', null), link('a2', 'a')], 'first')
    expect(links.map((l) => l.url)).toEqual(['x', 'a1', 'y'])
    expect(links[0].alternates).toBeUndefined()
  })

  it('does not carry its bookkeeping onto what gets saved', () => {
    for (const choice of ['first', 'all'] as const) {
      const [saved] = pickSources([sized('a', '720p', 1)], choice)
      expect(saved).not.toHaveProperty('title')
      expect(saved).not.toHaveProperty('meta')
    }
  })
})

describe('naming a download', () => {
  const folder = (label: string) => ({ key: label, label })

  it('uses the title, not the link text', () => {
    expect(displayName({ name: '🎥 BluRay\n📦 6 GB', path: [folder('Drama'), folder('O Rei Leão')] })).toBe('O Rei Leão')
  })

  it('adds the episode', () => {
    expect(displayName({ name: '1. Pilot › 720p', path: [folder('Show'), folder('Season 1')] })).toBe('Season 1 - 1. Pilot')
  })

  it('has only the link text without a path', () => {
    expect(displayName({ name: 'Trailer', path: [] })).toBe('Trailer')
  })

  it('reads what it can from the link text and address', () => {
    expect(entryMeta({ name: '🎥 WEB-DL 🎞️ HEVC', url: 'https://a.test/Film.1080p.mkv' })).toMatchObject({
      quality: 'WEB-DL',
      codec: 'HEVC',
      resolution: '1080p',
    })
  })
})

describe('downloadStateText', () => {
  const entry = (status: DownloadEntry['status'], doneBytes = 0, totalBytes: number | null = null) =>
    ({ status, doneBytes, totalBytes }) as DownloadEntry

  it('says what a link is doing, and nothing once finished', () => {
    expect(downloadStateText(undefined, null)).toBeNull()
    expect(downloadStateText(entry('done'), null)).toBeNull()
    expect(downloadStateText(entry('opened'), null)).toBeNull()
    expect(downloadStateText(entry('failed'), null)).toBe('Failed')
    expect(downloadStateText(entry('queued'), null)).toBe('Queued')
    expect(downloadStateText(entry('downloading'), 'Merging…')).toBe('Merging…')
    expect(downloadStateText(entry('downloading', 5, 10), null)).toBe('50%')
    expect(downloadStateText(entry('downloading'), null)).toBe('Downloading')
    expect(downloadStateText(entry('paused', 5, 10), null)).toBe('Paused 50%')
  })
})

describe('other sources', () => {
  const withSources = (url: string, ...others: string[]) => ({
    ...opened(url),
    alternates: others.map((other) => ({ url: other, name: other })),
  })

  it('moves on to the next source of a title that never delivered, keeping one row', async () => {
    const { list, started, emit, db } = managed()
    await list.downloadMany([withSources('one', 'two', 'three')])
    await tick()
    emit({ kind: 'failed', id: 'one', done: 0, error: 'HTTP 404', expired: true })
    await tick()
    await tick()
    expect(started.map((job) => job.url)).toEqual(['one', 'two'])
    expect(list.items.value.map((item) => item.url)).toEqual(['two'])
    expect(list.find('two')).toMatchObject({
      status: 'downloading',
      alternates: [{ url: 'three', name: 'three' }],
      attempts: [{ name: 'Film', error: 'HTTP 404' }],
    })
    await list.saved()
    expect((await db.downloads()).map((entry) => entry.url)).toEqual(['two'])
  })

  it('shows every reason once no source works', async () => {
    const { list, emit } = managed()
    await list.downloadMany([withSources('one', 'two')])
    await tick()
    emit({ kind: 'failed', id: 'one', done: 0, error: 'HTTP 404', expired: true })
    await tick()
    await tick()
    emit({ kind: 'failed', id: 'two', done: 0, error: 'HTTP 410', expired: true })
    await tick()
    expect(list.find('two')).toMatchObject({
      status: 'failed',
      error: 'HTTP 410',
      attempts: [{ name: 'Film', error: 'HTTP 404' }],
    })
  })

  it('keeps a source that saved some video, for Resume, rather than starting another', async () => {
    const { list, started, emit } = managed()
    await list.downloadMany([withSources('one', 'two')])
    await tick()
    emit({ kind: 'failed', id: 'one', done: 500, error: 'Connection lost', expired: false })
    await tick()
    expect(started).toHaveLength(1)
    expect(list.find('one')).toMatchObject({ status: 'failed', doneBytes: 500 })
    expect(list.find('two')).toBeUndefined()
  })

  it('tidies up after a source it gives up on', async () => {
    const { list, engine, emit } = managed()
    await list.downloadMany([withSources('one', 'two')])
    await tick()
    emit({ kind: 'started', id: 'one', filePath: '/dl/x.mp4', total: null, validator: null, done: 0, restarted: false })
    emit({ kind: 'failed', id: 'one', done: 0, error: 'HTTP 403', expired: true })
    expect(engine.cancel).toHaveBeenCalledWith('one', '/dl/x.mp4')
  })

  it('skips a source already in the list', async () => {
    const { list, started, emit } = managed()
    await list.downloadMany([opened('two')])
    await list.downloadMany([withSources('one', 'two', 'three')])
    await tick()
    emit({ kind: 'failed', id: 'one', done: 0, error: 'HTTP 404', expired: true })
    await tick()
    await tick()
    expect(started.map((job) => job.url)).toEqual(['two', 'one', 'three'])
  })

  it('keeps its place in the queue', async () => {
    const { list, emit } = managed(memory(), '/dl', () => 1)
    await list.downloadMany([withSources('one', 'two'), opened('after')])
    await tick()
    emit({ kind: 'failed', id: 'one', done: 0, error: 'HTTP 404', expired: true })
    await tick()
    await tick()
    expect(statusOf(list, 'two')).toBe('downloading')
    expect(statusOf(list, 'after')).toBe('queued')
  })

  it('remembers the sources left across a restart', async () => {
    const db = memory()
    const first = managed(db)
    await first.list.downloadMany([withSources('one', 'two')])
    await first.list.saved()
    const second = managed(db)
    await tick()
    await tick()
    second.emit({ kind: 'failed', id: 'one', done: 0, error: 'HTTP 404', expired: true })
    await tick()
    await tick()
    expect(second.started.map((job) => job.url)).toEqual(['one', 'two'])
  })
})

describe('savedName', () => {
  const movie = [{ key: 'label:Movies', label: 'Filmes' }, { key: 'meta:m', label: 'Wall-e' }]

  it('says which film an option belongs to', () => {
    expect(savedName({ name: 'Opcao 1', path: movie })).toBe('Wall-e - Opcao 1')
  })

  it('says which show and episode', () => {
    expect(savedName({ name: 'Pilot › Opcao 1', path: movie })).toBe('Wall-e - Pilot - Opcao 1')
  })

  it("doesn't repeat itself, and copes with no path", () => {
    expect(savedName({ name: 'Wall-e', path: movie })).toBe('Wall-e')
    expect(savedName({ name: 'Film', path: [] })).toBe('Film')
  })
})

describe('videos on pages', () => {
  const PAGE = 'https://host.test/e/1'
  const video = (kind: FoundVideo['kind'], url = 'https://cdn.test/v'): FoundVideo => ({
    url,
    kind,
    referer: PAGE,
    userAgent: 'UA',
  })

  /** A find that stays pending until the test settles it. */
  function pendingFinder() {
    const calls: { url: string; options: FindOptions; settle: (found: FoundVideo | null) => void }[] = []
    const resolve = vi.fn(
      (url: string, options: FindOptions) =>
        new Promise<FoundVideo | null>((settle) => {
          calls.push({ url, options, settle })
          options.signal.addEventListener('abort', () => settle(null))
        }),
    )
    return { resolve, calls }
  }

  function withPages(
    kinds: Record<string, LinkKind> = {},
    finder: { resolve: (url: string, options: FindOptions) => Promise<FoundVideo | null> } = pendingFinder(),
    db: Db = memory(),
  ) {
    const fake = fakeEngine()
    const list = createDownloads(Promise.resolve(db), {
      engine: fake.engine,
      folder: async () => '/dl',
      maxActive: () => 3,
      classify: async (link) => kinds[link] ?? 'page',
      resolve: finder.resolve,
    })
    return { ...fake, list, db }
  }

  const settle = async () => {
    await tick()
    await tick()
  }

  it('fetches a found file directly, as the page would, under our own name', async () => {
    const finder = pendingFinder()
    const { list, started } = withPages({}, finder)
    await list.download(opened(PAGE))
    await settle()
    expect(list.stageOf(PAGE)).toBe('Finding video…')
    expect(started).toEqual([])

    finder.calls[0].settle(video('file'))
    await settle()
    expect(started).toEqual([
      {
        id: PAGE,
        url: 'https://cdn.test/v',
        fallbackName: 'Movies - Film',
        folder: '/dl',
        filePath: null,
        validator: null,
        mode: 'file',
        referer: PAGE,
        userAgent: 'UA',
        exactName: true,
      },
    ])
    expect(list.find(PAGE)).toMatchObject({ mediaUrl: 'https://cdn.test/v', mediaKind: 'file', status: 'downloading' })
  })

  it('saves a found stream with the media engine', async () => {
    const finder = pendingFinder()
    const { list, started } = withPages({}, finder)
    await list.download(opened(PAGE))
    await settle()
    finder.calls[0].settle(video('stream', 'https://cdn.test/a.m3u8'))
    await settle()
    expect(started[0]).toMatchObject({ url: 'https://cdn.test/a.m3u8', mode: 'media', exactName: false, referer: PAGE })
  })

  it('lets yt-dlp fetch a page it understands', async () => {
    const finder = pendingFinder()
    const { list, started } = withPages({}, finder)
    await list.download(opened(PAGE))
    await settle()
    finder.calls[0].settle({ url: PAGE, kind: 'extract', referer: null, userAgent: null })
    await settle()
    expect(started[0]).toMatchObject({ url: PAGE, mode: 'media' })
  })

  it('says it is looking from the moment it starts, until bytes move', async () => {
    let answer: (kind: LinkKind) => void = () => {}
    const fake = fakeEngine()
    const list = createDownloads(Promise.resolve(memory()), {
      engine: fake.engine,
      folder: async () => '/dl',
      classify: () => new Promise<LinkKind>((resolve) => (answer = resolve)),
    })
    await list.download(opened('https://a.test/x'))
    await settle()
    expect(list.stageOf('https://a.test/x')).toBe('Finding video…')
    answer('file')
    await settle()
    expect(list.stageOf('https://a.test/x')).toBeNull()
    expect(fake.started[0]).toMatchObject({ mode: 'file', exactName: false, fallbackName: 'Film' })
  })

  it('saves a link straight to a stream without looking at any page', async () => {
    const finder = pendingFinder()
    const { list, started } = withPages({ 'https://cdn.test/a.m3u8': 'stream' }, finder)
    await list.download(opened('https://cdn.test/a.m3u8'))
    await settle()
    expect(finder.resolve).not.toHaveBeenCalled()
    expect(started[0]).toMatchObject({ url: 'https://cdn.test/a.m3u8', mode: 'media', referer: null })
  })

  it("won't try to save a link meant for another program", async () => {
    const finder = pendingFinder()
    const { list, started } = withPages({ 'magnet:?x': 'external' }, finder)
    await list.download(opened('magnet:?x'))
    await settle()
    expect(finder.resolve).not.toHaveBeenCalled()
    expect(started).toEqual([])
    expect(statusOf(list, 'magnet:?x')).toBe('failed')
  })

  it('may ask a person about one chosen link, but never during a bulk download', async () => {
    const finder = pendingFinder()
    const { list } = withPages({}, finder)
    await list.download(opened('https://host.test/one'))
    await list.downloadMany([opened('https://host.test/many')])
    await settle()
    const asked = (url: string) => finder.calls.find((call) => call.url === url)?.options.interactive
    expect(asked('https://host.test/one')).toBe(true)
    expect(asked('https://host.test/many')).toBe(false)
  })

  it('says when a person needs to press play', async () => {
    const finder = pendingFinder()
    const { list } = withPages({}, finder)
    await list.download(opened(PAGE))
    await settle()
    finder.calls[0].options.onVisible?.()
    expect(list.stageOf(PAGE)).toBe('Press play in the window')
  })

  it('fails with a way forward when nothing is found, and moves on', async () => {
    const finder = pendingFinder()
    const fake = fakeEngine()
    const list = createDownloads(Promise.resolve(memory()), {
      engine: fake.engine,
      folder: async () => '/dl',
      maxActive: () => 1,
      classify: async (link) => (link === 'next' ? 'file' : 'page'),
      resolve: finder.resolve,
    })
    await list.downloadMany([opened(PAGE), opened('next')])
    await settle()
    finder.calls[0].settle(null)
    await settle()
    expect(list.find(PAGE)).toMatchObject({ status: 'failed', error: expect.stringContaining('Press Resume') })
    expect(fake.started.map((job) => job.id)).toEqual(['next'])
  })

  it('tries the next source when a page has no video', async () => {
    const finder = pendingFinder()
    const { list } = withPages({}, finder)
    await list.downloadMany([{ ...opened(PAGE), alternates: [{ url: 'https://host.test/e/2', name: 'Other' }] }])
    await settle()
    finder.calls[0].settle(null)
    await settle()
    expect(finder.calls[1].url).toBe('https://host.test/e/2')
    expect(list.find('https://host.test/e/2')?.attempts[0].error).toContain('No video found')
    expect(list.find(PAGE)).toBeUndefined()
  })

  it('resuming after nothing was found looks again, and may ask a person this time', async () => {
    const finder = pendingFinder()
    const { list } = withPages({}, finder)
    await list.downloadMany([opened(PAGE)])
    await settle()
    finder.calls[0].settle(null)
    await settle()
    await list.resume(PAGE)
    await settle()
    expect(finder.calls).toHaveLength(2)
    expect(finder.calls[1].options.interactive).toBe(true)
  })

  it('pausing calls off the search, with nothing left for the engine to confirm', async () => {
    const finder = pendingFinder()
    const { list, engine, started } = withPages({}, finder)
    await list.download(opened(PAGE))
    await settle()
    await list.pause(PAGE)
    await settle()
    expect(finder.calls[0].options.signal.aborted).toBe(true)
    expect(statusOf(list, PAGE)).toBe('paused')
    expect(engine.pause).not.toHaveBeenCalled()
    expect(started).toEqual([])
    expect(list.stageOf(PAGE)).toBeNull()
  })

  it('a pause during a search frees a slot for the next download', async () => {
    const finder = pendingFinder()
    const fake = fakeEngine()
    const list = createDownloads(Promise.resolve(memory()), {
      engine: fake.engine,
      folder: async () => '/dl',
      maxActive: () => 1,
      classify: async (link) => (link === 'next' ? 'file' : 'page'),
      resolve: finder.resolve,
    })
    await list.downloadMany([opened(PAGE), opened('next')])
    await settle()
    await list.pause(PAGE)
    await settle()
    expect(fake.started.map((job) => job.id)).toEqual(['next'])
  })

  it('removing calls off the search and starts nothing', async () => {
    const finder = pendingFinder()
    const { list, started } = withPages({}, finder)
    await list.download(opened(PAGE))
    await settle()
    await list.remove(PAGE)
    await settle()
    expect(finder.calls[0].options.signal.aborted).toBe(true)
    expect(list.find(PAGE)).toBeUndefined()
    expect(started).toEqual([])
  })

  it('opening the link during a search does not orphan the download', async () => {
    const finder = pendingFinder()
    const { list, started } = withPages({}, finder)
    await list.download(opened(PAGE))
    await settle()
    await list.recordOpened(opened(PAGE))
    finder.calls[0].settle(video('file'))
    await settle()
    expect(started).toHaveLength(1)
    expect(statusOf(list, PAGE)).toBe('downloading')
  })

  it('finds an expired link again, once, keeping the saved file', async () => {
    const finder = pendingFinder()
    const { list, started, emit } = withPages({}, finder)
    await list.download(opened(PAGE))
    await settle()
    finder.calls[0].settle(video('file', 'https://cdn.test/old'))
    await settle()
    emit({ kind: 'started', id: PAGE, filePath: '/dl/Film.mp4', total: 100, validator: null, done: 0, restarted: false })

    emit({ kind: 'failed', id: PAGE, done: 40, error: 'HTTP 403', expired: true })
    await settle()
    expect(statusOf(list, PAGE)).toBe('downloading')
    finder.calls[1].settle(video('file', 'https://cdn.test/new'))
    await settle()
    expect(started[1]).toMatchObject({ url: 'https://cdn.test/new', filePath: '/dl/Film.mp4' })

    emit({ kind: 'failed', id: PAGE, done: 40, error: 'HTTP 403', expired: true })
    await settle()
    expect(finder.calls).toHaveLength(2)
    expect(list.find(PAGE)).toMatchObject({ status: 'failed', error: 'HTTP 403' })
  })

  it('does not look for a new link on other failures, or for a link with no page behind it', async () => {
    const finder = pendingFinder()
    const { list, emit } = withPages({ 'https://cdn.test/a.m3u8': 'stream' }, finder)
    await list.download(opened('https://cdn.test/a.m3u8'))
    await settle()
    emit({ kind: 'failed', id: 'https://cdn.test/a.m3u8', done: 0, error: 'HTTP 403', expired: true })
    await settle()
    expect(finder.resolve).not.toHaveBeenCalled()
    expect(statusOf(list, 'https://cdn.test/a.m3u8')).toBe('failed')

    await list.download(opened(PAGE))
    await settle()
    finder.calls[0].settle(video('stream'))
    await settle()
    emit({ kind: 'failed', id: PAGE, done: 0, error: 'Disk full', expired: false })
    await settle()
    expect(finder.calls).toHaveLength(1)
    expect(statusOf(list, PAGE)).toBe('failed')
  })

  it('opens the page itself when yt-dlp understood it but could not save it', async () => {
    const finder = pendingFinder()
    const { list, engine, started, emit } = withPages({}, finder)
    await list.download(opened(PAGE))
    await settle()
    expect(finder.calls[0].options.skipProbe).toBe(false)
    finder.calls[0].settle({ url: PAGE, kind: 'extract', referer: null, userAgent: null })
    await settle()
    emit({ kind: 'started', id: PAGE, filePath: '/dl/Film.mp4', total: null, validator: null, done: 0, restarted: false })
    emit({ kind: 'failed', id: PAGE, done: 5, error: 'HTTP Error 403', expired: true })
    await settle()
    expect(finder.calls[1].options.skipProbe).toBe(true)
    finder.calls[1].settle(video('stream', 'https://cdn.test/a.m3u8'))
    await settle()
    expect(engine.cancel).toHaveBeenCalledWith(PAGE, '/dl/Film.mp4')
    expect(started[1]).toMatchObject({ url: 'https://cdn.test/a.m3u8', mode: 'media', filePath: null })
  })

  it('drops old working files when a new find is fetched differently', async () => {
    const finder = pendingFinder()
    const { list, engine, started, emit } = withPages({}, finder)
    await list.download(opened(PAGE))
    await settle()
    finder.calls[0].settle(video('file'))
    await settle()
    emit({ kind: 'started', id: PAGE, filePath: '/dl/Film.mp4', total: 100, validator: null, done: 0, restarted: false })
    emit({ kind: 'failed', id: PAGE, done: 40, error: 'HTTP 403', expired: true })
    await settle()
    finder.calls[1].settle(video('stream', 'https://cdn.test/a.m3u8'))
    await settle()
    expect(engine.cancel).toHaveBeenCalledWith(PAGE, '/dl/Film.mp4')
    expect(started[1]).toMatchObject({ mode: 'media', filePath: null, folder: '/dl' })
  })

  it('remembers what was found across a restart', async () => {
    const db = memory()
    const finder = pendingFinder()
    const first = withPages({}, finder, db)
    await first.list.download(opened(PAGE))
    await settle()
    finder.calls[0].settle(video('stream', 'https://cdn.test/a.m3u8'))
    await settle()
    first.emit({ kind: 'started', id: PAGE, filePath: '/dl/Film.mp4', total: null, validator: null, done: 0, restarted: false })
    await first.list.saved()

    const again = pendingFinder()
    const second = withPages({}, again, db)
    await settle()
    await settle()
    expect(again.resolve).not.toHaveBeenCalled()
    expect(second.started[0]).toMatchObject({
      url: 'https://cdn.test/a.m3u8',
      mode: 'media',
      filePath: '/dl/Film.mp4',
      referer: PAGE,
      userAgent: 'UA',
    })
  })

  it('shows merging, and clears it when done', async () => {
    const finder = pendingFinder()
    const { list, emit } = withPages({}, finder)
    await list.download(opened(PAGE))
    await settle()
    finder.calls[0].settle(video('stream'))
    await settle()
    emit({ kind: 'stage', id: PAGE, stage: 'merging' })
    expect(list.stageOf(PAGE)).toBe('Merging…')
    emit({ kind: 'finished', id: PAGE, filePath: '/dl/Film.mp4', done: 9 })
    expect(list.stageOf(PAGE)).toBeNull()
  })

  it('keeps a plain download started before all this going without any lookup', async () => {
    const db = memory()
    await db.recordDownload({
      ...opened(PAGE),
      openedAt: 1,
      status: 'downloading',
      totalBytes: 100,
      doneBytes: 10,
      filePath: '/dl/old.mkv',
      validator: null,
      error: null,
      mediaUrl: null,
      mediaKind: null,
      referer: null,
      userAgent: null,
      alternates: [],
      attempts: [],
    })
    const classify = vi.fn(async () => 'page' as const)
    const finder = pendingFinder()
    const fake = fakeEngine()
    createDownloads(Promise.resolve(db), {
      engine: fake.engine,
      folder: async () => '/dl',
      classify,
      resolve: finder.resolve,
    })
    await settle()
    await settle()
    expect(classify).not.toHaveBeenCalled()
    expect(fake.started[0]).toMatchObject({ url: PAGE, mode: 'file', filePath: '/dl/old.mkv', exactName: false })
  })
})
