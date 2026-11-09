<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, ref, watch } from 'vue'
import BrowseGrid from '../components/BrowseGrid.vue'
import SearchBar from '../components/SearchBar.vue'
import SelectionBar from '../components/SelectionBar.vue'
import StreamCard from '../components/StreamCard.vue'
import StreamRow from '../components/StreamRow.vue'
import TreeRow from '../components/TreeRow.vue'
import { canOpen, type LinkFilter, type PathSegment } from '../lib/addon'
import { copyText, openLink as openExternal } from '../lib/platform'
import {
  bulkSummary,
  kindFromAddress,
  linkKind,
  pickSources,
  selectFiles,
  useDownloads,
  type LinkKind,
  type OpenedLink,
} from '../lib/downloads'
import type { CombinedTree, SourcedLink } from '../lib/combinedTree'
import { useSettings, type HomeViewMode, type SourceChoice } from '../lib/settings'
import { withoutAddonName } from '../lib/shelves'
import { sourceName } from '../lib/sources'
import { showToast } from '../lib/toast'
import { useWatchlist } from '../lib/watchlist'
import { MAX_SEARCH_LOADS, isCheckable, isFolderNode, type TreeNode, type VisibleRow } from '../lib/useTree'

const props = defineProps<{
  /** One addon, or several one after another. */
  browser: CombinedTree
  active: boolean
  view: HomeViewMode
  /** A folder to browse to as soon as the addon is open. */
  path?: PathSegment[] | null
}>()
defineEmits<{ retry: [] }>()

const SEARCH_DELAY_MS = 300
/** Ask first from this many files: the queue would start straight away. */
const BULK_CONFIRM_FROM = 50

const tree = props.browser
const watchlist = useWatchlist()
const downloads = useDownloads()
const settings = useSettings()

const treeEl = ref<HTMLElement>()
const searchBar = ref<InstanceType<typeof SearchBar>>()
const focused = ref<number | null>(null)
/** The tree shows which row has the keyboard only while the keyboard is in use. */
const usingKeys = ref(false)
const copied = ref<number | null>(null)
const actionError = ref<string | null>(null)
const searchText = ref('')
/** Link types to show. Kept here: other pages show the same addons with their own. */
const filters = ref(new Set<LinkFilter>())
let searchTimer: ReturnType<typeof setTimeout> | undefined
/** Where a shift-click extends from. */
let lastChecked: number | null = null
/** Looking through the selection for files to download. */
const selectionScan = ref<{ found: number; stop: () => void } | null>(null)
const notice = ref<string | null>(null)
interface PendingBulk {
  files: OpenedLink[]
  label: string
  skipped: number
  failed: number
  limited: boolean
  source: SourceChoice
}
const pendingBulk = ref<PendingBulk | null>(null)

const hovered = ref<{ row: VisibleRow; element: HTMLElement } | null>(null)
const browseUid = ref<number | null>(null)

/** The addon a node is in, for saving where something came from. */
function addonOf(uid: number): { url: string; name: string } | null {
  const source = tree.sourceOf(uid)
  return source ? { url: source.url, name: sourceName(source) } : null
}
const activeId = computed(() => (focused.value === null ? undefined : `node-${focused.value}`))
const focusedIndex = computed(() => tree.rows.value.findIndex((row) => row.node.uid === focused.value))
const hasQuery = computed(() => searchText.value.trim() !== '')

/** Catalog names repeat the addon's name, which is already above them. */
const browseAddon = computed(() => browseChain.value[0]?.node.label ?? '')
const shortLabel = (label: string) => withoutAddonName(label, browseAddon.value)
const trailOf = (row: VisibleRow) => {
  const name = addonOf(row.node.uid)?.name ?? ''
  return row.trail?.map((label) => withoutAddonName(label, name)).join(' › ')
}

/** Take the keyboard, unless this tab finished loading while another URL is being typed. */
async function focusTree() {
  await nextTick()
  if (!props.active) return
  const focusedElement = document.activeElement
  if (focusedElement instanceof HTMLInputElement && focusedElement.value) return
  treeEl.value?.focus()
}

// A root that's gone was loaded again: start over from the first one.
watch(
  () => tree.roots.value[0]?.uid,
  (uid) => {
    if (uid === undefined) return
    if (focused.value === null || !tree.rowOf(focused.value)) focused.value = tree.rows.value[0]?.node.uid ?? null
    if (browseUid.value === null || !tree.rowOf(browseUid.value)) browseUid.value = uid
    focusTree()
  },
  { immediate: true },
)

// Runs after the watcher above, so the folder asked for wins over the root.
let pathShown = false
watch(
  () => tree.roots.value.length,
  (count) => {
    if (!count || !props.path || pathShown) return
    pathShown = true
    browseTo(props.path)
  },
  { immediate: true },
)

watch(
  () => props.active,
  (active) => {
    if (active) focusTree()
    else hovered.value = null
  },
)

// Filter on every key; wait for a pause before fetching anything.
watch(searchText, (text) => {
  tree.setQuery(text)
  clearTimeout(searchTimer)
  if (text.trim()) searchTimer = setTimeout(tree.startSearch, SEARCH_DELAY_MS)
})

// Going back to the list needs what the filters ruled out loaded. Thumbnails only filter a title's copies.
watch(
  () => props.view,
  (view) => {
    hovered.value = null
    if (view === 'list' && filters.value.size) tree.startSearch()
  },
)

function onGlobalKeydown(event: KeyboardEvent) {
  if (!props.active) return
  const target = event.target as Element | null
  const typing = target instanceof HTMLInputElement
  if (event.key === '/' && !typing && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault()
    searchBar.value?.focus()
  } else if (event.key === 'Escape' && !typing) {
    if (hasQuery.value) clearSearch()
    else tree.clearSelection()
  }
}

onActivated(() => {
  window.addEventListener('keydown', onGlobalKeydown)
  // Other pages may have searched the same addons.
  tree.setQuery(searchText.value)
  tree.setFilters(filters.value)
})
onDeactivated(() => window.removeEventListener('keydown', onGlobalKeydown))

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeydown)
  clearTimeout(searchTimer)
  selectionScan.value?.stop()
})

function clearSearch() {
  searchText.value = ''
}

function setFilters(next: Iterable<LinkFilter>) {
  filters.value = new Set(next)
  tree.setFilters(filters.value)
}

function toggleFilter(id: LinkFilter) {
  const next = new Set(filters.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  setFilters(next)
  // Filters need to see what isn't loaded yet, same as a search.
  if (next.size && (props.view === 'list' || hasQuery.value)) tree.startSearch()
}

function goToFirstMatch() {
  const first = tree.rows.value.find((row) => row.trail !== undefined || tree.isMatch(row.node)) ?? tree.rows.value[0]
  if (first) focusRow(first)
  usingKeys.value = true
  treeEl.value?.focus()
}

async function browseTo(path: PathSegment[]) {
  clearSearch()
  setFilters([])
  actionError.value = null
  const result = await tree.reveal(path)
  if (!result) return
  actionError.value = result.error
  browseUid.value = result.node.uid
  const row = tree.rows.value.find((candidate) => candidate.node.uid === result.node.uid)
  if (row) focusRow(row)
  focusTree()
}

/** Find a picture for what's being watched, so its row shows more than a stand-in. */
function posterFor(node: TreeNode): string | null {
  if (node.poster) return node.poster
  for (const child of node.children ?? []) {
    const found = child.poster ?? (child.children ? posterFor(child) : null)
    if (found) return found
  }
  return null
}

const watchUrl = (row: VisibleRow) => addonOf(row.node.uid)?.url ?? null

async function toggleWatch(row: VisibleRow) {
  const addon = addonOf(row.node.uid)
  if (!addon) return
  actionError.value = null
  const watching = watchlist.has(addon.url, row.path)
  try {
    await watchlist.toggle({ url: addon.url, addonName: addon.name, path: row.path, poster: posterFor(row.node) })
    showToast(`${watching ? 'Stopped watching' : 'Watching'} ${row.node.label}`)
  } catch (cause) {
    actionError.value = `Couldn't update the watchlist: ${cause instanceof Error ? cause.message : String(cause)}`
  }
}

function focusRow(row: VisibleRow) {
  focused.value = row.node.uid
  nextTick(() => document.getElementById(`node-${row.node.uid}`)?.scrollIntoView({ block: 'nearest' }))
}

async function openLink(row: VisibleRow, kind?: LinkKind) {
  const link = row.node.url
  actionError.value = null
  if (!link) return
  if (!canOpen(link)) {
    actionError.value = `Can't open this link type: ${link}`
    return
  }
  try {
    await openExternal(link)
    showToast('Opened link in browser')
  } catch (cause) {
    actionError.value = `Couldn't open the link: ${cause instanceof Error ? cause.message : String(cause)}`
    return
  }
  const details = downloadDetails(row, link)
  if (!details) return
  try {
    await downloads.recordOpened(details, kind)
  } catch (cause) {
    actionError.value = `Couldn't save the download: ${cause instanceof Error ? cause.message : String(cause)}`
  }
}

function downloadDetails(row: Pick<VisibleRow, 'node' | 'parent' | 'path'>, url: string, addon = addonOf(row.node.uid)) {
  if (!addon) return null
  // An episode isn't part of the path, so name it here.
  const name = row.parent?.kind === 'video' ? `${row.parent.label} › ${row.node.label}` : row.node.label
  return { url, name, addonUrl: addon.url, addonName: addon.name, path: row.path }
}

/** Anything that might hold a video downloads here. Everything else, and everything in a browser, opens outside. */
async function activateLink(row: VisibleRow) {
  const link = row.node.url
  if (!link || !downloads.managed || !canOpen(link)) return openLink(row)
  actionError.value = null
  const existing = downloads.find(link)
  const managedAlready = existing && existing.status !== 'opened'
  let kind: LinkKind = 'file'
  if (!managedAlready) {
    row.node.loading = true
    kind = await linkKind(link).finally(() => (row.node.loading = false))
  }
  if (kind === 'external') return openLink(row, kind)
  const details = downloadDetails(row, link)
  if (!details) return
  try {
    await downloads.download(details)
  } catch (cause) {
    actionError.value = `Couldn't start the download: ${cause instanceof Error ? cause.message : String(cause)}`
  }
}

/** Shift extends from the box last clicked, through what's showing, without unticking any of it. */
function checkRow(row: VisibleRow, event: MouseEvent | null, order: VisibleRow[]) {
  notice.value = null
  pendingBulk.value = null
  const at = order.findIndex((candidate) => candidate.node.uid === row.node.uid)
  const from = lastChecked === null ? -1 : order.findIndex((candidate) => candidate.node.uid === lastChecked)
  lastChecked = row.node.uid
  if (event?.shiftKey && at >= 0 && from >= 0) {
    const uids = order.slice(Math.min(at, from), Math.max(at, from) + 1).map(({ node }) => node.uid)
    for (const uid of uids) {
      const current = tree.rowOf(uid)
      if (current && isCheckable(current.node) && current.check !== 'on') tree.toggleCheck(current)
    }
    return
  }
  tree.toggleCheck(tree.rowOf(row.node.uid) ?? row)
}

/** Links under one film or episode are copies of the same thing, unless picked out one by one. */
const titleOf = ({ parent, explicit }: Pick<SourcedLink, 'parent' | 'explicit'>) =>
  !explicit && (parent.kind === 'item' || parent.kind === 'video') ? String(parent.uid) : null

/** A link ready for choosing between copies. */
function candidate(link: SourcedLink) {
  const details = link.node.url ? downloadDetails(link, link.node.url, { url: link.source.url, name: sourceName(link.source) }) : null
  return details ? [{ ...details, title: titleOf(link), meta: link.node.meta }] : []
}

/** How many files the button would queue, going by what's loaded. A browser can only hand links over. */
const queueSize = computed(() => {
  const { links, complete } = tree.peekSelected()
  const saveable = links.flatMap(candidate).filter((link) => !downloads.managed || kindFromAddress(link.url) !== 'external')
  return { count: pickSources(saveable, settings.bulkSource.value).length, complete }
})

const selectionText = computed(() => {
  const { folders, files } = tree.selection.value
  const count = (n: number, one: string, many: string) => (n ? `${n} ${n === 1 ? one : many}` : '')
  const parts = [count(folders, 'folder', 'folders'), count(files, 'file', 'files')].filter(Boolean)
  return parts.length ? `${parts.join(' + ')} selected` : ''
})

const actionLabel = computed(() => {
  const { count, complete } = queueSize.value
  const amount = count ? ` ${count}${complete ? '' : '+'}` : ''
  if (downloads.managed) return `Download${amount}`
  return `Copy${amount} ${count === 1 && complete ? 'link' : 'links'}`
})

/** Look through the selection for files, then queue them, or in a browser copy their links. */
async function goSelection() {
  if (selectionScan.value) return
  actionError.value = null
  notice.value = null
  pendingBulk.value = null
  const label = tree.selection.value.label ?? 'your selection'
  let stopped = false
  const scan = tree.collectSelected((found) => {
    if (selectionScan.value) selectionScan.value.found = found
  })
  selectionScan.value = {
    found: 0,
    stop() {
      stopped = true
      scan.stop()
    },
  }
  try {
    const { links, failed, limited } = await scan.done
    const candidates = links.flatMap(candidate)
    if (selectionScan.value) selectionScan.value.found = candidates.length
    const source = settings.bulkSource.value
    if (!downloads.managed) {
      if (stopped) return
      const urls = pickSources(candidates, source).map((link) => link.url)
      await copyText(urls.join('\n'))
      tree.clearSelection()
      showToast(`Copied ${urls.length} ${urls.length === 1 ? 'link' : 'links'}`)
      if (failed || limited) notice.value = bulkCaveats({ failed, limited, skipped: 0 })
      return
    }
    const classify = async (url: string): Promise<LinkKind> => {
      const existing = downloads.find(url)
      return existing && existing.status !== 'opened' ? 'file' : linkKind(url)
    }
    const { files: saveable, skipped } = await selectFiles(candidates, classify, () => !stopped)
    if (stopped) return
    const files = pickSources(saveable, source)
    const bulk = { files, label, skipped, failed, limited, source }
    if (files.length >= BULK_CONFIRM_FROM) pendingBulk.value = bulk
    else await queueBulk(bulk)
  } catch (cause) {
    actionError.value = `Couldn't queue the downloads: ${cause instanceof Error ? cause.message : String(cause)}`
  } finally {
    selectionScan.value = null
  }
}

function bulkCaveats({ failed, limited, skipped }: { failed: number; limited: boolean; skipped: number }) {
  const parts = [
    skipped ? `Skipped ${skipped} ${skipped === 1 ? "link that can't be saved" : "links that can't be saved"}.` : '',
    failed ? `${failed} ${failed === 1 ? 'part' : 'parts'} couldn't be loaded.` : '',
    limited ? 'Stopped early: this addon is too big to scan in one go.' : '',
  ]
  return parts.filter(Boolean).join(' ')
}

async function queueBulk({ files, label, skipped, failed, limited, source }: PendingBulk) {
  pendingBulk.value = null
  const added = await downloads.downloadMany(files)
  tree.clearSelection()
  if (added) showToast(`Queued ${added} ${added === 1 ? 'download' : 'downloads'}`)
  // The toast covers the usual case. This stays for anything that didn't go as asked.
  if (!added) notice.value = bulkSummary({ label, added, skipped, failed, limited, source })
  else if (skipped || failed || limited) notice.value = bulkCaveats({ failed, limited, skipped })
}

async function confirmBulk() {
  if (!pendingBulk.value) return
  try {
    await queueBulk(pendingBulk.value)
  } catch (cause) {
    actionError.value = `Couldn't queue the downloads: ${cause instanceof Error ? cause.message : String(cause)}`
  }
}

/** Stops it and deletes what it saved so far. A finished file is never touched. */
async function cancelDownload(row: VisibleRow) {
  const link = row.node.url
  if (!link) return
  actionError.value = null
  try {
    await downloads.remove(link)
  } catch (cause) {
    actionError.value = `Couldn't cancel the download: ${cause instanceof Error ? cause.message : String(cause)}`
  }
}

async function copyLink(row: VisibleRow) {
  const link = row.node.url
  if (!link) return
  actionError.value = null
  try {
    await copyText(link)
    copied.value = row.node.uid
    showToast('Link copied')
    setTimeout(() => {
      if (copied.value === row.node.uid) copied.value = null
    }, 1500)
  } catch (cause) {
    actionError.value = `Couldn't copy the link: ${cause instanceof Error ? cause.message : String(cause)}`
  }
}

/** A single click only selects a link. Double click or Enter is what gets it. */
function clickRow(row: VisibleRow) {
  usingKeys.value = false
  focused.value = row.node.uid
  const { node } = row
  if (node.kind === 'more') tree.loadMore(row)
  else if (node.kind !== 'link' && tree.isExpandable(node)) tree.toggle(node)
}

function activate(row: VisibleRow) {
  clickRow(row)
  if (row.node.kind === 'link') activateLink(row)
}

function onKeydown(event: KeyboardEvent) {
  const rows = tree.rows.value
  if (rows.length === 0) return
  const index = focusedIndex.value
  const row = rows[index]

  switch (event.key) {
    case 'ArrowDown':
      focusRow(rows[Math.min(index + 1, rows.length - 1)])
      break
    case 'ArrowUp':
      focusRow(rows[Math.max(index - 1, 0)])
      break
    case 'Home':
      focusRow(rows[0])
      break
    case 'End':
      focusRow(rows[rows.length - 1])
      break
    case 'ArrowRight':
      if (!row) return
      if (!tree.isExpandable(row.node)) break
      if (!row.open) tree.expand(row.node)
      else if (rows[index + 1]?.parent === row.node) focusRow(rows[index + 1])
      break
    case 'ArrowLeft':
      if (!row) return
      if (row.open) tree.collapse(row.node)
      else if (row.parent) {
        const parent = rows.find((candidate) => candidate.node === row.parent)
        if (parent) focusRow(parent)
      }
      break
    case 'Enter':
      if (!row) return
      activate(row)
      break
    case ' ':
      if (!row || !isCheckable(row.node)) return
      checkRow(row, null, rows)
      break
    default:
      return
  }
  usingKeys.value = true
  event.preventDefault()
}

function setHover(row: VisibleRow, element: HTMLElement | null) {
  hovered.value = element ? { row, element } : null
}

const hoverTitle = computed(() => {
  const parent = hovered.value?.row.parent
  return parent ? parent.label : (hovered.value?.row.node.label ?? '')
})

const resultLabel = computed(() => {
  if (hasQuery.value) {
    const count = tree.matchCount.value
    return `${count} ${count === 1 ? 'title matches' : 'titles match'} “${searchText.value.trim()}”`
  }
  const count = tree.matchCount.value
  return `${count} ${count === 1 ? 'link' : 'links'} of this type`
})

const searchProgress = computed(() => {
  const { status, loads } = tree.search.value
  if (status === 'running') return `Searching… ${loads} loaded`
  if (status === 'stopped') return 'Stopped, results are partial'
  if (status === 'limit') return `Paused after ${MAX_SEARCH_LOADS} loads, results are partial`
  return ''
})
const searchFailures = computed(() => (tree.search.value.failed ? `${tree.search.value.failed} couldn't load` : ''))

// Thumbnails: one folder at a time.

const browseChain = computed(() => (browseUid.value === null ? [] : tree.chainOf(browseUid.value)))
const browseRow = computed(() => browseChain.value.at(-1) ?? null)
const browseChildren = computed(() => (browseUid.value === null ? [] : tree.childRows(browseUid.value)))

const gridRows = computed(() => (hasQuery.value ? tree.rows.value.filter((row) => row.trail !== undefined) : browseChildren.value))

const passesFilter = (row: VisibleRow) => {
  const allowed = filters.value
  return !allowed.size || tree.isMatch(row.node)
}
const browseStreams = computed(() => gridRows.value.filter((row) => row.node.kind === 'link' && passesFilter(row)))
const isTitlePage = computed(() => {
  if (hasQuery.value) return false
  const node = browseRow.value?.node
  if (!node) return false
  if (browseChildren.value.some((row) => row.node.kind === 'link')) return true
  return node.kind !== 'addon' && node.kind !== 'folder' && !!node.children && !browseChildren.value.some((row) => row.node.kind !== 'note')
})

const browseCrumbs = computed(() => browseChain.value.map(({ node }) => ({ uid: node.uid, label: shortLabel(node.label) })))
const browsePlace = computed(() =>
  browseChain.value
    .slice(1, -1)
    .map(({ node }) => shortLabel(node.label))
    .join(' › '),
)
/** What Select all covers: everything showing that has a box. */
const browseCheckable = computed(() =>
  (isTitlePage.value ? browseStreams.value : gridRows.value).filter((row) => isCheckable(row.node)),
)
const allBrowseSelected = computed(() => browseCheckable.value.length > 0 && browseCheckable.value.every((row) => row.check === 'on'))

function selectAllHere() {
  notice.value = null
  pendingBulk.value = null
  const target = !allBrowseSelected.value
  for (const { node } of browseCheckable.value) {
    const current = tree.rowOf(node.uid)
    if (current && (current.check === 'on') !== target) tree.toggleCheck(current)
  }
}

function browseOpen(row: VisibleRow) {
  if (row.node.kind === 'locked') return
  clearSearch()
  browseUid.value = row.node.uid
  void tree.load(row.node)
}

function browseGo(uid: number) {
  browseUid.value = uid
  const row = tree.rowOf(uid)
  if (row) void tree.load(row.node)
}

function browseUp() {
  const parent = browseRow.value?.parent
  if (parent) browseGo(parent.uid)
}

/** Tiles of folders show what's in them, so fetch that much for what's on screen. */
watch(
  () => (props.view === 'grid' && props.active ? gridRows.value : []),
  (rows) => {
    const folders = rows.filter(({ node }) => node.kind === 'folder').map(({ node }) => node)
    const below = folders.flatMap((node) => (node.children ?? []).filter((child) => child.kind === 'folder').slice(0, 4))
    void tree.preload([...folders, ...below])
  },
)
</script>

<template>
  <div class="addon">
    <SearchBar
      v-if="tree.roots.value.length"
      ref="searchBar"
      v-model="searchText"
      :filters="filters"
      @filter="toggleFilter"
      @enter="goToFirstMatch"
      @clear="clearSearch"
    />

    <div v-if="tree.roots.value.length" class="body">
      <div v-if="view === 'list'" ref="treeEl" class="scroller tree" :class="{ 'using-keys': usingKeys }" role="tree" tabindex="0" :aria-activedescendant="activeId" @keydown="onKeydown" @scroll.passive="hovered = null">
        <div v-if="tree.searching.value" class="results">
          <span class="result-label mono">{{ resultLabel }}</span>
          <span v-if="searchProgress" class="result-note">{{ searchProgress }}</span>
          <span v-if="searchFailures" class="result-note failed">{{ searchFailures }}</span>
          <button v-if="tree.search.value.status === 'running'" class="btn result-action" type="button" @click="tree.stopSearch()">Stop</button>
          <button v-else-if="tree.search.value.status === 'stopped' || tree.search.value.status === 'limit'" class="btn result-action" type="button" @click="tree.startSearch()">Continue</button>
        </div>
        <template v-for="row in tree.rows.value" :key="row.node.uid">
          <StreamRow
            v-if="row.node.kind === 'link'"
            :row="row"
            :focused="usingKeys && row.node.uid === focused"
            :copied="row.node.uid === copied"
            :download="downloads.find(row.node.url)"
            :stage="downloads.stageOf(row.node.url)"
            @activate="clickRow(row)"
            @download="activateLink(row)"
            @copy="copyLink(row)"
            @cancel="cancelDownload(row)"
            @open="openLink(row)"
            @check="checkRow(row, $event, tree.rows.value)"
            @hover="setHover(row, $event)"
          />
          <TreeRow
            v-else
            :row="row"
            :focused="usingKeys && row.node.uid === focused"
            :expandable="tree.isExpandable(row.node)"
            :watched="isFolderNode(row.node) && watchlist.has(watchUrl(row), row.path)"
            :trail="trailOf(row)"
            @activate="clickRow(row)"
            @toggle="focused = row.node.uid; tree.toggle(row.node)"
            @retry="tree.retry(row)"
            @check="checkRow(row, $event, tree.rows.value)"
            @watch="toggleWatch(row)"
          />
        </template>
      </div>

      <div v-else class="scroller grid-scroller">
        <div v-if="hasQuery" class="results flush">
          <span class="result-label mono">{{ resultLabel }}</span>
          <span v-if="searchProgress" class="result-note">{{ searchProgress }}</span>
          <span v-if="searchFailures" class="result-note failed">{{ searchFailures }}</span>
          <button v-if="tree.search.value.status === 'running'" class="btn result-action" type="button" @click="tree.stopSearch()">Stop</button>
          <button v-else-if="tree.search.value.status === 'stopped' || tree.search.value.status === 'limit'" class="btn result-action" type="button" @click="tree.startSearch()">Continue</button>
        </div>
        <BrowseGrid
          :current="browseRow"
          :crumbs="browseCrumbs"
          :rows="gridRows"
          :streams="browseStreams"
          :is-title="isTitlePage"
          :place="browsePlace"
          :searching="hasQuery"
          :short-label="shortLabel"
          :loading="!!browseRow?.node.loading"
          :error="browseRow?.node.error ?? null"
          :all-selected="allBrowseSelected"
          :copied="copied"
          :is-watched="(row) => watchlist.has(watchUrl(row), row.path)"
          :download-of="(row) => downloads.find(row.node.url)"
          :stage-of="(row) => downloads.stageOf(row.node.url)"
          @up="browseUp"
          @crumb="browseGo"
          @open="browseOpen"
          @check="(row, event) => checkRow(row, event, browseCheckable)"
          @watch="toggleWatch"
          @select-all="selectAllHere"
          @copy="copyLink"
          @download="activateLink"
          @more="tree.loadMore"
          @retry="browseRow && tree.retry(browseRow)"
        />
      </div>

      <StreamCard
        v-if="hovered"
        :title="hoverTitle"
        :meta="hovered.row.node.meta ?? {}"
        :fallback="hovered.row.node.label"
        :anchor="hovered.element"
      />

      <div v-if="pendingBulk" class="float" role="alertdialog" aria-label="Confirm download">
        <span class="float-text">Download {{ pendingBulk.files.length }} files from {{ pendingBulk.label }}?</span>
        <button class="btn float-action" type="button" @click="pendingBulk = null">Cancel</button>
        <button class="btn-primary float-action" type="button" @click="confirmBulk">Download all</button>
      </div>
      <div v-else-if="selectionScan" class="float" role="status">
        <span class="float-text">Looking for files… {{ selectionScan.found }} found</span>
        <button class="btn float-action" type="button" @click="selectionScan.stop()">Stop</button>
      </div>
      <SelectionBar
        v-else-if="selectionText"
        :source="settings.bulkSource.value"
        :text="selectionText"
        :action="actionLabel"
        :copies="!downloads.managed"
        @update:source="settings.setBulkSource"
        @clear="tree.clearSelection()"
        @go="goSelection"
      />
      <div v-else-if="notice" class="float" role="status">
        <span class="float-text">{{ notice }}</span>
        <button class="btn float-action" type="button" @click="notice = null">Dismiss</button>
      </div>
    </div>
    <div v-else class="empty" :class="{ failed: tree.error.value }">
      <template v-if="tree.error.value">
        <span>{{ tree.error.value }}</span>
        <button class="btn empty-retry" type="button" @click="$emit('retry')">Retry</button>
      </template>
      <template v-else>Loading manifest…</template>
    </div>

    <div v-if="actionError" class="status" role="alert">{{ actionError }}</div>
  </div>
</template>

<style scoped>
.addon {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}

.body {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}

.scroller {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.tree {
  padding: 8px 0 80px;
  outline: none;
}

.grid-scroller {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 14px 20px 90px;
}

.results {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
  align-items: center;
  padding: 6px 20px 10px;
}

.results.flush {
  padding: 0;
}

.result-label {
  color: var(--dim);
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.result-note {
  color: var(--muted);
  font-size: 14.5px;
}

.result-note.failed {
  color: var(--danger);
}

.result-action {
  height: 24px;
  padding: 0 10px;
  font-size: 14px;
}

.float {
  position: absolute;
  z-index: 20;
  right: 20px;
  bottom: 16px;
  left: 20px;
  display: flex;
  gap: 12px;
  align-items: center;
  min-height: 52px;
  padding: 8px 8px 8px 16px;
  background: var(--floating);
  border: 1px solid var(--strong-border);
  border-radius: 12px;
  box-shadow: var(--shadow-floating);
}

.float-text {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

.float-action {
  height: 34px;
  padding: 0 14px;
  border-radius: 8px;
}

.empty {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 12px;
  align-items: center;
  justify-content: center;
  padding: 16px;
  color: var(--muted);
  text-align: center;
}

.empty.failed span {
  color: var(--danger);
}

.empty-retry {
  height: 30px;
  padding: 0 12px;
  color: var(--text);
}

.status {
  flex: none;
  padding: 8px 20px;
  color: var(--danger);
  font-size: 14.5px;
  background: var(--inset);
  border-top: 1px solid var(--border);
  overflow-wrap: anywhere;
}
</style>
