// Pure Stremio addon protocol logic: no network, no Vue.
import { parseStreamMeta, type StreamMeta, type StreamText } from './streamMeta'

export interface ManifestResource {
  name: string
  types?: string[]
  idPrefixes?: string[]
}

export interface CatalogExtra {
  name: string
  isRequired?: boolean
  options?: string[]
}

export interface ManifestCatalog {
  type: string
  id: string
  name?: string
  extra?: CatalogExtra[]
  // Legacy manifest fields, still used by older addons.
  extraSupported?: string[]
  extraRequired?: string[]
  genres?: string[]
}

export interface Manifest {
  id: string
  name: string
  version?: string
  resources: (string | ManifestResource)[]
  types?: string[]
  idPrefixes?: string[]
  catalogs: ManifestCatalog[]
}

export interface Stream extends StreamText {
  url?: string
  externalUrl?: string
  ytId?: string
  infoHash?: string
  title?: string
  description?: string
  name?: string
}

export interface Video {
  id: string
  title?: string
  name?: string
  season?: number
  episode?: number
  thumbnail?: string
  streams?: Stream[]
}

export interface Meta {
  id: string
  name?: string
  videos?: Video[]
}

export interface MetaPreview {
  id: string
  name?: string
  poster?: string
}

/** What must be fetched to fill a node's children. */
export type Loader =
  | { kind: 'catalog'; type: string; catalogId: string; genre?: string; pageable: boolean }
  | { kind: 'meta'; type: string; id: string }
  | { kind: 'stream'; type: string; id: string }

export type NodeKind = 'addon' | 'folder' | 'item' | 'video' | 'link' | 'more' | 'locked' | 'note'

/** Plain description of a tree row; useTree adds the runtime state. */
export interface NodeSpec {
  kind: NodeKind
  label: string
  hint?: string
  url?: string
  loader?: Loader
  children?: NodeSpec[]
  /** An image address from the addon. Only ever used for display. */
  poster?: string
  /** What a link's text says about its video. */
  meta?: StreamMeta
}

/** One step of the way to a folder. The key survives renames; the label is the fallback and what we display. */
export interface PathSegment {
  key: string
  label: string
}

/** Identifies a node among its siblings, based on what it was built from. */
export function nodeKey({ label, loader }: Pick<NodeSpec, 'label' | 'loader'>): string {
  if (!loader) return `label:${label}`
  if (loader.kind === 'catalog') return `catalog:${loader.type}:${loader.catalogId}:${loader.genre ?? ''}`
  return `${loader.kind}:${loader.type}:${loader.id}`
}

const NO_STREAMS = 'No streams available'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const MANIFEST = '/manifest.json'
const SCHEME = /^[a-z][a-z\d+.-]*:/i
/** What a host looks like when typed without a scheme: a domain, `localhost`, or one with a port. */
const BARE_HOST = /^(localhost|[^\s/:?#]+\.[^\s/:?#]+|[^\s/:?#]+:\d+)([/?#]|$)/i

/** Local addons rarely have a certificate, so those default to http. */
const withDefaultScheme = (typed: string) =>
  `${/^(localhost|\d{1,3}(\.\d{1,3}){3})([/:?#]|$)/i.test(typed) ? 'http' : 'https'}://${typed}`

/**
 * The address typed so far, as a full addon URL: `https://` if there's no scheme, and
 * `/manifest.json` on the end if it's missing. Null if it doesn't look like an address yet.
 */
export function completeAddonUrl(input: string): string | null {
  const typed = input.trim()
  if (!typed) return null
  const withScheme = SCHEME.test(typed) && !/^[^\s/:?#]+:\d+/.test(typed) ? typed : BARE_HOST.test(typed) ? withDefaultScheme(typed) : null
  if (!withScheme) return null
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const path = url.pathname.replace(/\/+$/, '')
  // Another file isn't an addon, and adding to its name would hide that.
  if (/\.json$/i.test(path) && !path.endsWith(MANIFEST)) return null
  return url.origin + (path.endsWith(MANIFEST) ? path : path + MANIFEST)
}

/** Everything before `/manifest.json`, keeping the path so configured addons work. */
export function addonBase(input: string): string {
  const typed = input.trim()
  let url: URL
  try {
    url = new URL(SCHEME.test(typed) && !/^[^\s/:?#]+:\d+/.test(typed) ? typed : withDefaultScheme(typed))
  } catch {
    throw new Error('Not a valid URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https URLs are supported')
  }
  const complete = completeAddonUrl(typed)
  if (!complete) {
    if (/^[^\s/:?#]+$/.test(typed)) throw new Error('Not a valid URL')
    throw new Error('Not an addon URL: it must end in /manifest.json')
  }
  return complete.slice(0, -MANIFEST.length)
}

export function parseManifest(data: unknown): Manifest {
  if (!isRecord(data) || typeof data.id !== 'string' || typeof data.name !== 'string' || !Array.isArray(data.resources)) {
    throw new Error('Not an addon manifest: id, name or resources is missing')
  }
  const catalogs = Array.isArray(data.catalogs)
    ? data.catalogs.filter(
        (c): c is ManifestCatalog => isRecord(c) && typeof c.type === 'string' && typeof c.id === 'string',
      )
    : []
  return { ...(data as unknown as Manifest), catalogs }
}

export function resourceUrl(
  base: string,
  resource: string,
  type: string,
  id: string,
  extra: Record<string, string | number> = {},
): string {
  const extras = Object.entries(extra)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&')
  const path = [resource, type, id].map(encodeURIComponent).join('/')
  return `${base}/${path}${extras ? `/${extras}` : ''}.json`
}

export function loaderUrl(base: string, loader: Loader, skip = 0): string {
  if (loader.kind !== 'catalog') return resourceUrl(base, loader.kind, loader.type, loader.id)
  const extra: Record<string, string | number> = {}
  if (loader.genre !== undefined) extra.genre = loader.genre
  if (skip > 0) extra.skip = skip
  return resourceUrl(base, 'catalog', loader.type, loader.catalogId, extra)
}

/** Does the addon declare this resource for this type and id? */
export function supports(manifest: Manifest, resource: string, type: string, id: string): boolean {
  return manifest.resources.some((entry) => {
    const declared: ManifestResource = typeof entry === 'string' ? { name: entry } : entry
    if (declared?.name !== resource) return false
    const types = declared.types ?? manifest.types
    const prefixes = declared.idPrefixes ?? manifest.idPrefixes
    if (types?.length && !types.includes(type)) return false
    if (prefixes?.length && !prefixes.some((prefix) => id.startsWith(prefix))) return false
    return true
  })
}

function catalogExtras(catalog: ManifestCatalog): CatalogExtra[] {
  if (Array.isArray(catalog.extra)) return catalog.extra
  return (catalog.extraSupported ?? []).map((name) => ({
    name,
    isRequired: catalog.extraRequired?.includes(name),
    options: name === 'genre' ? catalog.genres : undefined,
  }))
}

function catalogNode(catalog: ManifestCatalog): NodeSpec {
  const label = catalog.name || `${catalog.type} / ${catalog.id}`
  const extras = catalogExtras(catalog)
  const genre = extras.find((extra) => extra.name === 'genre')
  const genres = genre?.options ?? []
  const blocker = extras.find(
    (extra) => extra.isRequired && extra.name !== 'skip' && !(extra.name === 'genre' && genres.length > 0),
  )
  if (blocker) return { kind: 'locked', label, hint: `requires ${blocker.name}` }

  const base = {
    kind: 'catalog' as const,
    type: catalog.type,
    catalogId: catalog.id,
    pageable: extras.some((extra) => extra.name === 'skip'),
  }
  if (genres.length === 0) return { kind: 'folder', label, loader: base }

  const children: NodeSpec[] = genres.map((name) => ({
    kind: 'folder',
    label: name,
    loader: { ...base, genre: name },
  }))
  if (!genre?.isRequired) children.unshift({ kind: 'folder', label: 'All', loader: base })
  return { kind: 'folder', label, children }
}

export function addonNode(manifest: Manifest): NodeSpec {
  return {
    kind: 'addon',
    label: manifest.name,
    hint: manifest.version ? `v${manifest.version}` : undefined,
    children: manifest.catalogs.length
      ? manifest.catalogs.map(catalogNode)
      : [{ kind: 'note', label: 'This addon has no catalogs to browse' }],
  }
}

/** Items of a catalog page that haven't been seen yet; records them in `seen`. */
export function newItems(data: unknown, seen: Set<string>): MetaPreview[] {
  if (!isRecord(data) || !Array.isArray(data.metas)) throw new Error('Unexpected response: metas is missing')
  const fresh: MetaPreview[] = []
  for (const meta of data.metas) {
    if (!isRecord(meta) || typeof meta.id !== 'string' || seen.has(meta.id)) continue
    seen.add(meta.id)
    fresh.push(meta as unknown as MetaPreview)
  }
  return fresh
}

/**
 * Children of a catalog item before its meta is fetched. Items normally need a
 * meta request; addons without one go straight to their links.
 */
export function itemNode(manifest: Manifest, type: string, item: MetaPreview): NodeSpec {
  const label = item.name || item.id
  const poster = posterOf(item.poster)
  if (supports(manifest, 'meta', type, item.id)) {
    return { kind: 'item', label, loader: { kind: 'meta', type, id: item.id }, ...poster }
  }
  return { kind: 'item', ...linkPlan(manifest, type, item.id), label, ...poster }
}

/** Remote data decides this too, so only web images. */
function posterOf(address: unknown): Pick<NodeSpec, 'poster'> {
  return typeof address === 'string' && /^https?:\/\//i.test(address) ? { poster: address } : {}
}

/** YouTube links are derived from `yt_id:<channel>:<video>`; a channel id alone has no link. */
export function derivedYouTubeLink(id: string): NodeSpec | undefined {
  const parts = id.split(':')
  if (parts[0] !== 'yt_id' || parts.length < 3 || !parts.at(-1)) return undefined
  const ytId = encodeURIComponent(parts.at(-1) as string)
  return { kind: 'link', label: `youtube.com/watch?v=${ytId}`, url: `https://www.youtube.com/watch?v=${ytId}` }
}

/** How to reach the links of one id: a fetch, or children known right away. */
function linkPlan(manifest: Manifest, type: string, id: string, inline?: Stream[]): Pick<NodeSpec, 'loader' | 'children'> {
  if (inline?.length) return { children: streamNodes({ streams: inline }) }
  if (supports(manifest, 'stream', type, id)) return { loader: { kind: 'stream', type, id } }
  const derived = derivedYouTubeLink(id)
  return { children: [derived ?? { kind: 'note', label: NO_STREAMS }] }
}

function videoLabel(video: Video): string {
  const title = video.title || video.name || video.id
  return video.episode !== undefined ? `${video.episode}. ${title}` : title
}

function videoNode(manifest: Manifest, type: string, video: Video): NodeSpec {
  return { kind: 'video', label: videoLabel(video), ...linkPlan(manifest, type, video.id, video.streams), ...posterOf(video.thumbnail) }
}

export type MetaChildren =
  | { children: NodeSpec[] }
  /** One video or none: the item itself lists the streams. */
  | { loader: Loader }

export function metaChildren(manifest: Manifest, type: string, data: unknown): MetaChildren {
  if (!isRecord(data) || !isRecord(data.meta)) return { children: [{ kind: 'note', label: 'No details available' }] }
  const meta = data.meta as unknown as Meta
  const videos = (Array.isArray(meta.videos) ? meta.videos : []).filter(
    (video): video is Video => isRecord(video) && typeof video.id === 'string',
  )

  if (videos.length <= 1) {
    const plan = linkPlan(manifest, type, videos[0]?.id ?? meta.id, videos[0]?.streams)
    return plan.loader ? { loader: plan.loader } : { children: plan.children ?? [] }
  }

  const seasons = new Map<number, Video[]>()
  const loose: Video[] = []
  for (const video of videos) {
    if (typeof video.season === 'number') {
      seasons.set(video.season, [...(seasons.get(video.season) ?? []), video])
    } else {
      loose.push(video)
    }
  }
  const seasonNodes = [...seasons.entries()]
    .sort(([a], [b]) => a - b)
    .map(([season, episodes]): NodeSpec => ({
      kind: 'folder',
      label: `Season ${season}`,
      children: [...episodes]
        .sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0))
        .map((video) => videoNode(manifest, type, video)),
    }))
  return { children: [...seasonNodes, ...loose.map((video) => videoNode(manifest, type, video))] }
}

export function streamLink(stream: Stream): string | undefined {
  if (stream.url) return stream.url
  if (stream.externalUrl) return stream.externalUrl
  if (stream.ytId) return `https://www.youtube.com/watch?v=${encodeURIComponent(stream.ytId)}`
  if (stream.infoHash) return `magnet:?xt=urn:btih:${encodeURIComponent(stream.infoHash)}`
  return undefined
}

/** Host to display for a link, looking through `?u=<url>` redirect wrappers. */
export function linkHost(link: string): string | undefined {
  try {
    const url = new URL(link)
    if (url.protocol === 'magnet:') return 'magnet'
    const wrapped = url.searchParams.get('u')
    if (wrapped) {
      const target = new URL(wrapped)
      if (target.protocol === 'http:' || target.protocol === 'https:') return target.hostname
    }
    return url.hostname || undefined
  } catch {
    return undefined
  }
}

export function streamNodes(data: unknown): NodeSpec[] {
  const streams = isRecord(data) && Array.isArray(data.streams) ? data.streams : []
  const nodes: NodeSpec[] = []
  streams.filter(isRecord).forEach((raw, index) => {
    const stream = raw as Stream
    const url = streamLink(stream)
    if (typeof url !== 'string') return
    nodes.push({
      kind: 'link',
      label: stream.title || stream.description || stream.name || `Stream ${index + 1}`,
      hint: linkHost(url),
      url,
      meta: parseStreamMeta({ ...stream, url }),
    })
  })
  return nodes.length ? nodes : [{ kind: 'note', label: NO_STREAMS }]
}

/** Remote data decides these URLs, so only known-safe schemes may be opened. */
export function canOpen(link: string): boolean {
  try {
    return ['http:', 'https:', 'magnet:'].includes(new URL(link).protocol)
  } catch {
    return false
  }
}

/** The extension of what a web link leads to, looking through `?u=<url>` redirect wrappers. */
export function linkExtension(url: URL): string {
  let target = url
  try {
    const wrapped = new URL(url.searchParams.get('u') ?? '')
    if (wrapped.protocol === 'http:' || wrapped.protocol === 'https:') target = wrapped
  } catch {
    // Not a wrapper.
  }
  const name = target.pathname.split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export type LinkFilter = 'mp4' | 'mkv' | 'avi' | 'mov' | 'wmv' | 'webm' | 'website' | 'other'

export const LINK_FILTERS: { id: LinkFilter; label: string }[] = [
  { id: 'mp4', label: 'MP4' },
  { id: 'mkv', label: 'MKV' },
  { id: 'avi', label: 'AVI' },
  { id: 'mov', label: 'MOV' },
  { id: 'wmv', label: 'WMV' },
  { id: 'webm', label: 'WEBM' },
  { id: 'website', label: 'Websites' },
  { id: 'other', label: 'Other' },
]

const VIDEO_FILTERS = new Set<string>(['mp4', 'mkv', 'avi', 'mov', 'wmv', 'webm'])
const PAGE_EXTENSIONS = new Set(['', 'html', 'htm', 'xhtml', 'php', 'asp', 'aspx', 'jsp'])

/**
 * Which filter a link belongs to, by its address alone: rows can't ask each server.
 * A web address without a file extension counts as a website.
 */
export function linkFilterOf(link: string): LinkFilter {
  let url: URL
  try {
    url = new URL(link)
  } catch {
    return 'other'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'other'
  const extension = linkExtension(url)
  if (VIDEO_FILTERS.has(extension)) return extension as LinkFilter
  return PAGE_EXTENSIONS.has(extension) ? 'website' : 'other'
}
