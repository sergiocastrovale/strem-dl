<script setup lang="ts">
import { Minus, Square, X } from '@lucide/vue'
import type { WindowControls } from '../lib/platform'

defineProps<{ controls: WindowControls }>()
</script>

<template>
  <header class="title-bar" data-tauri-drag-region>
    <span class="title">strem-dl</span>
    <div class="buttons">
      <button type="button" tabindex="-1" aria-label="Minimize" title="Minimize" @click="controls.minimize()"><Minus :size="17" /></button>
      <button type="button" tabindex="-1" aria-label="Maximize" title="Maximize" @click="controls.toggleMaximize()"><Square :size="15" /></button>
      <button class="close" type="button" tabindex="-1" aria-label="Close" title="Close" @click="controls.close()"><X :size="17" /></button>
    </div>
  </header>
</template>

<style scoped>
.title-bar {
  position: relative;
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  height: 32px;
  background: #0e0c0b;
  border-bottom: 1px solid var(--hairline);
  user-select: none;
}

/* Drags are only picked up from the bar itself. */
.title {
  color: var(--muted);
  font-size: 14px;
  font-weight: 600;
  pointer-events: none;
}

.buttons {
  position: absolute;
  top: 0;
  right: 4px;
  bottom: 0;
  display: flex;
  gap: 2px;
  align-items: center;
}

button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 28px;
  color: var(--muted);
  border-radius: 6px;
}

button:hover {
  color: var(--text);
  background: var(--row-hover);
}

.close:hover {
  color: var(--on-accent);
  background: var(--accent);
}
</style>
