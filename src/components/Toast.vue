<script setup lang="ts">
import { Check } from '@lucide/vue'
import { toastMessage } from '../lib/toast'
</script>

<template>
  <div v-if="toastMessage" class="toast" role="status"><Check :size="14" />{{ toastMessage }}</div>
</template>

<style scoped>
.toast {
  position: fixed;
  z-index: 40;
  top: calc(var(--title-bar, 0px) + 16px);
  left: 50%;
  display: flex;
  gap: 8px;
  align-items: center;
  max-width: 70vw;
  height: 34px;
  padding: 0 14px;
  overflow: hidden;
  color: var(--on-accent);
  font-size: 14.5px;
  font-weight: 600;
  white-space: nowrap;
  text-overflow: ellipsis;
  background: var(--accent);
  border-radius: 17px;
  box-shadow: var(--shadow-toast);
  transform: translateX(-50%);
}
</style>
