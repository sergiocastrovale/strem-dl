<script setup lang="ts">
import { ArrowUpRight, ClipboardCopy, ExternalLink, FolderOpen, Pause, Play, Trash2 } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import CheckBox from '../components/CheckBox.vue'
import { canOpen, linkHost } from '../lib/addon'
import {
  displayName,
  entryMeta,
  formatBytes,
  formatDuration,
  percentOf,
  useDownloads,
  type DownloadEntry,
} from '../lib/downloads'
import { copyText, openLink, showInFolder } from '../lib/platform'
import { metaLine } from '../lib/streamMeta'
import { showToast } from '../lib/toast'

type Filter = 'all' | 'active' | 'finished'

const STATUS_LABELS: Record<DownloadEntry['status'], string> = {
  opened: 'Opened',
  queued: 'Queued',
  downloading: 'Downloading',
  paused: 'Paused',
  done: 'Done',
  failed: 'Failed',
}

const downloads = useDownloads()
const router = useRouter()
const error = ref<string | null>(null)
const filter = ref<Filter>('all')
const selected = ref(new Set<string>())
const focused = ref<string | null>(null)
/** Where a shift-click extends from. */
let anchor: string | null = null

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))
const isFinished = (entry: DownloadEntry) => entry.status === 'done' || entry.status === 'opened'

const all = downloads.items
const countOf = (status: DownloadEntry['status']) => all.value.filter((entry) => entry.status === status).length
const finishedCount = computed(() => all.value.filter(isFinished).length)

const filters = computed<{ id: Filter; label: string; count: number }[]>(() => [
  { id: 'all', label: 'All', count: all.value.length },
  { id: 'active', label: 'Active', count: all.value.length - finishedCount.value },
  { id: 'finished', label: 'Done', count: finishedCount.value },
])

const summary = computed(() =>
  downloads.managed
    ? `${countOf('downloading')} downloading · ${countOf('queued')} queued · ${countOf('done')} done`
    : `${countOf('opened')} opened · Downloads run in the desktop app`,
)

const visible = computed(() =>
  all.value.filter((entry) => {
    if (filter.value === 'all') return true
    return filter.value === 'finished' ? isFinished(entry) : !isFinished(entry)
  }),
)
const chosen = computed(() => all.value.filter((entry) => selected.value.has(entry.url)))
const detail = computed(() => visible.value.find((entry) => entry.url === focused.value) ?? null)
const canPause = computed(() => chosen.value.some((entry) => entry.status === 'queued' || entry.status === 'downloading'))
const canResume = computed(() => chosen.value.some((entry) => entry.status === 'paused' || entry.status === 'failed'))

// Rows hidden by a filter or removed shouldn't stay secretly selected.
watch(visible, (rows) => {
  const shown = new Set(rows.map((entry) => entry.url))
  const kept = [...selected.value].filter((url) => shown.has(url))
  if (kept.length !== selected.value.size) selected.value = new Set(kept)
})

function click(entry: DownloadEntry, event: MouseEvent) {
  const next = new Set(selected.value)
  if (event.shiftKey && anchor) {
    const urls = visible.value.map((row) => row.url)
    const [a, b] = [urls.indexOf(anchor), urls.indexOf(entry.url)].sort((x, y) => x - y)
    if (a >= 0) urls.slice(a, b + 1).forEach((url) => next.add(url))
    else next.add(entry.url)
  } else {
    if (next.has(entry.url)) next.delete(entry.url)
    else next.add(entry.url)
    anchor = entry.url
  }
  selected.value = next
  focused.value = entry.url
}

function move(step: number) {
  const rows = visible.value
  if (!rows.length) return
  const current = rows.findIndex((entry) => entry.url === focused.value)
  const index = current < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, current + step))
  anchor = rows[index].url
  focused.value = anchor
  selected.value = new Set([anchor])
  document.getElementById(`download-${index}`)?.scrollIntoView({ block: 'nearest' })
}

async function act(run: () => Promise<unknown>, failure: string) {
  error.value = null
  try {
    await run()
  } catch (cause) {
    error.value = `${failure}: ${messageOf(cause)}`
  }
}

const resumeChosen = () => act(() => Promise.all(chosen.value.map((entry) => downloads.resume(entry.url))), "Couldn't resume")
const pauseChosen = () => act(() => Promise.all(chosen.value.map((entry) => downloads.pause(entry.url))), "Couldn't pause")
const removeChosen = () => act(() => Promise.all(chosen.value.map((entry) => downloads.remove(entry.url))), "Couldn't remove")

function open(entry: DownloadEntry) {
  act(async () => {
    if (!canOpen(entry.url)) throw new Error(`can't open this link type: ${entry.url}`)
    await openLink(entry.url)
    await downloads.recordOpened(entry)
    showToast('Opened link in browser')
  }, "Couldn't open the link")
}

function copy(entry: DownloadEntry) {
  act(async () => {
    await copyText(entry.url)
    showToast('Link copied')
  }, "Couldn't copy the link")
}

function reveal(entry: DownloadEntry) {
  const path = entry.filePath
  if (!path) return
  act(async () => {
    await showInFolder(path)
    showToast(`Opened ${path.replace(/[/\\][^/\\]*$/, '')}`)
  }, "Couldn't show the file")
}

/** Pause or start what's unfinished, and show what's saved. Ctrl and Shift are for selecting. */
function doubleClick(entry: DownloadEntry, event: MouseEvent) {
  if (!downloads.managed || event.ctrlKey || event.metaKey || event.shiftKey) return
  const { status, url } = entry
  if (status === 'done') reveal(entry)
  else if (status === 'queued' || status === 'downloading') act(() => downloads.pause(url), "Couldn't pause")
  else if (status === 'paused' || status === 'failed') act(() => downloads.resume(url), "Couldn't resume")
}

function browse(entry: DownloadEntry) {
  const query: Record<string, string> = { url: entry.addonUrl }
  if (entry.path.length) query.path = JSON.stringify(entry.path)
  router.push({ name: 'home', query })
}

const where = (entry: DownloadEntry) => [entry.addonName, ...entry.path.map((segment) => segment.label)].join(' › ')
const when = (entry: DownloadEntry) => new Date(entry.openedAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })

function metaText(entry: DownloadEntry) {
  return metaLine(entryMeta(entry)) || linkHost(entry.url) || ''
}

function sizeText(entry: DownloadEntry) {
  if (entry.totalBytes) return formatBytes(entry.totalBytes)
  return entry.doneBytes ? `${formatBytes(entry.doneBytes)}+` : ''
}

function speedText(entry: DownloadEntry) {
  if (entry.status !== 'downloading') return ''
  const speed = downloads.speedOf(entry.url)
  return speed ? `${formatBytes(speed)}/s` : ''
}

function etaText(entry: DownloadEntry) {
  if (entry.status === 'queued') return 'waiting'
  const speed = downloads.speedOf(entry.url)
  if (entry.status !== 'downloading' || !speed || !entry.totalBytes) return ''
  return formatDuration((entry.totalBytes - entry.doneBytes) / speed)
}

const statusText = (entry: DownloadEntry) => (entry.status === 'downloading' && downloads.stageOf(entry.url)) || STATUS_LABELS[entry.status]
</script>

<template>
  <div class="page">
    <div class="header">
      <h1 class="page-title">Downloads</h1>
      <span class="summary">{{ summary }}</span>
      <span class="grow" />
      <button class="btn action" type="button" :disabled="!canResume" @click="resumeChosen"><Play :size="13" />Resume</button>
      <button class="btn action" type="button" :disabled="!canPause" @click="pauseChosen"><Pause :size="13" />Pause</button>
      <button class="btn action" type="button" :disabled="!chosen.length" @click="removeChosen"><Trash2 :size="13" />Remove</button>
      <span class="divider" />
      <div class="segmented filters" role="group" aria-label="Show">
        <button
          v-for="option in filters"
          :key="option.id"
          type="button"
          :class="{ on: filter === option.id }"
          :aria-pressed="filter === option.id"
          @click="filter = option.id"
        >
          {{ option.label }}<span class="filter-count mono">{{ option.count }}</span>
        </button>
      </div>
    </div>

    <div class="table">
      <div class="columns head mono" role="row">
        <span /><span>Name</span><span class="right">Size</span><span>Progress</span><span>Status</span><span>Speed</span><span>ETA</span>
      </div>
      <div
        v-if="visible.length"
        class="rows"
        tabindex="0"
        role="grid"
        aria-label="Downloads"
        @keydown.down.prevent="move(1)"
        @keydown.up.prevent="move(-1)"
      >
        <div
          v-for="(entry, index) in visible"
          :id="`download-${index}`"
          :key="entry.url"
          class="columns row"
          :class="{ selected: selected.has(entry.url), focused: focused === entry.url }"
          role="row"
          :aria-selected="selected.has(entry.url)"
          @click="click(entry, $event)"
          @dblclick="doubleClick(entry, $event)"
        >
          <CheckBox :state="selected.has(entry.url) ? 'on' : 'off'" :label="`Select ${displayName(entry)}`" @toggle="click(entry, $event)" />
          <div class="name">
            <span class="title" :title="displayName(entry)">{{ displayName(entry) }}</span>
            <span class="meta mono">{{ metaText(entry) }}</span>
          </div>
          <span class="size mono right">{{ sizeText(entry) }}</span>
          <div class="progress">
            <template v-if="entry.status !== 'opened'">
              <div class="track" role="progressbar" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="percentOf(entry) ?? undefined">
                <div class="fill" :class="entry.status" :style="{ width: `${percentOf(entry) ?? 0}%` }" />
              </div>
              <span class="percent mono">{{ percentOf(entry) === null ? '' : `${percentOf(entry)}%` }}</span>
            </template>
          </div>
          <span class="status" :class="entry.status" :title="entry.error ?? statusText(entry)">{{ statusText(entry) }}</span>
          <span class="speed mono">{{ speedText(entry) }}</span>
          <span class="eta mono">{{ etaText(entry) }}</span>
        </div>
      </div>
      <div v-else class="empty">
        <template v-if="all.length">Nothing here with this filter.</template>
        <template v-else-if="downloads.managed">No downloads yet. Double-click a link on Home to download it.</template>
        <template v-else>No downloads yet. Links to files you open on Home show up here.</template>
      </div>
    </div>

    <div v-if="detail" class="details">
      <div class="facts">
        <span class="key">Link</span><span class="value mono" :title="detail.url">{{ detail.url }}</span>
        <template v-if="detail.filePath">
          <span class="key">Saved to</span><span class="value mono" :title="detail.filePath">{{ detail.filePath }}</span>
        </template>
        <template v-if="detail.mediaUrl && detail.mediaUrl !== detail.url">
          <span class="key">Video at</span><span class="value mono" :title="detail.mediaUrl">{{ linkHost(detail.mediaUrl) }}</span>
        </template>
        <span class="key">Addon</span><span class="value plain" :title="where(detail)">{{ where(detail) }}</span>
        <span class="key">Added</span><span class="value plain">{{ when(detail) }}</span>
        <template v-if="detail.error">
          <span class="key">Error</span><span class="value failed">{{ detail.error }}</span>
        </template>
        <template v-if="detail.attempts.length">
          <span class="key">Sources tried</span>
          <span class="value plain tried"><span v-for="attempt in detail.attempts" :key="attempt.name">{{ attempt.name }}: {{ attempt.error }}</span></span>
        </template>
        <template v-if="downloads.noteOf(detail.url)">
          <span class="key">Note</span><span class="value plain">{{ downloads.noteOf(detail.url) }}</span>
        </template>
      </div>
      <div class="detail-actions">
        <button class="btn detail-action" type="button" :disabled="detail.status !== 'done' || !downloads.managed" @click="reveal(detail)"><FolderOpen :size="14" />Show in folder</button>
        <button class="btn detail-action" type="button" @click="open(detail)"><ExternalLink :size="14" />Open link</button>
        <button class="btn detail-action" type="button" @click="copy(detail)"><ClipboardCopy :size="14" />Copy link</button>
        <button class="btn-primary detail-action" type="button" @click="browse(detail)"><ArrowUpRight :size="14" />Go to addon</button>
      </div>
    </div>

    <div v-if="error || downloads.error.value" class="error-bar" role="alert">{{ error || downloads.error.value }}</div>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.header {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 20px 24px 14px;
}

h1 {
  margin: 0 12px 0 0;
}

.summary {
  color: var(--muted);
  font-size: 14.5px;
}

.grow {
  flex: 1;
}

.action {
  height: 30px;
  padding: 0 10px;
  font-size: 14.5px;
}

.divider {
  flex: none;
  width: 1px;
  height: 20px;
  margin: 0 6px;
  background: var(--field-border);
}

.filters button {
  gap: 6px;
  height: 24px;
  padding: 0 10px;
  font-size: 14px;
  font-weight: 500;
}

.filter-count {
  font-size: 12.5px;
  font-weight: 500;
  opacity: 0.7;
}

.table {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  overflow: auto hidden;
}

.columns {
  display: grid;
  flex: none;
  grid-template-columns: 36px minmax(120px, 1fr) 80px 200px 120px 90px 80px;
  align-items: center;
  min-width: 726px;
  padding: 0 24px;
}

.head {
  height: 30px;
  color: var(--dim);
  font-size: 12.5px;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  border-bottom: 1px solid var(--border);
}

.right {
  padding-right: 16px;
  text-align: right;
}

.rows {
  flex: 1;
  min-height: 0;
  overflow: hidden auto;
  outline: none;
}

.row {
  height: 54px;
  border-bottom: 1px solid var(--hairline);
  cursor: pointer;
  user-select: none;
}

.row:hover {
  background: var(--row-hover);
}

.row.selected {
  background: var(--row-selected);
}

.row.focused {
  box-shadow: inset 3px 0 0 var(--accent);
}

.name {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.title {
  overflow: hidden;
  font-weight: 500;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.meta {
  overflow: hidden;
  color: var(--muted);
  font-size: 13px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.size {
  color: var(--soft);
  font-size: 14px;
}

.progress {
  display: flex;
  gap: 10px;
  align-items: center;
  padding-right: 16px;
}

.track {
  flex: 1;
  height: 8px;
  overflow: hidden;
  background: var(--chip);
  border-radius: 3px;
}

.fill {
  height: 100%;
  background: var(--accent);
  border-radius: 3px;
}

.fill.done {
  background: var(--done-bar);
}

.fill.paused {
  background: var(--star);
}

.fill.failed {
  background: var(--danger);
}

.percent {
  flex: none;
  width: 34px;
  color: var(--secondary);
  font-size: 13px;
  font-weight: 500;
  text-align: right;
}

.status {
  overflow: hidden;
  padding-right: 8px;
  color: var(--secondary);
  font-size: 14.5px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.status.done {
  color: var(--accent);
}

.status.downloading {
  color: var(--text);
}

.status.paused {
  color: var(--star);
}

.status.failed {
  color: var(--danger);
}

.speed {
  color: var(--soft);
  font-size: 14px;
}

.eta {
  color: var(--muted);
  font-size: 14px;
}

.empty {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  padding: 16px;
  color: var(--muted);
  text-align: center;
}

.details {
  display: flex;
  flex: none;
  gap: 24px;
  align-items: flex-start;
  max-height: 45%;
  padding: 16px 24px;
  overflow: auto;
  background: var(--inset);
  border-top: 1px solid var(--border);
}

.facts {
  display: grid;
  flex: 1;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 10px 16px;
  min-width: 0;
  font-size: 15px;
}

.key {
  color: var(--dim);
}

.value {
  min-width: 0;
  overflow: hidden;
  color: var(--soft);
  font-size: 14.5px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.value.plain {
  color: var(--text);
  font-size: 15px;
}

.value.failed {
  color: var(--danger);
  font-size: 15px;
  white-space: normal;
  overflow-wrap: anywhere;
}

.tried {
  display: flex;
  flex-direction: column;
  gap: 2px;
  white-space: normal;
}

.detail-actions {
  display: grid;
  flex: none;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}

.detail-action {
  gap: 7px;
  justify-content: flex-start;
  height: 32px;
  padding: 0 12px;
  font-size: 14.5px;
  font-weight: 500;
}

.detail-action.btn-primary {
  font-weight: 600;
}

.btn.detail-action svg {
  color: var(--soft);
}

.error-bar {
  flex: none;
  padding: 8px 24px;
  color: var(--danger);
  font-size: 14.5px;
  background: var(--inset);
  border-top: 1px solid var(--border);
  overflow-wrap: anywhere;
}
</style>
