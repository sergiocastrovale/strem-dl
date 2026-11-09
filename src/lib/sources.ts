import { shallowRef, watch, type Ref } from 'vue'
import { fetchJson } from './http'
import { normalizeUrl, useAddons } from './addons'
import { useUrlHistory } from './urlHistory'
import { useTree, type FetchJson } from './useTree'

/** One addon, loaded once and shared by every page that shows it. */
export interface Source {
  /** Normalized `<base>/manifest.json`. */
  url: string
  tree: ReturnType<typeof useTree>
  /** Settles when the manifest has loaded: true if it did. */
  ready: Promise<boolean>
}

export function sourceName(source: Source): string {
  const name = source.tree.roots.value[0]?.label
  if (name) return name
  try {
    return new URL(source.url).hostname
  } catch {
    return source.url
  }
}

/**
 * Every added addon, loaded as soon as it's known. Opening a new one loads it, and
 * once it has loaded `onOpened` adds it, which puts it among the rest.
 */
export function createSources(
  fetcher: FetchJson,
  addons: Ref<{ url: string }[]>,
  onOpened: (url: string, name: string) => Promise<void>,
) {
  const known = new Map<string, Source>()
  /** Opened but not added yet, in the order they were opened. */
  const pending = new Set<string>()
  const list = shallowRef<Source[]>([])

  function create(url: string): Source {
    const tree = useTree(fetcher)
    const source: Source = { url, tree, ready: tree.open(url) }
    known.set(url, source)
    return source
  }

  function sync() {
    const addonUrls = addons.value.map((item) => item.url)
    const urls = [...addonUrls, ...[...pending].filter((url) => !addonUrls.includes(url))]
    for (const [url, source] of known) {
      if (urls.includes(url)) continue
      source.tree.stopSearch()
      known.delete(url)
    }
    list.value = urls.map((url) => known.get(url) ?? create(url))
  }

  watch(addons, sync, { immediate: true })

  function get(input: string): Source | null {
    try {
      return known.get(normalizeUrl(input)) ?? null
    } catch {
      return null
    }
  }

  /** Load it again if it failed. */
  function retry(source: Source) {
    if (source.tree.loading.value) return
    source.ready = source.tree.open(source.url)
  }

  /**
   * The addon at this address, loaded, and added. Throws if the address isn't an addon's
   * or it won't load; one that was never added is then forgotten.
   */
  async function open(input: string): Promise<Source> {
    const url = normalizeUrl(input)
    let source = known.get(url)
    if (!source) {
      pending.add(url)
      sync()
      source = known.get(url) as Source
    } else if (source.tree.error.value) {
      retry(source)
    }
    const ok = await source.ready
    const name = source.tree.roots.value[0]?.label
    if (!ok || !name) {
      if (pending.delete(url)) sync()
      throw new Error(source.tree.error.value ?? "Couldn't load the addon")
    }
    await onOpened(url, name)
    pending.delete(url)
    sync()
    return source
  }

  return { list, get, open, retry }
}

let shared: ReturnType<typeof createSources> | undefined

export function useSources() {
  if (!shared) {
    const addons = useAddons()
    const history = useUrlHistory()
    shared = createSources(fetchJson, addons.items, async (url, name) => {
      await addons.add(url, name)
      await history.record(url, name)
    })
  }
  return shared
}
