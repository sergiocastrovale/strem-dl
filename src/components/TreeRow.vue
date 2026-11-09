<script setup lang="ts">
import { ChevronRight, Ellipsis, Eye, Film, Folder, FolderOpen, Info, Lock } from '@lucide/vue'
import { computed, type Component } from 'vue'
import { isFolderNode, type VisibleRow } from '../lib/useTree'
import CheckBox from './CheckBox.vue'

const props = defineProps<{
  row: VisibleRow
  focused: boolean
  expandable: boolean
  watched?: boolean
  /** Breadcrumb for a search result. */
  trail?: string
}>()

defineEmits<{
  activate: []
  toggle: []
  retry: []
  check: [event: MouseEvent]
  watch: []
}>()

const node = computed(() => props.row.node)

const ICONS: Partial<Record<VisibleRow['node']['kind'], Component>> = {
  item: Film,
  video: Film,
  more: Ellipsis,
  locked: Lock,
  note: Info,
}
const icon = computed(() => {
  if (node.value.kind === 'addon') return null
  if (node.value.kind === 'folder') return props.row.open ? FolderOpen : Folder
  return ICONS[node.value.kind]
})
/** What can be opened or ticked lines up with its chevron. What can't has neither. */
const isPlain = computed(() => ['more', 'note', 'locked'].includes(node.value.kind))
/** Direct children of the root are the addon's catalogs. */
const isCatalog = computed(() => node.value.kind === 'folder' && props.row.depth === 1 && props.trail === undefined)
</script>

<template>
  <div
    :id="`node-${node.uid}`"
    class="row"
    :class="[`kind-${node.kind}`, { focused, catalog: isCatalog }]"
    role="treeitem"
    :aria-level="row.depth + 1"
    :aria-expanded="expandable ? row.open : undefined"
    :aria-selected="focused"
    :style="{ paddingLeft: `${14 + row.depth * 20}px` }"
    @click="$emit('activate')"
  >
    <template v-if="!isPlain">
      <button
        class="chevron"
        type="button"
        tabindex="-1"
        :class="{ open: row.open, hidden: !expandable }"
        :disabled="!expandable"
        :aria-label="row.open ? 'Collapse' : 'Expand'"
        @click.stop="$emit('toggle')"
      >
        <ChevronRight :size="14" />
      </button>
      <CheckBox :state="row.check" :label="`Select ${node.label}`" @toggle="$emit('check', $event)" />
    </template>

    <span v-if="node.loading" class="spinner" role="status" aria-label="Loading" />
    <component :is="icon" v-else-if="icon" class="icon" :size="isPlain ? 14 : 15" />

    <span class="label">{{ node.label }}</span>
    <span v-if="trail" class="trail">{{ trail }}</span>
    <span v-else-if="node.kind === 'more' && node.hint" class="trail">{{ node.hint }}</span>
    <span v-else-if="node.kind === 'locked' && node.hint" class="trail">{{ node.hint }}</span>

    <template v-if="node.kind === 'addon'">
      <span v-if="node.hint" class="version mono">{{ node.hint }}</span>
    </template>

    <button
      v-if="isFolderNode(node)"
      class="flat eye"
      :class="{ on: watched }"
      type="button"
      tabindex="-1"
      :aria-pressed="!!watched"
      :aria-label="watched ? 'Stop watching' : 'Watch for new items'"
      :title="watched ? 'Stop watching' : 'Watch for new items'"
      @click.stop="$emit('watch')"
    >
      <Eye :size="14" />
    </button>

    <span v-if="node.error" class="error">
      {{ node.error }}
      <button class="btn retry" type="button" tabindex="-1" @click.stop="$emit('retry')">Retry</button>
    </span>
  </div>
</template>

<style scoped>
.row {
  display: flex;
  gap: 8px;
  align-items: center;
  height: 30px;
  padding-right: 20px;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
}

.row:hover {
  background: var(--row-hover);
}

.row.focused {
  background: var(--row-selected);
}

.chevron {
  display: flex;
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--dim);
}

.chevron.hidden {
  visibility: hidden;
}

.chevron svg {
  transition: transform 150ms;
}

.chevron.open svg {
  transform: rotate(90deg);
}

.icon {
  color: var(--secondary);
}

.kind-folder .icon {
  color: var(--folder);
}

.spinner {
  flex: none;
  width: 15px;
  height: 15px;
  border: 2px solid var(--strong-border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 700ms linear infinite;
}

.label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.kind-addon .label {
  font-weight: 600;
}

.catalog .label {
  font-weight: 500;
}

.kind-more {
  color: var(--accent);
  font-size: 15px;
}

.kind-more .icon {
  color: currentcolor;
}

.kind-note,
.kind-locked {
  color: var(--muted);
  cursor: default;
}

.trail {
  flex: none;
  color: var(--dim);
  font-size: 14px;
}

.version {
  flex: none;
  padding: 1px 6px;
  color: var(--muted);
  font-size: 13px;
  font-weight: 500;
  border: 1px solid var(--strong-border);
  border-radius: 4px;
}

.flat {
  display: flex;
  flex: none;
}

.eye {
  color: var(--faint);
}

.eye:hover {
  color: var(--secondary);
}

.eye.on {
  color: var(--accent);
}

.error {
  display: flex;
  flex: none;
  gap: 8px;
  align-items: center;
  margin-left: 4px;
  color: var(--danger);
  font-size: 14.5px;
}

.retry {
  height: 22px;
  padding: 0 8px;
  color: var(--text);
  font-size: 14px;
}

@media (prefers-reduced-motion: reduce) {
  .chevron svg {
    transition: none;
  }

  .spinner {
    animation-duration: 2s;
  }
}
</style>
