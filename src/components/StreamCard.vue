<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { audioText, sourceText, type StreamMeta } from '../lib/streamMeta'

const props = defineProps<{
  title: string
  meta: StreamMeta
  /** Shown when no filename is known. */
  fallback: string
  /** The row it belongs to. */
  anchor: HTMLElement
}>()

const CARD_WIDTH = 420
const BELOW_ROW = 36
const FROM_LEFT = 120
const EDGE = 8

const card = ref<HTMLElement>()
const place = ref({ top: 0, left: 0 })

const rows = computed(() =>
  [
    ['Source', sourceText(props.meta, ' · ')],
    ['Video', props.meta.codec],
    ['Audio', audioText(props.meta)],
    ['Size', props.meta.size],
    ['Runtime', props.meta.runtime],
  ].filter(([, value]) => value),
)

/** Under the row, unless that would run off the window: the list scrolls, so it can be anywhere. */
async function position() {
  await nextTick()
  const row = props.anchor.getBoundingClientRect()
  const height = card.value?.offsetHeight ?? 0
  const below = row.top + BELOW_ROW
  const fits = below + height + EDGE <= window.innerHeight
  place.value = {
    top: fits ? below : Math.max(EDGE, row.top - height - 4),
    left: Math.min(row.left + FROM_LEFT, window.innerWidth - CARD_WIDTH - EDGE),
  }
}

watch(() => props.anchor, position, { immediate: true })
</script>

<template>
  <div ref="card" class="card" role="tooltip" :style="{ top: `${place.top}px`, left: `${place.left}px` }">
    <div class="title">{{ title }}</div>
    <div v-if="rows.length" class="facts">
      <template v-for="[key, value] in rows" :key="key">
        <span class="key">{{ key }}</span>
        <span>{{ value }}</span>
      </template>
    </div>
    <div class="file mono">{{ meta.filename ?? fallback }}</div>
  </div>
</template>

<style scoped>
.card {
  position: fixed;
  z-index: 25;
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 420px;
  padding: 14px 16px;
  background: var(--tooltip);
  border: 1px solid var(--strong-border);
  border-radius: 10px;
  box-shadow: var(--shadow-tooltip);
  pointer-events: none;
}

.title {
  font-size: 16px;
  font-weight: 600;
}

.facts {
  display: grid;
  grid-template-columns: 78px 1fr;
  row-gap: 7px;
  font-size: 14.5px;
}

.key {
  color: var(--muted);
}

.file {
  padding: 8px 10px;
  color: var(--accent);
  font-size: 13.5px;
  word-break: break-all;
  white-space: pre-line;
  background: var(--inset);
  border-radius: 6px;
}
</style>
