import { describe, expect, it, vi } from 'vitest'
import { createDependencies, type DependencyEngine, type DependencyProgress, type DependencyStatus } from './dependencies'

const missing: DependencyStatus[] = [
  { id: 'yt-dlp', installed: false, version: null },
  { id: 'ffmpeg', installed: false, version: null },
]

function fake(status: DependencyStatus[] = missing) {
  let handler: (progress: DependencyProgress) => void = () => {}
  const engine: DependencyEngine = {
    status: vi.fn(async () => status),
    check: vi.fn(async () => []),
    install: vi.fn(async (id) => ({ id, installed: true, version: 'v2' })),
    listen: vi.fn(async (next) => void (handler = next)),
  }
  return { engine, emit: (progress: DependencyProgress) => handler(progress) }
}

describe('createDependencies', () => {
  it('is ready only once everything is installed', async () => {
    const { engine } = fake()
    const deps = createDependencies(engine)
    expect(deps.ready.value).toBe(false)
    await deps.load()
    expect(deps.ready.value).toBe(false)
    await deps.install('yt-dlp')
    expect(deps.ready.value).toBe(false)
    await deps.install('ffmpeg')
    expect(deps.ready.value).toBe(true)
    expect(deps.items.value[0].version).toBe('v2')
  })

  it('is ready straight away when already installed', async () => {
    const deps = createDependencies(
      fake([
        { id: 'yt-dlp', installed: true, version: '1' },
        { id: 'ffmpeg', installed: true, version: '2' },
      ]).engine,
    )
    await deps.load()
    expect(deps.ready.value).toBe(true)
  })

  it('shows progress while installing, and clears it after', async () => {
    const { engine, emit } = fake()
    let finish: (status: DependencyStatus) => void = () => {}
    engine.install = vi.fn(() => new Promise<DependencyStatus>((resolve) => (finish = resolve)))
    const deps = createDependencies(engine)
    await deps.load()
    const installing = deps.install('ffmpeg')
    expect(deps.items.value[1].progress?.stage).toBe('downloading')
    expect(deps.busy.value).toBe(true)
    emit({ id: 'ffmpeg', stage: 'downloading', done: 50, total: 100 })
    expect(deps.items.value[1].progress?.done).toBe(50)
    expect(deps.items.value[0].progress).toBeNull()
    finish({ id: 'ffmpeg', installed: true, version: 'v1' })
    await installing
    expect(deps.items.value[1].progress).toBeNull()
    expect(deps.busy.value).toBe(false)
  })

  it("won't start the same install twice", async () => {
    const { engine } = fake()
    const deps = createDependencies(engine)
    await deps.load()
    await Promise.all([deps.install('yt-dlp'), deps.install('yt-dlp')])
    expect(engine.install).toHaveBeenCalledOnce()
  })

  it('reports a failed install, which can be tried again', async () => {
    const { engine } = fake()
    engine.install = vi.fn().mockRejectedValueOnce('No network').mockResolvedValue({ id: 'yt-dlp', installed: true, version: 'v1' })
    const deps = createDependencies(engine)
    await deps.load()
    await deps.install('yt-dlp')
    expect(deps.items.value[0]).toMatchObject({ error: 'No network', installed: false, progress: null })
    await deps.install('yt-dlp')
    expect(deps.items.value[0]).toMatchObject({ error: null, installed: true })
  })

  it('a failed update keeps what was installed', async () => {
    const { engine } = fake([{ id: 'yt-dlp', installed: true, version: 'old' }])
    engine.install = vi.fn().mockRejectedValue('No network')
    const deps = createDependencies(engine)
    await deps.load()
    await deps.install('yt-dlp')
    expect(deps.items.value[0]).toMatchObject({ error: 'No network', installed: true, version: 'old' })
  })

  it('finds updates, and an install clears the offer', async () => {
    const { engine } = fake([{ id: 'yt-dlp', installed: true, version: 'old' }])
    engine.check = vi.fn(async () => [{ id: 'yt-dlp' as const, version: 'new', updateAvailable: true }])
    const deps = createDependencies(engine)
    await deps.load()
    await deps.checkForUpdates()
    expect(deps.items.value[0].latest).toEqual({ id: 'yt-dlp', version: 'new', updateAvailable: true })
    await deps.install('yt-dlp')
    expect(deps.items.value[0].latest?.updateAvailable).toBe(false)
    expect(deps.checking.value).toBe(false)
  })

  it('reports a failed check', async () => {
    const { engine } = fake()
    engine.check = vi.fn().mockRejectedValue('GitHub is limiting requests')
    const deps = createDependencies(engine)
    await deps.load()
    await deps.checkForUpdates()
    expect(deps.checkError.value).toBe('GitHub is limiting requests')
    expect(deps.checking.value).toBe(false)
  })

  it('reports being unable to read the status, and can retry', async () => {
    const { engine } = fake()
    engine.status = vi.fn().mockRejectedValueOnce('disk').mockResolvedValue(missing)
    const deps = createDependencies(engine)
    await deps.load()
    expect(deps.loadError.value).toContain('disk')
    expect(deps.loaded.value).toBe(false)
    await deps.load()
    expect(deps.loadError.value).toBeNull()
    expect(deps.loaded.value).toBe(true)
  })
})
