<script setup lang="ts">
import { EyeOff } from '@lucide/vue'
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import PosterImage from '../components/PosterImage.vue'
import { watchPathKey } from '../lib/db'
import { showToast } from '../lib/toast'
import { useWatchlist, type WatchEntry } from '../lib/watchlist'

const watchlist = useWatchlist()
const router = useRouter()
const error = ref<string | null>(null)

const labelOf = (entry: WatchEntry) => entry.path.at(-1)?.label ?? entry.addonName

async function remove(entry: WatchEntry) {
  error.value = null
  try {
    await watchlist.remove(entry.url, entry.path)
    showToast(`Stopped watching ${labelOf(entry)}`)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}

function open(entry: WatchEntry) {
  router.push({ name: 'home', query: { url: entry.url, path: JSON.stringify(entry.path) } })
}

/** Where it sits. Directly in the addon, there's only the addon to name. */
function trail(entry: WatchEntry) {
  const above = entry.path.slice(0, -1).map((segment) => segment.label)
  return above.length ? above.join(' › ') : entry.addonName
}
</script>

<template>
  <div class="page">
    <div class="head">
      <h1 class="page-title">Watchlist</h1>
      <span class="sub">Folders and titles checked for new copies</span>
    </div>

    <div v-if="error || watchlist.error.value" class="failed" role="alert">{{ error || watchlist.error.value }}</div>

    <div v-if="!watchlist.items.value.length" class="empty">Click the eye on any folder to watch it.</div>
    <div class="rows">
      <div
        v-for="entry in watchlist.items.value"
        :key="`${entry.url} ${watchPathKey(entry.path)}`"
        class="row"
        role="button"
        tabindex="0"
        :title="entry.url"
        @click="open(entry)"
        @keydown.enter="open(entry)"
      >
        <span class="poster"><PosterImage :src="entry.poster" :label="labelOf(entry)" /></span>
        <span class="about">
          <span class="label">{{ labelOf(entry) }}</span>
          <span class="trail">{{ trail(entry) }}</span>
        </span>
        <button class="btn stop" type="button" :aria-label="`Stop watching ${labelOf(entry)}`" title="Stop watching" @click.stop="remove(entry)">
          <EyeOff :size="14" />
        </button>
      </div>
    </div>
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

.head {
  display: flex;
  gap: 12px;
  align-items: baseline;
}

h1 {
  margin: 0;
}

.sub {
  color: var(--muted);
}

.empty {
  padding: 40px 0;
  color: var(--muted);
}

.failed {
  color: var(--danger);
  font-size: 14.5px;
  overflow-wrap: anywhere;
}

.rows {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.row {
  display: flex;
  gap: 14px;
  align-items: center;
  padding: 10px 14px 10px 10px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 10px;
  cursor: pointer;
}

.row:hover {
  background: var(--row-hover);
}

.row:focus-visible {
  outline-offset: -2px;
}

.poster {
  flex: none;
  width: 36px;
  height: 52px;
  overflow: hidden;
  border-radius: 6px;
}

.about {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.label {
  font-weight: 600;
}

.trail {
  color: var(--muted);
  font-size: 14.5px;
}

.stop {
  width: 30px;
  height: 30px;
  color: var(--accent);
}
</style>
