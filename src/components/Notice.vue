<script setup lang="ts">
import { X } from '@lucide/vue'

defineEmits<{ dismiss: [] }>()
</script>

<template>
  <div class="notice-banner" role="status">
    <span class="message"><slot /></span>
    <button class="dismiss" type="button" aria-label="Dismiss" title="Dismiss" @click="$emit('dismiss')">
      <X :size="14" />
    </button>
  </div>
</template>

<style scoped>
.notice-banner {
  display: flex;
  flex: none;
  gap: 8px;
  align-items: center;
  padding: 8px 12px 8px 20px;
  color: var(--secondary);
  font-size: 14.5px;
  background: var(--inset);
  border-bottom: 1px solid var(--border);
}

.message {
  flex: 1;
  min-width: 0;
}

.dismiss {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 6px;
}

.dismiss:hover {
  background: var(--row-hover);
}
</style>
