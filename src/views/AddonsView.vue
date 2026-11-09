<script setup lang="ts">
import { Box, Trash2 } from '@lucide/vue'
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import UrlInput from '../components/UrlInput.vue'
import { useAddons } from '../lib/addons'
import { sourceName, useSources } from '../lib/sources'
import { showToast } from '../lib/toast'
import { useUrlHistory } from '../lib/urlHistory'

const addons = useAddons()
const sources = useSources()
const history = useUrlHistory()
const router = useRouter()
const url = ref('')
const input = ref<InstanceType<typeof UrlInput>>()
const error = ref<string | null>(null)
const opening = ref(false)

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

onMounted(() => {
  if (!addons.items.value.length) input.value?.focus()
})

/** Load the addon, which adds it to the list. */
async function submit() {
  if (!url.value.trim() || opening.value) return
  error.value = null
  opening.value = true
  try {
    const source = await sources.open(url.value)
    url.value = ''
    input.value?.blur()
    showToast(`Added ${sourceName(source)}`)
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

async function remove(target: string) {
  error.value = null
  try {
    await addons.remove(target)
  } catch (cause) {
    error.value = messageOf(cause)
  }
}

function open(target: string) {
  router.push({ name: 'home', query: { source: target } })
}
</script>

<template>
  <div class="page">
    <h1 class="page-title">Addons</h1>

    <form @submit.prevent="submit">
      <UrlInput
        ref="input"
        v-model="url"
        :entries="history.entries.value"
        placeholder="Paste an addon URL and press Enter to add it"
        @pick="submit"
        @remove="forgetUrl"
      />
    </form>

    <div v-if="opening" class="note" role="status">Loading the addon…</div>
    <div v-if="error || addons.error.value" class="note failed" role="alert">{{ error || addons.error.value }}</div>

    <div v-if="addons.items.value.length" class="list">
      <div
        v-for="item in addons.items.value"
        :key="item.url"
        class="row"
        role="button"
        tabindex="0"
        :title="item.url"
        @click="open(item.url)"
        @keydown.enter="open(item.url)"
      >
        <span class="tile"><Box :size="16" /></span>
        <span class="about">
          <span class="name">{{ item.name }}</span>
          <span class="url mono">{{ item.url }}</span>
        </span>
        <button class="remove" type="button" :aria-label="`Remove ${item.name} from Addons`" title="Remove" @click.stop="remove(item.url)">
          <Trash2 :size="14" />
        </button>
      </div>
    </div>
    <div v-else class="empty">No addons yet. Paste an addon URL above to add one.</div>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 20px;
  height: 100%;
  padding: 28px 32px;
  overflow: auto;
}

h1 {
  margin: 0;
}

.note {
  color: var(--muted);
  font-size: 14.5px;
}

.note.failed {
  color: var(--danger);
  overflow-wrap: anywhere;
}

.list {
  display: flex;
  flex: none;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 10px;
}

.row {
  display: flex;
  flex: none;
  gap: 14px;
  align-items: center;
  height: 56px;
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
}

.row:last-child {
  border-bottom: 0;
}

.row:hover {
  background: var(--row-hover);
}

.row:focus-visible {
  outline-offset: -2px;
}

.tile {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  color: var(--accent);
  background: var(--accent-14);
  border-radius: 8px;
}

.about {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.name {
  font-weight: 600;
}

.url {
  overflow: hidden;
  color: var(--muted);
  font-size: 14px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.remove {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  color: var(--dim);
  border-radius: 6px;
}

.remove:hover {
  color: var(--text);
  background: var(--button);
}

.empty {
  padding: 40px 0;
  color: var(--muted);
}
</style>
