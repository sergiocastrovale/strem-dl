<script setup lang="ts">
import { Check, Minus } from '@lucide/vue'

withDefaults(
  defineProps<{
    state: 'on' | 'off' | 'mixed'
    label: string
    /** Box size in pixels. */
    size?: number
    /** Sits on top of a picture, so it needs its own backdrop. */
    overlay?: boolean
  }>(),
  { size: 16, overlay: false },
)
defineEmits<{ toggle: [event: MouseEvent] }>()
</script>

<template>
  <button
    class="checkbox"
    :class="[state, { overlay }]"
    type="button"
    role="checkbox"
    tabindex="-1"
    :aria-checked="state === 'mixed' ? 'mixed' : state === 'on'"
    :aria-label="label"
    :style="{ width: `${size}px`, height: `${size}px`, borderRadius: size > 16 ? '5px' : '4px' }"
    @click.stop="$emit('toggle', $event)"
    @dblclick.stop
  >
    <Check v-if="state === 'on'" :size="Math.round(size * 0.68)" :stroke-width="3" />
    <Minus v-else-if="state === 'mixed'" :size="Math.round(size * 0.68)" :stroke-width="3" />
  </button>
</template>

<style scoped>
.checkbox {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  color: var(--on-accent);
  background: transparent;
  border: 1.5px solid var(--checkbox-off);
}

.checkbox:hover {
  border-color: var(--accent);
}

.checkbox.overlay {
  -webkit-backdrop-filter: blur(4px);
  backdrop-filter: blur(4px);
}

.checkbox.on,
.checkbox.mixed {
  background: var(--accent);
  border-color: var(--accent);
}
</style>
