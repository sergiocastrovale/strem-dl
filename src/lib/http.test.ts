import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchHeaders, fetchJson } from './http'

afterEach(() => vi.unstubAllGlobals())

describe('fetchHeaders', () => {
  const typed = (status = 200) => new Response(null, { status, headers: { 'Content-Type': 'video/mp4' } })

  it('asks with HEAD', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => typed())
    vi.stubGlobal('fetch', fetch)
    expect((await fetchHeaders('https://a.io/x'))?.get('content-type')).toBe('video/mp4')
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0][1].method).toBe('HEAD')
  })

  it('falls back to a one-byte GET when HEAD is refused', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => (init.method === 'HEAD' ? typed(405) : typed(206)))
    vi.stubGlobal('fetch', fetch)
    expect((await fetchHeaders('https://a.io/x'))?.get('content-type')).toBe('video/mp4')
    expect(fetch.mock.calls[1][1]).toMatchObject({ method: 'GET', headers: { Range: 'bytes=0-0' } })
  })

  it('is null when nothing works', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch')
    })
    expect(await fetchHeaders('https://a.io/x')).toBeNull()
  })
})

describe('fetchJson in a browser', () => {
  it('returns parsed JSON using the global fetch', async () => {
    const fetch = vi.fn(async () => new Response('{"id":"a"}'))
    vi.stubGlobal('fetch', fetch)
    await expect(fetchJson('https://a.io/manifest.json')).resolves.toEqual({ id: 'a' })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('reports HTTP errors', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 404 }))
    await expect(fetchJson('https://a.io/x.json')).rejects.toThrow('HTTP 404')
  })

  it('reports invalid JSON', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>'))
    await expect(fetchJson('https://a.io/x.json')).rejects.toThrow('not valid JSON')
  })

  it('explains CORS blocks and network failures', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(fetchJson('https://a.io/x.json')).rejects.toThrow('try the desktop app')
  })

  it('leaves other errors unchanged', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('boom')
    })
    await expect(fetchJson('https://a.io/x.json')).rejects.toThrow('boom')
  })
})
