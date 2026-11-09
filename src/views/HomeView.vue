<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AddonView from '../components/AddonView.vue'
import SourceShelves from '../components/SourceShelves.vue'
import UrlInput from '../components/UrlInput.vue'
import ViewToggle from '../components/ViewToggle.vue'
import { combineTrees } from '../lib/combinedTree'
import { useKeptScroll } from '../lib/keptScroll'
import { useSaved } from '../lib/saved'
import { useSettings } from '../lib/settings'
import { useSources, type Source } from '../lib/sources'
import { useUrlHistory } from '../lib/urlHistory'

const history = useUrlHistory()
const saved = useSaved()
const sources = useSources()
const settings = useSettings()
const route = useRoute()
const router = useRouter()
const url = ref('')
const input = ref<InstanceType<typeof UrlInput>>()
const scroller = ref<HTMLElement>()
const error = ref<string | null>(null)
const opening = ref(false)
const kept = useKeptScroll(scroller)

const all = combineTrees(() => sources.list.value)
const view = computed(() => settings.homeView.value)
const anchorOf = (source: Pick<Source, 'url'>) => `source-${encodeURIComponent(source.url)}`

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

/** Show where an addon is on the page. */
async function scrollTo(source: Source) {
  await nextTick()
  if (view.value === 'grid') {
    document.getElementById(anchorOf(source))?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    return
  }
  const root = source.tree.roots.value[0]
  if (root) document.getElementById(`node-${root.uid}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
}

/** Load the addon, which saves it, and show it. */
async function submit() {
  if (!url.value.trim() || opening.value) return
  error.value = null
  opening.value = true
  try {
    const source = await sources.open(url.value)
    url.value = ''
    input.value?.blur()
    await scrollTo(source)
  } catch (cause) {
    error.value = messageOf(cause)
  } finally {
    opening.value = false
  }
}

async function forgetUrl(target: string) {
  error.value = null
  try {
    await history.remove(target)
  } catch (cause) {
    error.value = `Couldn't remove the URL: ${messageOf(cause)}`
  }
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
    <div class="header">
      <form class="add" @submit.prevent="submit">
        <UrlInput
          ref="input"
          v-model="url"
          :entries="history.entries.value"
          placeholder="Paste an addon URL and press Enter to add it"
          @pick="submit"
          @remove="forgetUrl"
        />
      </form>
      <ViewToggle :view="view" @view="settings.setHomeView" />
    </div>
    <div v-if="opening" class="status note" role="status">Loading the addon…</div>
    <div v-if="error" class="status" role="alert">{{ error }}</div>

    <div v-if="!sources.list.value.length" class="empty">
      {{ saved.error.value ?? 'Nothing here yet. Paste an addon URL above to add it.' }}
    </div>

    <div v-else-if="view === 'grid'" ref="scroller" class="shelves" @scroll.passive="kept.onScroll">
      <SourceShelves v-for="source in sources.list.value" :id="anchorOf(source)" :key="source.url" :source="source" />
    </div>

    <AddonView v-else :browser="all" :active="true" view="list" />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.header {
  display: flex;
  flex: none;
  gap: 12px;
  align-items: center;
  padding: 16px 20px 12px;
  border-bottom: 1px solid var(--border);
}

.add {
  flex: 1;
  min-width: 0;
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

.status.note {
  color: var(--muted);
}
</style>
