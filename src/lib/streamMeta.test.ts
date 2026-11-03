import { describe, expect, it } from 'vitest'
import { audioText, hasChips, metaLine, parseStreamMeta, resolutionRank, sourceText } from './streamMeta'

describe('parseStreamMeta', () => {
  // As served by a real addon.
  const emoji = {
    name: 'PTGDrive 1080p',
    description:
      '🎥 BluRay   🎞️ AVC\n🎧 AC3\n📦 6.54 GB\n🔊 🌐Áudio duplo | 🇺🇸 Inglês | 🇵🇹 Português (Portugal)\n⏱️ 1h 28m\n📄 The.Lion.King.1994.1080p.DualAudio.BluRay.Hi10P.H264.AC3.mkv',
    url: 'https://host.test/playback/abc/The.Lion.King.1994.1080p.mkv',
    behaviorHints: { videoSize: 6544034653, filename: 'The.Lion.King.1994.1080p.mkv' },
  }

  it('reads an emoji-labelled description', () => {
    expect(parseStreamMeta(emoji)).toEqual({
      quality: 'BluRay',
      resolution: '1080p',
      codec: 'AVC',
      audio: 'AC3',
      size: '6.54 GB',
      sizeBytes: 6544034653,
      languages: ['EN', 'PT-PT'],
      languagesLong: 'Áudio duplo · Inglês, Português (Portugal)',
      runtime: '1h 28m',
      filename: 'The.Lion.King.1994.1080p.mkv',
    })
  })

  it('takes the filename from its label without hints', () => {
    const { behaviorHints: _, ...plain } = emoji
    const meta = parseStreamMeta(plain)
    expect(meta.filename).toBe('The.Lion.King.1994.1080p.DualAudio.BluRay.Hi10P.H264.AC3.mkv')
    expect(meta.sizeBytes).toBe(6.54e9)
  })

  it('reads a scene-style release name', () => {
    expect(parseStreamMeta({ title: 'Movie.2021.2160p.WEB-DL.DDP5.1.x265-GRP.mkv 💾 1,5 GB' })).toMatchObject({
      quality: 'WEB-DL',
      resolution: '2160p',
      codec: 'HEVC',
      audio: 'EAC3',
      size: '1,5 GB',
      sizeBytes: 1.5e9,
      filename: 'Movie.2021.2160p.WEB-DL.DDP5.1.x265-GRP.mkv',
    })
  })

  it('falls back on the address, and on hints for the size', () => {
    expect(parseStreamMeta({ url: 'https://a.test/Film.720p.WEBRip.mp4', behaviorHints: { videoSize: 2_500_000_000 } })).toEqual({
      quality: 'WEBRip',
      resolution: '720p',
      size: '2.50 GB',
      sizeBytes: 2_500_000_000,
      filename: 'Film.720p.WEBRip.mp4',
    })
  })

  it('leaves out what it cannot find', () => {
    expect(parseStreamMeta({ title: 'Option 1', url: 'https://a.test/watch' })).toEqual({})
    expect(hasChips(parseStreamMeta({ title: 'Option 1' }))).toBe(false)
    expect(hasChips(parseStreamMeta({ title: '1080p' }))).toBe(true)
  })

  it('names 4K consistently and does not mistake other words for it', () => {
    expect(parseStreamMeta({ title: 'Film 4K HDR' }).resolution).toBe('2160p')
    expect(parseStreamMeta({ title: 'Film uhd' }).resolution).toBe('2160p')
    expect(parseStreamMeta({ title: 'Top 4Kids' }).resolution).toBeUndefined()
  })

  it('reads languages from flags alone', () => {
    expect(parseStreamMeta({ title: 'x\n🇬🇧 / 🇮🇹 / 🇯🇵' }).languages).toEqual(['EN', 'IT', 'JA'])
  })

  it('tolerates a malformed address', () => {
    expect(parseStreamMeta({ url: 'not a url' })).toEqual({})
  })
})

describe('formatting', () => {
  const meta = { quality: 'WEB-DL', codec: 'HEVC', resolution: '1080p', audio: 'AAC', languagesLong: 'Inglês' }

  it('joins what is known', () => {
    expect(sourceText(meta)).toBe('WEB-DL 1080p')
    expect(sourceText(meta, ' · ')).toBe('WEB-DL · 1080p')
    expect(sourceText({ resolution: '720p' })).toBe('720p')
    expect(audioText(meta)).toBe('AAC · Inglês')
    expect(metaLine(meta)).toBe('WEB-DL · HEVC · 1080p')
    expect(metaLine({})).toBe('')
  })

  it('ranks resolutions', () => {
    expect(resolutionRank('2160p')).toBeGreaterThan(resolutionRank('1080p'))
    expect(resolutionRank(undefined)).toBe(0)
  })
})
