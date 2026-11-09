import type { PathSegment } from './addon'

export interface AddonEntry {
  /** Normalized `<base>/manifest.json`. */
  url: string
  name: string
}

export interface HistoryEntry {
  /** Normalized `<base>/manifest.json`. */
  url: string
  name: string
  lastUsedAt: number
}

export interface WatchEntry {
  /** Normalized `<base>/manifest.json`. */
  url: string
  addonName: string
  /** From below the addon root down to the watched folder. */
  path: PathSegment[]
  /** An image address from the addon, when there was one. */
  poster?: string | null
}

/** `opened`: handed to the browser or system, which we can't follow. */
export type DownloadStatus = 'opened' | 'queued' | 'downloading' | 'paused' | 'done' | 'failed'

/** Another link to the same title, to try if this one turns out to be unavailable. */
export interface OtherSource {
  url: string
  name: string
}

/** A source that was tried and didn't work. */
export interface SourceAttempt {
  name: string
  error: string
}

export interface DownloadEntry {
  /** The file link. */
  url: string
  name: string
  /** Normalized `<base>/manifest.json` of the addon it came from. */
  addonUrl: string
  addonName: string
  /** From below the addon root down to the folder holding the link. */
  path: PathSegment[]
  openedAt: number
  status: DownloadStatus
  /** Null until known, and for servers that don't say. */
  totalBytes: number | null
  doneBytes: number
  /** Where the file is saved. Unfinished downloads add `.part` to it. */
  filePath: string | null
  /** ETag or Last-Modified, to tell on resuming if the file changed. */
  validator: string | null
  error: string | null
  /** What actually gets fetched, when that isn't `url`. Pages expire these, so it can be found again. */
  mediaUrl: string | null
  /** How `mediaUrl` is fetched. Null for a plain link to a file. */
  mediaKind: 'file' | 'stream' | 'extract' | null
  /** Sent the way the page would have. Some servers refuse anything else. */
  referer: string | null
  userAgent: string | null
  /** Still to try, in order. */
  alternates: OtherSource[]
  attempts: SourceAttempt[]
}

/** Two paths with these keys lead to the same folder, whatever the labels say now. */
export function watchPathKey(path: PathSegment[]): string {
  return JSON.stringify(path.map((segment) => segment.key))
}

/** Saved data. SQLite on desktop, local storage in a browser (see platform.ts). */
export interface Db {
  /** Oldest first. */
  addons(): Promise<AddonEntry[]>
  addAddon(addon: AddonEntry): Promise<void>
  removeAddon(url: string): Promise<void>
  /** Most recently used first. */
  history(): Promise<HistoryEntry[]>
  recordHistory(entry: HistoryEntry): Promise<void>
  removeHistory(url: string): Promise<void>
  /** Oldest first. */
  watchlist(): Promise<WatchEntry[]>
  addWatch(entry: WatchEntry): Promise<void>
  removeWatch(url: string, path: PathSegment[]): Promise<void>
  /** Most recently opened first. */
  downloads(): Promise<DownloadEntry[]>
  recordDownload(entry: DownloadEntry): Promise<void>
  removeDownload(url: string): Promise<void>
  setting(key: string): Promise<string | null>
  /** Null removes it. */
  setSetting(key: string, value: string | null): Promise<void>
}

/** The part of the Tauri SQL plugin's `Database` that we use. */
export interface SqlConnection {
  select<T>(query: string, params?: unknown[]): Promise<T>
  execute(query: string, params?: unknown[]): Promise<unknown>
}

// Columns keep their original names (source_url, source_name): renaming them needs a migration.
export function sqliteDb(sql: SqlConnection): Db {
  return {
    addons: () => sql.select<AddonEntry[]>('SELECT url, name FROM addons ORDER BY rowid'),
    async addAddon({ url, name }) {
      await sql.execute('INSERT OR IGNORE INTO addons (url, name) VALUES (?, ?)', [url, name])
    },
    async removeAddon(url) {
      await sql.execute('DELETE FROM addons WHERE url = ?', [url])
    },
    history: () =>
      sql.select<HistoryEntry[]>(
        'SELECT url, name, last_used_at AS lastUsedAt FROM url_history ORDER BY last_used_at DESC, rowid DESC',
      ),
    async recordHistory({ url, name, lastUsedAt }) {
      await sql.execute(
        `INSERT INTO url_history (url, name, last_used_at) VALUES (?, ?, ?)
         ON CONFLICT (url) DO UPDATE SET name = excluded.name, last_used_at = excluded.last_used_at`,
        [url, name, lastUsedAt],
      )
    },
    async removeHistory(url) {
      await sql.execute('DELETE FROM url_history WHERE url = ?', [url])
    },
    async watchlist() {
      const rows = await sql.select<{ url: string; addonName: string; path: string; poster: string | null }[]>(
        'SELECT url, source_name AS addonName, path, poster FROM watchlist ORDER BY rowid',
      )
      return rows.map((row) => ({ ...row, path: JSON.parse(row.path) as PathSegment[] }))
    },
    async addWatch({ url, addonName, path, poster = null }) {
      await sql.execute('INSERT OR IGNORE INTO watchlist (url, source_name, path_key, path, poster) VALUES (?, ?, ?, ?, ?)', [
        url,
        addonName,
        watchPathKey(path),
        JSON.stringify(path),
        poster,
      ])
    },
    async removeWatch(url, path) {
      await sql.execute('DELETE FROM watchlist WHERE url = ? AND path_key = ?', [url, watchPathKey(path)])
    },
    async downloads() {
      const rows = await sql.select<(Omit<DownloadEntry, 'path' | 'alternates' | 'attempts'> & Record<'path' | 'alternates' | 'attempts', string>)[]>(
        `SELECT url, name, source_url AS addonUrl, source_name AS addonName, path, opened_at AS openedAt,
           status, total_bytes AS totalBytes, done_bytes AS doneBytes, file_path AS filePath, validator, error,
           media_url AS mediaUrl, media_kind AS mediaKind, referer, user_agent AS userAgent, alternates, attempts
         FROM downloads ORDER BY opened_at DESC, rowid DESC`,
      )
      return rows.map((row) => ({
        ...row,
        path: JSON.parse(row.path) as PathSegment[],
        alternates: JSON.parse(row.alternates) as OtherSource[],
        attempts: JSON.parse(row.attempts) as SourceAttempt[],
      }))
    },
    async recordDownload(entry) {
      await sql.execute(
        `INSERT INTO downloads
           (url, name, source_url, source_name, path, opened_at, status, total_bytes, done_bytes, file_path, validator, error,
            media_url, media_kind, referer, user_agent, alternates, attempts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (url) DO UPDATE SET
           name = excluded.name,
           source_url = excluded.source_url,
           source_name = excluded.source_name,
           path = excluded.path,
           opened_at = excluded.opened_at,
           status = excluded.status,
           total_bytes = excluded.total_bytes,
           done_bytes = excluded.done_bytes,
           file_path = excluded.file_path,
           validator = excluded.validator,
           error = excluded.error,
           media_url = excluded.media_url,
           media_kind = excluded.media_kind,
           referer = excluded.referer,
           user_agent = excluded.user_agent,
           alternates = excluded.alternates,
           attempts = excluded.attempts`,
        [
          entry.url,
          entry.name,
          entry.addonUrl,
          entry.addonName,
          JSON.stringify(entry.path),
          entry.openedAt,
          entry.status,
          entry.totalBytes,
          entry.doneBytes,
          entry.filePath,
          entry.validator,
          entry.error,
          entry.mediaUrl,
          entry.mediaKind,
          entry.referer,
          entry.userAgent,
          JSON.stringify(entry.alternates),
          JSON.stringify(entry.attempts),
        ],
      )
    },
    async removeDownload(url) {
      await sql.execute('DELETE FROM downloads WHERE url = ?', [url])
    },
    async setting(key) {
      const rows = await sql.select<{ value: string }[]>('SELECT value FROM settings WHERE key = ?', [key])
      return rows[0]?.value ?? null
    },
    async setSetting(key, value) {
      if (value === null) await sql.execute('DELETE FROM settings WHERE key = ?', [key])
      else {
        await sql.execute(
          'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
          [key, value],
        )
      }
    },
  }
}

const ADDONS_KEY = 'strem-dl:addons'
/** Addons were kept under these keys before the renames, newest first. */
const OLD_ADDONS_KEYS = ['strem-dl:saved', 'strem-dl:favorites']
const HISTORY_KEY = 'strem-dl:url-history'
const WATCHLIST_KEY = 'strem-dl:watchlist'
const DOWNLOADS_KEY = 'strem-dl:downloads'
const SETTING_PREFIX = 'strem-dl:setting:'

/** Addon details were saved under these names in browsers before the rename. */
function renameStored<T>(entry: T): T {
  const { sourceUrl, sourceName, ...rest } = entry as T & { sourceUrl?: string; sourceName?: string }
  return {
    ...(sourceUrl === undefined ? {} : { addonUrl: sourceUrl }),
    ...(sourceName === undefined ? {} : { addonName: sourceName }),
    ...rest,
  } as T
}

export function storageDb(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>): Db {
  function readRaw(key: string): unknown[] {
    try {
      const parsed: unknown = JSON.parse(storage.getItem(key) ?? '[]')
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  function read<T extends { url: string; name: string }>(key: string): T[] {
    return readRaw(key).filter(
      (entry): entry is T =>
        typeof (entry as T | null)?.url === 'string' && typeof (entry as T | null)?.name === 'string',
    )
  }

  function readAddons(): AddonEntry[] {
    if (storage.getItem(ADDONS_KEY) === null) {
      const oldKey = OLD_ADDONS_KEYS.find((key) => storage.getItem(key) !== null)
      if (oldKey) storage.setItem(ADDONS_KEY, JSON.stringify(read<AddonEntry>(oldKey)))
    }
    for (const key of OLD_ADDONS_KEYS) storage.removeItem(key)
    return read<AddonEntry>(ADDONS_KEY)
  }

  function readWatchlist(): WatchEntry[] {
    return readRaw(WATCHLIST_KEY)
      .filter((entry): entry is WatchEntry => {
        const candidate = entry as WatchEntry | null
        return typeof candidate?.url === 'string' && Array.isArray(candidate?.path)
      })
      .map(renameStored)
  }

  function readDownloads(): DownloadEntry[] {
    return read<DownloadEntry>(DOWNLOADS_KEY)
      .filter((entry) => Array.isArray(entry.path))
      .map(renameStored)
      .map((entry) => ({
        ...entry,
        // Saved before downloads had progress.
        status: entry.status ?? 'opened',
        totalBytes: entry.totalBytes ?? null,
        doneBytes: entry.doneBytes ?? 0,
        filePath: entry.filePath ?? null,
        validator: entry.validator ?? null,
        error: entry.error ?? null,
        mediaUrl: entry.mediaUrl ?? null,
        mediaKind: entry.mediaKind ?? null,
        referer: entry.referer ?? null,
        userAgent: entry.userAgent ?? null,
        alternates: entry.alternates ?? [],
        attempts: entry.attempts ?? [],
      }))
  }

  return {
    addons: async () => readAddons(),
    async addAddon(addon) {
      const items = readAddons()
      if (items.some((item) => item.url === addon.url)) return
      storage.setItem(ADDONS_KEY, JSON.stringify([...items, addon]))
    },
    async removeAddon(url) {
      const items = readAddons().filter((item) => item.url !== url)
      storage.setItem(ADDONS_KEY, JSON.stringify(items))
    },
    history: async () => read<HistoryEntry>(HISTORY_KEY),
    async recordHistory(entry) {
      const others = read<HistoryEntry>(HISTORY_KEY).filter((item) => item.url !== entry.url)
      storage.setItem(HISTORY_KEY, JSON.stringify([entry, ...others]))
    },
    async removeHistory(url) {
      const items = read<HistoryEntry>(HISTORY_KEY).filter((item) => item.url !== url)
      storage.setItem(HISTORY_KEY, JSON.stringify(items))
    },
    watchlist: async () => readWatchlist(),
    async addWatch(entry) {
      const items = readWatchlist()
      const key = watchPathKey(entry.path)
      if (items.some((item) => item.url === entry.url && watchPathKey(item.path) === key)) return
      storage.setItem(WATCHLIST_KEY, JSON.stringify([...items, entry]))
    },
    async removeWatch(url, path) {
      const key = watchPathKey(path)
      const items = readWatchlist().filter((item) => item.url !== url || watchPathKey(item.path) !== key)
      storage.setItem(WATCHLIST_KEY, JSON.stringify(items))
    },
    downloads: async () => readDownloads(),
    async recordDownload(entry) {
      const others = readDownloads().filter((item) => item.url !== entry.url)
      storage.setItem(DOWNLOADS_KEY, JSON.stringify([entry, ...others]))
    },
    async removeDownload(url) {
      const items = readDownloads().filter((item) => item.url !== url)
      storage.setItem(DOWNLOADS_KEY, JSON.stringify(items))
    },
    setting: async (key) => storage.getItem(SETTING_PREFIX + key),
    async setSetting(key, value) {
      if (value === null) storage.removeItem(SETTING_PREFIX + key)
      else storage.setItem(SETTING_PREFIX + key, value)
    },
  }
}
