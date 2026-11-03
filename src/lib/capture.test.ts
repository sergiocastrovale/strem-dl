import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCapture, createResolver, pickStream } from './capture'
import type { CaptureEvent, CaptureFind } from './transfer'

const find = (url: string, extra: Partial<CaptureFind> = {}): CaptureFind => ({
  url,
  via: 'xhr',
  contentType: null,
  duration: null,
  width: null,
  referer: 'https://host.test/e/1',
  userAgent: 'UA',
  ...extra,
})

describe('pickStream', () => {
  it('takes the first manifest, as players load the master before its variants', () => {
    const master = find('https://c.test/master.m3u8')
    expect(pickStream([master, find('https://c.test/index-v1.m3u8')])).toEqual({
      url: master.url,
      kind: 'stream',
      referer: 'https://host.test/e/1',
      userAgent: 'UA',
    })
  })

  it('knows a manifest by its type when the address has no extension', () => {
    const hls = find('https://c.test/playlist', { contentType: 'application/vnd.apple.mpegurl' })
    const dash = find('https://c.test/d', { contentType: 'application/dash+xml' })
    expect(pickStream([hls])?.kind).toBe('stream')
    expect(pickStream([dash])?.kind).toBe('stream')
    expect(pickStream([find('https://c.test/a.mpd?x=1')])?.kind).toBe('stream')
  })

  it('prefers a manifest over any file', () => {
    const film = find('https://c.test/film', { duration: 5000 })
    expect(pickStream([film, find('https://c.test/a.m3u8')])?.kind).toBe('stream')
  })

  it('takes a long video straight away', () => {
    expect(pickStream([find('https://c.test/film', { duration: 5890 })])).toMatchObject({
      url: 'https://c.test/film',
      kind: 'file',
    })
  })

  it('keeps waiting while a video might be an ad', () => {
    expect(pickStream([find('https://ads.test/a.mp4', { duration: 30 })])).toBeNull()
    expect(pickStream([find('https://c.test/film')])).toBeNull()
    expect(pickStream([])).toBeNull()
  })

  it('picks the longest once time is up', () => {
    const short = find('https://ads.test/a.mp4', { duration: 30 })
    const longer = find('https://c.test/b.mp4', { duration: 90 })
    expect(pickStream([short, longer], true)?.url).toBe(longer.url)
    expect(pickStream([find('https://c.test/unknown')], true)?.url).toBe('https://c.test/unknown')
    expect(pickStream([], true)).toBeNull()
  })
})

function fakeWindows() {
  let handler: (event: CaptureEvent) => void = () => {}
  const opened: string[] = []
  const ids: string[] = []
  const engine = {
    captureOpen: vi.fn(async (id: string, url: string) => {
      ids.push(id)
      opened.push(url)
    }),
    captureShow: vi.fn(async () => {}),
    captureClose: vi.fn(async () => {}),
    captureListen: vi.fn(async (next: (event: CaptureEvent) => void) => {
      handler = next
    }),
  }
  return { engine, opened, ids, emit: (event: CaptureEvent) => handler(event) }
}

const options = (extra = {}) => ({ interactive: false, signal: new AbortController().signal, ...extra })
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('createCapture', () => {
  beforeEach(() => void vi.useFakeTimers())
  afterEach(() => void vi.useRealTimers())

  it('opens hidden, returns what it finds and closes the window', async () => {
    const { engine, ids, emit } = fakeWindows()
    const result = createCapture(engine)('https://host.test/e/1', options())
    await settle()
    expect(engine.captureOpen).toHaveBeenCalledWith(ids[0], 'https://host.test/e/1', false)
    emit({ kind: 'found', id: ids[0], ...find('https://c.test/a.m3u8') })
    expect((await result)?.url).toBe('https://c.test/a.m3u8')
    expect(engine.captureClose).toHaveBeenCalledWith(ids[0])
    expect(engine.captureShow).not.toHaveBeenCalled()
  })

  it('waits for a video to report how long it is', async () => {
    const { engine, ids, emit } = fakeWindows()
    const result = createCapture(engine)('https://host.test/e/1', options())
    await settle()
    emit({ kind: 'found', id: ids[0], ...find('https://c.test/film') })
    await settle()
    expect(engine.captureClose).not.toHaveBeenCalled()
    emit({ kind: 'found', id: ids[0], ...find('https://c.test/film', { duration: 5890 }) })
    expect((await result)?.kind).toBe('file')
  })

  it('in bulk, gives up after the hidden wait without showing anything', async () => {
    const { engine } = fakeWindows()
    const result = createCapture(engine, { hiddenWait: 100 })('https://host.test/e/1', options())
    await settle()
    await vi.advanceTimersByTimeAsync(100)
    expect(await result).toBeNull()
    expect(engine.captureShow).not.toHaveBeenCalled()
    expect(engine.captureClose).toHaveBeenCalled()
  })

  it('settles for a short video when time is up, without asking anyone', async () => {
    const { engine, ids, emit } = fakeWindows()
    const result = createCapture(engine, { hiddenWait: 100 })('https://host.test/e/1', options({ interactive: true }))
    await settle()
    emit({ kind: 'found', id: ids[0], ...find('https://c.test/clip.mp4', { duration: 60 }) })
    await vi.advanceTimersByTimeAsync(100)
    expect((await result)?.url).toBe('https://c.test/clip.mp4')
    expect(engine.captureShow).not.toHaveBeenCalled()
  })

  it('asks a person to press play, then finishes when they do', async () => {
    const { engine, ids, emit } = fakeWindows()
    const onVisible = vi.fn()
    const result = createCapture(engine, { hiddenWait: 100 })(
      'https://host.test/e/1',
      options({ interactive: true, onVisible }),
    )
    await settle()
    await vi.advanceTimersByTimeAsync(100)
    expect(engine.captureShow).toHaveBeenCalledWith(ids[0])
    expect(onVisible).toHaveBeenCalledOnce()
    emit({ kind: 'found', id: ids[0], ...find('https://c.test/a.m3u8') })
    expect((await result)?.kind).toBe('stream')
  })

  it('finds nothing if the person closes the window', async () => {
    const { engine, ids, emit } = fakeWindows()
    const result = createCapture(engine, { hiddenWait: 100 })('https://host.test/e/1', options({ interactive: true }))
    await settle()
    await vi.advanceTimersByTimeAsync(100)
    emit({ kind: 'closed', id: ids[0] })
    expect(await result).toBeNull()
  })

  it('stops waiting for a person eventually', async () => {
    const { engine } = fakeWindows()
    const result = createCapture(engine, { hiddenWait: 100, visibleWait: 500 })(
      'https://host.test/e/1',
      options({ interactive: true }),
    )
    await settle()
    await vi.advanceTimersByTimeAsync(600)
    expect(await result).toBeNull()
  })

  it('closes the window when aborted', async () => {
    const { engine } = fakeWindows()
    const abort = new AbortController()
    const result = createCapture(engine)('https://host.test/e/1', options({ signal: abort.signal }))
    await settle()
    abort.abort()
    expect(await result).toBeNull()
    expect(engine.captureClose).toHaveBeenCalled()
  })

  it('reports a window that fails to open', async () => {
    const { engine } = fakeWindows()
    engine.captureOpen.mockRejectedValueOnce(new Error('no window'))
    await expect(createCapture(engine)('https://host.test/e/1', options())).rejects.toThrow('no window')
  })

  it('ignores events from other windows', async () => {
    const { engine, ids, emit } = fakeWindows()
    const result = createCapture(engine)('https://host.test/e/1', options())
    await settle()
    emit({ kind: 'found', id: 'someone-else', ...find('https://evil.test/a.m3u8') })
    await settle()
    emit({ kind: 'found', id: ids[0], ...find('https://c.test/a.m3u8') })
    expect((await result)?.url).toBe('https://c.test/a.m3u8')
  })

  it('opens at most two windows at once, and the rest wait their turn', async () => {
    const { engine, ids, opened, emit } = fakeWindows()
    const capture = createCapture(engine)
    const results = ['a', 'b', 'c'].map((name) => capture(`https://host.test/${name}`, options()))
    await settle()
    expect(opened).toEqual(['https://host.test/a', 'https://host.test/b'])
    emit({ kind: 'found', id: ids[0], ...find('https://c.test/a.m3u8') })
    await results[0]
    await settle()
    expect(opened).toHaveLength(3)
    emit({ kind: 'found', id: ids[1], ...find('https://c.test/b.m3u8') })
    emit({ kind: 'found', id: ids[2], ...find('https://c.test/c.m3u8') })
    await Promise.all(results)
  })

  it('never opens a window for a find aborted while waiting its turn', async () => {
    const { engine, ids, opened, emit } = fakeWindows()
    const capture = createCapture(engine, { maxWindows: 1 })
    const first = capture('https://host.test/a', options())
    const abort = new AbortController()
    const second = capture('https://host.test/b', options({ signal: abort.signal }))
    await settle()
    abort.abort()
    expect(await second).toBeNull()
    expect(opened).toEqual(['https://host.test/a'])
    emit({ kind: 'found', id: ids[0], ...find('https://c.test/a.m3u8') })
    await first
  })
})

describe('createResolver', () => {
  it('lets yt-dlp read pages it understands, without opening them', async () => {
    const capture = vi.fn()
    const resolve = createResolver(async () => true, capture)
    expect(await resolve('https://video.test/w', options())).toEqual({
      url: 'https://video.test/w',
      kind: 'extract',
      referer: null,
      userAgent: null,
    })
    expect(capture).not.toHaveBeenCalled()
  })

  it('opens the page otherwise, and stops asking yt-dlp about that host', async () => {
    const probe = vi.fn(async (_url: string) => false)
    const capture = vi.fn(async () => null)
    const resolve = createResolver(probe, capture)
    await resolve('https://embed.test/e/1', options())
    await resolve('https://embed.test/e/2', options())
    await resolve('https://other.test/e/3', options())
    expect(probe.mock.calls.map(([url]) => url)).toEqual(['https://embed.test/e/1', 'https://other.test/e/3'])
    expect(capture).toHaveBeenCalledTimes(3)
  })

  it('still opens the page when yt-dlp fails to run', async () => {
    const capture = vi.fn(async () => null)
    await createResolver(async () => {
      throw new Error('missing')
    }, capture)('https://embed.test/e/1', options())
    expect(capture).toHaveBeenCalledOnce()
  })

  it('goes straight to the page when yt-dlp already failed on it', async () => {
    const probe = vi.fn(async () => true)
    const capture = vi.fn(async () => null)
    await createResolver(probe, capture)('https://embed.test/e/1', options({ skipProbe: true }))
    expect(probe).not.toHaveBeenCalled()
    expect(capture).toHaveBeenCalledOnce()
  })

  it('opens nothing once aborted', async () => {
    const abort = new AbortController()
    const capture = vi.fn(async () => null)
    const resolve = createResolver(async () => {
      abort.abort()
      return false
    }, capture)
    expect(await resolve('https://embed.test/e/1', options({ signal: abort.signal }))).toBeNull()
    expect(capture).not.toHaveBeenCalled()
  })
})
