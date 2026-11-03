import { nextTick } from 'vue'
import { describe, expect, it } from 'vitest'
import type { NodeKind } from './addon'
import { contentsText, holdsOnlyFiles, MAX_SEARCH_LOADS, PAGE_SIZE, useTree, type FetchJson, type VisibleRow } from './useTree'

const BASE = 'https://addon.test'

const manifest = {
  id: 'kids',
  name: 'Kids',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie'],
  catalogs: [{ type: 'movie', id: 'filmes', name: 'Filmes', extra: [{ name: 'skip' }] }],
}

function responder(routes: Record<string, unknown>): FetchJson & { calls: string[] } {
  const calls: string[] = []
  const fetcher = (async (url: string) => {
    calls.push(url)
    const value = routes[url]
    if (value === undefined) throw new Error('HTTP 404')
    return value
  }) as FetchJson & { calls: string[] }
  fetcher.calls = calls
  return fetcher
}

function find(rows: VisibleRow[], label: string) {
  const row = rows.find((candidate) => candidate.node.label === label)
  if (!row) throw new Error(`no row ${label}`)
  return row
}

describe('what a folder holds', () => {
  const of = (...kinds: NodeKind[]) => kinds.map((kind) => ({ kind }))

  it('counts files and folders apart', () => {
    expect(contentsText(of('folder', 'item', 'item'))).toBe('3 folders')
    expect(contentsText(of('item'))).toBe('1 folder')
    expect(contentsText(of('video', 'video'))).toBe('2 files')
    expect(contentsText(of('link'))).toBe('1 file')
    expect(contentsText(of('folder', 'link', 'video'))).toBe('1 folder · 2 files')
  })

  it('says when there may be more, and when there is nothing', () => {
    expect(contentsText(of('item', 'more'))).toBe('1+ folders')
    expect(contentsText(of('note'))).toBe('Empty')
    expect(contentsText([])).toBe('Empty')
  })

  it('knows a folder of only files', () => {
    expect(holdsOnlyFiles(of('video', 'link', 'note'))).toBe(true)
    expect(holdsOnlyFiles(of('video', 'folder'))).toBe(false)
    expect(holdsOnlyFiles(of('note'))).toBe(false)
    expect(holdsOnlyFiles([])).toBe(false)
  })
})

describe('useTree', () => {
  it('pages by items received, dedupes, and stops when nothing is new', async () => {
    const fetcher = responder({
      [`${BASE}/manifest.json`]: manifest,
      [`${BASE}/catalog/movie/filmes.json`]: { metas: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] },
      [`${BASE}/catalog/movie/filmes/skip=2.json`]: { metas: [{ id: 'b', name: 'B' }, { id: 'c', name: 'C' }] },
      [`${BASE}/catalog/movie/filmes/skip=4.json`]: { metas: [{ id: 'c', name: 'C' }] },
    })
    const tree = useTree(fetcher)
    await tree.open(`${BASE}/manifest.json`)
    await tree.expand(find(tree.rows.value, 'Filmes').node)
    expect(tree.rows.value.map((r) => r.node.label)).toEqual(['Kids', 'Filmes', 'A', 'B', 'Load more'])

    await tree.loadMore(find(tree.rows.value, 'Load more'))
    expect(tree.rows.value.map((r) => r.node.label)).toEqual(['Kids', 'Filmes', 'A', 'B', 'C', 'Load more'])

    await tree.loadMore(find(tree.rows.value, 'Load more'))
    expect(tree.rows.value.map((r) => r.node.label)).toEqual(['Kids', 'Filmes', 'A', 'B', 'C'])
  })

  it('loads a single-video item as meta and then streams', async () => {
    const fetcher = responder({
      [`${BASE}/manifest.json`]: manifest,
      [`${BASE}/catalog/movie/filmes.json`]: { metas: [{ id: 'wall', name: 'Wall-e' }] },
      [`${BASE}/meta/movie/wall.json`]: { meta: { id: 'wall', videos: [{ id: 'wall', title: 'Wall E' }] } },
      [`${BASE}/stream/movie/wall.json`]: { streams: [{ title: 'Opcao 1', externalUrl: 'https://a.io/1' }] },
    })
    const tree = useTree(fetcher)
    await tree.open(`${BASE}/manifest.json`)
    await tree.expand(find(tree.rows.value, 'Filmes').node)
    await tree.expand(find(tree.rows.value, 'Wall-e').node)
    expect(find(tree.rows.value, 'Opcao 1').node.url).toBe('https://a.io/1')
    expect(find(tree.rows.value, 'Opcao 1').depth).toBe(3)
  })

  it('caches children across collapse and expand', async () => {
    const fetcher = responder({
      [`${BASE}/manifest.json`]: manifest,
      [`${BASE}/catalog/movie/filmes.json`]: { metas: [{ id: 'a', name: 'A' }] },
    })
    const tree = useTree(fetcher)
    await tree.open(`${BASE}/manifest.json`)
    const filmes = find(tree.rows.value, 'Filmes').node
    await tree.toggle(filmes)
    await tree.toggle(filmes)
    await tree.toggle(filmes)
    expect(fetcher.calls.filter((url) => url.includes('/catalog/'))).toHaveLength(1)
  })

  it('shows errors on the node, and retry recovers', async () => {
    const routes: Record<string, unknown> = { [`${BASE}/manifest.json`]: manifest }
    const tree = useTree(responder(routes))
    await tree.open(`${BASE}/manifest.json`)
    const row = find(tree.rows.value, 'Filmes')
    await tree.expand(row.node)
    expect(row.node.error).toBe('HTTP 404')

    routes[`${BASE}/catalog/movie/filmes.json`] = { metas: [{ id: 'a', name: 'A' }] }
    await tree.retry(row)
    expect(row.node.error).toBeNull()
    expect(find(tree.rows.value, 'A').node.kind).toBe('item')
  })

  describe('reveal', () => {
    const FILMES = { key: 'catalog:movie:filmes:', label: 'Filmes' }
    const item = (id: string, label: string) => ({ key: `meta:movie:${id}`, label })

    it('walks down through seasons and leaves the target open', async () => {
      const fetcher = responder({
        [`${BASE}/manifest.json`]: manifest,
        [`${BASE}/catalog/movie/filmes.json`]: { metas: [{ id: 'show', name: 'Show' }] },
        [`${BASE}/meta/movie/show.json`]: {
          meta: {
            id: 'show',
            videos: [
              { id: 's1e1', title: 'One', season: 1, episode: 1, streams: [{ url: 'https://a.io/1' }] },
              { id: 's2e1', title: 'Two', season: 2, episode: 1, streams: [{ url: 'https://a.io/2' }] },
            ],
          },
        },
      })
      const tree = useTree(fetcher)
      await tree.open(`${BASE}/manifest.json`)
      const season = { key: 'label:Season 2', label: 'Season 2' }
      const result = await tree.reveal([FILMES, item('show', 'Show'), season])
      expect(result?.error).toBeNull()
      expect(result?.node.label).toBe('Season 2')
      expect(result?.node.expanded).toBe(true)
      expect(find(tree.rows.value, '1. Two').depth).toBe(4)
    })

    it('reads more pages to reach an item', async () => {
      const fetcher = responder({
        [`${BASE}/manifest.json`]: manifest,
        [`${BASE}/catalog/movie/filmes.json`]: { metas: [{ id: 'a', name: 'A' }] },
        [`${BASE}/catalog/movie/filmes/skip=1.json`]: { metas: [{ id: 'b', name: 'B' }] },
        [`${BASE}/catalog/movie/filmes/skip=2.json`]: { metas: [{ id: 'c', name: 'C' }] },
        [`${BASE}/meta/movie/c.json`]: { meta: { id: 'c', videos: [{ id: 'c', streams: [{ url: 'https://a.io/c' }] }] } },
      })
      const tree = useTree(fetcher)
      await tree.open(`${BASE}/manifest.json`)
      const result = await tree.reveal([FILMES, item('c', 'C')])
      expect(result?.error).toBeNull()
      expect(result?.node.label).toBe('C')
      expect(fetcher.calls).not.toContain(`${BASE}/catalog/movie/filmes/skip=3.json`)
    })

    it('stops at the deepest folder when the target is gone', async () => {
      const fetcher = responder({
        [`${BASE}/manifest.json`]: manifest,
        [`${BASE}/catalog/movie/filmes.json`]: { metas: [{ id: 'a', name: 'A' }] },
        [`${BASE}/catalog/movie/filmes/skip=1.json`]: { metas: [] },
      })
      const tree = useTree(fetcher)
      await tree.open(`${BASE}/manifest.json`)
      const result = await tree.reveal([FILMES, item('gone', 'Gone')])
      expect(result?.node.label).toBe('Filmes')
      expect(result?.error).toBe('Couldn\'t find "Gone" in "Filmes"')
    })

    it('reports a folder that fails to load', async () => {
      const tree = useTree(responder({ [`${BASE}/manifest.json`]: manifest }))
      await tree.open(`${BASE}/manifest.json`)
      const result = await tree.reveal([FILMES, item('a', 'A')])
      expect(result?.node.label).toBe('Filmes')
      expect(result?.error).toBe('Couldn\'t load "Filmes": HTTP 404')
    })

    it('stops reading pages at the limit', async () => {
      const fetcher: FetchJson = async (url) => {
        if (url.endsWith('manifest.json')) return manifest
        return { metas: [{ id: url, name: url }] }
      }
      const tree = useTree(fetcher)
      await tree.open(`${BASE}/manifest.json`)
      const result = await tree.reveal([FILMES, item('gone', 'Gone')])
      expect(result?.error).toBe('Couldn\'t find "Gone" in the first 50 extra pages of "Filmes"')
    })

    it('falls back to the label when the key changed', async () => {
      const fetcher = responder({
        [`${BASE}/manifest.json`]: manifest,
        [`${BASE}/catalog/movie/filmes.json`]: { metas: [{ id: 'new-id', name: 'Film' }] },
        [`${BASE}/meta/movie/new-id.json`]: { meta: { id: 'new-id', videos: [{ id: 'v', streams: [{ url: 'https://a.io/v' }] }] } },
      })
      const tree = useTree(fetcher)
      await tree.open(`${BASE}/manifest.json`)
      const result = await tree.reveal([FILMES, item('old-id', 'Film')])
      expect(result?.error).toBeNull()
      expect(result?.node.label).toBe('Film')
    })

    it('reuses what is already loaded, and waits for a load under way', async () => {
      const fetcher = responder({
        [`${BASE}/manifest.json`]: manifest,
        [`${BASE}/catalog/movie/filmes.json`]: { metas: [{ id: 'a', name: 'A' }] },
        [`${BASE}/meta/movie/a.json`]: { meta: { id: 'a', videos: [{ id: 'a', streams: [{ url: 'https://a.io/a' }] }] } },
      })
      const tree = useTree(fetcher)
      await tree.open(`${BASE}/manifest.json`)
      const pending = tree.expand(find(tree.rows.value, 'Filmes').node)
      const result = await tree.reveal([FILMES, item('a', 'A')])
      await pending
      expect(result?.error).toBeNull()
      await tree.reveal([FILMES, item('a', 'A')])
      expect(fetcher.calls.filter((url) => url.includes('/catalog/'))).toHaveLength(1)
    })

    it('gives up quietly when another URL or reveal takes over', async () => {
      let release: (value: unknown) => void = () => {}
      const slow = new Promise((resolve) => {
        release = resolve
      })
      const fetcher: FetchJson = async (url) => (url.includes('/catalog/') ? slow : manifest)
      const tree = useTree(fetcher)
      await tree.open(`${BASE}/manifest.json`)
      const first = tree.reveal([FILMES, item('a', 'A')])
      await tree.open(`${BASE}/manifest.json`)
      release({ metas: [{ id: 'a', name: 'A' }] })
      expect(await first).toBeNull()
    })
  })

  describe('search', () => {
    const LONG = {
      id: 'kids',
      name: 'Kids',
      resources: ['catalog', 'meta', 'stream'],
      types: ['movie'],
      catalogs: [{ type: 'movie', id: 'filmes', name: 'Filmes', extra: [{ name: 'skip' }] }],
    }
    const routes = () => ({
      [`${BASE}/manifest.json`]: LONG,
      [`${BASE}/catalog/movie/filmes.json`]: { metas: [{ id: 'a', name: 'Alpha' }] },
      [`${BASE}/catalog/movie/filmes/skip=1.json`]: { metas: [{ id: 'b', name: 'Bravo Show' }] },
      [`${BASE}/catalog/movie/filmes/skip=2.json`]: { metas: [] },
      [`${BASE}/meta/movie/a.json`]: { meta: { id: 'a', videos: [{ id: 'a' }] } },
      [`${BASE}/stream/movie/a.json`]: { streams: [{ title: 'Opcao UM', url: 'https://cdn.test/a.mp4' }] },
      [`${BASE}/meta/movie/b.json`]: {
        meta: {
          id: 'b',
          videos: [
            { id: 'b1', title: 'Pilot', season: 1, episode: 1, streams: [{ title: 'Link P', url: 'https://cdn.test/p.mp4' }] },
            { id: 'b2', title: 'Finale', season: 2, episode: 1, streams: [{ title: 'Link F', url: 'https://cdn.test/f.mp4' }] },
          ],
        },
      },
    })
    const labels = (tree: ReturnType<typeof useTree>) => tree.rows.value.map((r) => r.node.label)
    const settle = async (tree: ReturnType<typeof useTree>) => {
      while (tree.search.status === 'running') await new Promise((resolve) => setTimeout(resolve))
    }
    async function searched(text: string, data: Record<string, unknown> = routes()) {
      const fetcher = responder(data)
      const tree = useTree(fetcher)
      await tree.open(`${BASE}/manifest.json`)
      tree.setQuery(text)
      tree.startSearch()
      await settle(tree)
      return { tree, fetcher }
    }

    it('finds things nothing has loaded yet, across pages and down to streams', async () => {
      const { tree } = await searched('finale')
      expect(tree.search.status).toBe('done')
      expect(labels(tree)).toEqual(['1. Finale'])
      expect(tree.rows.value[0].trail).toEqual(['Filmes', 'Bravo Show', 'Season 2'])
      expect(tree.matchCount.value).toBe(1)
      expect((await searched('opcao')).tree.matchCount.value).toBe(1)
    })

    it('ignores case in the query and the data', async () => {
      expect(labels((await searched('OPCAO um')).tree)).toEqual(['Alpha'])
      expect(labels((await searched('bRaVo')).tree)).toContain('Bravo Show')
    })

    it('matches link addresses, and not placeholder rows', async () => {
      expect((await searched('p.mp4')).tree.matchCount.value).toBe(1)
      expect((await searched('load more')).tree.matchCount.value).toBe(0)
    })

    it('does not expand anything, so clearing restores the tree', async () => {
      const { tree } = await searched('finale')
      tree.setQuery('')
      expect(labels(tree)).toEqual(['Kids', 'Filmes'])
      expect(tree.search.status).toBe('idle')
      expect(tree.matchCount.value).toBe(0)
    })

    it('lists a matching title once, and shows what is in it only if opened', async () => {
      const { tree } = await searched('bravo')
      expect(labels(tree)).toEqual(['Bravo Show'])
      expect(tree.rows.value[0].trail).toEqual(['Filmes'])
      await tree.toggle(find(tree.rows.value, 'Bravo Show').node)
      expect(labels(tree)).toEqual(['Bravo Show', 'Season 1', 'Season 2'])
      expect(tree.matchCount.value).toBe(1)
      await tree.toggle(find(tree.rows.value, 'Bravo Show').node)
      expect(labels(tree)).toEqual(['Bravo Show'])
    })

    it('finds titles only, not the folders around them', async () => {
      expect(labels((await searched('filmes')).tree)).toEqual([])
    })

    it('returns no rows without a match', async () => {
      const { tree } = await searched('zzz')
      expect(tree.rows.value).toEqual([])
      expect(tree.search.status).toBe('done')
    })

    it('does not fetch twice: reuses loads, including for later queries', async () => {
      const { tree, fetcher } = await searched('finale')
      const count = fetcher.calls.length
      tree.setQuery('pilot')
      tree.startSearch()
      await settle(tree)
      expect(fetcher.calls).toHaveLength(count)
      expect(new Set(fetcher.calls).size).toBe(count)
      expect(tree.matchCount.value).toBe(1)
    })

    it('counts failures, finishes anyway, and retries them on the next run', async () => {
      const data: Record<string, unknown> = routes()
      const missing = data[`${BASE}/meta/movie/a.json`]
      delete data[`${BASE}/meta/movie/a.json`]
      const { tree } = await searched('finale', data)
      expect(tree.search).toMatchObject({ status: 'done', failed: 1 })
      expect(tree.matchCount.value).toBe(1)

      data[`${BASE}/meta/movie/a.json`] = missing
      tree.startSearch()
      await settle(tree)
      expect(tree.search).toMatchObject({ status: 'done', failed: 0 })
    })

    it('stop leaves nothing further fetched, and continue finishes the job', async () => {
      const fetcher = responder(routes())
      const tree = useTree(fetcher)
      await tree.open(`${BASE}/manifest.json`)
      tree.setQuery('finale')
      tree.startSearch()
      tree.stopSearch()
      expect(tree.search.status).toBe('stopped')
      await new Promise((resolve) => setTimeout(resolve, 5))
      expect(fetcher.calls.filter((url) => url.includes('/meta/'))).toEqual([])

      tree.startSearch()
      await settle(tree)
      expect(tree.matchCount.value).toBe(1)
    })

    it('pauses at the load limit on an endless addon and can go on', async () => {
      const fetcher: FetchJson = async (url) => {
        if (url.endsWith('manifest.json')) return { ...LONG, resources: ['catalog'] }
        return { metas: [{ id: url, name: 'x' }] }
      }
      const tree = useTree(fetcher)
      await tree.open(`${BASE}/manifest.json`)
      tree.setQuery('nothing')
      tree.startSearch()
      await settle(tree)
      expect(tree.search.status).toBe('limit')
      expect(tree.search.loads).toBe(MAX_SEARCH_LOADS)
    })

    it('abandons the search when the addon reloads', async () => {
      const fetcher = responder(routes())
      const tree = useTree(fetcher)
      await tree.open(`${BASE}/manifest.json`)
      tree.setQuery('finale')
      tree.startSearch()
      await tree.open(`${BASE}/manifest.json`)
      expect(tree.search.status).toBe('idle')
    })
  })

  describe('browsing', () => {
    const ITEMS = 40
    const single = {
      [`${BASE}/manifest.json`]: manifest,
      [`${BASE}/catalog/movie/filmes.json`]: {
        metas: Array.from({ length: ITEMS }, (_, i) => ({ id: `m${i}`, name: `M${i}`, poster: `https://p.test/${i}.jpg` })),
      },
      [`${BASE}/catalog/movie/filmes/skip=${ITEMS}.json`]: { metas: [{ id: 'last', name: 'Last' }] },
      [`${BASE}/meta/movie/m0.json`]: { meta: { id: 'm0' } },
      [`${BASE}/stream/movie/m0.json`]: {
        streams: [
          { title: 'One 720p', url: 'https://c.test/one.mp4' },
          { title: 'Two 1080p', url: 'https://c.test/two.mp4' },
        ],
      },
    }
    async function opened() {
      const fetcher = responder(single)
      const tree = useTree(fetcher)
      await tree.open(`${BASE}/manifest.json`)
      await tree.expand(find(tree.rows.value, 'Filmes').node)
      return { tree, fetcher, labels: () => tree.rows.value.map((row) => row.node.label) }
    }

    it('shows a page of children at a time, then fetches more', async () => {
      const { tree, labels } = await opened()
      expect(tree.rows.value.filter((row) => row.parent?.label === 'Filmes')).toHaveLength(PAGE_SIZE + 1)
      expect(labels().at(-1)).toBe('Load more')
      expect(tree.rows.value.at(-1)?.node.hint).toBe(`${ITEMS - PAGE_SIZE} more`)

      await tree.loadMore(tree.rows.value.at(-1) as VisibleRow)
      expect(labels()).toContain(`M${PAGE_SIZE * 2 - 1}`)
      expect(tree.rows.value.at(-1)?.node.hint).toBe(`${ITEMS - PAGE_SIZE * 2} more`)

      await tree.loadMore(tree.rows.value.at(-1) as VisibleRow)
      expect(labels()).toContain(`M${ITEMS - 1}`)
      expect(tree.rows.value.at(-1)?.node.hint).toBeUndefined()

      await tree.loadMore(tree.rows.value.at(-1) as VisibleRow)
      expect(labels()).toContain('Last')
    })

    it('reveals a folder past the page showing', async () => {
      const { tree, labels } = await opened()
      const late = { key: 'label:M30', label: 'M30' }
      const filmes = { key: 'catalog:movie:filmes:', label: 'Filmes' }
      const result = await tree.reveal([filmes, late])
      expect(result?.node.label).toBe('M30')
      expect(labels()).toContain('M30')
    })

    it('selects what is hidden by paging, as part of its folder', async () => {
      const { tree } = await opened()
      tree.toggleCheck(find(tree.rows.value, 'Filmes'))
      const page = tree.childRows(find(tree.rows.value, 'Filmes').node.uid)
      expect(page).toHaveLength(ITEMS + 1)
      expect(page[ITEMS - 1].check).toBe('on')
    })

    it('finds a node from anywhere, with its ancestors, and its children with their state', async () => {
      const { tree } = await opened()
      const m3 = find(tree.rows.value, 'M3')
      expect(tree.chainOf(m3.node.uid).map((row) => row.node.label)).toEqual(['Kids', 'Filmes', 'M3'])
      expect(tree.rowOf(m3.node.uid)?.path.map((segment) => segment.label)).toEqual(['Filmes', 'M3'])
      expect(tree.rowOf(-1)).toBeNull()

      const filmes = find(tree.rows.value, 'Filmes').node
      expect(tree.childRows(filmes.uid)[3].node.poster).toBe('https://p.test/3.jpg')
      tree.toggleCheck(m3)
      expect(tree.childRows(filmes.uid)[3].check).toBe('on')
      expect(tree.childRows(filmes.uid)[4].check).toBe('off')
      expect(tree.rowOf(filmes.uid)?.check).toBe('mixed')
      expect(tree.childRows(-1)).toEqual([])
    })

    it('loads without opening, and preloads only what is missing', async () => {
      const { tree, fetcher } = await opened()
      const m0 = find(tree.rows.value, 'M0').node
      await tree.load(m0)
      expect(m0.expanded).toBe(false)
      expect(m0.children).toHaveLength(2)
      const before = fetcher.calls.length
      await tree.preload([m0, find(tree.rows.value, 'Filmes').node])
      expect(fetcher.calls).toHaveLength(before)

      const failing = find(tree.rows.value, 'M1').node
      await tree.preload([failing])
      expect(failing.error).toBeTruthy()
      const failed = fetcher.calls.length
      await tree.preload([failing])
      expect(fetcher.calls).toHaveLength(failed)
    })

    it('peeks at what is selected, saying when more is not loaded yet', async () => {
      const { tree } = await opened()
      const m0 = find(tree.rows.value, 'M0')
      tree.toggleCheck(m0)
      expect(tree.peekSelected()).toEqual({ links: [], complete: false })

      await tree.expand(m0.node)
      const peek = tree.peekSelected()
      expect(peek.complete).toBe(true)
      expect(peek.links.map((link) => [link.node.label, link.explicit])).toEqual([
        ['One 720p', false],
        ['Two 1080p', false],
      ])

      tree.toggleCheck(find(tree.rows.value, 'M0'))
      tree.toggleCheck(find(tree.rows.value, 'Two 1080p'))
      expect(tree.peekSelected().links.map((link) => [link.node.label, link.explicit])).toEqual([['Two 1080p', true]])
      expect(tree.peekSelected().complete).toBe(true)
      tree.toggleCheck(find(tree.rows.value, 'Filmes'))
      expect(tree.peekSelected().complete).toBe(false)
    })
  })

  it('keeps a folder path stable after its item loads', async () => {
    const fetcher = responder({
      [`${BASE}/manifest.json`]: manifest,
      [`${BASE}/catalog/movie/filmes.json`]: { metas: [{ id: 'wall', name: 'Wall-e' }] },
      [`${BASE}/meta/movie/wall.json`]: { meta: { id: 'wall', videos: [{ id: 'wall', title: 'Wall E' }] } },
      [`${BASE}/stream/movie/wall.json`]: { streams: [{ externalUrl: 'https://a.io/1' }] },
    })
    const tree = useTree(fetcher)
    await tree.open(`${BASE}/manifest.json`)
    await tree.expand(find(tree.rows.value, 'Filmes').node)
    const before = find(tree.rows.value, 'Wall-e').path
    await tree.expand(find(tree.rows.value, 'Wall-e').node)
    expect(find(tree.rows.value, 'Wall-e').path).toEqual(before)
    expect(before.map((segment) => segment.label)).toEqual(['Filmes', 'Wall-e'])
  })

  it('reports a bad manifest URL and a bad manifest', async () => {
    const tree = useTree(responder({ [`${BASE}/manifest.json`]: { meta: {} } }))
    expect(await tree.open('https://addon.test/other.json')).toBe(false)
    expect(tree.error.value).toContain('/manifest.json')
    expect(await tree.open(`${BASE}/manifest.json`)).toBe(false)
    expect(tree.error.value).toContain('Not an addon manifest')
  })

  it('ignores a slow response from a previous URL', async () => {
    let release: (value: unknown) => void = () => {}
    const slow = new Promise((resolve) => {
      release = resolve
    })
    const fetcher: FetchJson = async (url) => {
      if (url.startsWith('https://old.test')) return slow
      return { ...manifest, name: 'New' }
    }
    const tree = useTree(fetcher)
    const first = tree.open('https://old.test/manifest.json')
    await tree.open('https://new.test/manifest.json')
    release({ ...manifest, name: 'Old' })
    await first
    expect(tree.rows.value[0].node.label).toBe('New')
  })

  it('ignores a slow child response from a previous URL', async () => {
    let release: (value: unknown) => void = () => {}
    const slow = new Promise((resolve) => {
      release = resolve
    })
    const fetcher: FetchJson = async (url) => {
      if (url.includes('/catalog/')) return slow
      return manifest
    }
    const tree = useTree(fetcher)
    await tree.open(`${BASE}/manifest.json`)
    const old = find(tree.rows.value, 'Filmes').node
    const pending = tree.expand(old)
    await tree.open('https://new.test/manifest.json')
    release({ metas: [{ id: 'a', name: 'A' }] })
    await pending
    expect(old.children).toBeNull()
    expect(tree.rows.value.map((r) => r.node.label)).toEqual(['Kids', 'Filmes'])
  })

  describe('selection', () => {
    const SHOWS = {
      ...manifest,
      catalogs: [{ type: 'movie', id: 'filmes', name: 'Filmes', extra: [{ name: 'skip' }] }],
    }
    const routes = () => ({
      [`${BASE}/manifest.json`]: SHOWS,
      [`${BASE}/catalog/movie/filmes.json`]: { metas: [{ id: 'a', name: 'Alpha' }, { id: 'show', name: 'Show' }] },
      [`${BASE}/catalog/movie/filmes/skip=2.json`]: { metas: [{ id: 'z', name: 'Zed' }] },
      [`${BASE}/catalog/movie/filmes/skip=3.json`]: { metas: [] },
      [`${BASE}/meta/movie/a.json`]: { meta: { id: 'a' } },
      [`${BASE}/stream/movie/a.json`]: {
        streams: [{ title: 'A1', url: 'https://c.test/a1.mp4' }, { title: 'A2', url: 'https://c.test/a2.mp4' }],
      },
      [`${BASE}/meta/movie/show.json`]: {
        meta: {
          id: 'show',
          videos: [
            { id: 'e2', title: 'Second', season: 2, episode: 1, streams: [{ title: 'S2', url: 'https://c.test/s2.mp4' }] },
            { id: 'e1', title: 'Pilot', season: 1, episode: 1, streams: [{ title: 'S1', url: 'https://c.test/s1.mp4' }] },
          ],
        },
      },
      [`${BASE}/meta/movie/z.json`]: { meta: { id: 'z' } },
      [`${BASE}/stream/movie/z.json`]: { streams: [{ title: 'Z1', url: 'https://c.test/z1.mp4' }] },
    })

    async function opened(routeMap: Record<string, unknown> = routes()) {
      const fetcher = responder(routeMap)
      const tree = useTree(fetcher)
      await tree.open(`${BASE}/manifest.json`)
      const row = (label: string) => find(tree.rows.value, label)
      const toggle = (label: string) => tree.toggleCheck(row(label))
      const open = async (label: string) => tree.expand(row(label).node)
      const scanned = async () => (await tree.collectSelected().done).links.map((link) => link.node.label)
      return { fetcher, tree, row, toggle, open, scanned }
    }

    it('selects nothing to begin with', async () => {
      const { tree, row } = await opened()
      expect(row('Filmes').check).toBe('off')
      expect(tree.selection.value).toEqual({ folders: 0, files: 0, label: null })
    })

    it('a checked folder covers what is below it, also what loads later', async () => {
      const { row, toggle, open } = await opened()
      toggle('Filmes')
      await open('Filmes')
      expect(row('Alpha').check).toBe('on')
      expect(row('Kids').check).toBe('mixed')
    })

    it('unchecking a child makes the parents mixed, and checking it back undoes that', async () => {
      const { row, toggle, open } = await opened()
      await open('Filmes')
      toggle('Filmes')
      toggle('Alpha')
      expect(row('Alpha').check).toBe('off')
      expect(row('Filmes').check).toBe('mixed')
      toggle('Alpha')
      expect(row('Filmes').check).toBe('on')
    })

    it('a mixed box selects all, then none', async () => {
      const { row, toggle, open } = await opened()
      await open('Filmes')
      toggle('Alpha')
      expect(row('Filmes').check).toBe('mixed')
      toggle('Filmes')
      expect(['Filmes', 'Alpha', 'Show'].map((label) => row(label).check)).toEqual(['on', 'on', 'on'])
      toggle('Filmes')
      expect(['Filmes', 'Alpha', 'Show'].map((label) => row(label).check)).toEqual(['off', 'off', 'off'])
    })

    it('the root box selects the whole addon', async () => {
      const { row, toggle, scanned, tree } = await opened()
      toggle('Kids')
      expect(row('Filmes').check).toBe('on')
      expect(tree.selection.value).toEqual({ folders: 1, files: 0, label: 'Kids' })
      expect(await scanned()).toEqual(['A1', 'A2', 'S1', 'S2', 'Z1'])
    })

    it('counts a selected folder once, and names a single choice', async () => {
      const { tree, toggle, open } = await opened()
      await open('Filmes')
      await open('Alpha')
      toggle('Show')
      expect(tree.selection.value).toEqual({ folders: 1, files: 0, label: 'Show' })
      toggle('A1')
      expect(tree.selection.value).toEqual({ folders: 1, files: 1, label: null })
      tree.clearSelection()
      expect(tree.selection.value).toEqual({ folders: 0, files: 0, label: null })
    })

    it('finds selected links in tree order across pages, without expanding', async () => {
      const { tree, toggle } = await opened()
      toggle('Filmes')
      const seen: number[] = []
      const result = await tree.collectSelected((found) => seen.push(found)).done
      expect(result.links.map((link) => link.node.label)).toEqual(['A1', 'A2', 'S1', 'S2', 'Z1'])
      expect(result).toMatchObject({ failed: 0, limited: false })
      expect(seen.at(-1)).toBe(5)
      expect(tree.rows.value.map((row) => row.node.label)).toEqual(['Kids', 'Filmes'])
    })

    it('knows where each link sits', async () => {
      const { tree, toggle } = await opened()
      toggle('Filmes')
      const { links } = await tree.collectSelected().done
      const pilot = links.find((link) => link.node.label === 'S1')
      expect(pilot?.parent.label).toBe('1. Pilot')
      expect(pilot?.path.map((segment) => segment.label)).toEqual(['Filmes', 'Show', 'Season 1'])
    })

    it('takes separate choices together', async () => {
      const { toggle, open, scanned } = await opened()
      await open('Filmes')
      await open('Alpha')
      toggle('A2')
      toggle('Show')
      expect(await scanned()).toEqual(['A2', 'S1', 'S2'])
    })

    it('leaves out what was unchecked, without loading it', async () => {
      const { fetcher, toggle, open, scanned } = await opened()
      await open('Filmes')
      toggle('Filmes')
      toggle('Show')
      expect(await scanned()).toEqual(['A1', 'A2', 'Z1'])
      expect(fetcher.calls).not.toContain(`${BASE}/meta/movie/show.json`)
    })

    it('takes a file back inside an unchecked folder', async () => {
      const { toggle, open, scanned } = await opened()
      await open('Filmes')
      await open('Alpha')
      toggle('Filmes')
      toggle('Alpha')
      toggle('A1')
      expect(await scanned()).toEqual(['A1', 'S1', 'S2', 'Z1'])
    })

    it('does not change a running scan when boxes change', async () => {
      const { tree, toggle } = await opened()
      toggle('Filmes')
      const scan = tree.collectSelected()
      tree.clearSelection()
      expect((await scan.done).links).toHaveLength(5)
    })

    it('reports parts that would not load and keeps the rest', async () => {
      const broken: Record<string, unknown> = routes()
      delete broken[`${BASE}/meta/movie/show.json`]
      const { tree, toggle } = await opened(broken)
      toggle('Filmes')
      const result = await tree.collectSelected().done
      expect(result.links.map((link) => link.node.label)).toEqual(['A1', 'A2', 'Z1'])
      expect(result.failed).toBe(1)
    })

    it('stops at the load limit on an endless addon', async () => {
      const fetcher: FetchJson = async (url) => {
        if (url.endsWith('manifest.json')) return { ...SHOWS, resources: ['catalog'] }
        return { metas: [{ id: url, name: 'x' }] }
      }
      const tree = useTree(fetcher)
      await tree.open(`${BASE}/manifest.json`)
      tree.toggleCheck(find(tree.rows.value, 'Filmes'))
      expect((await tree.collectSelected().done).limited).toBe(true)
    })

    it('stops when told to, and requests no more', async () => {
      const { fetcher, tree, toggle } = await opened()
      toggle('Filmes')
      const scan = tree.collectSelected()
      scan.stop()
      expect((await scan.done).limited).toBe(false)
      await new Promise((resolve) => setTimeout(resolve, 5))
      expect(fetcher.calls.length).toBeLessThanOrEqual(2)
    })

    it('forgets the selection, and ends a scan, when the addon reloads', async () => {
      const { tree, toggle } = await opened()
      toggle('Filmes')
      const scan = tree.collectSelected()
      await tree.open(`${BASE}/manifest.json`)
      await expect(scan.done).resolves.toBeDefined()
      expect(tree.selection.value).toEqual({ folders: 0, files: 0, label: null })
    })
  })

  describe('filters', () => {
    const ADDON = {
      ...manifest,
      catalogs: [{ type: 'movie', id: 'filmes', name: 'Filmes' }],
    }
    const routes = () => ({
      [`${BASE}/manifest.json`]: ADDON,
      [`${BASE}/catalog/movie/filmes.json`]: { metas: [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }, { id: 'c', name: 'Gamma' }] },
      [`${BASE}/meta/movie/a.json`]: { meta: { id: 'a' } },
      [`${BASE}/stream/movie/a.json`]: {
        streams: [
          { title: 'A mp4', url: 'https://c.test/a.mp4' },
          { title: 'A mkv', url: 'https://c.test/a.mkv' },
          { title: 'A page', externalUrl: 'https://site.test/e/1' },
          { title: 'A magnet', infoHash: 'abc' },
        ],
      },
      [`${BASE}/meta/movie/b.json`]: { meta: { id: 'b' } },
      [`${BASE}/stream/movie/b.json`]: { streams: [{ title: 'B mkv', url: 'https://c.test/b.mkv' }] },
      [`${BASE}/meta/movie/c.json`]: { meta: { id: 'c' } },
      [`${BASE}/stream/movie/c.json`]: { streams: [{ title: 'C page', externalUrl: 'https://site.test/e/2' }] },
    })

    async function loaded() {
      const tree = useTree(responder(routes()))
      await tree.open(`${BASE}/manifest.json`)
      tree.setFilters(['mp4', 'mkv', 'avi', 'mov', 'wmv', 'webm', 'website', 'other'])
      tree.startSearch()
      await settle(tree)
      tree.setFilters([])
      const row = (label: string) => find(tree.rows.value, label)
      await tree.expand(row('Filmes').node)
      for (const label of ['Alpha', 'Beta', 'Gamma']) await tree.expand(row(label).node)
      const labels = () => tree.rows.value.map((candidate) => candidate.node.label)
      const scanned = async () => (await tree.collectSelected().done).links.map((link) => link.node.label)
      return { tree, row, labels, scanned, toggle: (label: string) => tree.toggleCheck(row(label)) }
    }

    async function settle(tree: ReturnType<typeof useTree>) {
      while (tree.search.status === 'running') await new Promise((resolve) => setTimeout(resolve))
    }

    it('shows only links of the chosen types, and the way to them', async () => {
      const { tree, labels } = await loaded()
      tree.setFilters(['mkv'])
      expect(labels()).toEqual(['Kids', 'Filmes', 'Alpha', 'A mkv', 'Beta', 'B mkv'])
      expect(tree.matchCount.value).toBe(2)
    })

    it('combines types, and sorts websites and everything else apart', async () => {
      const { tree, labels } = await loaded()
      tree.setFilters(['mp4', 'website'])
      expect(labels()).toEqual(['Kids', 'Filmes', 'Alpha', 'A mp4', 'A page', 'Gamma', 'C page'])
      tree.setFilters(['other'])
      expect(labels()).toEqual(['Kids', 'Filmes', 'Alpha', 'A magnet'])
    })

    it('finds links not loaded yet, once the crawl reaches them', async () => {
      const tree = useTree(responder(routes()))
      await tree.open(`${BASE}/manifest.json`)
      tree.setFilters(['mkv'])
      expect(tree.rows.value).toEqual([])
      tree.startSearch()
      await settle(tree)
      expect(tree.rows.value.map((row) => row.node.label)).toEqual(['Kids', 'Filmes', 'Alpha', 'A mkv', 'Beta', 'B mkv'])
    })

    it('narrows a search, also one that matched a folder', async () => {
      const { tree, labels } = await loaded()
      tree.setFilters(['mkv'])
      tree.setQuery('alpha')
      expect(labels()).toEqual(['Alpha', 'A mkv'])
      tree.setQuery('b mkv')
      expect(labels()).toEqual(['Beta', 'B mkv'])
    })

    it('clearing the search leaves the filters, and clearing both shows everything', async () => {
      const { tree, labels } = await loaded()
      const all = labels()
      tree.setFilters(['mkv'])
      tree.setQuery('alpha')
      tree.setQuery('')
      expect(labels()).toContain('B mkv')
      tree.setFilters([])
      expect(labels()).toEqual(all)
      expect(tree.search.status).toBe('idle')
    })

    it('deselects a chosen file out of bounds', async () => {
      const { tree, toggle } = await loaded()
      toggle('A mp4')
      toggle('A mkv')
      tree.setFilters(['mkv'])
      expect(tree.selection.value).toEqual({ folders: 0, files: 1, label: 'A mkv' })
    })

    it('empties the selection when nothing chosen is in bounds', async () => {
      const { tree, toggle } = await loaded()
      toggle('A mp4')
      tree.setFilters(['mkv'])
      expect(tree.selection.value).toEqual({ folders: 0, files: 0, label: null })
    })

    it('keeps a checked folder but drops its out of bounds links, for good', async () => {
      const { tree, row, toggle, scanned } = await loaded()
      toggle('Filmes')
      tree.setFilters(['mkv'])
      expect(row('Filmes').check).toBe('on')
      expect(await scanned()).toEqual(['A mkv', 'B mkv'])

      tree.setFilters([])
      expect(row('A mp4').check).toBe('off')
      expect(row('A mkv').check).toBe('on')
      expect(row('Filmes').check).toBe('mixed')
      expect(await scanned()).toEqual(['A mkv', 'B mkv'])
    })

    it('deselects a folder left with nothing in bounds', async () => {
      const { tree, row, toggle } = await loaded()
      toggle('Gamma')
      toggle('Beta')
      tree.setFilters(['mkv'])
      expect(tree.selection.value).toEqual({ folders: 1, files: 0, label: 'Beta' })
      tree.setFilters([])
      expect(row('Gamma').check).toBe('off')
    })

    it('another filter deselects further, and removing one brings nothing back', async () => {
      const { tree, toggle, scanned } = await loaded()
      toggle('Filmes')
      tree.setFilters(['mkv', 'mp4'])
      expect(await scanned()).toEqual(['A mp4', 'A mkv', 'B mkv'])
      tree.setFilters(['mkv'])
      expect(await scanned()).toEqual(['A mkv', 'B mkv'])
      tree.setFilters(['mkv', 'mp4'])
      expect(await scanned()).toEqual(['A mkv', 'B mkv'])
    })

    it('selecting under a filter only takes what is in bounds, and can be undone', async () => {
      const { tree, row, toggle, scanned } = await loaded()
      tree.setFilters(['mkv'])
      toggle('Filmes')
      expect(row('Filmes').check).toBe('on')
      expect(await scanned()).toEqual(['A mkv', 'B mkv'])
      toggle('Filmes')
      expect(row('Filmes').check).toBe('off')
      expect(tree.selection.value).toEqual({ folders: 0, files: 0, label: null })
    })

    it('sorts out a selected folder as its contents load', async () => {
      const tree = useTree(responder(routes()))
      await tree.open(`${BASE}/manifest.json`)
      tree.toggleCheck(find(tree.rows.value, 'Filmes'))
      tree.setFilters(['mkv'])
      expect(tree.selection.value.folders).toBe(1)
      tree.startSearch()
      await settle(tree)
      await nextTick()
      tree.setFilters([])
      await tree.expand(find(tree.rows.value, 'Filmes').node)
      await tree.expand(find(tree.rows.value, 'Alpha').node)
      expect(find(tree.rows.value, 'A mp4').check).toBe('off')
      expect(find(tree.rows.value, 'A mkv').check).toBe('on')
    })

    it('a scan with a filter on only takes links in bounds, before pruning catches up', async () => {
      const tree = useTree(responder(routes()))
      await tree.open(`${BASE}/manifest.json`)
      tree.toggleCheck(find(tree.rows.value, 'Filmes'))
      tree.setFilters(['mkv'])
      const { links } = await tree.collectSelected().done
      expect(links.map((link) => link.node.label)).toEqual(['A mkv', 'B mkv'])
    })

    it('a search alone leaves the selection alone', async () => {
      const { tree, toggle, scanned } = await loaded()
      toggle('Beta')
      tree.setQuery('alpha')
      expect(await scanned()).toEqual(['B mkv'])
    })

    it('forgets filters when the addon reloads', async () => {
      const { tree } = await loaded()
      tree.setFilters(['mkv'])
      await tree.open(`${BASE}/manifest.json`)
      expect(tree.filters.value.size).toBe(0)
    })
  })
})
