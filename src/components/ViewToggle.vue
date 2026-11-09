<script setup lang="ts">
import { LayoutGrid, List } from '@lucide/vue'
import type { HomeViewMode } from '../lib/settings'

defineProps<{ view: HomeViewMode }>()
defineEmits<{ view: [view: HomeViewMode] }>()

const VIEWS = [
  { id: 'grid', label: 'Thumbnails', icon: LayoutGrid },
  { id: 'list', label: 'List', icon: List },
] as const
</script>

<template>
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
</template>

<style scoped>
.view button {
  width: 32px;
  height: 30px;
}
</style>
