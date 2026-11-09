import { computed, ref, shallowRef, type ShallowRef } from 'vue'
import type { PathSegment } from './addon'
import { normalizeUrl } from './saved'
import { useTree, type FetchJson } from './useTree'

export const MAX_TABS = 10

/** Thrown by open() when a new tab would go over MAX_TABS. */
export class TabLimitError extends Error {
  constructor() {
    super(`You can have up to ${MAX_TABS} tabs open. Close one to open another.`)
  }
}

export interface Tab {
  id: number
  /** Normalized `<base>/manifest.json`: one tab per addon. */
  url: string
  tree: ReturnType<typeof useTree>
  /** A folder to browse to as soon as the addon is open. */
  path: ShallowRef<PathSegment[] | null>
}

export function tabTitle(tab: Tab): string {
  return tab.tree.roots.value[0]?.label ?? new URL(tab.url).hostname
}

export function useTabs(fetchJson: FetchJson, onOpened: (url: string, name: string) => void) {
  const tabs = shallowRef<Tab[]>([])
  const activeId = ref<number | null>(null)
  const active = computed(() => tabs.value.find((tab) => tab.id === activeId.value) ?? null)
  let nextId = 1

  async function load(tab: Tab) {
    const opened = await tab.tree.open(tab.url)
    const name = tab.tree.roots.value[0]?.label
    if (opened && name && tabs.value.includes(tab)) onOpened(tab.url, name)
  }

  /**
   * Open an addon in a new tab, or go to the tab it's already in. A tab that
   * failed to load tries again. Throws if the input isn't an addon URL, or
   * with TabLimitError if there's no room for a new tab.
   */
  function open(input: string, path: PathSegment[] | null = null): 'opened' | 'unchanged' {
    const url = normalizeUrl(input)
    const existing = tabs.value.find((tab) => tab.url === url)
    if (!existing) {
      if (tabs.value.length >= MAX_TABS) throw new TabLimitError()
      const tab: Tab = { id: nextId++, url, tree: useTree(fetchJson), path: shallowRef(path) }
      tabs.value = [...tabs.value, tab]
      activeId.value = tab.id
      void load(tab)
      return 'opened'
    }

    const failed = existing.tree.error.value !== null && !existing.tree.loading.value
    if (existing.id === activeId.value && !path && !failed) return 'unchanged'
    activeId.value = existing.id
    if (path) existing.path.value = path
    if (failed) void load(existing)
    return 'opened'
  }

  function activate(id: number) {
    activeId.value = id
  }

  /** Like a browser: closing the active tab shows the one to its right, or else its left. */
  function close(id: number) {
    const index = tabs.value.findIndex((tab) => tab.id === id)
    if (index < 0) return
    tabs.value[index].tree.stopSearch()
    const remaining = tabs.value.filter((tab) => tab.id !== id)
    tabs.value = remaining
    if (activeId.value === id) activeId.value = (remaining[index] ?? remaining[index - 1])?.id ?? null
  }

  return { tabs, activeId, active, open, load, activate, close }
}
