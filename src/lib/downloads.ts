import { computed, reactive, ref, toRaw, watch } from 'vue'
import { linkExtension } from './addon'
import { createCapture, createResolver, type FindOptions, type FoundVideo } from './capture'
import type { Db, DownloadEntry, OtherSource } from './db'
import { fetchHeaders } from './http'
import { getDb, getTransferEngine } from './platform'
import { DEFAULT_MAX_DOWNLOADS, useSettings, type SourceChoice } from './settings'
import { parseStreamMeta, resolutionRank, type StreamMeta } from './streamMeta'
import type { TransferEngine, TransferEvent } from './transfer'

export type { DownloadEntry }

/**
 * `stream`: a playlist of pieces. `page`: might have a video on it. `external`: needs another
 * program, like a magnet link.
 */
export type LinkKind = 'file' | 'stream' | 'page' | 'external'

/** A link about to be recorded. */
export type OpenedLink = Pick<DownloadEntry, 'url' | 'name' | 'addonUrl' | 'addonName' | 'path'> & {
  alternates?: OtherSource[]
}

const CLASSIFY_CONCURRENCY = 4

const FILE_EXTENSIONS = new Set(
  (
    'mp4 m4v mkv avi mov wmv flv webm mpg mpeg ts 3gp ogv ' +
    'mp3 m4a aac flac wav ogg opus ' +
    'zip rar 7z tar gz iso torrent srt vtt pdf epub'
  ).split(' '),
)
const STREAM_EXTENSIONS = new Set(['m3u8', 'mpd'])
const PAGE_EXTENSIONS = new Set(['html', 'htm', 'xhtml'])

/** Going by the address alone. Null when only the server can tell. */
export function kindFromAddress(link: string): LinkKind | null {
  let url: URL
  try {
    url = new URL(link)
  } catch {
    return 'external'
  }
  // Magnets start a torrent; they don't point at a file.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'external'

  const extension = linkExtension(url)
  if (FILE_EXTENSIONS.has(extension)) return 'file'
  if (STREAM_EXTENSIONS.has(extension)) return 'stream'
  if (PAGE_EXTENSIONS.has(extension)) return 'page'
  return null
}

export function kindFromHeaders(headers: Headers): LinkKind {
  if (/^\s*attachment/i.test(headers.get('content-disposition') ?? '')) return 'file'
  const type = headers.get('content-type')?.toLowerCase()
  if (!type || type.includes('html')) return 'page'
  return type.includes('mpegurl') || type.includes('dash+xml') ? 'stream' : 'file'
}

/** What a link leads to. When it can't be told, a page. */
export async function linkKind(link: string): Promise<LinkKind> {
  const known = kindFromAddress(link)
  if (known !== null) return known
  const headers = await fetchHeaders(link)
  return headers ? kindFromHeaders(headers) : 'page'
}

export function percentOf({ doneBytes, totalBytes }: Pick<DownloadEntry, 'doneBytes' | 'totalBytes'>): number | null {
  if (!totalBytes) return null
  return Math.min(100, Math.floor((doneBytes / totalBytes) * 100))
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${unit === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(1, Math.ceil(totalSeconds))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/**
 * Keep the links the app can try to save, in the same order. Stops asking servers once
 * `live` turns false.
 */
export async function selectFiles<T extends { url: string }>(
  links: T[],
  classify: (link: string) => Promise<LinkKind>,
  live: () => boolean = () => true,
): Promise<{ files: T[]; skipped: number }> {
  const kinds = new Array<LinkKind | undefined>(links.length)
  let next = 0
  const worker = async () => {
    while (next < links.length && live()) {
      const index = next++
      kinds[index] = await classify(links[index].url)
    }
  }
  await Promise.all(Array.from({ length: CLASSIFY_CONCURRENCY }, worker))
  const files = links.filter((_, index) => kinds[index] && kinds[index] !== 'external')
  return { files, skipped: kinds.filter((kind) => kind === 'external').length }
}

const SOURCE_WORDS: Partial<Record<SourceChoice, string>> = {
  first: 'the first copy',
  best: 'the best quality copy',
  smallest: 'the smallest file',
}

type Candidate = OpenedLink & { title: string | null; meta?: StreamMeta }

/** Which of a title's sources to take. Those that don't say are the last resort. */
function chosenIndex(sources: Candidate[], choice: SourceChoice): number {
  if (choice !== 'best' && choice !== 'smallest') return 0
  const sizeOf = (source: Candidate) => source.meta?.sizeBytes
  let at = 0
  sources.forEach((source, index) => {
    const size = sizeOf(source)
    const held = sizeOf(sources[at])
    if (choice === 'smallest') {
      if (size !== undefined && (held === undefined || size < held)) at = index
      return
    }
    const rank = resolutionRank(source.meta?.resolution) - resolutionRank(sources[at].meta?.resolution)
    if (rank > 0 || (rank === 0 && size !== undefined && (held === undefined || size > held))) at = index
  })
  return at
}

/**
 * Reduce links to one per title, keeping the others to try if that one's unavailable. `title`
 * says which links are sources of the same thing, and null is a link with no sources.
 */
export function pickSources(links: Candidate[], choice: SourceChoice): OpenedLink[] {
  const sources = new Map<string, Candidate[]>()
  for (const link of links) {
    if (link.title !== null) sources.set(link.title, [...(sources.get(link.title) ?? []), link])
  }
  const bare = ({ title: _title, meta: _meta, ...link }: Candidate): OpenedLink => link

  const picked: OpenedLink[] = []
  const done = new Set<string>()
  for (const link of links) {
    if (link.title === null || choice === 'all') {
      picked.push(bare(link))
      continue
    }
    if (done.has(link.title)) continue
    done.add(link.title)
    const all = sources.get(link.title) as Candidate[]
    const at = chosenIndex(all, choice)
    // The ones after it first, then back round to the start.
    const others = [...all.slice(at + 1), ...all.slice(0, at)]
    picked.push({ ...bare(all[at]), alternates: others.map(({ url, name }) => ({ url, name })) })
  }
  return picked
}

export function bulkSummary({
  label,
  added,
  skipped,
  failed,
  limited,
  source,
}: {
  label: string
  added: number
  skipped: number
  failed: number
  limited: boolean
  source?: SourceChoice
}): string {
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  const parts = [
    added
      ? `Queued ${count(added, 'file', 'files')} from ${label}.`
      : `Nothing new to queue from ${label}.`,
  ]
  if (added && source && SOURCE_WORDS[source]) {
    parts.push(`Taking ${SOURCE_WORDS[source]} of each title, and trying the others if it's unavailable.`)
  }
  if (skipped) parts.push(`Skipped ${count(skipped, "link that can't be saved", "links that can't be saved")}.`)
  if (failed) parts.push(`${count(failed, 'part', 'parts')} couldn't be loaded.`)
  if (limited) parts.push('Stopped early: this addon is too big to scan in one go.')
  return parts.join(' ')
}

/**
 * A name for the saved file. Stream labels often only say "Option 1", and the address means
 * nothing on these hosts, so it says where in the tree the video came from.
 */
export function savedName({ name, path }: Pick<DownloadEntry, 'name' | 'path'>): string {
  const parts = name.split(' › ')
  const holder = path.at(-1)?.label
  return (holder && holder !== parts[0] ? [holder, ...parts] : parts).join(' - ')
}

/** What to call a download in a list: the title it belongs to, and the episode if it's one. */
export function displayName({ name, path }: Pick<DownloadEntry, 'name' | 'path'>): string {
  const holder = path.at(-1)?.label
  if (!holder) return name.split(' › ')[0]
  const [episode, ...rest] = name.split(' › ')
  return rest.length && episode !== holder ? `${holder} - ${episode}` : holder
}

/** What the saved link's text says about its video. */
export const entryMeta = ({ name, url }: Pick<DownloadEntry, 'name' | 'url'>) => parseStreamMeta({ title: name, url })

/** What a link's row says about its download, if anything. Null once there's nothing to report. */
export function downloadStateText(entry: DownloadEntry | undefined, stage: string | null | undefined): string | null {
  if (!entry || entry.status === 'done' || entry.status === 'opened') return null
  if (entry.status === 'failed') return 'Failed'
  if (entry.status === 'queued') return 'Queued'
  if (entry.status === 'downloading' && stage) return stage
  const percent = percentOf(entry)
  const amount = percent === null ? '' : `${percent}%`
  return entry.status === 'paused' ? `Paused ${amount}`.trim() : amount || 'Downloading'
}

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

interface Options {
  classify?: (link: string) => Promise<LinkKind>
  /** Null in a browser: links are handed over and recorded, not downloaded here. */
  engine?: TransferEngine | null
  /** Where new downloads go. */
  folder?: () => Promise<string | null>
  /** Most downloads at once. The rest wait in the queue. */
  maxActive?: () => number
  /** Finds the video on a page. */
  resolve?: (url: string, options: FindOptions) => Promise<FoundVideo | null>
}

const STAGE_FINDING = 'Finding video…'
const STAGE_PRESS_PLAY = 'Press play in the window'
const STAGE_MERGING = 'Merging…'
const NO_VIDEO = 'No video found on this page. Press Resume to try with the page open'

export function createDownloads(
  database: Promise<Db>,
  {
    classify = linkKind,
    engine = null,
    folder = async () => null,
    maxActive = () => DEFAULT_MAX_DOWNLOADS,
    resolve = async () => null,
  }: Options = {},
) {
  const items = ref<DownloadEntry[]>([])
  const error = ref<string | null>(null)
  /** Only meaningful while the app runs, so not saved. */
  const live = reactive(new Map<string, { speed: number; note: string | null; stage: string | null }>())
  /** Finds in progress, so they can be called off. */
  const finding = new Map<string, AbortController>()
  /** May open a window for a person to press play. Bulk downloads may not: think of 50 windows. */
  const interactive = new Set<string>()
  /** Already found again after expiring, so a link that stays broken can't loop. */
  const refound = new Set<string>()
  const byUrl = computed(() => new Map(items.value.map((entry) => [entry.url, entry])))
  const find = (url: string | undefined) => (url === undefined ? undefined : byUrl.value.get(url))

  /** Writes run in order, so an older state can't overwrite a newer one. */
  let writes: Promise<unknown> = Promise.resolve()
  function persist(entry: DownloadEntry) {
    const snapshot = { ...toRaw(entry), path: [...toRaw(entry.path)] }
    writes = writes
      .then(() => ready)
      .then((db) => db.recordDownload(snapshot))
      .catch((cause) => {
        error.value = `Couldn't save the download: ${messageOf(cause)}`
      })
  }

  function fail(entry: DownloadEntry, message: string) {
    entry.status = 'failed'
    entry.error = message
    live.delete(entry.url)
    persist(entry)
  }

  function setStage(url: string, stage: string | null) {
    const current = live.get(url)
    live.set(url, { speed: current?.speed ?? 0, note: current?.note ?? null, stage })
  }

  /** A different way of fetching means different working files, which are no use now. */
  async function adopt(entry: DownloadEntry, found: FoundVideo) {
    const wasFile = entry.mediaKind === 'file'
    if (entry.filePath && entry.mediaKind && (wasFile !== (found.kind === 'file') || entry.mediaKind === 'extract')) {
      await (engine as TransferEngine).cancel(entry.url, entry.filePath)
      entry.filePath = null
      entry.doneBytes = 0
      entry.totalBytes = null
    }
    entry.mediaUrl = found.url
    entry.mediaKind = found.kind
    entry.referer = found.referer
    entry.userAgent = found.userAgent
    persist(entry)
  }

  /**
   * Switch to the title's next source, if this one never delivered any video. One that did stays
   * as it is: that's likely a dropped connection, and Resume won't lose what it saved.
   */
  function moveToNextSource(entry: DownloadEntry, reason: string): boolean {
    if (entry.doneBytes > 0) return false
    const next = entry.alternates.find((source) => !find(source.url))
    if (!next) return false

    const gone = entry.url
    if (engine && entry.filePath) engine.cancel(gone, entry.filePath).catch(() => {})
    const moved: DownloadEntry = {
      ...toRaw(entry),
      url: next.url,
      name: next.name,
      status: 'queued',
      totalBytes: null,
      filePath: null,
      validator: null,
      error: null,
      mediaUrl: null,
      mediaKind: null,
      referer: null,
      userAgent: null,
      alternates: entry.alternates.filter((source) => source.url !== next.url),
      attempts: [...entry.attempts, { name: entry.name, error: reason }],
    }
    items.value = items.value.map((item) => (item.url === gone ? moved : item))
    live.delete(gone)
    interactive.delete(gone)
    refound.delete(gone)
    writes = writes
      .then(() => ready)
      .then((db) => db.removeDownload(gone))
      .catch((cause) => {
        error.value = `Couldn't save the download: ${messageOf(cause)}`
      })
    persist(find(next.url) as DownloadEntry)
    return true
  }

  /** Work out what to fetch and how. Otherwise says why it won't be fetched. */
  async function route(entry: DownloadEntry, signal: AbortSignal): Promise<'go' | 'failed' | 'called off'> {
    if (entry.mediaUrl) return 'go'
    // Already being saved as a plain file, from before anything else was possible.
    if (entry.filePath && !entry.mediaKind) return 'go'

    setStage(entry.url, STAGE_FINDING)
    const kind = entry.mediaKind ? 'page' : await classify(entry.url)
    if (signal.aborted) return 'called off'
    if (kind === 'file') {
      setStage(entry.url, null)
      return 'go'
    }
    if (kind === 'stream') {
      setStage(entry.url, null)
      entry.mediaUrl = entry.url
      entry.mediaKind = 'stream'
      persist(entry)
      return 'go'
    }
    if (kind === 'external') {
      fail(entry, "This link can't be saved here. Use Open instead")
      return 'failed'
    }

    const found = await resolve(entry.url, {
      interactive: interactive.has(entry.url),
      signal,
      skipProbe: entry.mediaKind === 'extract',
      onVisible: () => setStage(entry.url, STAGE_PRESS_PLAY),
    })
    if (signal.aborted) return 'called off'
    if (!found) {
      if (!moveToNextSource(entry, NO_VIDEO)) fail(entry, NO_VIDEO)
      return 'failed'
    }
    await adopt(entry, found)
    return 'go'
  }

  async function begin(entry: DownloadEntry) {
    entry.status = 'downloading'
    entry.error = null
    const finder = new AbortController()
    finding.set(entry.url, finder)
    let settled = false
    try {
      // Before anything else, as there's no point in finding a video with nowhere to put it.
      if (!entry.filePath && !(await folder())) throw new Error('No download folder set. Choose one in Settings')
      if (find(entry.url) !== entry) return // Removed while waiting.
      const routed = await route(entry, finder.signal)
      if (routed !== 'go') {
        settled = routed === 'failed'
        return
      }
      if (find(entry.url) !== entry) return // Removed while finding.
      finding.delete(entry.url)
      const target = entry.filePath ? null : await folder()
      if (!entry.filePath && !target) throw new Error('No download folder set. Choose one in Settings')
      const media = entry.mediaKind === 'stream' || entry.mediaKind === 'extract'
      await (engine as TransferEngine).start({
        id: entry.url,
        url: entry.mediaUrl ?? entry.url,
        fallbackName: entry.mediaKind ? savedName(entry) : entry.name,
        folder: target,
        filePath: entry.filePath,
        validator: entry.validator,
        mode: media ? 'media' : 'file',
        referer: entry.referer,
        userAgent: entry.userAgent,
        exactName: entry.mediaKind === 'file',
      })
    } catch (cause) {
      fail(entry, messageOf(cause))
      settled = true
    } finally {
      if (finding.get(entry.url) === finder) finding.delete(entry.url)
      if (settled) pump()
    }
  }

  function pump() {
    if (!engine) return
    let active = items.value.filter((entry) => entry.status === 'downloading').length
    // The list is newest first, and the queue is oldest first.
    for (const entry of [...items.value].reverse()) {
      if (active >= maxActive()) break
      if (entry.status !== 'queued') continue
      active++
      begin(entry)
    }
  }

  /** Not a stream linked directly: there's no page behind it to ask. */
  const canFindAgain = (entry: DownloadEntry) =>
    entry.mediaUrl !== null && (entry.mediaKind === 'extract' || (entry.mediaKind !== null && entry.mediaUrl !== entry.url))

  function onEvent(event: TransferEvent) {
    const entry = find(event.id)
    if (!entry) return
    switch (event.kind) {
      case 'started':
        entry.filePath = event.filePath
        entry.totalBytes = event.total
        entry.validator = event.validator
        entry.doneBytes = event.done
        live.set(entry.url, {
          speed: 0,
          note: event.restarted ? "The server couldn't continue this download, so it started over." : null,
          stage: null,
        })
        persist(entry)
        break
      case 'progress': {
        // Too frequent to save. The `.part` file on disk knows anyway.
        entry.doneBytes = event.done
        entry.totalBytes = event.total
        const current = live.get(entry.url)
        live.set(entry.url, { speed: event.speed, note: current?.note ?? null, stage: current?.stage ?? null })
        break
      }
      case 'stage':
        setStage(entry.url, event.stage === 'merging' ? STAGE_MERGING : null)
        break
      case 'finished':
        entry.status = 'done'
        entry.filePath = event.filePath
        entry.doneBytes = event.done
        entry.totalBytes = event.done
        entry.error = null
        live.delete(entry.url)
        interactive.delete(entry.url)
        refound.delete(entry.url)
        persist(entry)
        pump()
        break
      case 'paused':
        entry.status = 'paused'
        entry.doneBytes = event.done
        live.delete(entry.url)
        persist(entry)
        pump()
        break
      case 'failed':
        entry.doneBytes = event.done
        if (event.expired && canFindAgain(entry) && !refound.has(entry.url)) {
          // A page's link stopped working, and the page can give a new one.
          refound.add(entry.url)
          entry.mediaUrl = null
          entry.status = 'queued'
          live.delete(entry.url)
          persist(entry)
        } else if (!moveToNextSource(entry, event.error)) {
          fail(entry, event.error)
        }
        pump()
        break
    }
  }

  const ready = database.then(async (db) => {
    items.value = await db.downloads()
    if (engine) {
      await engine.listen(onEvent)
      // Still marked as running means the app closed mid-transfer.
      for (const entry of items.value) {
        if (entry.status === 'downloading') entry.status = 'queued'
      }
      pump()
    }
    return db
  })
  ready.catch((cause) => {
    error.value = `Couldn't load the downloads: ${messageOf(cause)}`
  })

  /** Move an existing entry to the top, or add a new one. */
  function place(opened: OpenedLink, status: DownloadEntry['status']): DownloadEntry {
    const existing = find(opened.url)
    if (existing) {
      // The same object: a download in progress holds on to it.
      Object.assign(existing, opened, { path: [...opened.path], openedAt: Date.now(), status })
      items.value = [existing, ...items.value.filter((entry) => entry.url !== opened.url)]
      persist(existing)
      return existing
    }
    const base = {
      totalBytes: null,
      doneBytes: 0,
      filePath: null,
      validator: null,
      error: null,
      mediaUrl: null,
      mediaKind: null,
      referer: null,
      userAgent: null,
      alternates: [],
      attempts: [],
    }
    items.value = [
      { ...base, ...opened, path: [...opened.path], openedAt: Date.now(), status },
      ...items.value.filter((entry) => entry.url !== opened.url),
    ]
    const placed = find(opened.url) as DownloadEntry
    persist(placed)
    return placed
  }

  /** Call after opening a link outside the app. A link already being handled here stays as it is. */
  async function recordOpened(opened: OpenedLink, kind?: LinkKind) {
    await ready
    const existing = find(opened.url)
    if (existing) {
      place(opened, existing.status)
    } else {
      const resolved = kind ?? (await classify(opened.url))
      if (resolved === 'page' || resolved === 'external') return
      place(opened, 'opened')
    }
    await writes
  }

  /** Returns whether this added work: a running or finished download is left alone. */
  function enqueue(opened: OpenedLink): boolean {
    const existing = find(opened.url)
    if (!existing || existing.status === 'opened') {
      place(opened, 'queued')
      return true
    }
    if (existing.status !== 'paused' && existing.status !== 'failed') return false
    existing.status = 'queued'
    existing.error = null
    if (opened.alternates) existing.alternates = opened.alternates
    persist(existing)
    return true
  }

  /** Download file links, in this order. Continues stopped ones. Returns how many it added. */
  async function downloadMany(links: OpenedLink[]): Promise<number> {
    await ready
    const added = links.filter(enqueue).length
    pump()
    await writes
    return added
  }

  /** One link someone just chose, so it may ask them to press play. */
  function download(opened: OpenedLink) {
    interactive.add(opened.url)
    return downloadMany([opened])
  }

  async function resume(url: string) {
    const entry = find(url)
    if (entry?.status !== 'paused' && entry?.status !== 'failed') return
    const wasFailed = entry.status === 'failed'
    entry.status = 'queued'
    entry.error = null
    interactive.add(url)
    refound.delete(url)
    // A failed link is likely expired, and finding it again costs little.
    if (wasFailed && canFindAgain(entry)) entry.mediaUrl = null
    persist(entry)
    pump()
    await writes
  }

  async function pause(url: string) {
    const entry = find(url)
    if (entry?.status === 'queued') {
      entry.status = 'paused'
      persist(entry)
      await writes
    } else if (entry?.status === 'downloading' && finding.has(url)) {
      // Nothing's running to confirm it. There's only a page being searched.
      finding.get(url)?.abort()
      finding.delete(url)
      entry.status = 'paused'
      live.delete(url)
      persist(entry)
      pump()
      await writes
    } else if (entry?.status === 'downloading') {
      // Becomes paused when the engine confirms it.
      await engine?.pause(url)
    }
  }

  /** Remove from the list. An unfinished download loses its partial file; a finished file stays. */
  async function remove(url: string) {
    const db = await ready
    const entry = find(url)
    finding.get(url)?.abort()
    finding.delete(url)
    interactive.delete(url)
    refound.delete(url)
    if (entry && engine && entry.status !== 'done' && entry.status !== 'opened') {
      await engine.cancel(url, entry.filePath)
    }
    await writes
    await db.removeDownload(url)
    items.value = items.value.filter((item) => item.url !== url)
    live.delete(url)
    pump()
  }

  return {
    items,
    error,
    /** Downloads run inside the app, rather than being handed to the browser. */
    managed: engine !== null,
    find,
    speedOf: (url: string) => live.get(url)?.speed ?? 0,
    noteOf: (url: string) => live.get(url)?.note ?? null,
    /** What it's busy with, when that isn't moving bytes. */
    stageOf: (url: string | undefined) => (url === undefined ? null : (live.get(url)?.stage ?? null)),
    recordOpened,
    download,
    downloadMany,
    resume,
    pause,
    remove,
    /** Start what the limit now allows. Call after raising it. */
    refill: pump,
    /** Resolves when everything so far is saved. */
    saved: () => writes,
  }
}

function createShared() {
  const settings = useSettings()
  // Settings first, so nothing starts over the limit on launch.
  const database = settings.ready.then(() => getDb())
  const engine = getTransferEngine()
  const list = createDownloads(database, {
    engine,
    folder: async () => settings.downloadFolder.value,
    maxActive: () => settings.maxDownloads.value,
    resolve: engine ? createResolver(engine.probe, createCapture(engine)) : undefined,
  })
  watch(settings.maxDownloads, list.refill)
  return list
}

let shared: ReturnType<typeof createShared> | undefined

export function useDownloads() {
  return (shared ??= createShared())
}
