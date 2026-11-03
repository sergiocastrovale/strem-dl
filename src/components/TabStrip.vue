<script setup lang="ts">
import { Box, LayoutGrid, List, Plus, X } from '@lucide/vue'
import { nextTick, ref, watch } from 'vue'
import type { HomeViewMode } from '../lib/settings'
import { tabTitle, type Tab } from '../lib/useTabs'

const props = defineProps<{ tabs: Tab[]; activeId: number | null; view: HomeViewMode }>()
defineEmits<{ activate: [id: number]; close: [id: number]; add: []; view: [view: HomeViewMode] }>()

const strip = ref<HTMLElement>()

const VIEWS = [
  { id: 'list', label: 'List', icon: List },
  { id: 'grid', label: 'Thumbnails', icon: LayoutGrid },
] as const

watch(
  () => props.activeId,
  async () => {
    await nextTick()
    strip.value?.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  },
)
</script>

<template>
  <div class="row">
    <div ref="strip" class="tabs" role="tablist" aria-label="Open addons">
      <div
        v-for="tab in tabs"
        :key="tab.id"
        class="tab"
        :class="{ active: tab.id === activeId, failed: tab.tree.error.value }"
        :title="tab.url"
      >
        <button class="title" type="button" role="tab" :aria-selected="tab.id === activeId" @click="$emit('activate', tab.id)">
          <span v-if="tab.tree.loading.value" class="spinner" aria-hidden="true" />
          <Box v-else class="box" :size="14" />
          <span class="text">{{ tabTitle(tab) }}</span>
        </button>
        <button class="close" type="button" :aria-label="`Close ${tabTitle(tab)}`" title="Close tab" @click="$emit('close', tab.id)">
          <X :size="13" />
        </button>
      </div>
    </div>
    <button class="add" type="button" aria-label="New tab" title="New tab" @click="$emit('add')">
      <Plus :size="15" />
    </button>
    <span class="grow" />
    <div class="segmented view" role="group" aria-label="View">
      <button
        v-for="option in VIEWS"
        :key="option.id"
        type="button"
        :class="{ on: view === option.id }"
        :aria-pressed="view === option.id"
        :aria-label="option.label"
        :title="option.label"
        @click="$emit('view', option.id)"
      >
        <component :is="option.icon" :size="15" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.row {
  display: flex;
  flex: none;
  gap: 4px;
  align-items: center;
  border-bottom: 1px solid var(--border);
}

.tabs {
  display: flex;
  flex: 0 1 auto;
  gap: 4px;
  min-width: 0;
  margin-bottom: -1px;
  overflow: auto hidden;
  scrollbar-width: none;
}

.tabs::-webkit-scrollbar {
  display: none;
}

.tab {
  display: flex;
  flex: none;
  gap: 8px;
  align-items: center;
  max-width: 220px;
  padding: 8px 10px 10px;
  color: var(--secondary);
  border-bottom: 2px solid transparent;
}

.tab:hover {
  color: var(--text);
}

.tab.active {
  color: var(--text);
  font-weight: 600;
  border-bottom-color: var(--accent);
}

.tab.failed .title {
  color: var(--danger);
}

.title {
  display: flex;
  gap: 8px;
  align-items: center;
  min-width: 0;
  font-weight: inherit;
}

.box {
  color: var(--dim);
}

.active .box {
  color: var(--accent);
}

.text {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
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

.close {
  display: flex;
  flex: none;
  color: var(--dim);
}

.close:hover {
  color: var(--text);
}

.add {
  display: flex;
  flex: none;
  padding: 8px;
  color: var(--dim);
}

.add:hover {
  color: var(--text);
}

.grow {
  flex: 1;
}

.view {
  margin-bottom: 6px;
}

.view button {
  width: 32px;
  height: 26px;
}
</style>
