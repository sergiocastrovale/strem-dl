<script setup lang="ts">
import { Box, Trash2 } from '@lucide/vue'
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useSaved } from '../lib/saved'

const saved = useSaved()
const router = useRouter()
const error = ref<string | null>(null)

async function remove(target: string) {
  error.value = null
  try {
    await saved.remove(target)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}

function open(target: string) {
  router.push({ name: 'home', query: { source: target } })
}
</script>

<template>
  <div class="page">
    <h1 class="page-title">Saved</h1>

    <div v-if="error || saved.error.value" class="note failed" role="alert">{{ error || saved.error.value }}</div>

    <div v-if="saved.items.value.length" class="list">
      <div
        v-for="item in saved.items.value"
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
        <button class="remove" type="button" :aria-label="`Remove ${item.name} from Saved`" title="Remove" @click.stop="remove(item.url)">
          <Trash2 :size="14" />
        </button>
      </div>
    </div>
    <div v-else class="empty">Nothing saved yet. Addons you open on Home show up here.</div>
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
