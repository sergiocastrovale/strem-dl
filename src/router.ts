import { createRouter, createWebHashHistory } from 'vue-router'
import DownloadsView from './views/DownloadsView.vue'
import HomeView from './views/HomeView.vue'
import SavedView from './views/SavedView.vue'
import SettingsView from './views/SettingsView.vue'
import WatchlistView from './views/WatchlistView.vue'

// Hash history: works from file:// and the Tauri webview, and on static hosting without rewrites.
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'home', component: HomeView },
    { path: '/saved', name: 'saved', component: SavedView },
    { path: '/watchlist', name: 'watchlist', component: WatchlistView },
    { path: '/downloads', name: 'downloads', component: DownloadsView },
    { path: '/settings', name: 'settings', component: SettingsView },
    { path: '/:rest(.*)*', redirect: '/' },
  ],
})
