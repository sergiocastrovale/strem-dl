<script setup lang="ts">
import { Link, Trash2 } from '@lucide/vue'
import { computed, ref, useId, watch } from 'vue'
import type { HistoryEntry } from '../lib/db'
import { completeAddonUrl } from '../lib/addon'
import { matchHistory } from '../lib/urlHistory'

const model = defineModel<string>({ required: true })
const props = defineProps<{
  entries: HistoryEntry[]
  placeholder: string
  /** Picks out the host of the address when the field isn't being edited. */
  highlight?: boolean
}>()
const emit = defineEmits<{ pick: []; remove: [url: string]; blur: [] }>()

const id = useId()
const inputEl = ref<HTMLInputElement>()
const open = ref(false)
const active = ref(-1)
const focused = ref(false)

const matches = computed(() => (open.value ? matchHistory(props.entries, model.value) : []))
/** What the field would become, if it differs from what's typed. Only shown when it adds to the end. */
const completion = computed(() => {
  const complete = completeAddonUrl(model.value)
  const typed = model.value.trim()
  return complete && complete !== typed && complete.startsWith(typed) ? complete : null
})
const ghost = computed(() => (completion.value ? completion.value.slice(model.value.trim().length) : ''))
const activeId = computed(() => (active.value >= 0 && matches.value.length ? `${id}-${active.value}` : undefined))

/** The address in three parts, when there's a host to pick out. */
const parts = computed(() => {
  if (!props.highlight || focused.value) return null
  const value = model.value
  try {
    const { hostname } = new URL(value)
    const at = value.indexOf(hostname)
    if (!hostname || at < 0) return null
    return { before: value.slice(0, at), host: hostname, after: value.slice(at + hostname.length) }
  } catch {
    return null
  }
})

// A removed suggestion can leave the selection past the end of the list.
watch(matches, (list) => {
  if (active.value >= list.length) active.value = list.length - 1
})

defineExpose({ focus: () => inputEl.value?.focus(), blur: () => inputEl.value?.blur() })

function close() {
  open.value = false
  active.value = -1
}

function onBlur() {
  focused.value = false
  close()
  emit('blur')
}

function onInput() {
  active.value = -1
  open.value = model.value.trim() !== ''
}

/** Fill in the rest, with the cursor already at the end. */
function accept(): boolean {
  const input = inputEl.value
  if (!completion.value || !input || input.selectionStart !== model.value.length) return false
  model.value = completion.value
  return true
}

function pick(entry: HistoryEntry) {
  model.value = entry.url
  close()
  emit('pick')
}

/** Steps through the options and the "nothing selected" slot before the first one. */
function move(step: number) {
  if (!open.value) open.value = true
  const slots = matches.value.length + 1
  if (slots > 1) active.value = ((active.value + 1 + step + slots) % slots) - 1
}

function onKeydown(event: KeyboardEvent) {
  if (event.isComposing) return
  switch (event.key) {
    case 'ArrowDown':
      move(1)
      break
    case 'ArrowUp':
      move(-1)
      break
    case 'Enter': {
      const entry = matches.value[active.value]
      close()
      if (!entry) return // Let the form submit what was typed.
      pick(entry)
      break
    }
    case 'Tab':
    case 'ArrowRight':
      if (!accept()) return
      break
    case 'Escape':
      if (!matches.value.length) return
      close()
      break
    default:
      return
  }
  event.preventDefault()
}
</script>

<template>
  <div class="url-input">
    <label class="box field-box">
      <Link class="icon" :size="16" />
      <span class="field">
        <input
          ref="inputEl"
          v-model="model"
          class="mono"
          :class="{ masked: parts }"
          type="text"
          spellcheck="false"
          autocomplete="off"
          role="combobox"
          aria-label="Addon manifest URL"
          aria-autocomplete="list"
          :aria-expanded="matches.length > 0"
          :aria-controls="`${id}-list`"
          :aria-activedescendant="activeId"
          :placeholder="placeholder"
          @focus="focused = true"
          @input="onInput"
          @keydown="onKeydown"
          @blur="onBlur"
        />
        <span v-if="parts" class="shown mono" aria-hidden="true">{{ parts.before }}<span class="host">{{ parts.host }}</span>{{ parts.after }}</span>
        <span v-if="ghost" class="ghost mono" aria-hidden="true"><span class="typed">{{ model.trim() }}</span>{{ ghost }}</span>
      </span>
      <slot />
    </label>
    <ul v-if="matches.length" :id="`${id}-list`" class="list" role="listbox" aria-label="Saved URLs">
      <li
        v-for="(entry, index) in matches"
        :id="`${id}-${index}`"
        :key="entry.url"
        class="option"
        :class="{ active: index === active }"
        role="option"
        :aria-selected="index === active"
        @mousedown.prevent
        @mousemove="active = index"
        @click="pick(entry)"
      >
        <span class="name">{{ entry.name }}</span>
        <span class="url mono">{{ entry.url }}</span>
        <button
          class="remove"
          type="button"
          tabindex="-1"
          :aria-label="`Remove ${entry.name} from suggestions`"
          title="Remove from suggestions"
          @click.stop="emit('remove', entry.url)"
        >
          <Trash2 :size="14" />
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.url-input {
  position: relative;
}

.box {
  display: flex;
  gap: 10px;
  align-items: center;
  height: 42px;
  padding: 0 6px 0 14px;
  background: var(--field);
  border: 1px solid var(--field-border);
  border-radius: 10px;
}

.icon {
  color: var(--secondary);
}

.field {
  position: relative;
  flex: 1;
  min-width: 0;
  height: 100%;
}

input,
.shown,
.ghost {
  font-size: 15px;
}

input {
  width: 100%;
  height: 100%;
  padding: 0;
  background: none;
  border: 0;
}

input.masked {
  color: transparent;
}

.shown,
.ghost {
  position: absolute;
  inset: 0;
  display: block;
  overflow: hidden;
  line-height: 40px;
  white-space: pre;
  pointer-events: none;
}

.shown {
  color: var(--muted);
  text-overflow: ellipsis;
}

.host {
  color: var(--text);
}

.ghost {
  color: var(--muted);
  opacity: 0.7;
}

.typed {
  visibility: hidden;
}

.list {
  position: absolute;
  z-index: 30;
  top: calc(100% + 4px);
  right: 0;
  left: 0;
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
  gap: 10px;
  align-items: center;
  height: 32px;
  padding: 0 6px 0 10px;
  white-space: nowrap;
  border-radius: 6px;
  cursor: pointer;
}

.option.active {
  background: var(--row-hover);
}

.name {
  flex: none;
  max-width: 40%;
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
}

.url {
  min-width: 0;
  overflow: hidden;
  color: var(--muted);
  font-size: 14px;
  text-overflow: ellipsis;
}

.remove {
  display: flex;
  flex: none;
  margin-left: auto;
  padding: 4px;
  color: var(--dim);
}

.remove:hover {
  color: var(--danger);
}
</style>
