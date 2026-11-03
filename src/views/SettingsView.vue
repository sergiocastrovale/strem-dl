<script setup lang="ts">
import { Folder, Loader, Minus, Plus, RefreshCw } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import DependencyRow from '../components/DependencyRow.vue'
import { DEPENDENCY_PURPOSE, useDependencies, type DependencyId } from '../lib/dependencies'
import { canPickFolder, pickFolder } from '../lib/platform'
import { MAX_DOWNLOADS_LIMIT, useSettings } from '../lib/settings'
import { showToast } from '../lib/toast'

const settings = useSettings()
/** A browser has nothing to set here. The page keeps its shape, and says so. */
const desktop = canPickFolder()
const dependencies = useDependencies()
const path = ref('')
const error = ref<string | null>(null)
const maxError = ref<string | null>(null)
const checkNote = ref('')

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

const DEPENDENCY_IDS = Object.keys(DEPENDENCY_PURPOSE) as DependencyId[]
const maxDownloads = computed(() => (desktop ? settings.maxDownloads.value : '–'))

// Fill the field when the folder loads or is reset, without undoing typing otherwise.
watch(settings.downloadFolder, (folder) => (path.value = folder ?? ''), { immediate: true })
watch(path, () => (error.value = null))

async function stepMaxDownloads(step: number) {
  try {
    await settings.setMaxDownloads(settings.maxDownloads.value + step)
    maxError.value = null
  } catch (cause) {
    maxError.value = messageOf(cause)
  }
}

/** Saves as soon as there's something new to save, so there's no button for it. */
async function save() {
  const next = path.value.trim()
  if (!desktop || !next || next === settings.downloadFolder.value) return
  try {
    await settings.setDownloadFolder(next)
    path.value = settings.downloadFolder.value ?? ''
    error.value = null
    showToast('Download folder saved')
  } catch (cause) {
    error.value = messageOf(cause)
  }
}

async function browse() {
  try {
    const picked = await pickFolder(path.value || null)
    if (picked) {
      path.value = picked
      await save()
    }
  } catch (cause) {
    error.value = messageOf(cause)
  }
}

async function reset() {
  try {
    await settings.resetDownloadFolder()
    path.value = settings.downloadFolder.value ?? ''
    error.value = null
  } catch (cause) {
    error.value = messageOf(cause)
  }
}

async function checkUpdates() {
  if (!dependencies) return
  checkNote.value = ''
  await dependencies.checkForUpdates()
  if (dependencies.checkError.value) return
  const updates = dependencies.items.value.filter((item) => item.latest?.updateAvailable).length
  checkNote.value = updates
    ? `${updates} ${updates === 1 ? 'update' : 'updates'} available · checked just now`
    : 'Everything is up to date · checked just now'
}
</script>

<template>
  <div class="page">
    <h1 class="page-title">Settings</h1>

    <section class="setting">
      <label class="label" for="download-folder">Default download folder</label>
      <div class="field-row">
        <div class="input-box field-box" :class="{ off: !desktop }">
          <Folder :size="15" />
          <input
            id="download-folder"
            v-model="path"
            class="mono"
            type="text"
            spellcheck="false"
            autocomplete="off"
            :disabled="!desktop"
            :placeholder="desktop ? '' : 'Chosen by your browser'"
            @keydown.enter.prevent="save"
            @blur="save"
          />
        </div>
        <button class="btn browse" type="button" :disabled="!desktop" @click="browse">Browse…</button>
      </div>
      <div v-if="desktop" class="help">New downloads are saved here. The folder is created if it doesn't exist. Downloads already started stay where they are.</div>
      <div v-else class="help">The browser decides where files are saved. Change it in the browser's own settings, or use the desktop app.</div>
      <div v-if="error" class="error" role="alert">{{ error }}</div>
      <button v-if="settings.customFolder.value && settings.defaultFolder.value" class="system-folder" type="button" @click="reset">
        Use the system folder ({{ settings.defaultFolder.value }})
      </button>
    </section>

    <section class="setting">
      <div class="label">Downloads at once</div>
      <div class="stepper" :class="{ off: !desktop }" role="group" aria-label="Downloads at once">
        <button type="button" aria-label="Fewer" :disabled="!desktop || settings.maxDownloads.value <= 1" @click="stepMaxDownloads(-1)"><Minus :size="14" /></button>
        <span class="value mono" role="status">{{ maxDownloads }}</span>
        <button type="button" aria-label="More" :disabled="!desktop || settings.maxDownloads.value >= MAX_DOWNLOADS_LIMIT" @click="stepMaxDownloads(1)"><Plus :size="14" /></button>
      </div>
      <div v-if="desktop" class="help">The rest wait in the queue. Lowering it lets running downloads finish.</div>
      <div v-else class="help">Only the desktop app runs downloads. A browser opens each link by itself.</div>
      <div v-if="maxError" class="error" role="alert">{{ maxError }}</div>
    </section>

    <section class="setting">
      <div class="label">Dependencies</div>
      <div v-if="desktop" class="help">Programs that save video streams, kept in the app's own folder.</div>
      <div v-else class="help">Programs that save video streams. Only the desktop app can run them.</div>
      <div v-if="dependencies?.loaded.value && !dependencies.ready.value" class="help" role="status">Most video streams can't be saved until these are installed.</div>
      <div class="deps">
        <template v-if="dependencies">
          <DependencyRow v-for="dependency in dependencies.items.value" :key="dependency.id" :dependency="dependency" @install="dependencies.install(dependency.id)" />
        </template>
        <div v-for="id in DEPENDENCY_IDS" v-else :key="id" class="web-dep">
          <span class="dep-name mono">{{ id }}</span>
          <span class="dep-purpose">{{ DEPENDENCY_PURPOSE[id] }}</span>
          <span class="grow" />
          <span class="dep-state mono">Desktop app</span>
        </div>
      </div>
      <div class="foot">
        <button class="btn check" type="button" :disabled="!dependencies || dependencies.checking.value" @click="checkUpdates">
          <Loader v-if="dependencies?.checking.value" class="spin" :size="14" />
          <RefreshCw v-else :size="14" />
          {{ dependencies?.checking.value ? 'Checking…' : 'Check for updates' }}
        </button>
        <span v-if="dependencies?.checkError.value" class="error" role="alert">{{ dependencies.checkError.value }}</span>
        <span v-else-if="checkNote" class="checked">{{ checkNote }}</span>
      </div>
    </section>

    <div v-if="settings.error.value" class="error" role="alert">{{ settings.error.value }}</div>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 30px;
  height: 100%;
  padding: 28px 32px;
  overflow: auto;
}

h1 {
  margin: 0;
}

.page > * {
  flex: none;
  width: 100%;
  max-width: 656px;
}

.setting {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.label {
  font-weight: 600;
}

.field-row {
  display: flex;
  gap: 8px;
}

.input-box {
  display: flex;
  flex: 1;
  gap: 8px;
  align-items: center;
  min-width: 0;
  height: 38px;
  padding: 0 12px;
  background: var(--field);
  border: 1px solid var(--field-border);
  border-radius: 8px;
}

.input-box.off,
.stepper.off,
.web-dep .dep-state {
  opacity: 0.6;
}

.input-box svg {
  color: #fff;
}

.input-box input {
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 0;
  font-size: 15px;
  background: none;
  border: 0;
}

.browse {
  height: 38px;
  padding: 0 14px;
  border-radius: 8px;
}

.help {
  color: var(--muted);
  font-size: 14.5px;
  line-height: 1.5;
}

.system-folder {
  align-self: flex-start;
  color: var(--accent);
  font-size: 14.5px;
  text-align: left;
  overflow-wrap: anywhere;
}

.system-folder:hover {
  color: var(--accent-hover);
}

.stepper {
  display: flex;
  align-items: center;
  align-self: flex-start;
  height: 36px;
  overflow: hidden;
  border: 1px solid var(--field-border);
  border-radius: 8px;
}

.stepper button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 100%;
  color: var(--soft);
  background: var(--field);
}

.stepper button:hover:not(:disabled) {
  background: var(--row-hover);
}

.stepper button:disabled {
  color: var(--faint);
}

.value {
  width: 40px;
  font-size: 16px;
  font-weight: 500;
  text-align: center;
}

.deps {
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 10px;
}

.web-dep {
  display: flex;
  gap: 12px;
  align-items: center;
  height: 50px;
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
}

.web-dep:last-child {
  border-bottom: 0;
}

.dep-name {
  font-size: 15px;
  font-weight: 500;
}

.dep-purpose {
  color: var(--muted);
}

.grow {
  flex: 1;
}

.dep-state {
  color: var(--dim);
  font-size: 14px;
}

.foot {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
}

.check {
  gap: 8px;
  height: 34px;
  padding: 0 14px;
  border-radius: 8px;
}

.check svg {
  color: var(--soft);
}

.checked {
  color: var(--accent);
  font-size: 14.5px;
}

.error {
  color: var(--danger);
  font-size: 14.5px;
  overflow-wrap: anywhere;
}
</style>
