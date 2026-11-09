<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AddonView from '../components/AddonView.vue'
import SourceShelves from '../components/SourceShelves.vue'
import ViewToggle from '../components/ViewToggle.vue'
import { useAddons } from '../lib/addons'
import { combineTrees } from '../lib/combinedTree'
import { useKeptScroll } from '../lib/keptScroll'
import { useSettings } from '../lib/settings'
import { useSources, type Source } from '../lib/sources'

const addons = useAddons()
const sources = useSources()
const settings = useSettings()
const route = useRoute()
const router = useRouter()
const browser = ref<InstanceType<typeof AddonView>>()
const scroller = ref<HTMLElement>()
const error = ref<string | null>(null)
const kept = useKeptScroll(scroller)

const all = combineTrees(() => sources.list.value)
const view = computed(() => settings.homeView.value)
const anchorOf = (source: Pick<Source, 'url'>) => `source-${encodeURIComponent(source.url)}`

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

/** Show where an addon is on the page. */
async function scrollTo(source: Source) {
  browser.value?.clearSearch()
  await nextTick()
  if (view.value === 'grid') {
    document.getElementById(anchorOf(source))?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    return
  }
  const root = source.tree.roots.value[0]
  if (root) document.getElementById(`node-${root.uid}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
}

// An addon picked on another page arrives as ?source=<url>.
watch(
  () => route.query.source,
  async (target) => {
    if (typeof target !== 'string' || !target) return
    router.replace({ name: 'home' })
    error.value = null
    try {
      await scrollTo(await sources.open(target))
    } catch (cause) {
      error.value = messageOf(cause)
    }
  },
  { immediate: true },
)
</script>

<template>
  <div class="app">
    <div v-if="error" class="status" role="alert">{{ error }}</div>

    <div v-if="!sources.list.value.length" class="empty">
      <span v-if="addons.error.value">{{ addons.error.value }}</span>
      <span v-else>No addons yet. <RouterLink :to="{ name: 'addons' }">Add one on the Addons page.</RouterLink></span>
    </div>

    <AddonView v-else ref="browser" :browser="all" :active="true" :view="view" search-label="Search all addons">
      <template #toolbar>
        <ViewToggle :view="view" @view="settings.setHomeView" />
      </template>
      <template #browse>
        <div ref="scroller" class="shelves" @scroll.passive="kept.onScroll">
          <SourceShelves v-for="source in sources.list.value" :id="anchorOf(source)" :key="source.url" :source="source" />
        </div>
      </template>
    </AddonView>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.shelves {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 44px;
  min-height: 0;
  padding: 24px 24px 60px;
  overflow: auto;
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

.status {
  flex: none;
  padding: 8px 20px;
  color: var(--danger);
  font-size: 14.5px;
  background: var(--inset);
  border-bottom: 1px solid var(--border);
  overflow-wrap: anywhere;
}
</style>
