<script setup lang="ts">
import type { useDependencies } from '../lib/dependencies'
import DependencyRow from './DependencyRow.vue'

defineProps<{ dependencies: NonNullable<ReturnType<typeof useDependencies>> }>()
defineEmits<{ continue: []; skip: [] }>()
</script>

<template>
  <div class="setup">
    <div class="panel">
      <h1 class="page-title">Set up strem-dl</h1>
      <p>Saving video needs two free programs. They're downloaded from GitHub into the app's own folder.</p>

      <div v-if="dependencies.loadError.value" class="problem" role="alert">
        <span>{{ dependencies.loadError.value }}</span>
        <button class="btn try" type="button" @click="dependencies.load()">Try again</button>
      </div>

      <div class="list">
        <DependencyRow
          v-for="dependency in dependencies.items.value"
          :key="dependency.id"
          :dependency="dependency"
          @install="dependencies.install(dependency.id)"
        />
      </div>

      <div class="actions">
        <span class="hint">Without them, the app can still browse and save direct links, but not most video streams. You can install them later in Settings.</span>
        <button v-if="!dependencies.ready.value" class="btn action" type="button" @click="$emit('skip')">Skip for now</button>
        <button class="btn-primary action" type="button" :disabled="!dependencies.ready.value" @click="$emit('continue')">Continue</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.setup {
  display: grid;
  place-items: center;
  padding: 16px;
  overflow: auto;
}

.panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 100%;
  max-width: 560px;
}

h1 {
  margin: 0;
}

p {
  margin: 0;
  color: var(--secondary);
  line-height: 1.5;
}

.list {
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 10px;
}

.problem {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
  color: var(--danger);
  font-size: 14.5px;
}

.try {
  height: 30px;
  padding: 0 12px;
  color: var(--text);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  justify-content: flex-end;
}

.hint {
  flex: 1 1 260px;
  color: var(--muted);
  font-size: 14.5px;
  line-height: 1.5;
}

.action {
  height: 34px;
  padding: 0 14px;
  border-radius: 8px;
}
</style>
