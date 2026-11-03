<script setup lang="ts" generic="T extends string">
import { Check, ChevronsUpDown } from '@lucide/vue'
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue'

// Not a native <select>: each webview draws its popup differently, and this has to look the same.
const model = defineModel<T>({ required: true })
const props = defineProps<{ options: { id: T; label: string }[]; label: string }>()

const id = useId()
const root = ref<HTMLElement>()
const open = ref(false)
const active = ref(0)
const current = computed(() => props.options.find((option) => option.id === model.value))

function close() {
  open.value = false
}

function show() {
  active.value = Math.max(0, props.options.findIndex((option) => option.id === model.value))
  open.value = true
}

function pick(value: T) {
  model.value = value
  close()
}

function onOutside(event: MouseEvent) {
  if (!root.value?.contains(event.target as Node)) close()
}

watch(open, (isOpen) => {
  if (isOpen) document.addEventListener('mousedown', onOutside)
  else document.removeEventListener('mousedown', onOutside)
})
onBeforeUnmount(() => document.removeEventListener('mousedown', onOutside))

function onKeydown(event: KeyboardEvent) {
  if (!open.value) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') show()
    else return
  } else if (event.key === 'ArrowDown') {
    active.value = (active.value + 1) % props.options.length
  } else if (event.key === 'ArrowUp') {
    active.value = (active.value - 1 + props.options.length) % props.options.length
  } else if (event.key === 'Enter' || event.key === ' ') {
    pick(props.options[active.value].id)
  } else if (event.key === 'Escape') {
    close()
  } else {
    return
  }
  event.preventDefault()
  event.stopPropagation()
}
</script>

<template>
  <div ref="root" class="select">
    <button
      class="trigger"
      type="button"
      role="combobox"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="`${id}-list`"
      :aria-label="label"
      :aria-activedescendant="open ? `${id}-${active}` : undefined"
      @click="open ? close() : show()"
      @keydown="onKeydown"
      @blur="close"
    >
      {{ current?.label }}
      <ChevronsUpDown :size="13" />
    </button>
    <ul v-if="open" :id="`${id}-list`" class="options" role="listbox" :aria-label="label" @mousedown.prevent>
      <li
        v-for="(option, index) in options"
        :id="`${id}-${index}`"
        :key="option.id"
        class="option"
        :class="{ active: index === active }"
        role="option"
        :aria-selected="option.id === model"
        @mousemove="active = index"
        @click="pick(option.id)"
      >
        {{ option.label }}
        <Check v-if="option.id === model" :size="14" />
      </li>
    </ul>
  </div>
</template>

<style scoped>
.select {
  position: relative;
  flex: none;
}

.trigger {
  display: flex;
  gap: 8px;
  align-items: center;
  height: 34px;
  padding: 0 10px 0 12px;
  font-size: 15px;
  white-space: nowrap;
  background: var(--inset);
  border: 1px solid var(--strong-border);
  border-radius: 8px;
}

.trigger svg {
  color: var(--muted);
}

.options {
  position: absolute;
  z-index: 30;
  right: 0;
  bottom: calc(100% + 6px);
  min-width: 100%;
  margin: 0;
  padding: 4px;
  list-style: none;
  background: var(--tooltip);
  border: 1px solid var(--strong-border);
  border-radius: 10px;
  box-shadow: var(--shadow-floating);
}

.option {
  display: flex;
  gap: 16px;
  align-items: center;
  justify-content: space-between;
  height: 30px;
  padding: 0 10px;
  font-size: 15px;
  white-space: nowrap;
  border-radius: 6px;
  cursor: pointer;
}

.option svg {
  color: var(--accent);
}

.option.active {
  background: var(--row-hover);
}
</style>
