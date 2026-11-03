<script setup lang="ts">
import { ArrowUp, Check, ChevronRight, ClipboardCopy, Ellipsis, Eye, File, Film, Folder, ListChecks, Lock } from '@lucide/vue'
import { computed } from 'vue'
import type { DownloadEntry } from '../lib/downloads'
import { hasChips } from '../lib/streamMeta'
import { contentsText, holdsOnlyFiles, isFileNode, isFolderNode, type TreeNode, type VisibleRow } from '../lib/useTree'
import CheckBox from './CheckBox.vue'
import DownloadState from './DownloadState.vue'
import PosterImage from './PosterImage.vue'
import StreamChips from './StreamChips.vue'

const props = defineProps<{
  /** The folder showing. Null while a search lists titles from everywhere. */
  current: VisibleRow | null
  crumbs: { uid: number; label: string }[]
  /** What's inside it, or the search's results. */
  rows: VisibleRow[]
  /** The opened title's streams, when it's one. */
  streams: VisibleRow[]
  isTitle: boolean
  /** The current folder's breadcrumb, without the addon. */
  place: string
  /** Search results' count and progress go above the grid. */
  searching: boolean
  /** What to call a folder here. */
  shortLabel: (label: string) => string
  loading: boolean
  error: string | null
  allSelected: boolean
  copied: number | null
  isWatched: (row: VisibleRow) => boolean
  downloadOf: (row: VisibleRow) => DownloadEntry | undefined
  stageOf: (row: VisibleRow) => string | null
}>()

const emit = defineEmits<{
  up: []
  crumb: [uid: number]
  open: [row: VisibleRow]
  check: [row: VisibleRow, event: MouseEvent]
  watch: [row: VisibleRow]
  selectAll: []
  copy: [row: VisibleRow]
  download: [row: VisibleRow]
  more: [row: VisibleRow]
  retry: []
}>()

const tiles = computed(() => props.rows.filter(({ node }) => node.kind !== 'more' && node.kind !== 'note' && node.kind !== 'link'))
const moreRow = computed(() => props.rows.find(({ node }) => node.kind === 'more'))
const noteRow = computed(() => props.rows.find(({ node }) => node.kind === 'note'))

/** Inside a folder of episodes, each is a line. There's rarely a picture to make a tile of. */
const isFileList = computed(() => !props.searching && !props.isTitle && holdsOnlyFiles(tiles.value.map(({ node }) => node)))

const countText = computed(() => {
  // A title's links are copies of one thing. A plain folder's links are just files.
  if (props.isTitle && props.current?.node.kind !== 'folder') return `${props.streams.length} ${props.streams.length === 1 ? 'copy' : 'copies'}`
  if (props.isTitle) return `${props.streams.length} ${props.streams.length === 1 ? 'file' : 'files'}`
  if (isFileList.value) return `${tiles.value.length} ${tiles.value.length === 1 ? 'file' : 'files'}`
  return `${tiles.value.length}${moreRow.value ? '+' : ''} ${tiles.value.length === 1 ? 'item' : 'items'}`
})

const fileName = (node: TreeNode) => node.meta?.filename ?? node.label.split('\n')[0]
const filesIn = (node: TreeNode) => (node.children ?? []).filter(isFileNode)
const onlyFiles = (node: TreeNode) => !!node.children && holdsOnlyFiles(node.children)

/** The first four titles to be found below a folder, with blanks to fill the square. */
function mosaic(node: TreeNode): (TreeNode | null)[] {
  const found: TreeNode[] = []
  const collect = (nodes: TreeNode[] | null) => {
    for (const child of nodes ?? []) {
      if (found.length >= 4) return
      if (child.kind === 'item') found.push(child)
      else if (isFileNode(child)) continue
      else collect(child.children)
    }
  }
  collect(node.children)
  return [...found, null, null, null, null].slice(0, 4)
}
</script>

<template>
  <div class="browse">
    <div v-if="!searching && current" class="toolbar">
      <button class="btn up" type="button" title="Up one level" aria-label="Up one level" :disabled="!current.parent" @click="$emit('up')">
        <ArrowUp :size="15" />
      </button>
      <nav class="crumbs" aria-label="Folder path">
        <template v-for="(crumb, index) in crumbs" :key="crumb.uid">
          <ChevronRight v-if="index" class="separator" :size="12" />
          <button class="crumb" :class="{ last: index === crumbs.length - 1 }" type="button" @click="$emit('crumb', crumb.uid)">{{ crumb.label }}</button>
        </template>
      </nav>
      <span class="grow" />
      <span class="count mono">{{ countText }}</span>
      <button class="select-all" type="button" @click="$emit('selectAll')">
        <ListChecks :size="13" />
        {{ allSelected ? 'Deselect all' : 'Select all' }}
      </button>
    </div>

    <div v-if="isTitle && current" class="title-page">
      <div class="big-poster"><PosterImage :src="current.node.poster" :label="current.node.label" :initial-size="74" /></div>
      <div class="about">
        <div>
          <div class="heading">{{ current.node.label }}</div>
          <div v-if="place" class="place">{{ place }}</div>
        </div>
        <div v-for="row in streams" :key="row.node.uid" class="copy" @dblclick="$emit('download', row)">
          <CheckBox class="copy-check" :state="row.check" :size="18" :label="`Select ${row.node.label}`" @toggle="$emit('check', row, $event)" />
          <div class="copy-body">
            <StreamChips v-if="hasChips(row.node.meta)" :meta="row.node.meta ?? {}" />
            <div class="file mono">{{ row.node.meta?.filename ?? row.node.label }}</div>
          </div>
          <DownloadState class="copy-state" :download="downloadOf(row)" :stage="stageOf(row)" />
          <button
            class="btn copy-link"
            type="button"
            :aria-label="copied === row.node.uid ? 'Copied' : 'Copy link'"
            :title="copied === row.node.uid ? 'Copied' : 'Copy link'"
            @click.stop="$emit('copy', row)"
            @dblclick.stop
          >
            <component :is="copied === row.node.uid ? Check : ClipboardCopy" :size="14" />
          </button>
        </div>
        <div v-if="noteRow" class="note">{{ noteRow.node.label }}</div>
      </div>
    </div>

    <div v-else-if="isFileList" class="file-rows">
      <div
        v-for="row in tiles"
        :key="row.node.uid"
        class="file-row"
        :class="{ selected: row.check === 'on' }"
        tabindex="0"
        @click="$emit('open', row)"
        @keydown.enter="$emit('open', row)"
      >
        <CheckBox :state="row.check" :label="`Select ${row.node.label}`" @toggle="$emit('check', row, $event)" />
        <span v-if="row.node.poster" class="thumb"><PosterImage :src="row.node.poster" :label="row.node.label" /></span>
        <Film v-else class="film" :size="15" />
        <span class="file-label" :title="row.node.label">{{ fileName(row.node) }}</span>
        <ChevronRight class="go" :size="14" />
      </div>
      <button v-if="moreRow" class="file-row more-row" type="button" :disabled="moreRow.node.loading" @click="$emit('more', moreRow)">
        <span v-if="moreRow.node.loading" class="spinner" aria-label="Loading" />
        <Ellipsis v-else :size="14" />
        Load more
      </button>
    </div>

    <div v-else class="grid">
      <div
        v-for="row in tiles"
        :key="row.node.uid"
        class="tile"
        :class="{ locked: row.node.kind === 'locked' }"
        tabindex="0"
        @click="$emit('open', row)"
        @keydown.enter="$emit('open', row)"
      >
        <div class="card" :class="{ selected: row.check === 'on' }">
          <template v-if="row.node.kind === 'folder'">
            <ul v-if="onlyFiles(row.node)" class="file-names">
              <li v-for="file in filesIn(row.node).slice(0, 12)" :key="file.uid">{{ fileName(file) }}</li>
            </ul>
            <div v-else class="mosaic">
              <div v-for="(title, index) in mosaic(row.node)" :key="index" class="cell">
                <PosterImage v-if="title" :src="title.poster" :label="title.label" />
              </div>
            </div>
            <div class="overlay">
              <span v-if="row.node.loading" class="spinner" aria-label="Loading" />
              <File v-else-if="onlyFiles(row.node)" :size="13" />
              <Folder v-else :size="13" />
              <span v-if="row.node.error" class="overlay-text failed" :title="row.node.error">Couldn't load</span>
              <span v-else-if="row.node.children" class="overlay-text mono">{{ contentsText(row.node.children) }}</span>
            </div>
          </template>
          <div v-else-if="row.node.kind === 'locked'" class="locked-card"><Lock :size="22" /></div>
          <PosterImage v-else :src="row.node.poster" :label="row.node.label" :initial-size="58" />

          <CheckBox
            v-if="row.node.kind !== 'locked'"
            class="tile-check"
            overlay
            :state="row.check"
            :size="20"
            :label="`Select ${row.node.label}`"
            @toggle="$emit('check', row, $event)"
          />
          <button
            v-if="isFolderNode(row.node)"
            class="tile-watch"
            :class="{ on: isWatched(row) }"
            type="button"
            tabindex="-1"
            :aria-pressed="isWatched(row)"
            :aria-label="isWatched(row) ? 'Stop watching' : 'Watch for new items'"
            :title="isWatched(row) ? 'Stop watching' : 'Watch for new items'"
            @click.stop="$emit('watch', row)"
          >
            <Eye :size="13" />
          </button>
        </div>
        <span class="name" :title="row.node.label">{{ shortLabel(row.node.label) }}</span>
      </div>

      <button v-if="moreRow" class="tile more" type="button" :disabled="moreRow.node.loading" @click="$emit('more', moreRow)">
        <span class="card more-card">
          <span v-if="moreRow.node.loading" class="spinner" aria-label="Loading" />
          <Ellipsis v-else :size="22" />
        </span>
        <span class="name">Load more</span>
      </button>
    </div>

    <div v-if="!isTitle && noteRow" class="note">{{ noteRow.node.label }}</div>
    <div v-if="loading" class="note">Loading…</div>
    <div v-if="error" class="note failed">
      {{ error }}
      <button class="btn retry" type="button" @click="$emit('retry')">Retry</button>
    </div>
  </div>
</template>

<style scoped>
.browse {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.toolbar {
  display: flex;
  gap: 10px;
  align-items: center;
}

.up {
  width: 28px;
  height: 28px;
  color: var(--soft);
}

.crumbs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  min-width: 0;
  font-size: 15px;
}

.separator {
  color: var(--faint);
}

.crumb {
  color: var(--secondary);
}

.crumb:hover,
.crumb.last {
  color: var(--text);
}

.grow {
  flex: 1;
}

.count {
  flex: none;
  color: var(--dim);
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
}

.select-all {
  display: flex;
  flex: none;
  gap: 6px;
  align-items: center;
  height: 28px;
  padding: 0 10px;
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
  border: 1px solid var(--strong-border);
  border-radius: 7px;
}

.select-all svg {
  color: var(--accent);
}

.select-all:hover {
  background: var(--row-hover);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
  gap: 20px 16px;
}

.tile {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  text-align: left;
  cursor: pointer;
  user-select: none;
}

.tile.locked {
  cursor: default;
}

.card {
  position: relative;
  display: block;
  aspect-ratio: 2 / 3;
  overflow: hidden;
  background: var(--field);
  border-radius: 10px;
}

.card.selected {
  box-shadow: 0 0 0 2px var(--accent);
}

.name {
  overflow: hidden;
  font-weight: 500;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.mosaic {
  position: absolute;
  inset: 8px;
  display: grid;
  grid-template-rows: 1fr 1fr;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
}

.cell {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--row-hover);
  border-radius: 5px;
}

.overlay {
  position: absolute;
  right: 8px;
  bottom: 8px;
  left: 8px;
  display: flex;
  gap: 6px;
  align-items: center;
  height: 30px;
  padding: 0 8px;
  color: var(--folder);
  background: rgb(13 19 17 / 88%);
  border-radius: 6px;
}

.overlay-text {
  min-width: 0;
  overflow: hidden;
  color: var(--secondary);
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.overlay-text.failed {
  color: var(--danger);
}

.file-names {
  position: absolute;
  inset: 38px 10px 46px;
  display: flex;
  flex-flow: column wrap;
  gap: 5px;
  margin: 0;
  padding: 0;
  overflow: hidden;
  color: var(--secondary);
  font-size: 13px;
  list-style: none;
}

.file-names li {
  width: 100%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.file-rows {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 10px;
}

.file-row {
  display: flex;
  flex: none;
  gap: 12px;
  align-items: center;
  min-height: 44px;
  padding: 6px 16px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  user-select: none;
}

.file-row:last-child {
  border-bottom: 0;
}

.file-row:hover {
  background: var(--row-hover);
}

.file-row.selected {
  background: var(--row-selected);
}

.file-row:focus-visible {
  outline-offset: -2px;
}

.thumb {
  flex: none;
  width: 56px;
  height: 32px;
  overflow: hidden;
  border-radius: 5px;
}

.film {
  color: var(--secondary);
}

.file-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.go {
  color: var(--faint);
}

.more-row {
  color: var(--accent);
  text-align: left;
}

.locked-card,
.more-card {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--faint);
}

.more-card {
  color: var(--accent);
}

.more:hover .more-card {
  background: var(--row-hover);
}

.tile-check {
  position: absolute;
  top: 8px;
  left: 8px;
}

.tile-watch {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  color: var(--faint);
  background: rgb(9 13 12 / 60%);
  border-radius: 6px;
}

.tile-watch:hover {
  color: var(--secondary);
}

.tile-watch.on {
  color: var(--accent);
}

.spinner {
  flex: none;
  width: 13px;
  height: 13px;
  border: 2px solid var(--strong-border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 700ms linear infinite;
}

.title-page {
  display: flex;
  gap: 24px;
  align-items: flex-start;
}

.big-poster {
  flex: none;
  width: 180px;
  aspect-ratio: 2 / 3;
  overflow: hidden;
  background: var(--field);
  border-radius: 12px;
}

.about {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}

.heading {
  font-size: 26px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.place {
  margin-top: 4px;
  color: var(--muted);
}

.copy {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 14px;
  background: var(--card);
  border: 1px solid var(--field-border);
  border-radius: 10px;
}

.copy-check {
  margin-top: 2px;
}

.copy-body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

.file {
  color: var(--muted);
  font-size: 13.5px;
  word-break: break-all;
  white-space: pre-line;
}

.copy-state {
  margin-top: 8px;
}

.copy-link {
  width: 30px;
  height: 30px;
  color: var(--soft);
}

.note {
  display: flex;
  gap: 10px;
  align-items: center;
  color: var(--muted);
}

.note.failed {
  color: var(--danger);
}

.retry {
  height: 26px;
  padding: 0 10px;
  color: var(--text);
  font-size: 14.5px;
}
</style>
