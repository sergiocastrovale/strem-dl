<script setup lang="ts">
import { Box, Plus, Trash2 } from '@lucide/vue'
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import UrlInput from '../components/UrlInput.vue'
import { normalizeUrl, useFavorites } from '../lib/favorites'
import { fetchJson } from '../lib/http'
import { showToast } from '../lib/toast'
import { useUrlHistory } from '../lib/urlHistory'

const favorites = useFavorites()
const history = useUrlHistory()
const router = useRouter()
const url = ref('')
const adding = ref(false)
const error = ref<string | null>(null)

async function add() {
  if (!url.value.trim() || adding.value) return
  adding.value = true
  error.value = null
  try {
    const name = await favorites.addFromUrl(url.value, fetchJson)
    await history.record(normalizeUrl(url.value), name)
    url.value = ''
    showToast('Added to favorites')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    adding.value = false
  }
}

async function remove(target: string) {
  error.value = null
  try {
    await favorites.remove(target)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}

async function forgetUrl(target: string) {
  error.value = null
  try {
    await history.remove(target)
  } catch (cause) {
    error.value = `Couldn't remove the URL: ${cause instanceof Error ? cause.message : String(cause)}`
  }
}

function open(target: string) {
  router.push({ name: 'home', query: { url: target } })
}
</script>

<template>
  <div class="page">
    <h1 class="page-title">Favorites</h1>

    <form class="add" @submit.prevent="add">
      <UrlInput v-model="url" :entries="history.entries.value" placeholder="Paste an addon manifest URL" @pick="add" @remove="forgetUrl">
        <button class="btn-primary add-button" type="submit" :disabled="adding">
          <Plus :size="14" />
          Add
        </button>
      </UrlInput>
    </form>

    <div v-if="adding" class="note">Checking manifest…</div>
    <div v-else-if="error || favorites.error.value" class="note failed" role="alert">{{ error || favorites.error.value }}</div>

    <div v-if="favorites.items.value.length" class="list">
      <div
        v-for="fav in favorites.items.value"
        :key="fav.url"
        class="row"
        role="button"
        tabindex="0"
        :title="fav.url"
        @click="open(fav.url)"
        @keydown.enter="open(fav.url)"
      >
        <span class="tile"><Box :size="16" /></span>
        <span class="about">
          <span class="name">{{ fav.name }}</span>
          <span class="url mono">{{ fav.url }}</span>
        </span>
        <button class="remove" type="button" :aria-label="`Remove ${fav.name} from favorites`" title="Remove" @click.stop="remove(fav.url)">
          <Trash2 :size="14" />
        </button>
      </div>
    </div>
    <div v-else class="empty">No favorites yet. Star an addon on Home, or add one above.</div>
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

.add :deep(.box) {
  height: 44px;
}

.add :deep(.icon) {
  color: var(--muted);
}

.add-button {
  height: 32px;
  padding: 0 12px;
  font-size: 14.5px;
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
