// What a stream's free text says about the video. Addons have no standard for this, so it reads
// what's commonly there, and leaves out whatever it can't find.

export interface StreamMeta {
  quality?: string
  resolution?: string
  codec?: string
  audio?: string
  size?: string
  sizeBytes?: number
  /** Short codes, like `EN`, `PT-PT`. */
  languages?: string[]
  /** As the addon words it, like `Áudio duplo · Inglês, Português (Portugal)`. */
  languagesLong?: string
  runtime?: string
  filename?: string
}

export interface StreamText {
  name?: string
  title?: string
  description?: string
  url?: string
  behaviorHints?: { videoSize?: unknown; filename?: unknown }
}

type Pattern = [RegExp, string]

const QUALITIES: Pattern[] = [
  [/\bremux\b/i, 'REMUX'],
  [/\bblu-?ray\b/i, 'BluRay'],
  [/\bbd-?rip\b/i, 'BDRip'],
  [/\bbr-?rip\b/i, 'BRRip'],
  [/\bweb-?dl\b/i, 'WEB-DL'],
  [/\bweb-?rip\b/i, 'WEBRip'],
  [/\bhd-?rip\b/i, 'HDRip'],
  [/\bdvd-?rip\b/i, 'DVDRip'],
  [/\bhdtv\b/i, 'HDTV'],
  [/\bhd-?cam\b|\bcam-?rip\b/i, 'CAM'],
]

const CODECS: Pattern[] = [
  [/\bav1\b/i, 'AV1'],
  [/\bhevc\b|\b[hx]\.?265\b/i, 'HEVC'],
  [/\bavc\b|\b[hx]\.?264\b/i, 'AVC'],
  [/\bvp9\b/i, 'VP9'],
  [/\bxvid\b/i, 'XviD'],
  [/\bdivx\b/i, 'DivX'],
  [/\bmpeg-?2\b/i, 'MPEG-2'],
]

const AUDIOS: Pattern[] = [
  [/\btrue-?hd\b/i, 'TrueHD'],
  [/\bdts-?hd\b/i, 'DTS-HD'],
  [/\bdts\b/i, 'DTS'],
  [/\be-?ac-?3\b|\bddp(?=\d|\b)|\bdd\+/i, 'EAC3'],
  [/\bac-?3\b|\bdd[ .]?[25]\.[01]\b/i, 'AC3'],
  [/\baac\b/i, 'AAC'],
  [/\bflac\b/i, 'FLAC'],
  [/\bopus\b/i, 'Opus'],
  [/\bmp3\b/i, 'MP3'],
]

const RESOLUTION = /(?:^|[^a-z\d])(4320p|2160p|1440p|1080p|720p|576p|540p|480p|360p|8k|4k|uhd)(?![a-z\d])/i
const SIZE = /(?:^|[^\d.,])(\d+(?:[.,]\d+)?)\s?(TB|GB|MB)\b/i
const RUNTIME = /\b\d{1,2}\s?h\s?\d{1,2}\s?m(?:in)?\b|\b\d{1,2}\s?h\b|\b\d{2,3}\s?min\b/i
const VIDEO_FILE = /[^\s/\\]+\.(?:mkv|mp4|m4v|avi|mov|wmv|webm|ts|mpg|mpeg)\b/i
/** Runs of symbols, flags and spacing marks, which is how addons label their lines. */
const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{FE0F}\u{200D}\u{20E3}]+/gu
const FLAG = /\p{Regional_Indicator}{2}/u

const SIZE_UNITS: Record<string, number> = { MB: 1e6, GB: 1e9, TB: 1e12 }

const FLAG_LANGUAGES: Record<string, string> = {
  US: 'EN',
  GB: 'EN',
  PT: 'PT-PT',
  BR: 'PT-BR',
  JP: 'JA',
  KR: 'KO',
  CN: 'ZH',
  GR: 'EL',
  SE: 'SV',
  DK: 'DA',
}

const NAMED_LANGUAGES: Pattern[] = [
  [/portugu[eê]se?s?.*(brasil|brazil)|pt-?br/i, 'PT-BR'],
  [/portugu[eê]s|portuguese|pt-?pt/i, 'PT-PT'],
  [/ingl[eê]s|english/i, 'EN'],
  [/espanhol|spanish|español|castellano/i, 'ES'],
  [/franc[eê]s|french/i, 'FR'],
  [/alem[aã]o|german/i, 'DE'],
  [/italiano|italian/i, 'IT'],
  [/japon[eê]s|japanese/i, 'JA'],
  [/coreano|korean/i, 'KO'],
  [/russo|russian/i, 'RU'],
]

const firstMatch = (patterns: Pattern[], text: string) => patterns.find(([pattern]) => pattern.test(text))?.[1]

/** `🇵🇹` to `PT`: each symbol is a letter, offset. */
function flagCountry(flag: string): string {
  return [...flag].map((symbol) => String.fromCodePoint((symbol.codePointAt(0) as number) - 0x1f1e6 + 65)).join('')
}

const clean = (text: string) => text.replace(EMOJI, ' ').replace(/\s+/g, ' ').trim()

/** What follows a label such as `🎧`, up to the next label or line. */
function labelled(text: string, label: string): string | undefined {
  const start = text.indexOf(label)
  if (start < 0) return undefined
  const rest = text.slice(start + label.length).replace(/^[\u{FE0F}\s]+/u, '')
  const end = rest.search(/\n|\p{Extended_Pictographic}/u)
  return clean(end < 0 ? rest : rest.slice(0, end)) || undefined
}

function parseLanguages(text: string): Pick<StreamMeta, 'languages' | 'languagesLong'> {
  const line = text.split('\n').find((candidate) => candidate.includes('🔊') || FLAG.test(candidate))
  if (!line) return {}
  const codes: string[] = []
  const names: string[] = []
  const notes: string[] = []
  for (const part of line.split(/[|/,]/)) {
    const flag = part.match(FLAG)?.[0]
    const name = clean(part)
    const code = firstMatch(NAMED_LANGUAGES, name) ?? (flag && (FLAG_LANGUAGES[flagCountry(flag)] ?? flagCountry(flag)))
    if (/duplo|dual|multi/i.test(name)) notes.push(name)
    else if (name) names.push(name)
    if (code && !codes.includes(code)) codes.push(code)
  }
  const worded = names.length ? names.join(', ') : codes.join(', ')
  const languagesLong = [...notes, worded].filter(Boolean).join(' · ')
  return { ...(codes.length ? { languages: codes } : {}), ...(languagesLong ? { languagesLong } : {}) }
}

function formatSize(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(2)} TB`
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`
  return `${Math.round(bytes / 1e6)} MB`
}

function fileFromUrl(url: string | undefined): string {
  if (!url) return ''
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
  } catch {
    return ''
  }
}

export function parseStreamMeta(stream: StreamText): StreamMeta {
  const text = [stream.name, stream.title, stream.description].filter(Boolean).join('\n')
  const urlFile = fileFromUrl(stream.url)
  const hinted = stream.behaviorHints?.filename
  const filename =
    (typeof hinted === 'string' && hinted) || labelled(text, '📄') || text.match(VIDEO_FILE)?.[0] || (VIDEO_FILE.test(urlFile) ? urlFile : undefined)
  const everything = `${text}\n${urlFile}`

  const hintedBytes = stream.behaviorHints?.videoSize
  const sizeText = text.match(SIZE)
  const sizeBytes =
    typeof hintedBytes === 'number' && hintedBytes > 0
      ? hintedBytes
      : sizeText
        ? Number(sizeText[1].replace(',', '.')) * SIZE_UNITS[sizeText[2].toUpperCase()]
        : undefined
  const size = sizeText ? `${sizeText[1]} ${sizeText[2].toUpperCase()}` : sizeBytes ? formatSize(sizeBytes) : undefined

  const resolutionText = everything.match(RESOLUTION)?.[1].toLowerCase()
  const resolution = resolutionText === '4k' || resolutionText === 'uhd' ? '2160p' : resolutionText === '8k' ? '4320p' : resolutionText

  const meta: StreamMeta = {
    quality: firstMatch(QUALITIES, everything) ?? labelled(text, '🎥'),
    resolution,
    codec: firstMatch(CODECS, everything) ?? labelled(text, '🎞'),
    audio: firstMatch(AUDIOS, everything) ?? labelled(text, '🎧'),
    size,
    sizeBytes,
    runtime: labelled(text, '⏱') ?? text.match(RUNTIME)?.[0],
    filename: filename || undefined,
    ...parseLanguages(text),
  }
  return Object.fromEntries(Object.entries(meta).filter(([, value]) => value !== undefined)) as StreamMeta
}

/** Higher is better. Zero when unknown. */
export function resolutionRank(resolution: string | undefined): number {
  return resolution ? Number.parseInt(resolution, 10) || 0 : 0
}

/** `BluRay 1080p`, or as much of it as is known. */
export const sourceText = ({ quality, resolution }: StreamMeta, separator = ' ') =>
  [quality, resolution].filter(Boolean).join(separator)

export function audioText({ audio, languagesLong }: StreamMeta): string {
  return [audio, languagesLong].filter(Boolean).join(' · ')
}

/** The line under a download's name: `WEB-DL · HEVC · 1080p`. */
export function metaLine({ quality, codec, resolution }: StreamMeta): string {
  return [quality, codec, resolution].filter(Boolean).join(' · ')
}

export const hasChips = (meta: StreamMeta | undefined): boolean =>
  !!meta && !!(meta.quality || meta.resolution || meta.codec || meta.audio || meta.size || meta.languages || meta.runtime)
