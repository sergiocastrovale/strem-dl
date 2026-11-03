<script setup lang="ts">
import { ArrowDownToLine, ClipboardCopy, SquareCheck } from '@lucide/vue'
import { SOURCE_CHOICES, type SourceChoice } from '../lib/settings'
import DropdownSelect from './DropdownSelect.vue'

const source = defineModel<SourceChoice>('source', { required: true })
defineProps<{
  text: string
  /** The primary button's label. */
  action: string
  /** A browser can't save these, only hand over their links. */
  copies: boolean
}>()
defineEmits<{ clear: []; go: [] }>()
</script>

<template>
  <div class="bar" role="region" aria-label="Selection">
    <SquareCheck class="mark" :size="16" />
    <span class="text">{{ text }}</span>
    <span class="grow" />
    <span class="each">Each title</span>
    <DropdownSelect v-model="source" :options="SOURCE_CHOICES" label="Each title" />
    <button class="clear" type="button" @click="$emit('clear')">Clear</button>
    <button class="btn-primary go" type="button" @click="$emit('go')">
      <component :is="copies ? ClipboardCopy : ArrowDownToLine" :size="15" />
      {{ action }}
    </button>
  </div>
</template>

<style scoped>
.bar {
  position: absolute;
  z-index: 20;
  right: 20px;
  bottom: 16px;
  left: 20px;
  display: flex;
  gap: 12px;
  align-items: center;
  height: 52px;
  padding: 0 8px 0 16px;
  background: var(--floating);
  border: 1px solid var(--strong-border);
  border-radius: 12px;
  box-shadow: var(--shadow-floating);
}

.mark {
  color: var(--accent);
}

.text {
  min-width: 0;
  overflow: hidden;
  font-weight: 500;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.grow {
  flex: 1;
}

.each {
  flex: none;
  color: var(--muted);
  font-size: 14.5px;
  white-space: nowrap;
}

.clear {
  flex: none;
  height: 34px;
  padding: 0 12px;
  color: var(--secondary);
  border-radius: 8px;
}

.clear:hover {
  color: var(--text);
}

.go {
  gap: 8px;
  height: 36px;
  padding: 0 16px;
  border-radius: 8px;
}
</style>
