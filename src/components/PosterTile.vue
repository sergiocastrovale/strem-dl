<script setup lang="ts">
import PosterImage from './PosterImage.vue'

defineProps<{ poster?: string | null; label: string }>()
defineEmits<{ open: [] }>()
</script>

<template>
  <button class="tile" type="button" :title="label" @click="$emit('open')">
    <span class="card"><PosterImage :src="poster" :label="label" :initial-size="58" /></span>
    <span class="name">{{ label }}</span>
  </button>
</template>

<style scoped>
.tile {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  text-align: center;
  cursor: pointer;
}

.card {
  position: relative;
  display: block;
  aspect-ratio: 2 / 3;
  overflow: hidden;
  background: var(--field);
  border-radius: 10px;
  transition: box-shadow 0.12s;
}

.tile:hover .card,
.tile:focus-visible .card {
  box-shadow: 0 0 0 2px var(--accent);
}

.tile:focus-visible {
  outline: none;
}

.name {
  display: -webkit-box;
  overflow: hidden;
  font-weight: 500;
  line-height: 1.3;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
}
</style>
