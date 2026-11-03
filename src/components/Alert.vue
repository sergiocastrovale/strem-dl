<script setup lang="ts">
import { X } from '@lucide/vue'

defineEmits<{ dismiss: [] }>()
</script>

<template>
  <div class="alert" role="alert">
    <span class="message"><slot /></span>
    <button class="dismiss" type="button" aria-label="Dismiss" title="Dismiss" @click="$emit('dismiss')">
      <X :size="14" />
    </button>
  </div>
</template>

<style scoped>
.alert {
  display: flex;
  flex: none;
  gap: 8px;
  align-items: center;
  padding: 8px 8px 8px 14px;
  color: var(--danger);
  font-size: 14.5px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
}

.message {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

.dismiss {
  display: flex;
  flex: none;
  padding: 4px;
}
</style>
