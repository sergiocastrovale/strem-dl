import type { CaptureEvent, CaptureFind, TransferEngine } from './transfer'

/** Where a page's video turned out to be. */
export interface FoundVideo {
  url: string
  /** `file`: one download. `stream`: pieces. `extract`: yt-dlp reads the page itself. */
  kind: 'file' | 'stream' | 'extract'
  referer: string | null
  userAgent: string | null
}

export interface FindOptions {
  /** Whether a person can be asked to press play, in a window that then appears. */
  interactive: boolean
  signal: AbortSignal
  onVisible?: () => void
  /** yt-dlp already said it understood this page, then couldn't save it. */
  skipProbe?: boolean
}

type Finder = (url: string, options: FindOptions) => Promise<FoundVideo | null>

const HIDDEN_WAIT = 20_000
const VISIBLE_WAIT = 5 * 60_000
const MAX_WINDOWS = 2
/** Ads run short, and the film is what's wanted, so shorter videos only count if nothing else turns up. */
const MIN_CONFIDENT_SECONDS = 120

const MANIFEST_ADDRESS = /\.(m3u8|mpd)(\?|#|$)/i
const MANIFEST_TYPE = /mpegurl|dash\+xml/i

const isManifest = (find: CaptureFind) =>
  MANIFEST_ADDRESS.test(find.url) || MANIFEST_TYPE.test(find.contentType ?? '')

const toVideo = (find: CaptureFind, kind: FoundVideo['kind']): FoundVideo => ({
  url: find.url,
  kind,
  referer: find.referer,
  userAgent: find.userAgent,
})

/**
 * The best of what a page loaded, or null to keep waiting. Players load the master playlist
 * before its variants, so the first manifest is the one to use. `final` takes anything over
 * nothing, for when time's up.
 */
export function pickStream(finds: CaptureFind[], final = false): FoundVideo | null {
  const manifest = finds.find(isManifest)
  if (manifest) return toVideo(manifest, 'stream')

  const longest = [...finds].sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))[0]
  if (!longest) return null
  return final || (longest.duration ?? 0) >= MIN_CONFIDENT_SECONDS ? toVideo(longest, 'file') : null
}

/** Finds videos by opening pages in capture windows. See src-tauri/src/capture.rs. */
export function createCapture(
  engine: Pick<TransferEngine, 'captureOpen' | 'captureShow' | 'captureClose' | 'captureListen'>,
  { hiddenWait = HIDDEN_WAIT, visibleWait = VISIBLE_WAIT, maxWindows = MAX_WINDOWS } = {},
): Finder {
  const sessions = new Map<string, (event: CaptureEvent) => void>()
  let listening: Promise<void> | undefined
  let nextId = 0

  let open = 0
  const waiting: (() => void)[] = []
  async function takeSlot(signal: AbortSignal) {
    while (open >= maxWindows && !signal.aborted) {
      await new Promise<void>((resolve) => {
        waiting.push(resolve)
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    }
    open++
  }
  function freeSlot() {
    open--
    waiting.shift()?.()
  }

  async function watch(url: string, { interactive, signal, onVisible }: FindOptions): Promise<FoundVideo | null> {
    const id = `capture-${nextId++}`
    const finds: CaptureFind[] = []
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort = () => {}
    try {
      return await new Promise<FoundVideo | null>((resolve, reject) => {
        onAbort = () => resolve(null)
        signal.addEventListener('abort', onAbort, { once: true })

        const giveUp = () => resolve(pickStream(finds, true))
        const askPerson = () => {
          const best = pickStream(finds, true)
          if (best || !interactive) return resolve(best)
          engine
            .captureShow(id)
            .then(() => {
              onVisible?.()
              timer = setTimeout(giveUp, visibleWait)
            })
            .catch(reject)
        }

        sessions.set(id, (event) => {
          if (event.kind === 'closed') return giveUp()
          const known = finds.findIndex((find) => find.url === event.url)
          if (known >= 0) finds[known] = event
          else finds.push(event)
          const best = pickStream(finds)
          if (best) resolve(best)
        })
        timer = setTimeout(askPerson, hiddenWait)
        engine.captureOpen(id, url, false).catch(reject)
      })
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      sessions.delete(id)
      await engine.captureClose(id).catch(() => {})
    }
  }

  return async function find(url, options) {
    listening ??= engine.captureListen((event) => sessions.get(event.id)?.(event))
    await listening
    await takeSlot(options.signal)
    try {
      return options.signal.aborted ? null : await watch(url, options)
    } finally {
      freeSlot()
    }
  }
}

/** yt-dlp first, since it runs none of the page's code, then the page itself. */
export function createResolver(probe: (url: string) => Promise<boolean>, capture: Finder): Finder {
  /** yt-dlp won't change its mind about a host this session, and asking takes seconds. */
  const unsupportedHosts = new Set<string>()

  async function understood(url: string) {
    const host = new URL(url).host
    if (unsupportedHosts.has(host)) return false
    // If yt-dlp can't even run, the page may still work.
    const known = await probe(url).catch(() => false)
    if (!known) unsupportedHosts.add(host)
    return known
  }

  return async function resolve(url, options) {
    if (!options.skipProbe && (await understood(url))) return { url, kind: 'extract', referer: null, userAgent: null }
    return options.signal.aborted ? null : capture(url, options)
  }
}
