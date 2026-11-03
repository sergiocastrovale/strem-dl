<script setup lang="ts">
import { computed, ref, watch } from 'vue'

const props = defineProps<{
  src?: string | null
  /** Tints the stand-in, so each title keeps its own colour. */
  label: string
  /** Size of the stand-in's letter in pixels. None if left out. */
  initialSize?: number
}>()

const failed = ref(false)
watch(
  () => props.src,
  () => (failed.value = false),
)

const hash = (text: string) => [...text].reduce((total, char) => (total * 31 + (char.codePointAt(0) as number)) >>> 0, 7)
const hue = computed(() => hash(props.label) % 360)
const initial = computed(() =>
  props.label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/^(O|A|Os|As|The) /, '')
    .charAt(0),
)
</script>

<template>
  <img
    v-if="src && !failed"
    class="poster"
    :src="src"
    alt=""
    loading="lazy"
    decoding="async"
    referrerpolicy="no-referrer"
    draggable="false"
    @error="failed = true"
  />
  <div
    v-else
    class="poster stand-in"
    :style="{ background: `linear-gradient(165deg, oklch(0.5 0.07 ${hue}) 0%, oklch(0.26 0.04 ${hue}) 100%)` }"
  >
    <span v-if="initialSize" :style="{ fontSize: `${initialSize}px` }">{{ initial }}</span>
  </div>
</template>

<style scoped>
.poster {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.stand-in {
  display: flex;
  align-items: flex-end;
  padding: 12px;
}

.stand-in span {
  color: rgb(255 255 255 / 14%);
  font-weight: 700;
  line-height: 1;
}
</style>
