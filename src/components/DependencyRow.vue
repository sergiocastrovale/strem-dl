<script setup lang="ts">
import { computed } from 'vue'
import { DEPENDENCY_PURPOSE, type Dependency } from '../lib/dependencies'
import { formatBytes } from '../lib/downloads'

const props = defineProps<{ dependency: Dependency }>()
defineEmits<{ install: [] }>()

const progress = computed(() => props.dependency.progress)
const percent = computed(() => {
  const { done = 0, total = null } = progress.value ?? {}
  return total ? Math.min(100, Math.floor((done / total) * 100)) : null
})
const progressText = computed(() => {
  const current = progress.value
  if (!current) return ''
  if (current.stage === 'installing') return 'Installing…'
  if (!current.done) return 'Starting…'
  const size = current.total ? `${formatBytes(current.done)} of ${formatBytes(current.total)}` : formatBytes(current.done)
  return `Downloading ${size}`
})
const action = computed(() => {
  const { installed, latest } = props.dependency
  if (!installed) return 'Install'
  return latest?.updateAvailable ? `Update to ${latest.version}` : null
})
</script>

<template>
  <div class="dependency">
    <div class="line">
      <span class="name mono">{{ dependency.id }}</span>
      <span class="purpose">{{ DEPENDENCY_PURPOSE[dependency.id] }}</span>
      <span class="grow" />
      <template v-if="!progress">
        <span class="version mono" :class="{ missing: !dependency.installed }">{{ dependency.installed ? dependency.version : 'Not installed' }}</span>
        <button v-if="action" class="btn action" type="button" @click="$emit('install')">{{ action }}</button>
      </template>
    </div>
    <div v-if="progress" class="progress">
      <div class="track" :class="{ unknown: percent === null || progress.stage === 'installing' }">
        <div class="fill" :style="{ width: `${percent ?? 100}%` }" />
      </div>
      <span class="progress-text" role="status">{{ progressText }}</span>
    </div>
    <div v-if="dependency.error" class="error" role="alert">{{ dependency.error }}</div>
  </div>
</template>

<style scoped>
.dependency {
  display: flex;
  flex-direction: column;
  gap: 8px;
  justify-content: center;
  min-height: 50px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
}

.dependency:last-child {
  border-bottom: 0;
}

.line {
  display: flex;
  gap: 12px;
  align-items: center;
}

.name {
  flex: none;
  font-size: 15px;
  font-weight: 500;
}

.purpose {
  min-width: 0;
  overflow: hidden;
  color: var(--muted);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.grow {
  flex: 1;
}

.version {
  flex: none;
  color: var(--version);
  font-size: 14px;
}

.version.missing {
  color: var(--dim);
}

.action {
  height: 28px;
  padding: 0 10px;
  font-size: 14.5px;
}

.progress {
  display: flex;
  gap: 10px;
  align-items: center;
}

.track {
  flex: 1;
  height: 8px;
  overflow: hidden;
  background: var(--chip);
  border-radius: 3px;
}

.fill {
  height: 100%;
  background: var(--accent);
  border-radius: 3px;
}

.track.unknown .fill {
  opacity: 0.45;
}

.progress-text {
  flex: none;
  color: var(--muted);
  font-size: 14.5px;
}

.error {
  color: var(--danger);
  font-size: 14.5px;
  overflow-wrap: anywhere;
}
</style>
