<script setup lang="ts">
import { Search } from '@lucide/vue'
import { ref } from 'vue'
import { LINK_FILTERS, type LinkFilter } from '../lib/addon'

const model = defineModel<string>({ required: true })
defineProps<{ filters: Set<LinkFilter> }>()
defineEmits<{ enter: []; clear: []; filter: [id: LinkFilter] }>()

const input = ref<HTMLInputElement>()
defineExpose({ focus: () => input.value?.focus() })
</script>

<template>
  <div class="search" role="search">
    <label class="field field-box">
      <Search class="icon" :size="15" />
      <input
        ref="input"
        v-model="model"
        type="text"
        spellcheck="false"
        autocomplete="off"
        aria-label="Search this source"
        placeholder="Search this source"
        @keydown.enter.prevent="$emit('enter')"
        @keydown.down.prevent="$emit('enter')"
        @keydown.esc.prevent="$emit('clear')"
      />
      <kbd class="key mono">/</kbd>
    </label>
    <div class="filters" role="group" aria-label="Filter links by type">
      <button
        v-for="filter in LINK_FILTERS"
        :key="filter.id"
        class="filter mono"
        :class="{ on: filters.has(filter.id) }"
        type="button"
        :aria-pressed="filters.has(filter.id)"
        @click="$emit('filter', filter.id)"
      >
        {{ filter.label }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.search {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  padding: 12px 20px 0;
}

.field {
  display: flex;
  flex: 1 1 200px;
  gap: 8px;
  align-items: center;
  min-width: 200px;
  height: 34px;
  padding: 0 10px 0 12px;
  background: var(--field);
  border: 1px solid var(--field-border);
  border-radius: 8px;
}

.icon {
  color: var(--dim);
}

input {
  flex: 1;
  min-width: 0;
  font-size: 15px;
  background: none;
  border: 0;
}

.key {
  padding: 1px 6px;
  color: var(--dim);
  font-size: 13px;
  font-weight: 500;
  border: 1px solid var(--strong-border);
  border-radius: 4px;
}

.filters {
  display: flex;
  flex: none;
  height: 34px;
  overflow: hidden;
  border: 1px solid var(--field-border);
  border-radius: 8px;
}

.filter {
  display: flex;
  align-items: center;
  padding: 0 10px;
  color: var(--secondary);
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.04em;
}

.filter + .filter {
  border-left: 1px solid var(--field-border);
}

.filter:hover {
  background: var(--row-hover);
}

.filter.on {
  color: var(--accent);
  background: var(--toggle-on);
}

.filter:focus-visible {
  outline-offset: -2px;
}
</style>
