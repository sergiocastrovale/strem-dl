import { nextTick, ref } from 'vue'
import { describe, expect, it } from 'vitest'
import { combineTrees } from './combinedTree'
import { folderAt, shelvesOf, titlePath, titlesIn, withoutAddonName } from './shelves'
import { createSources, sourceName } from './sources'
import type { FetchJson } from './useTree'

const A = 'https://a.test/manifest.json'
const B = 'https://b.test/manifest.json'

const manifest = (name: string) => ({
  id: name,
  name,
  resources: ['catalog', 'stream'],
  types: ['movie'],
  catalogs: [
    { type: 'movie', id: 'top', name: `${name} Top`, extra: [{ name: 'skip' }] },
    { type: 'movie', id: 'genres', name: 'By genre', extra: [{ name: 'genre', isRequired: true, options: ['Drama', 'Comedy'] }] },
    { type: 'movie', id: 'search', name: 'Search', extra: [{ name: 'search', isRequired: true }] },
  ],
})

function setup(routes: Record<string, () => unknown> = {}) {
  const calls: string[] = []
  const fetcher: FetchJson = async (url) => {
    calls.push(url)
    if (routes[url]) return routes[url]()
    if (url === A) return manifest('Alpha')
    if (url === B) return manifest('Beta')
    throw new Error('HTTP 404')
  }
  const addons = ref<{ url: string; name: string }[]>([])
  const opened: string[] = []
  const sources = createSources(fetcher, addons, async (url, name) => {
    opened.push(name)
    addons.value = [...addons.value, { url, name }]
  })
  return { sources, addons, calls, opened }
}

describe('sources', () => {
  it('loads every added addon, in order', async () => {
    const { sources, addons } = setup()
    addons.value = [
      { url: B, name: 'Beta' },
      { url: A, name: 'Alpha' },
    ]
    await nextTick()
    await Promise.all(sources.list.value.map((source) => source.ready))
    expect(sources.list.value.map(sourceName)).toEqual(['Beta', 'Alpha'])
  })

  it('saves an addon once it has opened, however it was typed', async () => {
    const { sources, opened, calls } = setup()
    const source = await sources.open('  a.test ')
    expect(source.url).toBe(A)
    expect(opened).toEqual(['Alpha'])
    expect(sources.list.value).toEqual([source])
    await sources.open(A)
    expect(calls).toEqual([A])
  })

  it("forgets an addon that won't load and was never added", async () => {
    const { sources, opened } = setup()
    await expect(sources.open('https://c.test')).rejects.toThrow('HTTP 404')
    expect(opened).toEqual([])
    expect(sources.list.value).toEqual([])
    await expect(sources.open('nope')).rejects.toThrow('Not a valid URL')
  })

  it('drops an addon removed from Addons', async () => {
    const { sources, addons } = setup()
    await sources.open(A)
    addons.value = []
    await nextTick()
    expect(sources.list.value).toEqual([])
    expect(sources.get(A)).toBeNull()
  })
})

describe('shelves', () => {
  it('makes one shelf per browsable catalog, picking a genre when one is needed', async () => {
    const { sources } = setup()
    const source = await sources.open(A)
    const root = source.tree.roots.value[0]
    const shelves = shelvesOf(root)
    expect(shelves.map((shelf) => shelf.label)).toEqual(['Top', 'By genre · Drama'])
    expect(shelves[1].path.map((step) => step.label)).toEqual(['By genre', 'Drama'])
    expect(folderAt(root, shelves[1].path)).toBe(shelves[1].node)
    expect(folderAt(root, [{ key: 'gone', label: 'Gone' }])).toBeNull()
  })

  it('lists titles and where they are', async () => {
    const top = 'https://a.test/catalog/movie/top.json'
    const { sources } = setup({ [top]: () => ({ metas: [{ id: 'x', name: 'X' }, { id: 'y', name: 'Y' }] }) })
    const source = await sources.open(A)
    const [shelf] = shelvesOf(source.tree.roots.value[0])
    await source.tree.load(shelf.node)
    const titles = titlesIn(shelf.node)
    expect(titles.map((title) => title.label)).toEqual(['X', 'Y'])
    expect(titlePath(shelf.path, titles[0]).map((step) => step.label)).toEqual(['Alpha Top', 'X'])
  })

  it("leaves a label alone unless it starts with the addon's name", () => {
    expect(withoutAddonName('Alpha Top', 'Alpha')).toBe('Top')
    expect(withoutAddonName('Alphabet', 'Alpha')).toBe('Alphabet')
    expect(withoutAddonName('Alpha', 'Alpha')).toBe('Alpha')
  })
})

describe('combined trees', () => {
  it('lists every addon and sends each change to the tree it belongs to', async () => {
    const { sources } = setup()
    await sources.open(A)
    await sources.open(B)
    const all = combineTrees(() => sources.list.value)
    expect(all.roots.value.map((root) => root.label)).toEqual(['Alpha', 'Beta'])

    const beta = all.rows.value.find((row) => row.node.label === 'Beta')
    expect(beta && all.sourceOf(beta.node.uid)?.url).toBe(B)
    if (!beta) return
    all.toggleCheck(beta)
    expect(all.selection.value).toEqual({ folders: 1, files: 0, label: 'Beta' })
    expect(sources.get(A)?.tree.selection.value.folders).toBe(0)
    all.clearSelection()
    expect(all.selection.value.folders).toBe(0)
  })

  it('searches every addon at once', async () => {
    const { sources } = setup()
    await sources.open(A)
    await sources.open(B)
    const all = combineTrees(() => sources.list.value)
    all.setQuery('top')
    expect(sources.list.value.every((source) => source.tree.searching.value)).toBe(true)
    all.setQuery('')
    expect(all.searching.value).toBe(false)
  })
})
