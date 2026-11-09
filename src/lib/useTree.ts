import { computed, reactive, ref, watch } from 'vue'
import {
  addonBase,
  addonNode,
  itemNode,
  linkFilterOf,
  metaChildren,
  nodeKey,
  newItems,
  parseManifest,
  loaderUrl,
  streamNodes,
  type LinkFilter,
  type Manifest,
  type NodeSpec,
  type PathSegment,
  type Loader,
} from './addon'

export interface TreeNode extends Omit<NodeSpec, 'children'> {
  uid: number
  /** Fixed at build time: a node's loader can change once it loads. */
  key: string
  children: TreeNode[] | null
  expanded: boolean
  loading: boolean
  error: string | null
  /** Catalog paging state. */
  skip: number
  seen: Set<string> | null
}

export interface VisibleRow {
  node: TreeNode
  parent: TreeNode | null
  depth: number
  /** From below the root down to this row, for rows that are folders. */
  path: PathSegment[]
  /** Showing its children. Differs from node.expanded when filters open the way to a match. */
  open: boolean
  check: CheckState
  /** Search results only: the folders it sits in, below the root. */
  trail?: string[]
}

/** `mixed`: something below it differs from it. */
export type CheckState = 'on' | 'off' | 'mixed'

/** What's selected, counting a selected folder once however much is below it. */
export interface SelectionSummary {
  folders: number
  files: number
  /** Name of the one thing selected. Null when there are several. */
  label: string | null
}

export interface SearchState {
  /** Loading the parts of the addon not fetched yet, so they can be searched too. */
  status: 'idle' | 'running' | 'stopped' | 'limit' | 'done'
  loads: number
  failed: number
}

/** Stop loading here, so a search or bulk download can't hammer a huge addon unattended. */
export const MAX_SEARCH_LOADS = 2000
const SEARCH_CONCURRENCY = 4

/** How far reveal() got. */
export interface RevealResult {
  node: TreeNode
  error: string | null
}

type CrawlOutcome = 'done' | 'limit' | 'stopped'

interface CrawlHooks {
  /** False once nobody wants the result any more. */
  live: () => boolean
  onLoadStart: () => void
  onLoaded: (failed: number) => void
  onEnd: (outcome: CrawlOutcome) => void
  /** Leave this node and everything below it out. */
  skip?: (node: TreeNode) => boolean
}

/** A link and where it sits. */
export interface CollectedLink {
  node: TreeNode
  parent: TreeNode
  /** Folders from below the root down to the link. */
  path: PathSegment[]
  /** Its own box is ticked, rather than one above it. */
  explicit: boolean
}

/** What's selected among what's loaded, without loading anything. */
export interface SelectionPeek {
  links: CollectedLink[]
  /** False when something selected isn't loaded yet, so there may be more links. */
  complete: boolean
}

export interface LinkScanResult {
  links: CollectedLink[]
  /** Parts that wouldn't load, so their links are missing. */
  failed: number
  /** Hit MAX_SEARCH_LOADS with more left to load. */
  limited: boolean
}

export interface LinkScan {
  done: Promise<LinkScanResult>
  stop: () => void
}

/** Catalog pages to read while looking for a watched item, so a huge catalog can't run forever. */
const MAX_REVEAL_PAGES = 50

/** Children of a folder shown at a time. */
export const PAGE_SIZE = 16
const PRELOAD_CONCURRENCY = 3

export function isFolderNode(node: Pick<TreeNode, 'kind'>): boolean {
  return node.kind === 'folder' || node.kind === 'item'
}

/** A film, show or episode: what a search looks for. */
export function isTitleNode(node: Pick<TreeNode, 'kind'>): boolean {
  return node.kind === 'item' || node.kind === 'video'
}

/** Something to save rather than a place to go: a link, or an episode, which is one video. */
export function isFileNode(node: Pick<TreeNode, 'kind'>): boolean {
  return node.kind === 'link' || node.kind === 'video'
}

/** A loaded folder holding files and nothing else to open. */
export function holdsOnlyFiles(children: Pick<TreeNode, 'kind'>[]): boolean {
  const entries = children.filter(({ kind }) => kind !== 'note' && kind !== 'more')
  return entries.length > 0 && entries.every(isFileNode)
}

/** What a loaded folder holds, as far as is known: `3 folders`, `12 files`, `100+ folders`. */
export function contentsText(children: Pick<TreeNode, 'kind'>[]): string {
  const count = (n: number, one: string, more: boolean) => `${n}${more ? '+' : ''} ${n === 1 && !more ? one : `${one}s`}`
  const more = children.some(({ kind }) => kind === 'more')
  const files = children.filter(isFileNode).length
  const folders = children.filter(({ kind }) => kind !== 'note' && kind !== 'more' && !isFileNode({ kind })).length
  if (!folders && !files) return more ? 'More to load' : 'Empty'
  // Only catalogs come in pages, and what's in them are folders.
  return [folders && count(folders, 'folder', more), files && count(files, 'file', more && !folders)].filter(Boolean).join(' · ')
}

export function isCheckable(node: Pick<TreeNode, 'kind'>): boolean {
  return ['addon', 'folder', 'item', 'video', 'link'].includes(node.kind)
}

export type FetchJson = (url: string) => Promise<unknown>

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Shared by all trees: rows of different addons are in the same document, and their ids must not clash. */
let nextUid = 1

export function useTree(fetchJson: FetchJson) {
  const roots = ref<TreeNode[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  /** Normalized `<base>/manifest.json` of the open addon, or null. */
  const manifestUrl = ref<string | null>(null)

  let generation = 0
  let manifest: Manifest | null = null
  let base = ''
  let revealToken = 0
  const query = ref('')
  /** Folders opened by a search that the user closed again. Reset by a new query. */
  const closedInSearch = ref(new Set<number>())
  const search = reactive<SearchState>({ status: 'idle', loads: 0, failed: 0 })
  /** Bumped to abandon a running crawl. */
  let crawlToken = 0
  /**
   * Boxes the user set. Everything else follows its parent, so a selected folder also
   * covers what hasn't loaded yet. Only holds marks that differ from the parent's state.
   */
  const marks = ref(new Map<number, boolean>())

  /** Link types to show. Empty shows them all. */
  const filters = ref(new Set<LinkFilter>())
  const searching = computed(() => query.value !== '' || filters.value.size > 0)

  function hasText(node: TreeNode): boolean {
    const text = query.value
    if (!text || node.kind === 'more' || node.kind === 'note') return false
    return [node.label, node.hint, node.url].some((value) => value?.toLowerCase().includes(text))
  }

  const passesFilters = (node: TreeNode) =>
    filters.value.size === 0 || (node.kind === 'link' && !!node.url && filters.value.has(linkFilterOf(node.url)))

  /**
   * What the search and filters leave. With filters, only links match, and a link's text
   * may match through a folder above it: `Show` plus MKV is the MKV links in Show.
   */
  const matched = computed(() => {
    const self = new Set<number>()
    const below = new Set<number>()
    if (!searching.value) return { self, below }
    const filtering = filters.value.size > 0
    const visit = (node: TreeNode, textAbove: boolean): boolean => {
      const text = hasText(node)
      const own = filtering ? node.kind === 'link' && passesFilters(node) && (!query.value || textAbove || text) : text
      if (own) self.add(node.uid)
      let any = false
      for (const child of node.children ?? []) {
        if (visit(child, textAbove || text)) any = true
      }
      if (any) below.add(node.uid)
      return own || any
    }
    for (const root of roots.value) visit(root, false)
    return { self, below }
  })

  const isMatch = (node: TreeNode) => matched.value.self.has(node.uid)
  /** Loads under way, so a second caller waits for the same one. */
  const inFlight = new Map<number, Promise<void>>()

  function once(node: TreeNode, run: () => Promise<void>): Promise<void> {
    const pending = inFlight.get(node.uid)
    if (pending) return pending
    const started = run().finally(() => inFlight.delete(node.uid))
    inFlight.set(node.uid, started)
    return started
  }

  function build(spec: NodeSpec): TreeNode {
    return {
      ...spec,
      uid: nextUid++,
      key: nodeKey(spec),
      children: spec.children ? spec.children.map(build) : null,
      expanded: false,
      loading: false,
      error: null,
      skip: 0,
      seen: null,
    }
  }

  async function open(input: string): Promise<boolean> {
    const current = ++generation
    stopSearch('idle')
    marks.value = new Map()
    filters.value = new Set()
    roots.value = []
    error.value = null
    manifest = null
    manifestUrl.value = null
    loading.value = true
    try {
      const nextBase = addonBase(input)
      const data = await fetchJson(`${nextBase}/manifest.json`)
      if (current !== generation) return false
      manifest = parseManifest(data)
      base = nextBase
      manifestUrl.value = `${nextBase}/manifest.json`
      const root = build(addonNode(manifest))
      root.expanded = true
      roots.value = [root]
      return true
    } catch (cause) {
      if (current === generation) error.value = messageOf(cause)
      return false
    } finally {
      if (current === generation) loading.value = false
    }
  }

  // What the filters hide was deselected by them, so it doesn't make a box mixed.
  const counts = (node: TreeNode) =>
    filters.value.size === 0 ||
    (node.children === null && node.kind !== 'link') ||
    matched.value.self.has(node.uid) ||
    matched.value.below.has(node.uid)
  const differsBelow = (node: TreeNode, on: boolean): boolean =>
    (node.children ?? []).some((child) => {
      if (!counts(child)) return false
      const childOn = marks.value.get(child.uid) ?? on
      return childOn !== on || differsBelow(child, childOn)
    })
  const checkOf = (node: TreeNode, on: boolean): CheckState =>
    marks.value.size && differsBelow(node, on) ? 'mixed' : on ? 'on' : 'off'
  const pathTo = (node: TreeNode, trail: PathSegment[]) =>
    isFolderNode(node) ? [...trail, { key: node.key, label: node.label }] : trail

  /** How many of each folder's children are showing, once past the first page. */
  const limits = ref(new Map<number, number>())
  /** The "Load more" row that shows more of what's already fetched, one per folder. */
  const pagers = new Map<number, TreeNode>()
  const pagerUids = new Set<number>()

  function pagerFor(parent: TreeNode, left: number): TreeNode {
    let pager = pagers.get(parent.uid)
    if (!pager) {
      pager = build({ kind: 'more', label: 'Load more' })
      pagers.set(parent.uid, pager)
      pagerUids.add(pager.uid)
    }
    pager.hint = `${left} more`
    return pager
  }

  const fetchedChildren = (node: TreeNode) => (node.children ?? []).filter((child) => child.kind !== 'more')

  /** Does this title answer the search? With filters, it must also lead to a link they allow. */
  function isTitleHit(node: TreeNode): boolean {
    if (filters.value.size) return matched.value.below.has(node.uid)
    return hasText(node) || (node.children ?? []).some((child) => child.kind === 'link' && hasText(child))
  }

  const rows = computed<VisibleRow[]>(() => {
    const out: VisibleRow[] = []

    /** `filter`: list only what leads to a match. Off below a matching folder the user opened. */
    const walk = (
      nodes: TreeNode[],
      parent: TreeNode | null,
      depth: number,
      trail: PathSegment[],
      filter: boolean,
      parentOn: boolean,
    ) => {
      for (const node of nodes) {
        const hitBelow = filter && matched.value.below.has(node.uid)
        if (filter && !hitBelow && !isMatch(node)) continue
        const open = hitBelow ? !closedInSearch.value.has(node.uid) : node.expanded
        const path = pathTo(node, trail)
        const on = marks.value.get(node.uid) ?? parentOn
        out.push({ node, parent, depth, path, open, check: checkOf(node, on) })
        if (!open || !node.children) continue
        const shown = fetchedChildren(node)
        const limit = limits.value.get(node.uid) ?? PAGE_SIZE
        if (hitBelow || shown.length <= limit) {
          walk(node.children, node, depth + 1, path, hitBelow, on)
        } else {
          walk(shown.slice(0, limit), node, depth + 1, path, false, on)
          out.push({ node: pagerFor(node, shown.length - limit), parent: node, depth: depth + 1, path, open: false, check: 'off' })
        }
      }
    }

    /** A search lists the matching titles, wherever they are, instead of the tree. */
    const titles = (nodes: TreeNode[], parent: TreeNode | null, depth: number, path: PathSegment[], crumbs: string[], parentOn: boolean) => {
      for (const node of nodes) {
        const on = marks.value.get(node.uid) ?? parentOn
        const below = pathTo(node, path)
        if (isTitleNode(node) && isTitleHit(node)) {
          out.push({ node, parent, depth: 0, path: below, open: node.expanded, check: checkOf(node, on), trail: crumbs })
          if (node.expanded && node.children) walk(node.children, node, 1, below, filters.value.size > 0, on)
          continue
        }
        // The root isn't part of a breadcrumb: there's only one per tab.
        titles(node.children ?? [], node, depth + 1, below, parent ? [...crumbs, node.label] : crumbs, on)
      }
    }

    if (query.value) titles(roots.value, null, 0, [], [], false)
    else walk(roots.value, null, 0, [], searching.value, false)
    return out
  })

  /** From the root down to this node, wherever it is, showing or not. */
  function chainOf(uid: number): VisibleRow[] {
    const visit = (nodes: TreeNode[], parent: TreeNode | null, depth: number, trail: PathSegment[], parentOn: boolean): VisibleRow[] | null => {
      for (const node of nodes) {
        const path = pathTo(node, trail)
        const on = marks.value.get(node.uid) ?? parentOn
        const row = (): VisibleRow => ({ node, parent, depth, path, open: node.expanded, check: checkOf(node, on) })
        if (node.uid === uid) return [row()]
        const below = visit(node.children ?? [], node, depth + 1, path, on)
        if (below) return [row(), ...below]
      }
      return null
    }
    return visit(roots.value, null, 0, [], false) ?? []
  }

  const rowOf = (uid: number): VisibleRow | null => chainOf(uid).at(-1) ?? null

  /** What's directly inside a folder, for browsing one folder at a time. */
  function childRows(uid: number): VisibleRow[] {
    const row = rowOf(uid)
    if (!row) return []
    const on = marks.value.get(row.node.uid) ?? (row.parent ? isOn(row.parent) : false)
    return (row.node.children ?? []).map((node) => {
      const childOn = marks.value.get(node.uid) ?? on
      return { node, parent: row.node, depth: row.depth + 1, path: pathTo(node, row.path), open: node.expanded, check: checkOf(node, childOn) }
    })
  }

  async function loadCatalogPage(node: TreeNode, loader: Extract<Loader, { kind: 'catalog' }>, current: number) {
    const data = await fetchJson(loaderUrl(base, loader, node.skip))
    if (current !== generation || !manifest) return
    node.seen ??= new Set()
    const items = newItems(data, node.seen)
    node.skip += Array.isArray((data as { metas?: unknown[] }).metas) ? (data as { metas: unknown[] }).metas.length : 0

    const existing = (node.children ?? []).filter((child) => child.kind !== 'more')
    const added = items.map((item) => build(itemNode(manifest as Manifest, loader.type, item)))
    const next = [...existing, ...added]
    if (loader.pageable && added.length > 0) next.push(build({ kind: 'more', label: 'Load more' }))
    if (next.length === 0) next.push(build({ kind: 'note', label: 'Empty' }))
    node.children = next
  }

  /** Fetch a folder's children without opening it. */
  async function load(node: TreeNode) {
    if (node.children === null && node.loader) await once(node, () => loadChildren(node))
  }

  /** Fetch these in the background, a few at a time. Leaves alone what's loaded or has failed. */
  async function preload(nodes: TreeNode[]) {
    const queue = nodes.filter((node) => node.children === null && node.loader && !node.loading && !node.error)
    const worker = async () => {
      for (let node = queue.shift(); node; node = queue.shift()) await load(node)
    }
    await Promise.all(Array.from({ length: PRELOAD_CONCURRENCY }, worker))
  }

  async function loadChildren(node: TreeNode) {
    const loader = node.loader
    if (!loader || !manifest) return
    const current = generation
    node.loading = true
    node.error = null
    try {
      if (loader.kind === 'catalog') {
        await loadCatalogPage(node, loader, current)
        return
      }
      const data = await fetchJson(loaderUrl(base, loader))
      if (current !== generation) return
      if (loader.kind === 'stream') {
        node.children = streamNodes(data).map(build)
        return
      }
      const result = metaChildren(manifest, loader.type, data)
      if ('children' in result) {
        node.children = result.children.map(build)
      } else {
        // One video or none: the streams belong directly under this item.
        node.loader = result.loader
        const streams = await fetchJson(loaderUrl(base, result.loader))
        if (current === generation) node.children = streamNodes(streams).map(build)
      }
    } catch (cause) {
      if (current === generation) node.error = messageOf(cause)
    } finally {
      node.loading = false
    }
  }

  function isExpandable(node: TreeNode): boolean {
    return node.children !== null || node.loader !== undefined
  }

  async function expand(node: TreeNode) {
    if (!isExpandable(node)) return
    node.expanded = true
    closedInSearch.value.delete(node.uid)
    if (node.children === null) await once(node, () => loadChildren(node))
  }

  function collapse(node: TreeNode) {
    node.expanded = false
    if (searching.value) closedInSearch.value.add(node.uid)
  }

  async function toggle(node: TreeNode) {
    const open = rows.value.find((row) => row.node.uid === node.uid)?.open ?? node.expanded
    if (open) collapse(node)
    else await expand(node)
  }

  async function retry(row: VisibleRow) {
    if (row.node.kind === 'more' && row.parent) await loadMore(row)
    else await loadChildren(row.node)
  }

  async function loadMore(row: Pick<VisibleRow, 'node' | 'parent'>) {
    const { node: more, parent } = row
    if (!parent) return
    const limit = limits.value.get(parent.uid) ?? PAGE_SIZE
    if (pagerUids.has(more.uid)) {
      limits.value.set(parent.uid, limit + PAGE_SIZE)
      return
    }
    if (parent.loader?.kind !== 'catalog') return
    const loader = parent.loader
    // What this fetches is what was asked for, so it shows right away.
    limits.value.set(parent.uid, Math.max(limit, fetchedChildren(parent).length + PAGE_SIZE))
    await once(more, async () => {
      const current = generation
      more.loading = true
      more.error = null
      try {
        await loadCatalogPage(parent, loader, current)
      } catch (cause) {
        if (current === generation) more.error = messageOf(cause)
      } finally {
        more.loading = false
      }
    })
  }

  function findChild(parent: TreeNode, segment: PathSegment): TreeNode | undefined {
    const folders = (parent.children ?? []).filter(isFolderNode)
    return folders.find((child) => child.key === segment.key) ?? folders.find((child) => child.label === segment.label)
  }

  /**
   * Expand down a saved path, reading more catalog pages where needed. Stops at the
   * deepest folder reached if a step fails. Null if something newer took over.
   */
  async function reveal(path: PathSegment[]): Promise<RevealResult | null> {
    const current = generation
    const token = ++revealToken
    const stale = () => current !== generation || token !== revealToken

    let node = roots.value[0]
    if (!node) return null
    for (const segment of path) {
      await expand(node)
      if (stale()) return null
      if (node.error) return { node, error: `Couldn't load "${node.label}": ${node.error}` }

      let child = findChild(node, segment)
      let pages = 0
      while (!child && pages < MAX_REVEAL_PAGES) {
        const more = node.children?.find((candidate) => candidate.kind === 'more')
        if (!more) break
        await loadMore({ node: more, parent: node })
        if (stale()) return null
        if (more.error) return { node, error: `Couldn't load more of "${node.label}": ${more.error}` }
        child = findChild(node, segment)
        pages++
      }
      if (!child) {
        const where = pages === MAX_REVEAL_PAGES ? `the first ${pages} extra pages of "${node.label}"` : `"${node.label}"`
        return { node, error: `Couldn't find "${segment.label}" in ${where}` }
      }
      // It may be past the page showing.
      limits.value.set(node.uid, Math.max(limits.value.get(node.uid) ?? PAGE_SIZE, fetchedChildren(node).indexOf(child) + 1))
      node = child
    }
    await expand(node)
    if (stale()) return null
    return { node, error: node.error ? `Couldn't load "${node.label}": ${node.error}` : null }
  }

  /** Titles for a search, and otherwise links the filters allow. */
  const matchCount = computed(() =>
    query.value ? rows.value.filter((row) => row.trail !== undefined).length : matched.value.self.size,
  )

  /** Filter the rows, ignoring case. Only what's loaded: startSearch() loads the rest. */
  function setQuery(text: string) {
    const next = text.trim().toLowerCase()
    if (next === query.value) return
    query.value = next
    closedInSearch.value = new Set()
    if (!searching.value) stopSearch('idle')
  }

  /** Show only these link types. Anything selected outside them gets deselected. */
  function setFilters(next: Iterable<LinkFilter>) {
    filters.value = new Set(next)
    closedInSearch.value = new Set()
    if (!searching.value) stopSearch('idle')
    pruneSelection()
  }

  /**
   * Deselect what the filters rule out. A folder left with nothing selected below it is
   * deselected too. What hasn't loaded stays, and gets sorted out as it arrives.
   */
  function pruneSelection() {
    if (!filters.value.size || !marks.value.size) return
    const kept = new Map<number, boolean>()
    const decide = (node: TreeNode, parentOn: boolean): boolean => {
      const on = marks.value.get(node.uid) ?? parentOn
      let keep = on
      if (node.kind === 'link') keep = on && passesFilters(node)
      else if (node.children !== null) {
        let any = false
        for (const child of node.children) {
          if (decide(child, on)) any = true
        }
        keep = on && any
      } else if (node.kind !== 'more' && !node.loader) keep = false
      kept.set(node.uid, keep)
      return keep
    }
    for (const root of roots.value) decide(root, false)

    const next = new Map<number, boolean>()
    const write = (nodes: TreeNode[], parentOn: boolean) => {
      for (const node of nodes) {
        const on = kept.get(node.uid) ?? false
        if (on !== parentOn) next.set(node.uid, on)
        write(node.children ?? [], on)
      }
    }
    write(roots.value, false)
    marks.value = next
  }

  // Keeps up as a crawl loads more of what's selected.
  watch(matched, pruneSelection)

  function stopSearch(status: 'idle' | 'stopped' = 'stopped') {
    crawlToken++
    search.status = status
  }

  /**
   * Load everything not loaded yet below these nodes, breadth first, without expanding
   * it: catalog pages, then items, then their streams. Results land in the tree as they
   * arrive. Reuses what's loaded and tries failures again.
   */
  function crawl(start: TreeNode[], hooks: CrawlHooks) {
    const queue: TreeNode[] = [...start]
    const visited = new Set<number>()
    const failed = new Set<number>()
    const parentOf = new Map<number, TreeNode>()
    let active = 0
    let loads = 0
    let ended = false

    const end = (outcome: CrawlOutcome) => {
      if (ended) return
      ended = true
      hooks.onEnd(outcome)
    }

    const enqueueChildren = (node: TreeNode) => {
      for (const child of node.children ?? []) {
        parentOf.set(child.uid, node)
        if (!visited.has(child.uid) && !hooks.skip?.(child)) queue.push(child)
      }
    }

    const load = (node: TreeNode, parent: TreeNode | null, run: () => Promise<void>) => {
      active++
      loads++
      hooks.onLoadStart()
      run().finally(() => {
        active--
        if (!hooks.live()) {
          end('stopped')
          return
        }
        if (node.error) failed.add(node.uid)
        // A new page changes the parent's children; everything else its own.
        enqueueChildren(parent ?? node)
        hooks.onLoaded(failed.size)
        pump()
      })
    }

    const pump = () => {
      while (hooks.live() && active < SEARCH_CONCURRENCY && queue.length) {
        if (loads >= MAX_SEARCH_LOADS) break
        const node = queue.shift() as TreeNode
        if (visited.has(node.uid)) continue
        visited.add(node.uid)
        if (node.kind === 'more') {
          const parent = parentOf.get(node.uid) ?? null
          if (parent) load(node, parent, () => loadMore({ node, parent }))
        } else if (node.children === null && node.loader) {
          load(node, null, () => once(node, () => loadChildren(node)))
        } else {
          enqueueChildren(node)
        }
      }
      if (hooks.live() && active === 0) end(queue.length ? 'limit' : 'done')
    }
    pump()
  }

  function startSearch() {
    if (search.status === 'running') return
    const token = ++crawlToken
    const current = generation
    search.status = 'running'
    search.loads = 0
    search.failed = 0
    crawl([...roots.value], {
      live: () => token === crawlToken && current === generation,
      onLoadStart: () => void search.loads++,
      onLoaded: (failed) => void (search.failed = failed),
      onEnd: (outcome) => {
        if (outcome !== 'stopped') search.status = outcome
      },
    })
  }

  /** Is this node selected, going by its own box or the nearest one above it? */
  function isOn(target: TreeNode): boolean {
    const search = (nodes: TreeNode[], parentOn: boolean): boolean | null => {
      for (const node of nodes) {
        const on = marks.value.get(node.uid) ?? parentOn
        if (node === target) return on
        const below = search(node.children ?? [], on)
        if (below !== null) return below
      }
      return null
    }
    return search(roots.value, false) ?? false
  }

  /** A mixed box turns on, as if selecting all of it. */
  function toggleCheck(row: Pick<VisibleRow, 'node' | 'parent' | 'check'>) {
    const next = row.check !== 'on'
    const clear = (node: TreeNode) => {
      for (const child of node.children ?? []) {
        marks.value.delete(child.uid)
        clear(child)
      }
    }
    clear(row.node)
    const parentOn = row.parent ? isOn(row.parent) : false
    if (next === parentOn) marks.value.delete(row.node.uid)
    else marks.value.set(row.node.uid, next)
    pruneSelection()
  }

  function clearSelection() {
    marks.value = new Map()
  }

  const selection = computed<SelectionSummary>(() => {
    const summary: SelectionSummary = { folders: 0, files: 0, label: null }
    if (!marks.value.size) return summary
    const walk = (nodes: TreeNode[], parentOn: boolean) => {
      for (const node of nodes) {
        const on = marks.value.get(node.uid) ?? parentOn
        if (on && !parentOn) {
          if (isFileNode(node)) summary.files++
          else summary.folders++
          summary.label = summary.folders + summary.files === 1 ? node.label : null
        }
        walk(node.children ?? [], on)
      }
    }
    walk(roots.value, false)
    return summary
  })

  /** The selected links in tree order, among what's loaded. */
  function linksIn(chosen: Map<number, boolean>, allowed: Set<LinkFilter>): SelectionPeek {
    const links: CollectedLink[] = []
    let complete = true
    const inBounds = (link: TreeNode) => !allowed.size || (!!link.url && allowed.has(linkFilterOf(link.url)))
    const walk = (parent: TreeNode, path: PathSegment[], parentOn: boolean) => {
      if (parentOn && parent.children === null && parent.loader) complete = false
      for (const child of parent.children ?? []) {
        const on = chosen.get(child.uid) ?? parentOn
        if (on && child.kind === 'more') complete = false
        if (child.kind === 'link' && on && inBounds(child)) links.push({ node: child, parent, path, explicit: chosen.get(child.uid) === true })
        walk(child, pathTo(child, path), on)
      }
    }
    for (const root of roots.value) walk(root, [], chosen.get(root.uid) ?? false)
    return { links, complete }
  }

  const peekSelected = (): SelectionPeek => linksIn(marks.value, filters.value)

  /**
   * Find every selected link, loading what it takes without expanding anything. Links
   * come in tree order, whatever order the loads finish in. Later changes to the boxes
   * don't affect a scan already running.
   */
  function collectSelected(onProgress?: (links: number) => void): LinkScan {
    const current = generation
    const chosen = new Map(marks.value)
    const allowed = new Set(filters.value)
    let stopped = false
    let failed = 0
    let finish: (result: LinkScanResult) => void = () => {}
    const done = new Promise<LinkScanResult>((resolve) => (finish = resolve))

    const gather = () => linksIn(chosen, allowed).links

    /** The highest selected nodes. Anything else selected is below one of these or its own start. */
    const starts: TreeNode[] = []
    const findStarts = (nodes: TreeNode[], parentOn: boolean) => {
      for (const node of nodes) {
        const on = chosen.get(node.uid) ?? parentOn
        if (on && !parentOn) starts.push(node)
        findStarts(node.children ?? [], on)
      }
    }
    findStarts(roots.value, false)

    crawl(starts, {
      live: () => !stopped && current === generation,
      onLoadStart: () => {},
      onLoaded(count) {
        failed = count
        onProgress?.(gather().length)
      },
      onEnd: (outcome) => finish({ links: gather(), failed, limited: outcome === 'limit' }),
      skip: (node) => chosen.get(node.uid) === false,
    })

    return {
      done,
      stop() {
        stopped = true
        finish({ links: gather(), failed, limited: false })
      },
    }
  }

  return { peekSelected, rowOf, chainOf, childRows, load, preload, query, filters, searching, matchCount, search, isMatch, setQuery, setFilters, startSearch, stopSearch, selection, toggleCheck, clearSelection, collectSelected, roots, rows, loading, error, manifestUrl, open, expand, collapse, toggle, retry, loadMore, isExpandable, reveal }
}
