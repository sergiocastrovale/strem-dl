<script setup lang="ts">
import { Check, ClipboardCopy, ExternalLink, Link2, X } from '@lucide/vue'
import { computed } from 'vue'
import type { DownloadEntry } from '../lib/downloads'
import { hasChips } from '../lib/streamMeta'
import type { VisibleRow } from '../lib/useTree'
import CheckBox from './CheckBox.vue'
import DownloadState from './DownloadState.vue'
import StreamChips from './StreamChips.vue'

const props = defineProps<{
  row: VisibleRow
  focused: boolean
  copied: boolean
  download?: DownloadEntry
  stage?: string | null
}>()

const emit = defineEmits<{
  activate: []
  download: []
  copy: []
  open: []
  cancel: []
  check: [event: MouseEvent]
  hover: [element: HTMLElement | null]
}>()

const node = computed(() => props.row.node)

/** Something that can still be stopped: waiting, running, paused or failed. */
const cancellable = computed(() => ['queued', 'downloading', 'paused', 'failed'].includes(props.download?.status ?? ''))

/** The row's own buttons stop their clicks, but a double click on one still reaches the row. */
function onDoubleClick(event: MouseEvent) {
  if (!(event.target as Element).closest('button')) emit('download')
}
</script>

<template>
  <div
    :id="`node-${node.uid}`"
    class="stream"
    :class="{ focused }"
    role="treeitem"
    :aria-level="row.depth + 1"
    :aria-selected="focused"
    :style="{ paddingLeft: `${14 + row.depth * 20}px` }"
    @click="$emit('activate')"
    @dblclick="onDoubleClick"
    @mouseenter="$emit('hover', $event.currentTarget as HTMLElement)"
    @mouseleave="$emit('hover', null)"
  >
    <span class="spacer" />
    <CheckBox :state="row.check" :label="`Select ${node.label}`" @toggle="$emit('check', $event)" />
    <span v-if="node.loading" class="spinner" role="status" aria-label="Loading" />
    <Link2 v-else class="link" :size="14" />
    <StreamChips v-if="hasChips(node.meta)" :meta="node.meta ?? {}" icons />
    <span v-else class="raw">{{ node.label }}</span>
    <span class="grow" />
    <DownloadState :download="download" :stage="stage" />
    <span v-if="node.hint" class="host mono">{{ node.hint }}</span>
    <button v-if="cancellable" class="btn action" type="button" tabindex="-1" aria-label="Cancel download" title="Cancel download" @click.stop="$emit('cancel')">
      <X :size="14" />
    </button>
    <button
      class="btn action"
      type="button"
      tabindex="-1"
      :aria-label="copied ? 'Copied' : 'Copy link'"
      :title="copied ? 'Copied' : 'Copy link'"
      @click.stop="$emit('copy')"
    >
      <component :is="copied ? Check : ClipboardCopy" :size="14" />
    </button>
    <button class="btn action" type="button" tabindex="-1" aria-label="Open link" title="Open link" @click.stop="$emit('open')">
      <ExternalLink :size="14" />
    </button>
  </div>
</template>

<style scoped>
.stream {
  display: flex;
  gap: 8px;
  align-items: center;
  height: 36px;
  padding-right: 14px;
  white-space: nowrap;
  user-select: none;
}

.stream:hover {
  background: var(--row-hover);
}

.stream.focused {
  background: var(--row-selected);
}

.spacer {
  flex: none;
  width: 14px;
}

.link {
  color: var(--accent);
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

.raw {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.grow {
  flex: 1;
}

.host {
  flex: 0 100 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--dim);
  font-size: 13.5px;
  text-overflow: ellipsis;
}

.action {
  width: 28px;
  height: 28px;
  color: var(--soft);
  border-radius: 6px;
}
</style>
