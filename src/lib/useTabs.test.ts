import { describe, expect, it } from 'vitest'
import { MAX_TABS, TabLimitError, tabTitle, useTabs } from './useTabs'
import type { FetchJson } from './useTree'

const manifest = (name: string) => ({ id: name, name, resources: ['catalog'], catalogs: [] })
const A = 'https://a.test/manifest.json'
const B = 'https://b.test/manifest.json'

function setup(overrides: Record<string, () => unknown> = {}) {
  const calls: string[] = []
  const opened: string[] = []
  const fetcher: FetchJson = async (url) => {
    calls.push(url)
    if (overrides[url]) return overrides[url]()
    if (url === A) return manifest('Alpha')
    if (url === B) return manifest('Beta')
    throw new Error('HTTP 404')
  }
  const tabs = useTabs(fetcher, (_, name) => opened.push(name))
  return { tabs, calls, opened }
}

const settle = () => new Promise((resolve) => setTimeout(resolve))

describe('useTabs', () => {
  it('opens one tab per addon and activates the newest', async () => {
    const { tabs, opened } = setup()
    expect(tabs.open(A)).toBe('opened')
    expect(tabs.open(B)).toBe('opened')
    await settle()
    expect(tabs.tabs.value.map(tabTitle)).toEqual(['Alpha', 'Beta'])
    expect(tabs.active.value?.url).toBe(B)
    expect(opened).toEqual(['Alpha', 'Beta'])
  })

  it('does nothing for the addon already showing, however it was typed', async () => {
    const { tabs, calls, opened } = setup()
    tabs.open(A)
    await settle()
    expect(tabs.open(A)).toBe('unchanged')
    expect(tabs.open(`  ${A}?x=1 `)).toBe('unchanged')
    await settle()
    expect(tabs.tabs.value).toHaveLength(1)
    expect(calls).toEqual([A])
    expect(opened).toEqual(['Alpha'])
  })

  it('does nothing while the same addon is still loading', () => {
    const { tabs, calls } = setup({ [A]: () => new Promise(() => {}) })
    tabs.open(A)
    expect(tabs.open(A)).toBe('unchanged')
    expect(calls).toEqual([A])
  })

  it('switches to an addon open in another tab, without reloading it', async () => {
    const { tabs, calls } = setup()
    tabs.open(A)
    tabs.open(B)
    await settle()
    expect(tabs.open(A)).toBe('opened')
    expect(tabs.active.value?.url).toBe(A)
    expect(tabs.tabs.value).toHaveLength(2)
    expect(calls.filter((url) => url === A)).toHaveLength(1)
  })

  it('keeps tabs loading side by side', async () => {
    let release: (value: unknown) => void = () => {}
    const slow = new Promise((resolve) => {
      release = resolve
    })
    const { tabs } = setup({ [A]: () => slow })
    tabs.open(A)
    tabs.open(B)
    await settle()
    release(manifest('Slow Alpha'))
    await settle()
    expect(tabs.tabs.value.map(tabTitle)).toEqual(['Slow Alpha', 'Beta'])
  })

  it('throws on a bad URL and opens nothing', () => {
    const { tabs } = setup()
    expect(() => tabs.open('nope')).toThrow('Not a valid URL')
    expect(() => tabs.open('https://a.test/other.json')).toThrow('/manifest.json')
    expect(tabs.tabs.value).toEqual([])
  })

  it('keeps a failed addon in its tab and tries again when entered again', async () => {
    let up = false
    const { tabs, opened } = setup({
      [A]: () => {
        if (!up) throw new Error('HTTP 500')
        return manifest('Alpha')
      },
    })
    tabs.open(A)
    await settle()
    expect(tabs.active.value?.tree.error.value).toBe('HTTP 500')
    expect(tabTitle(tabs.tabs.value[0])).toBe('a.test')
    expect(opened).toEqual([])

    up = true
    expect(tabs.open(A)).toBe('opened')
    await settle()
    expect(tabs.tabs.value).toHaveLength(1)
    expect(opened).toEqual(['Alpha'])
  })

  it('passes a folder to a new tab and to an existing one', async () => {
    const path = [{ key: 'label:X', label: 'X' }]
    const { tabs, calls } = setup()
    tabs.open(A, path)
    expect(tabs.tabs.value[0].path.value).toBe(path)
    await settle()
    tabs.tabs.value[0].path.value = null
    const again = [{ key: 'label:Y', label: 'Y' }]
    expect(tabs.open(A, again)).toBe('opened')
    expect(tabs.tabs.value[0].path.value).toBe(again)
    expect(calls).toEqual([A])
  })

  it('refuses an 11th addon, but still reaches open ones and has room after a close', () => {
    const { tabs, calls } = setup()
    const nth = (n: number) => `https://s${n}.test/manifest.json`
    for (let n = 0; n < MAX_TABS; n++) tabs.open(nth(n))
    const before = tabs.activeId.value

    expect(() => tabs.open(nth(MAX_TABS))).toThrow(TabLimitError)
    expect(tabs.tabs.value).toHaveLength(MAX_TABS)
    expect(tabs.activeId.value).toBe(before)
    expect(calls).not.toContain(nth(MAX_TABS))

    expect(tabs.open(nth(0))).toBe('opened')
    expect(tabs.active.value?.url).toBe(nth(0))

    tabs.close(tabs.tabs.value[1].id)
    expect(tabs.open(nth(MAX_TABS))).toBe('opened')
    expect(tabs.tabs.value).toHaveLength(MAX_TABS)
  })

  it('checks the URL before the limit', () => {
    const { tabs } = setup()
    for (let n = 0; n < MAX_TABS; n++) tabs.open(`https://s${n}.test/manifest.json`)
    expect(() => tabs.open('nope')).toThrow('Not a valid URL')
  })

  it('closes to the right, then the left, then nothing', () => {
    const { tabs } = setup()
    tabs.open(A)
    tabs.open(B)
    tabs.open('https://c.test/manifest.json')
    const [a, b, c] = tabs.tabs.value
    tabs.activate(b.id)
    tabs.close(b.id)
    expect(tabs.activeId.value).toBe(c.id)
    tabs.close(c.id)
    expect(tabs.activeId.value).toBe(a.id)
    tabs.close(a.id)
    expect(tabs.activeId.value).toBeNull()
    expect(tabs.tabs.value).toEqual([])
  })

  it('stops the search of a tab that closes', () => {
    const { tabs } = setup()
    tabs.open(A)
    const { tree, id } = tabs.tabs.value[0]
    tree.startSearch()
    tabs.close(id)
    expect(tree.search.status).toBe('stopped')
  })

  it('closing a background tab leaves the active one alone', () => {
    const { tabs } = setup()
    tabs.open(A)
    tabs.open(B)
    const [a, b] = tabs.tabs.value
    tabs.close(a.id)
    expect(tabs.activeId.value).toBe(b.id)
  })

  it('does not record an addon whose tab closed while loading, and can reopen it', async () => {
    const { tabs, opened } = setup()
    tabs.open(A)
    tabs.close(tabs.tabs.value[0].id)
    await settle()
    expect(opened).toEqual([])
    expect(tabs.open(A)).toBe('opened')
    expect(tabs.tabs.value).toHaveLength(1)
  })
})
