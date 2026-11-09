<script setup lang="ts">
import { Bookmark } from '@lucide/vue'
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import AddonView from '../components/AddonView.vue'
import Alert from '../components/Alert.vue'
import TabStrip from '../components/TabStrip.vue'
import UrlInput from '../components/UrlInput.vue'
import { fetchJson } from '../lib/http'
import { useSaved } from '../lib/saved'
import { useSettings } from '../lib/settings'
import { showToast } from '../lib/toast'
import { TabLimitError, useTabs } from '../lib/useTabs'
import { useUrlHistory } from '../lib/urlHistory'
import { parseWatchPath } from '../lib/watchlist'

const history = useUrlHistory()
const saved = useSaved()
const settings = useSettings()
const route = useRoute()
const url = ref('')
const input = ref<InstanceType<typeof UrlInput>>()
const error = ref<string | null>(null)
const limitAlert = ref<string | null>(null)

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

const tabs = useTabs(fetchJson, async (manifestUrl, name) => {
  try {
    await history.record(manifestUrl, name)
  } catch (cause) {
    error.value = `Couldn't save the URL: ${messageOf(cause)}`
  }
  try {
    await saved.add(manifestUrl, name)
  } catch (cause) {
    error.value = `Couldn't save the addon: ${messageOf(cause)}`
  }
})

const activeUrl = computed(() => tabs.active.value?.url ?? null)
const activeTree = computed(() => tabs.active.value?.tree ?? null)
const isSaved = computed(() => saved.has(activeTree.value?.manifestUrl.value ?? null))

onMounted(() => {
  if (!tabs.tabs.value.length) input.value?.focus()
})

// The field shows the address of the tab showing.
watch(activeUrl, (current) => (url.value = current ?? ''))

function showOpenFailure(cause: unknown) {
  if (cause instanceof TabLimitError) limitAlert.value = cause.message
  else error.value = messageOf(cause)
}

// A saved or watchlist row picked on its page arrives as ?url=...&path=...
watch(
  [() => route.query.url, () => route.query.path],
  ([target, rawPath]) => {
    if (typeof target !== 'string' || !target) return
    error.value = null
    limitAlert.value = null
    // Shows which addon is open, and leaves the field ready to change it.
    url.value = target
    try {
      tabs.open(target, parseWatchPath(rawPath))
    } catch (cause) {
      showOpenFailure(cause)
    }
  },
  { immediate: true },
)

function submit() {
  if (!url.value.trim()) return
  error.value = null
  limitAlert.value = null
  try {
    if (tabs.open(url.value) === 'unchanged') return
    url.value = activeUrl.value ?? ''
    input.value?.blur()
  } catch (cause) {
    showOpenFailure(cause)
  }
}

/** A new tab opens once there's an address for it. */
function startNewTab() {
  url.value = ''
  input.value?.focus()
}

/** Leaving the field empty goes back to showing where the tab is. */
function restoreUrl() {
  if (!url.value.trim() && activeUrl.value) url.value = activeUrl.value
}

async function forgetUrl(target: string) {
  error.value = null
  try {
    await history.remove(target)
  } catch (cause) {
    error.value = `Couldn't remove the URL: ${messageOf(cause)}`
  }
}

async function toggleSaved() {
  const tree = activeTree.value
  const manifestUrl = tree?.manifestUrl.value
  const name = tree?.roots.value[0]?.label
  if (!manifestUrl || !name) return
  error.value = null
  const adding = !saved.has(manifestUrl)
  try {
    await saved.toggle(manifestUrl, name)
    showToast(adding ? 'Added to Saved' : 'Removed from Saved')
  } catch (cause) {
    error.value = `Couldn't update Saved: ${messageOf(cause)}`
  }
}

function closeTab(id: number) {
  tabs.close(id)
  limitAlert.value = null
  if (tabs.tabs.value.length === 0) input.value?.focus()
}
</script>

<template>
  <div class="app">
    <div class="header">
      <form @submit.prevent="submit">
        <UrlInput
          ref="input"
          v-model="url"
          highlight
          :entries="history.entries.value"
          placeholder="Paste an addon URL and press Enter"
          @pick="submit"
          @remove="forgetUrl"
          @blur="restoreUrl"
        >
          <button
            v-if="activeTree?.manifestUrl.value"
            class="saved"
            :class="{ on: isSaved }"
            type="button"
            :aria-pressed="isSaved"
            :title="isSaved ? 'Remove from Saved' : 'Add to Saved'"
            @click.prevent="toggleSaved"
          >
            <Bookmark :size="14" />
            {{ isSaved ? 'Saved' : 'Save' }}
          </button>
        </UrlInput>
      </form>

      <Alert v-if="limitAlert" @dismiss="limitAlert = null">{{ limitAlert }}</Alert>

      <TabStrip
        v-if="tabs.tabs.value.length"
        :tabs="tabs.tabs.value"
        :active-id="tabs.activeId.value"
        :view="settings.homeView.value"
        @activate="tabs.activate"
        @close="closeTab"
        @add="startNewTab"
        @view="settings.setHomeView"
      />
    </div>

    <AddonView
      v-for="tab in tabs.tabs.value"
      v-show="tab.id === tabs.activeId.value"
      :key="tab.id"
      :tab="tab"
      :active="tab.id === tabs.activeId.value"
      :view="settings.homeView.value"
      @retry="tabs.load(tab)"
    />
    <div v-if="!tabs.tabs.value.length" class="empty">Nothing open yet</div>

    <div v-if="error" class="status" role="alert">{{ error }}</div>
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
  flex-direction: column;
  gap: 12px;
  padding: 16px 20px 0;
}

.saved {
  display: flex;
  flex: none;
  gap: 6px;
  align-items: center;
  height: 30px;
  padding: 0 12px;
  font-size: 14.5px;
  font-weight: 500;
  background: var(--chip);
  border-radius: 7px;
}

.saved svg {
  color: var(--muted);
}

.saved.on svg {
  color: var(--star);
}

.saved:hover {
  filter: brightness(1.12);
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
  border-top: 1px solid var(--border);
  overflow-wrap: anywhere;
}
</style>
