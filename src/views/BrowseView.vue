<script setup lang="ts">
import { ArrowLeft } from '@lucide/vue'
import { computed, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AddonView from '../components/AddonView.vue'
import type { PathSegment } from '../lib/addon'
import { combineTrees } from '../lib/combinedTree'
import { sourceName, useSources, type Source } from '../lib/sources'
import { parseWatchPath } from '../lib/watchlist'

const route = useRoute()
const router = useRouter()
const sources = useSources()

const source = shallowRef<Source | null>(null)
const path = ref<PathSegment[] | null>(null)
/** Remounts the browser for each visit, so it goes to the place asked for. */
const visit = ref('')
const error = ref<string | null>(null)
const browser = combineTrees(() => (source.value ? [source.value] : []))

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

watch(
  () => (route.name === 'browse' ? route.fullPath : null),
  async (fullPath) => {
    if (!fullPath || fullPath === visit.value) return
    const url = typeof route.query.url === 'string' ? route.query.url : ''
    path.value = parseWatchPath(route.query.path)
    error.value = null
    visit.value = fullPath
    source.value = sources.get(url)
    if (source.value) return
    try {
      source.value = await sources.open(url)
    } catch (cause) {
      error.value = messageOf(cause)
    }
  },
  { immediate: true },
)

const where = computed(() => {
  const name = source.value ? sourceName(source.value) : ''
  return [name, ...(path.value ?? []).slice(0, -1).map((segment) => segment.label)].filter(Boolean).join(' › ')
})

function back() {
  if (window.history.state?.back) router.back()
  else router.push({ name: 'home' })
}

function retry() {
  if (source.value) sources.retry(source.value)
}
</script>

<template>
  <div class="page">
    <header class="header">
      <button class="btn back" type="button" aria-label="Back" title="Back" @click="back">
        <ArrowLeft :size="16" />
      </button>
      <span class="where">{{ where }}</span>
    </header>
    <div v-if="error" class="failed" role="alert">{{ error }}</div>
    <AddonView v-else-if="source" :key="visit" :browser="browser" :active="true" view="grid" :path="path" @retry="retry" />
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
  gap: 12px;
  align-items: center;
  padding: 12px 20px 0;
}

.back {
  flex: none;
  width: 32px;
  height: 32px;
  color: var(--soft);
}

.where {
  min-width: 0;
  overflow: hidden;
  color: var(--muted);
  font-size: 14.5px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.failed {
  padding: 24px;
  color: var(--danger);
  overflow-wrap: anywhere;
}
</style>
