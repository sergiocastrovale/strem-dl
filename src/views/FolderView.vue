<script setup lang="ts">
import { ArrowLeft } from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PosterTile from '../components/PosterTile.vue'
import { useKeptScroll } from '../lib/keptScroll'
import { FOLDER_PAGE_SIZE, folderAt, moreIn, titlePath, titlesIn, withoutAddonName } from '../lib/shelves'
import { sourceName, useSources, type Source } from '../lib/sources'
import { parseWatchPath } from '../lib/watchlist'
import type { TreeNode } from '../lib/useTree'

const route = useRoute()
const router = useRouter()
const sources = useSources()
const scroller = ref<HTMLElement>()
const sentinel = ref<HTMLElement>()
const kept = useKeptScroll(scroller)

const source = shallowRef<Source | null>(null)
const openError = ref<string | null>(null)
const shown = ref(FOLDER_PAGE_SIZE)

const target = computed(() => (route.name === 'folder' && typeof route.query.url === 'string' ? route.query.url : null))
const path = computed(() => (route.name === 'folder' ? parseWatchPath(route.query.path) : null))

const root = computed(() => source.value?.tree.roots.value[0] ?? null)
const folder = computed(() => (root.value && path.value ? folderAt(root.value, path.value) : null))
const titles = computed(() => (folder.value ? titlesIn(folder.value) : []))
const visible = computed(() => titles.value.slice(0, shown.value))
const more = computed(() => (folder.value ? moreIn(folder.value) : null))
const loading = computed(() => !!folder.value?.loading || !!more.value?.loading || !!source.value?.tree.loading.value)
const failure = computed(() => openError.value ?? folder.value?.error ?? more.value?.error ?? null)

const heading = computed(() => {
  const name = root.value?.label ?? ''
  return (path.value ?? []).map((segment) => withoutAddonName(segment.label, name)).filter((label) => label !== 'All').join(' · ')
})

// A different folder starts at the top; the same one again keeps its place.
let applied = ''
watch(
  [target, () => route.query.path],
  async ([url, rawPath]) => {
    const key = `${url}\n${String(rawPath)}`
    if (!url || key === applied) return
    applied = key
    shown.value = FOLDER_PAGE_SIZE
    kept.reset()
    openError.value = null
    source.value = sources.get(url)
    if (source.value) return
    try {
      source.value = await sources.open(url)
    } catch (cause) {
      openError.value = cause instanceof Error ? cause.message : String(cause)
    }
  },
  { immediate: true },
)

watch(folder, (node) => {
  if (node) void source.value?.tree.load(node).then(fill)
}, { immediate: true })

const atEnd = () => {
  const box = scroller.value?.getBoundingClientRect()
  const mark = sentinel.value?.getBoundingClientRect()
  return !!box && !!mark && mark.top < box.bottom + 400
}

/** Show the next page, fetching more of the catalog when what's fetched runs out. */
async function showMore() {
  const node = folder.value
  const tree = source.value?.tree
  if (!node || !tree || node.loading) return false
  if (titles.value.length > shown.value) {
    shown.value += FOLDER_PAGE_SIZE
    return true
  }
  const next = more.value
  if (!next || next.loading || next.error) return false
  await tree.loadMore({ node: next, parent: node })
  if (titles.value.length > shown.value) shown.value += FOLDER_PAGE_SIZE
  return !next.error
}

let filling = false
/** Keep going while the end of the list is on screen. */
async function fill() {
  if (filling) return
  filling = true
  try {
    await nextTick()
    while (atEnd() && (await showMore())) await nextTick()
  } finally {
    filling = false
  }
}

let observer: IntersectionObserver | undefined
onMounted(() => {
  observer = new IntersectionObserver((entries) => entries.some((entry) => entry.isIntersecting) && fill(), {
    root: scroller.value,
    rootMargin: '0px 0px 400px 0px',
  })
  if (sentinel.value) observer.observe(sentinel.value)
})
onBeforeUnmount(() => observer?.disconnect())

function back() {
  if (window.history.state?.back) router.back()
  else router.push({ name: 'home' })
}

function open(title: TreeNode) {
  if (!source.value || !path.value) return
  router.push({ name: 'browse', query: { url: source.value.url, path: JSON.stringify(titlePath(path.value, title)) } })
}

function retry() {
  if (openError.value && target.value) {
    const url = target.value
    openError.value = null
    sources.open(url).then((opened) => (source.value = opened), (cause) => (openError.value = cause instanceof Error ? cause.message : String(cause)))
  } else if (folder.value?.error) void source.value?.tree.load(folder.value).then(fill)
  else void fill()
}
</script>

<template>
  <div class="page">
    <header class="header">
      <button class="btn back" type="button" aria-label="Back" title="Back" @click="back">
        <ArrowLeft :size="16" />
      </button>
      <div class="titles">
        <div v-if="source" class="addon">{{ sourceName(source) }}</div>
        <h1 class="title">{{ heading || 'Folder' }}</h1>
      </div>
      <span v-if="titles.length" class="count mono">{{ titles.length }}{{ more ? '+' : '' }} {{ titles.length === 1 ? 'title' : 'titles' }}</span>
    </header>

    <div ref="scroller" class="scroller" @scroll.passive="kept.onScroll">
      <div v-if="root && path && !folder" class="note">This folder isn't in the addon any more.</div>
      <div v-else-if="folder?.children && !titles.length && !more" class="note">Empty</div>
      <div class="grid">
        <PosterTile v-for="title in visible" :key="title.uid" :poster="title.poster" :label="title.label" @open="open(title)" />
      </div>
      <div ref="sentinel" class="sentinel" />
      <div v-if="loading" class="note"><span class="spinner" aria-hidden="true" />Loading…</div>
      <div v-else-if="failure" class="note failed">
        {{ failure }}
        <button class="btn retry" type="button" @click="retry">Retry</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.header {
  display: flex;
  flex: none;
  gap: 14px;
  align-items: center;
  padding: 16px 24px 14px;
  border-bottom: 1px solid var(--border);
}

.back {
  flex: none;
  width: 32px;
  height: 32px;
  color: var(--soft);
}

.titles {
  flex: 1;
  min-width: 0;
}

.addon {
  color: var(--muted);
  font-size: 13.5px;
}

.title {
  margin: 0;
  overflow: hidden;
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.01em;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.count {
  flex: none;
  color: var(--dim);
  font-size: 13px;
  font-weight: 500;
}

.scroller {
  flex: 1;
  min-height: 0;
  padding: 24px 24px 60px;
  overflow: auto;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 24px 16px;
}

.sentinel {
  height: 1px;
}

.note {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 16px 0;
  color: var(--muted);
  font-size: 14.5px;
}

.note.failed {
  color: var(--danger);
  overflow-wrap: anywhere;
}

.retry {
  height: 26px;
  padding: 0 10px;
  color: var(--text);
  font-size: 14px;
}

.spinner {
  flex: none;
  width: 14px;
  height: 14px;
  border: 2px solid var(--strong-border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 700ms linear infinite;
}
</style>
