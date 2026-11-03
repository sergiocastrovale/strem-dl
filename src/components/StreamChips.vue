<script setup lang="ts">
import { Clapperboard, Film, HardDrive, Headphones, Languages, Timer } from '@lucide/vue'
import { computed } from 'vue'
import { sourceText, type StreamMeta } from '../lib/streamMeta'

const props = defineProps<{
  meta: StreamMeta
  /** With icons, for the tree. Without, and wrapping, for a title's page. */
  icons?: boolean
}>()

const chips = computed(() => {
  const { meta } = props
  return [
    { text: meta.codec, icon: Film },
    { text: meta.audio, icon: Headphones },
    { text: meta.size, icon: HardDrive },
    { text: meta.languages?.join(' · '), icon: Languages },
    { text: meta.runtime, icon: Timer },
  ].filter((chip) => chip.text)
})
const source = computed(() => sourceText(props.meta))
</script>

<template>
  <div class="chips" :class="{ wrap: !icons }">
    <span v-if="source" class="chip source"><Clapperboard v-if="icons" :size="12" />{{ source }}</span>
    <span v-for="chip in chips" :key="chip.text" class="chip">
      <component :is="chip.icon" v-if="icons" :size="12" />
      {{ chip.text }}
    </span>
  </div>
</template>

<style scoped>
.chips {
  display: flex;
  gap: 6px;
  align-items: center;
  min-width: 0;
  overflow: hidden;
  color: var(--soft);
  font: 500 13.5px var(--mono);
}

.chips.wrap {
  flex-wrap: wrap;
}

.chip {
  display: flex;
  flex: none;
  gap: 5px;
  align-items: center;
  height: 22px;
  padding: 0 7px;
  white-space: nowrap;
  background: var(--button);
  border-radius: 5px;
}

.chip svg {
  color: var(--muted);
}

.chip.source {
  color: var(--accent);
  background: var(--accent-14);
}

.chip.source svg {
  color: currentcolor;
}
</style>
