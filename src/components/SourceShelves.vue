<script setup lang="ts">
import { ChevronRight } from '@lucide/vue'
import { computed, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { SHELF_SIZE, shelvesOf, titlePath, titlesIn, type Shelf } from '../lib/shelves'
import { sourceName, useSources, type Source } from '../lib/sources'
import type { TreeNode } from '../lib/useTree'
import PosterTile from './PosterTile.vue'

const props = defineProps<{ source: Source }>()

const sources = useSources()
const router = useRouter()
const tree = props.source.tree
const root = computed(() => tree.roots.value[0] ?? null)
const shelves = computed(() => (root.value ? shelvesOf(root.value) : []))

// Each shelf needs its catalog's first page.
watch(shelves, (list) => void tree.preload(list.map(({ node }) => node)), { immediate: true })

const folderLink = (shelf: Shelf) => ({ name: 'folder', query: { url: props.source.url, path: JSON.stringify(shelf.path) } })

function open(shelf: Shelf, title: TreeNode) {
  router.push({ name: 'browse', query: { url: props.source.url, path: JSON.stringify(titlePath(shelf.path, title)) } })
}
</script>

<template>
  <section class="source">
    <header class="source-head">
      <h2 class="source-name">{{ sourceName(source) }}</h2>
      <span v-if="tree.loading.value" class="spinner" aria-label="Loading" />
    </header>

    <div v-if="tree.error.value" class="note failed">
      {{ tree.error.value }}
      <button class="btn retry" type="button" @click="sources.retry(source)">Retry</button>
    </div>
    <div v-else-if="root && !shelves.length" class="note">Nothing to browse in this addon</div>

    <div v-for="shelf in shelves" :key="shelf.node.uid" class="shelf">
      <div class="shelf-head">
        <h3 class="shelf-name">{{ shelf.label }}</h3>
        <RouterLink class="view-all" :to="folderLink(shelf)">
          View all
          <ChevronRight :size="15" />
        </RouterLink>
      </div>

      <div v-if="shelf.node.error" class="note failed">
        Couldn't load: {{ shelf.node.error }}
        <button class="btn retry" type="button" @click="tree.load(shelf.node)">Retry</button>
      </div>
      <div v-else-if="shelf.node.children && !titlesIn(shelf.node).length" class="note">Empty</div>
      <div v-else class="row">
        <template v-if="shelf.node.children">
          <PosterTile
            v-for="title in titlesIn(shelf.node).slice(0, SHELF_SIZE)"
            :key="title.uid"
            :poster="title.poster"
            :label="title.label"
            @open="open(shelf, title)"
          />
        </template>
        <template v-else>
          <span v-for="n in SHELF_SIZE" :key="n" class="placeholder" aria-hidden="true" />
        </template>
      </div>
    </div>
  </section>
</template>

<style scoped>
.source {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.source-head {
  display: flex;
  gap: 10px;
  align-items: center;
}

.source-name {
  margin: 0;
  font-size: 24px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.shelf {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.shelf-head {
  display: flex;
  gap: 12px;
  align-items: baseline;
}

.shelf-name {
  flex: 1;
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: var(--secondary);
  font-size: 17px;
  font-weight: 500;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.view-all {
  display: flex;
  flex: none;
  gap: 2px;
  align-items: center;
  color: var(--muted);
  font-size: 14px;
  font-weight: 500;
  text-decoration: none;
}

.view-all:hover {
  color: var(--text);
}

.row {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 295px));
  gap: 16px;
}

.placeholder {
  aspect-ratio: 2 / 3;
  background: var(--field);
  border-radius: 10px;
  opacity: 0.6;
}

.note {
  color: var(--muted);
  font-size: 14.5px;
}

.note.failed {
  color: var(--danger);
  overflow-wrap: anywhere;
}

.spinner {
  flex: none;
  width: 14px;
  height: 14px;
  border: 2px solid var(--strong-border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 700ms linear infinite;
}

.retry {
  height: 26px;
  margin-left: 8px;
  padding: 0 10px;
  color: var(--text);
  font-size: 14px;
}
</style>
