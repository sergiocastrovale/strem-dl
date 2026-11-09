<script setup lang="ts">
import { ArrowDownToLine, Blocks, Eye, House, Settings } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'
import Notice from './components/Notice.vue'
import SetupPanel from './components/SetupPanel.vue'
import TitleBar from './components/TitleBar.vue'
import Toast from './components/Toast.vue'
import { useDependencies } from './lib/dependencies'
import { useDownloads } from './lib/downloads'
import { getWindowControls, isDesktop } from './lib/platform'
import { useSettings } from './lib/settings'

const dependencies = useDependencies()
const showWebNotice = !isDesktop()
const settings = useSettings()
const route = useRoute()
const windowControls = getWindowControls()
const logo = `${import.meta.env.BASE_URL}favicon.svg`

/** Null until it's known whether setup is needed. A browser never needs it. */
const needsSetup = ref<boolean | null>(dependencies ? null : false)
if (dependencies) {
  Promise.all([dependencies.load(), settings.ready.catch(() => {})]).then(() => {
    needsSetup.value = !dependencies.ready.value && !settings.setupSkipped.value
  })
}

function skipSetup() {
  settings.skipSetup()
  needsSetup.value = false
}

// Once set up rather than when a page first needs it: unfinished downloads resume on launch.
watch(
  needsSetup,
  (needed) => {
    if (needed === false) useDownloads()
  },
  { immediate: true },
)

const activeDownloads = computed(() =>
  needsSetup.value === false ? useDownloads().items.value.filter((entry) => entry.status === 'downloading').length : 0,
)

const nav = computed(() => [
  { name: 'home', label: 'Home', icon: House, badge: 0 },
  { name: 'addons', label: 'Addons', icon: Blocks, badge: 0 },
  { name: 'watchlist', label: 'Watchlist', icon: Eye, badge: 0 },
  { name: 'downloads', label: 'Downloads', icon: ArrowDownToLine, badge: activeDownloads.value },
])
</script>

<template>
  <div class="window" :class="{ framed: windowControls }">
    <TitleBar v-if="windowControls" :controls="windowControls" />
    <SetupPanel v-if="dependencies && needsSetup" class="page-area" :dependencies="dependencies" @continue="needsSetup = false" @skip="skipSetup" />
    <div v-else-if="needsSetup === false" class="shell page-area">
      <nav class="rail" aria-label="Sections">
        <img class="logo" :src="logo" alt="strem-dl" />
        <RouterLink v-for="item in nav" :key="item.name" class="item" :class="{ on: route.name === item.name }" :to="{ name: item.name }">
          <component :is="item.icon" :size="19" />
          {{ item.label }}
          <span v-if="item.badge" class="badge mono">{{ item.badge }}</span>
        </RouterLink>
        <span class="grow" />
        <RouterLink class="item" :class="{ on: route.name === 'settings' }" :to="{ name: 'settings' }"><Settings :size="19" />Settings</RouterLink>
      </nav>
      <main class="content">
        <Notice v-if="showWebNotice && !settings.webNoticeDismissed.value" @dismiss="settings.dismissWebNotice()">
          Downloading video from streaming and embed pages is a desktop app feature. It isn't supported in the web version,
          which can browse addons and open links.
        </Notice>
        <RouterView v-slot="{ Component }">
          <KeepAlive>
            <component :is="Component" />
          </KeepAlive>
        </RouterView>
      </main>
      <Toast />
    </div>
  </div>
</template>

<style scoped>
.window {
  display: flex;
  flex-direction: column;
  height: 100%;
}

/* A window without the system's frame needs its own edge, and the toast clears the title bar. */
.window.framed {
  --title-bar: 32px;
  border: 1px solid var(--border);
}

.page-area {
  flex: 1;
  min-height: 0;
}

.shell {
  display: flex;
}

.rail {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 6px;
  align-items: center;
  width: 96px;
  padding: 14px 0;
  background: var(--rail);
  border-right: 1px solid var(--rail-border);
}

.logo {
  flex: none;
  width: 36px;
  height: 36px;
  margin-bottom: 14px;
}

.item {
  position: relative;
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 5px;
  align-items: center;
  width: 80px;
  padding: 9px 0 7px;
  color: var(--secondary);
  font-size: 12.5px;
  font-weight: 500;
  text-decoration: none;
  border-radius: 10px;
}

.item:hover {
  color: var(--secondary);
  background: var(--row-hover);
}

.item.on {
  color: var(--accent);
  background: var(--accent-17);
}

.badge {
  position: absolute;
  top: 4px;
  right: 19px;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  color: var(--on-accent);
  font-size: 12px;
  font-weight: 600;
  background: var(--accent);
  border-radius: 8px;
}

.grow {
  flex: 1;
}

.content {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  height: 100%;
}

/* The page takes what the notice leaves. */
.content > :deep(:not(.notice-banner)) {
  flex: 1 1 0;
  min-height: 0;
}
</style>
