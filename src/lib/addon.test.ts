import { describe, expect, it } from 'vitest'
import {
  addonBase,
  completeAddonUrl,
  addonNode,
  canOpen,
  derivedYouTubeLink,
  itemNode,
  linkHost,
  metaChildren,
  newItems,
  parseManifest,
  resourceUrl,
  loaderUrl,
  streamLink,
  streamNodes,
  supports,
  type Manifest,
  linkFilterOf,
} from './addon'

const youtube: Manifest = {
  id: 'yt',
  name: 'YouTube',
  version: '1.30.7',
  resources: ['catalog', 'meta'],
  types: ['channel'],
  idPrefixes: ['yt_id:'],
  catalogs: [
    {
      type: 'channel',
      id: 'top',
      extra: [
        { name: 'search' },
        { name: 'genre', options: ['Gaming', 'Beauty & Fashion'] },
        { name: 'skip' },
      ],
    },
    { type: 'channel', id: 'videos', extra: [{ name: 'search', isRequired: true }] },
  ],
}

const kids: Manifest = {
  id: 'kids',
  name: 'Kids',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie', 'series'],
  idPrefixes: ['kidspt_movie_', 'kidspt_series_'],
  catalogs: [
    { type: 'movie', id: 'filmes', name: 'Filmes', extra: [{ name: 'search' }, { name: 'skip' }] },
  ],
}

describe('addonBase', () => {
  it('keeps the path of configured addons', () => {
    expect(addonBase(' https://x.io/cfg=1/manifest.json ')).toBe('https://x.io/cfg=1')
    expect(addonBase('http://127.0.0.1:7000/manifest.json')).toBe('http://127.0.0.1:7000')
  })

  it('assumes /manifest.json when it is missing', () => {
    expect(addonBase('https://x.io')).toBe('https://x.io')
    expect(addonBase('https://x.io/')).toBe('https://x.io')
    expect(addonBase('https://x.io/cfg=1/')).toBe('https://x.io/cfg=1')
  })

  it('assumes https when there is no scheme', () => {
    expect(addonBase('x.io/cfg=1')).toBe('https://x.io/cfg=1')
    expect(addonBase('localhost:7000')).toBe('http://localhost:7000')
    expect(addonBase('127.0.0.1:7000/x')).toBe('http://127.0.0.1:7000/x')
  })

  it('rejects anything else', () => {
    expect(() => addonBase('nope')).toThrow('Not a valid URL')
    expect(() => addonBase('https://x.io/meta/a.json')).toThrow('/manifest.json')
    expect(() => addonBase('ftp://x.io/manifest.json')).toThrow('http and https')
  })
})

describe('completeAddonUrl', () => {
  it('fills in what is missing', () => {
    expect(completeAddonUrl('https://x.io')).toBe('https://x.io/manifest.json')
    expect(completeAddonUrl(' x.io/cfg=1/ ')).toBe('https://x.io/cfg=1/manifest.json')
    expect(completeAddonUrl('http://127.0.0.1:7000')).toBe('http://127.0.0.1:7000/manifest.json')
    expect(completeAddonUrl('localhost:7000')).toBe('http://localhost:7000/manifest.json')
  })

  it('leaves a complete address as it is, dropping any query', () => {
    expect(completeAddonUrl('https://x.io/manifest.json')).toBe('https://x.io/manifest.json')
    expect(completeAddonUrl('https://x.io/a/manifest.json?x=1')).toBe('https://x.io/a/manifest.json')
  })

  it('says nothing while it is not an address yet, or is something else', () => {
    for (const typed of ['', '  ', 'h', 'https', 'https:/', 'nope', 'ftp://x.io', 'https://x.io/meta/a.json', 'a b.io']) {
      expect(completeAddonUrl(typed), typed).toBeNull()
    }
  })
})

describe('parseManifest', () => {
  it('rejects JSON that is not a manifest', () => {
    expect(() => parseManifest({ meta: {} })).toThrow('Not an addon manifest')
    expect(() => parseManifest(null)).toThrow('Not an addon manifest')
  })

  it('tolerates missing and malformed catalogs', () => {
    expect(parseManifest({ id: 'a', name: 'A', resources: [] }).catalogs).toEqual([])
    const parsed = parseManifest({ id: 'a', name: 'A', resources: [], catalogs: [{ type: 'movie', id: 'x' }, 7] })
    expect(parsed.catalogs).toHaveLength(1)
  })
})

describe('routes', () => {
  it('encodes ids and extra values', () => {
    expect(resourceUrl('https://x', 'meta', 'channel', 'yt_id:UC1')).toBe('https://x/meta/channel/yt_id%3AUC1.json')
    expect(resourceUrl('https://x', 'catalog', 'channel', 'top', { genre: 'Beauty & Fashion', skip: 96 })).toBe(
      'https://x/catalog/channel/top/genre=Beauty%20%26%20Fashion&skip=96.json',
    )
  })

  it('omits skip on the first page', () => {
    const loader = { kind: 'catalog', type: 'movie', catalogId: 'c', pageable: true } as const
    expect(loaderUrl('https://x', loader)).toBe('https://x/catalog/movie/c.json')
    expect(loaderUrl('https://x', loader, 100)).toBe('https://x/catalog/movie/c/skip=100.json')
  })
})

describe('supports', () => {
  it('reads string resources against manifest types and prefixes', () => {
    expect(supports(youtube, 'meta', 'channel', 'yt_id:UC1')).toBe(true)
    expect(supports(youtube, 'stream', 'channel', 'yt_id:UC1')).toBe(false)
    expect(supports(youtube, 'meta', 'movie', 'yt_id:UC1')).toBe(false)
    expect(supports(youtube, 'meta', 'channel', 'tt123')).toBe(false)
  })

  it('lets object resources override types and prefixes', () => {
    const manifest: Manifest = {
      ...kids,
      resources: [{ name: 'stream', types: ['movie'], idPrefixes: ['tt'] }],
    }
    expect(supports(manifest, 'stream', 'movie', 'tt1')).toBe(true)
    expect(supports(manifest, 'stream', 'series', 'tt1')).toBe(false)
    expect(supports(manifest, 'stream', 'movie', 'kidspt_movie_a')).toBe(false)
  })
})

describe('addonNode', () => {
  it('builds All and genre folders, and locks required extras', () => {
    const [top, videos] = addonNode(youtube).children ?? []
    expect(top.label).toBe('channel / top')
    expect(top.children?.map((c) => c.label)).toEqual(['All', 'Gaming', 'Beauty & Fashion'])
    expect(top.children?.[1].loader).toMatchObject({ kind: 'catalog', genre: 'Gaming', pageable: true })
    expect(videos).toMatchObject({ kind: 'locked', hint: 'requires search' })
  })

  it('puts items straight under catalogs with no genres', () => {
    const [filmes] = addonNode(kids).children ?? []
    expect(filmes.label).toBe('Filmes')
    expect(filmes.children).toBeUndefined()
    expect(filmes.loader).toMatchObject({ kind: 'catalog', catalogId: 'filmes', pageable: true })
  })

  it('hides All when genre is required', () => {
    const manifest = parseManifest({
      id: 'a',
      name: 'A',
      resources: ['catalog'],
      catalogs: [{ type: 'movie', id: 'c', extra: [{ name: 'genre', isRequired: true, options: ['Drama'] }] }],
    })
    expect(addonNode(manifest).children?.[0].children?.map((c) => c.label)).toEqual(['Drama'])
  })

  it('locks a required genre that has no options', () => {
    const manifest = parseManifest({
      id: 'a',
      name: 'A',
      resources: ['catalog'],
      catalogs: [{ type: 'movie', id: 'c', extra: [{ name: 'genre', isRequired: true }] }],
    })
    expect(addonNode(manifest).children?.[0]).toMatchObject({ kind: 'locked', hint: 'requires genre' })
  })

  it('reads legacy catalog fields', () => {
    const manifest = parseManifest({
      id: 'a',
      name: 'A',
      resources: ['catalog'],
      catalogs: [{ type: 'movie', id: 'c', extraSupported: ['genre', 'skip'], genres: ['Drama'] }],
    })
    const [catalog] = addonNode(manifest).children ?? []
    expect(catalog.children?.map((c) => c.label)).toEqual(['All', 'Drama'])
    expect(catalog.children?.[0].loader).toMatchObject({ pageable: true })
  })

  it('explains stream-only addons', () => {
    const manifest = parseManifest({ id: 'a', name: 'A', resources: ['stream'] })
    expect(addonNode(manifest).children?.[0].kind).toBe('note')
  })
})

describe('newItems', () => {
  it('dedupes across pages and drops malformed entries', () => {
    const seen = new Set<string>()
    expect(newItems({ metas: [{ id: 'a' }, { id: 'b' }, { name: 'no id' }, 3] }, seen)).toHaveLength(2)
    expect(newItems({ metas: [{ id: 'b' }, { id: 'c' }] }, seen).map((m) => m.id)).toEqual(['c'])
    expect(newItems({ metas: [{ id: 'c' }] }, seen)).toEqual([])
  })

  it('rejects responses without metas', () => {
    expect(() => newItems({}, new Set())).toThrow('metas')
  })
})

describe('itemNode', () => {
  it('uses meta when declared', () => {
    expect(itemNode(youtube, 'channel', { id: 'yt_id:UC1', name: 'Chan' })).toMatchObject({
      kind: 'item',
      label: 'Chan',
      loader: { kind: 'meta', type: 'channel', id: 'yt_id:UC1' },
    })
  })

  it('goes straight to streams when there is no meta resource', () => {
    const manifest: Manifest = { ...kids, resources: ['catalog', 'stream'] }
    expect(itemNode(manifest, 'movie', { id: 'kidspt_movie_a' })).toMatchObject({
      label: 'kidspt_movie_a',
      loader: { kind: 'stream', type: 'movie', id: 'kidspt_movie_a' },
    })
  })
})

describe('metaChildren', () => {
  it('collapses a single video onto the item', () => {
    const data = { meta: { id: 'kidspt_movie_a', videos: [{ id: 'kidspt_movie_a', title: 'A' }] } }
    expect(metaChildren(kids, 'movie', data)).toEqual({
      loader: { kind: 'stream', type: 'movie', id: 'kidspt_movie_a' },
    })
  })

  it('uses the meta id when there are no videos', () => {
    expect(metaChildren(kids, 'movie', { meta: { id: 'kidspt_movie_a' } })).toEqual({
      loader: { kind: 'stream', type: 'movie', id: 'kidspt_movie_a' },
    })
  })

  it('groups and sorts seasons, keeping unseasoned videos last', () => {
    const data = {
      meta: {
        id: 'kidspt_series_a',
        videos: [
          { id: 'kidspt_series_a:2:2', title: 'Later', season: 2, episode: 2 },
          { id: 'kidspt_series_a:2:1', title: 'Earlier', season: 2, episode: 1 },
          { id: 'kidspt_series_a:1:1', title: 'First', season: 1, episode: 1 },
          { id: 'kidspt_series_a:x', title: 'Extra' },
        ],
      },
    }
    const result = metaChildren(kids, 'series', data)
    if (!('children' in result)) throw new Error('expected children')
    expect(result.children.map((c) => c.label)).toEqual(['Season 1', 'Season 2', 'Extra'])
    expect(result.children[1].children?.map((c) => c.label)).toEqual(['1. Earlier', '2. Later'])
    expect(result.children[1].children?.[0].loader).toEqual({
      kind: 'stream',
      type: 'series',
      id: 'kidspt_series_a:2:1',
    })
  })

  it('lists channel videos flat with derived links', () => {
    const data = {
      meta: {
        id: 'yt_id:UC1',
        videos: [
          { id: 'yt_id:UC1:vid1', title: 'One' },
          { id: 'yt_id:UC1:vid2', title: 'Two' },
        ],
      },
    }
    const result = metaChildren(youtube, 'channel', data)
    if (!('children' in result)) throw new Error('expected children')
    expect(result.children[0]).toMatchObject({ kind: 'video', label: 'One' })
    expect(result.children[0].children?.[0].url).toBe('https://www.youtube.com/watch?v=vid1')
  })

  it('uses inline video streams without a request', () => {
    const data = {
      meta: {
        id: 'kidspt_series_a',
        videos: [
          { id: 'kidspt_series_a:1', title: 'One', streams: [{ url: 'https://cdn.io/1.mp4' }] },
          { id: 'kidspt_series_a:2', title: 'Two' },
        ],
      },
    }
    const result = metaChildren(kids, 'series', data)
    if (!('children' in result)) throw new Error('expected children')
    expect(result.children[0].loader).toBeUndefined()
    expect(result.children[0].children?.[0].url).toBe('https://cdn.io/1.mp4')
  })

  it('reports a missing meta and a channel with no videos', () => {
    expect(metaChildren(kids, 'movie', { meta: null })).toEqual({
      children: [{ kind: 'note', label: 'No details available' }],
    })
    expect(metaChildren(youtube, 'channel', { meta: { id: 'yt_id:UC1', videos: [] } })).toEqual({
      children: [{ kind: 'note', label: 'No streams available' }],
    })
  })
})

describe('derivedYouTubeLink', () => {
  it('only applies to video ids', () => {
    expect(derivedYouTubeLink('yt_id:UC1:abc')?.url).toBe('https://www.youtube.com/watch?v=abc')
    expect(derivedYouTubeLink('yt_id:UC1')).toBeUndefined()
    expect(derivedYouTubeLink('tt1:1:1')).toBeUndefined()
  })
})

describe('streams', () => {
  it('maps every link field', () => {
    expect(streamLink({ url: 'https://a', externalUrl: 'https://b' })).toBe('https://a')
    expect(streamLink({ externalUrl: 'https://b' })).toBe('https://b')
    expect(streamLink({ ytId: 'abc' })).toBe('https://www.youtube.com/watch?v=abc')
    expect(streamLink({ infoHash: 'ff00' })).toBe('magnet:?xt=urn:btih:ff00')
    expect(streamLink({ title: 'nothing' })).toBeUndefined()
  })

  it('shows the wrapped host, but keeps the original URL', () => {
    const url = 'https://addon.app/go?u=https%3A%2F%2Fplaymogo.com%2Fe%2F6h&t=movie'
    const [node] = streamNodes({ streams: [{ name: 'Wall E', title: 'Opcao 1', externalUrl: url }] })
    expect(node).toMatchObject({ kind: 'link', label: 'Opcao 1', hint: 'playmogo.com', url })
  })

  it('reads what a stream says about its video', () => {
    const [node] = streamNodes({
      streams: [{ name: 'Addon 1080p', description: '🎥 BluRay', url: 'https://a.io/f.mkv', behaviorHints: { videoSize: 2e9 } }],
    })
    expect(node.meta).toMatchObject({ quality: 'BluRay', resolution: '1080p', sizeBytes: 2e9, filename: 'f.mkv' })
  })

  it('keeps web posters only', () => {
    const manifest = { id: 'a', name: 'A', resources: ['meta'], catalogs: [] }
    expect(itemNode(manifest, 'movie', { id: 'x', poster: 'https://a.io/p.jpg' }).poster).toBe('https://a.io/p.jpg')
    expect(itemNode(manifest, 'movie', { id: 'x', poster: 'javascript:alert(1)' }).poster).toBeUndefined()
    expect(itemNode(manifest, 'movie', { id: 'x' }).poster).toBeUndefined()
  })

  it('ignores non-http u parameters', () => {
    expect(linkHost('https://addon.app/go?u=javascript%3Aalert(1)')).toBe('addon.app')
    expect(linkHost('https://addon.app/go?u=not-a-url')).toBeUndefined()
    expect(linkHost('magnet:?xt=urn:btih:ff')).toBe('magnet')
    expect(linkHost('not a url')).toBeUndefined()
  })

  it('skips unusable streams and falls back to a note', () => {
    expect(streamNodes({ streams: [{ title: 'no link' }, 4] })).toEqual([{ kind: 'note', label: 'No streams available' }])
    expect(streamNodes({})).toEqual([{ kind: 'note', label: 'No streams available' }])
  })

  it('labels streams with no text', () => {
    expect(streamNodes({ streams: [{ url: 'https://a.io/1' }] })[0].label).toBe('Stream 1')
  })
})

describe('canOpen', () => {
  it('allows only known-safe schemes', () => {
    expect(canOpen('https://a.io')).toBe(true)
    expect(canOpen('http://a.io')).toBe(true)
    expect(canOpen('magnet:?xt=urn:btih:ff')).toBe(true)
    expect(canOpen('file:///etc/passwd')).toBe(false)
    expect(canOpen('javascript:alert(1)')).toBe(false)
    expect(canOpen('not a url')).toBe(false)
  })
})

describe('linkFilterOf', () => {
  it('sorts common video files by extension, ignoring case and query', () => {
    expect(linkFilterOf('https://c.io/a/Film.MKV?token=1')).toBe('mkv')
    expect(linkFilterOf('https://c.io/a.mp4')).toBe('mp4')
    expect(linkFilterOf('http://c.io/a.webm')).toBe('webm')
  })

  it('counts pages and addresses without an extension as websites', () => {
    expect(linkFilterOf('https://www.youtube.com/watch?v=abc')).toBe('website')
    expect(linkFilterOf('https://a.io/embed.html')).toBe('website')
    expect(linkFilterOf('https://a.io/e/6h')).toBe('website')
    expect(linkFilterOf('https://a.io/')).toBe('website')
  })

  it('puts everything else in other', () => {
    expect(linkFilterOf('magnet:?xt=urn:btih:abc')).toBe('other')
    expect(linkFilterOf('https://c.io/live/index.m3u8')).toBe('other')
    expect(linkFilterOf('https://c.io/a.zip')).toBe('other')
    expect(linkFilterOf('https://c.io/a.m4v')).toBe('other')
    expect(linkFilterOf('nonsense')).toBe('other')
  })

  it('looks through redirect wrappers', () => {
    const wrap = (target: string) => `https://addon.app/go?u=${encodeURIComponent(target)}&t=movie`
    expect(linkFilterOf(wrap('https://c.io/a.avi'))).toBe('avi')
    expect(linkFilterOf(wrap('https://playmogo.com/e/6h'))).toBe('website')
    expect(linkFilterOf(wrap('javascript:alert(1).mp4'))).toBe('website')
  })
})
