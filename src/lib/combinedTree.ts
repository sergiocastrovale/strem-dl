import { computed } from 'vue'
import type { LinkFilter, PathSegment } from './addon'
import type { Source } from './sources'
import type { CollectedLink, LinkScanResult, SearchState, SelectionSummary, TreeNode, VisibleRow } from './useTree'

/** A selected link, with the addon it belongs to. */
export interface SourcedLink extends CollectedLink {
  source: Source
}

const STATUS_ORDER: SearchState['status'][] = ['running', 'limit', 'stopped', 'done', 'idle']

/**
 * Several addons' trees as one: rows follow each other, and everything done to a
 * node goes to the tree it's in. Node ids are unique across trees, so they tell which.
 */
export function combineTrees(sources: () => Source[]) {
  const list = computed(sources)
  const trees = () => list.value.map((source) => source.tree)

  const roots = computed(() => trees().flatMap((tree) => tree.roots.value))

  const listed = computed(() => {
    const owners = new Map<number, Source>()
    const rows: VisibleRow[] = []
    for (const source of list.value) {
      for (const row of source.tree.rows.value) {
        owners.set(row.node.uid, source)
        rows.push(row)
      }
    }
    return { rows, owners }
  })
  const rows = computed(() => listed.value.rows)

  /** The addon a node is in. Quick for what's showing; anything else is looked for. */
  function sourceOf(uid: number): Source | null {
    return listed.value.owners.get(uid) ?? list.value.find((source) => source.tree.rowOf(uid)) ?? null
  }
  const treeOf = (uid: number) => sourceOf(uid)?.tree ?? null
  /** "Load more" entries that only page through what's fetched aren't in the tree: go by the parent. */
  const treeOfRow = (row: Pick<VisibleRow, 'node' | 'parent'>) => treeOf(row.node.uid) ?? (row.parent ? treeOf(row.parent.uid) : null)

  const searching = computed(() => trees().some((tree) => tree.searching.value))
  const matchCount = computed(() => trees().reduce((total, tree) => total + tree.matchCount.value, 0))
  const search = computed<SearchState>(() => {
    const all = trees().map((tree) => tree.search)
    const status = STATUS_ORDER.find((candidate) => all.some((state) => state.status === candidate)) ?? 'idle'
    // Done only counts when every tree is.
    const settled = status === 'done' && all.some((state) => state.status === 'idle') ? 'idle' : status
    return {
      status: settled,
      loads: all.reduce((total, state) => total + state.loads, 0),
      failed: all.reduce((total, state) => total + state.failed, 0),
    }
  })

  const selection = computed<SelectionSummary>(() => {
    const parts = trees().map((tree) => tree.selection.value)
    const folders = parts.reduce((total, part) => total + part.folders, 0)
    const files = parts.reduce((total, part) => total + part.files, 0)
    const label = folders + files === 1 ? (parts.find((part) => part.label)?.label ?? null) : null
    return { folders, files, label }
  })

  function setQuery(text: string) {
    for (const tree of trees()) tree.setQuery(text)
  }

  function setFilters(next: Iterable<LinkFilter>) {
    const chosen = [...next]
    for (const tree of trees()) tree.setFilters(chosen)
  }

  function startSearch() {
    for (const tree of trees()) tree.startSearch()
  }

  function stopSearch(status: 'idle' | 'stopped' = 'stopped') {
    for (const tree of trees()) tree.stopSearch(status)
  }

  function clearSelection() {
    for (const tree of trees()) tree.clearSelection()
  }

  function peekSelected(): { links: SourcedLink[]; complete: boolean } {
    let complete = true
    const links = list.value.flatMap((source) => {
      const peek = source.tree.peekSelected()
      complete &&= peek.complete
      return peek.links.map((link) => ({ ...link, source }))
    })
    return { links, complete }
  }

  function collectSelected(onProgress?: (links: number) => void) {
    const found = list.value.map(() => 0)
    const scans = list.value.map((source, index) => ({
      source,
      scan: source.tree.collectSelected((count) => {
        found[index] = count
        onProgress?.(found.reduce((total, n) => total + n, 0))
      }),
    }))
    const done = Promise.all(scans.map(({ source, scan }) => scan.done.then((result) => ({ source, result })))).then(
      (results): Omit<LinkScanResult, 'links'> & { links: SourcedLink[] } => ({
        links: results.flatMap(({ source, result }) => result.links.map((link) => ({ ...link, source }))),
        failed: results.reduce((total, { result }) => total + result.failed, 0),
        limited: results.some(({ result }) => result.limited),
      }),
    )
    return {
      done,
      stop: () => scans.forEach(({ scan }) => scan.stop()),
    }
  }

  const isMatch = (node: TreeNode) => treeOf(node.uid)?.isMatch(node) ?? false
  const isExpandable = (node: TreeNode) => node.children !== null || node.loader !== undefined
  const rowOf = (uid: number) => treeOf(uid)?.rowOf(uid) ?? null
  const chainOf = (uid: number) => treeOf(uid)?.chainOf(uid) ?? []
  const childRows = (uid: number) => treeOf(uid)?.childRows(uid) ?? []

  async function load(node: TreeNode) {
    await treeOf(node.uid)?.load(node)
  }

  async function preload(nodes: TreeNode[]) {
    const byTree = new Map<ReturnType<typeof treeOf>, TreeNode[]>()
    for (const node of nodes) {
      const tree = treeOf(node.uid)
      if (tree) byTree.set(tree, [...(byTree.get(tree) ?? []), node])
    }
    await Promise.all([...byTree].map(([tree, group]) => tree?.preload(group)))
  }

  const expand = async (node: TreeNode) => treeOf(node.uid)?.expand(node)
  const collapse = (node: TreeNode) => treeOf(node.uid)?.collapse(node)
  const toggle = async (node: TreeNode) => treeOf(node.uid)?.toggle(node)
  const toggleCheck = (row: VisibleRow) => treeOfRow(row)?.toggleCheck(row)
  const retry = async (row: VisibleRow) => treeOfRow(row)?.retry(row)
  const loadMore = async (row: Pick<VisibleRow, 'node' | 'parent'>) => treeOfRow(row)?.loadMore(row)

  /** Only for a single addon: the path doesn't say which addon it's in. */
  async function reveal(path: PathSegment[]) {
    return list.value.length === 1 ? list.value[0].tree.reveal(path) : null
  }

  const error = computed(() => (list.value.length === 1 ? list.value[0].tree.error.value : null))

  return {
    roots,
    rows,
    error,
    searching,
    matchCount,
    search,
    selection,
    sourceOf,
    setQuery,
    setFilters,
    startSearch,
    stopSearch,
    clearSelection,
    peekSelected,
    collectSelected,
    isMatch,
    isExpandable,
    rowOf,
    chainOf,
    childRows,
    load,
    preload,
    expand,
    collapse,
    toggle,
    toggleCheck,
    retry,
    loadMore,
    reveal,
  }
}

export type CombinedTree = ReturnType<typeof combineTrees>
