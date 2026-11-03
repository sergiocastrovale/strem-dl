<script setup lang="ts">
import { Check } from '@lucide/vue'
import { computed } from 'vue'
import { downloadStateText, type DownloadEntry } from '../lib/downloads'

const props = defineProps<{ download?: DownloadEntry; stage?: string | null }>()

const finished = computed(() => props.download?.status === 'done' || props.download?.status === 'opened')
const text = computed(() => downloadStateText(props.download, props.stage))
const word = computed(() => (props.download?.status === 'done' ? 'Downloaded' : 'Opened'))
</script>

<template>
  <Check v-if="finished" class="finished" :size="14" :stroke-width="3" role="img" :aria-label="word">
    <title>{{ word }}</title>
  </Check>
  <span v-else-if="text" class="state" :class="{ failed: download?.status === 'failed' }" :title="download?.error ?? undefined">{{ text }}</span>
</template>

<style scoped>
.finished {
  color: var(--accent);
}

.state {
  flex: none;
  color: var(--accent);
  font: 500 13.5px var(--mono);
  white-space: nowrap;
}

.state.failed {
  color: var(--danger);
}
</style>
