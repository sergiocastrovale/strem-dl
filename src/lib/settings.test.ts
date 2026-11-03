import { describe, expect, it, vi } from 'vitest'
import { storageDb } from './db'
import { createSettings } from './settings'

function memory() {
  const data = new Map<string, string>()
  return storageDb({
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  })
}

const create = (db = memory(), validate = vi.fn(async () => {})) =>
  createSettings(Promise.resolve(db), { systemFolder: async () => '/home/me/Downloads', validate })

describe('settings', () => {
  it('uses the system folder until one is set', async () => {
    const settings = create()
    await settings.ready
    expect(settings.downloadFolder.value).toBe('/home/me/Downloads')
    expect(settings.customFolder.value).toBeNull()
  })

  it('saves a checked folder, which survives a reload, and can go back', async () => {
    const db = memory()
    const validate = vi.fn(async () => {})
    const settings = create(db, validate)
    await settings.setDownloadFolder('  /data/films ')
    expect(validate).toHaveBeenCalledWith('/data/films')
    expect(settings.downloadFolder.value).toBe('/data/films')

    const reloaded = create(db)
    await reloaded.ready
    expect(reloaded.downloadFolder.value).toBe('/data/films')

    await reloaded.resetDownloadFolder()
    expect(reloaded.downloadFolder.value).toBe('/home/me/Downloads')
    expect(await db.setting('download-folder')).toBeNull()
  })

  it('allows 4 downloads at once until told otherwise', async () => {
    const db = memory()
    const settings = create(db)
    await settings.ready
    expect(settings.maxDownloads.value).toBe(4)
    await settings.setMaxDownloads('7')
    expect(settings.maxDownloads.value).toBe(7)

    const reloaded = create(db)
    await reloaded.ready
    expect(reloaded.maxDownloads.value).toBe(7)
  })

  it('refuses a bad limit and keeps the old one', async () => {
    const db = memory()
    const settings = create(db)
    for (const bad of ['0', '11', '-1', '2.5', 'many', '']) {
      await expect(settings.setMaxDownloads(bad)).rejects.toThrow('1 to 10')
    }
    expect(settings.maxDownloads.value).toBe(4)
    expect(await db.setting('max-downloads')).toBeNull()
  })

  it('ignores a saved limit that makes no sense', async () => {
    const db = memory()
    await db.setSetting('max-downloads', '999')
    const settings = create(db)
    await settings.ready
    expect(settings.maxDownloads.value).toBe(4)
  })

  it('brings a limit saved when more were allowed down to the most allowed now', async () => {
    const db = memory()
    await db.setSetting('max-downloads', '15')
    const settings = create(db)
    await settings.ready
    expect(settings.maxDownloads.value).toBe(10)
  })

  it('remembers how Home is viewed, and treats a source choice no longer offered as the first', async () => {
    const db = memory()
    await db.setSetting('bulk-copy', 'second')
    const settings = create(db)
    await settings.ready
    expect(settings.bulkSource.value).toBe('first')
    expect(settings.homeView.value).toBe('list')
    await settings.setHomeView('grid')

    const reloaded = create(db)
    await reloaded.ready
    expect(reloaded.homeView.value).toBe('grid')
  })

  it('keeps the old folder when the new one is refused', async () => {
    const db = memory()
    const settings = create(db, vi.fn(async () => Promise.reject(new Error('read-only'))))
    await expect(settings.setDownloadFolder('/nope')).rejects.toThrow('read-only')
    await expect(settings.setDownloadFolder('   ')).rejects.toThrow('Enter a folder')
    expect(settings.downloadFolder.value).toBe('/home/me/Downloads')
    expect(await db.setting('download-folder')).toBeNull()
  })

  it('shows the web notice until it is dismissed, and remembers that', async () => {
    const db = memory()
    const settings = create(db)
    await settings.ready
    expect(settings.webNoticeDismissed.value).toBe(false)
    await settings.dismissWebNotice()
    expect(settings.webNoticeDismissed.value).toBe(true)

    const again = create(db)
    await again.ready
    expect(again.webNoticeDismissed.value).toBe(true)
  })

  it('remembers skipping setup', async () => {
    const db = memory()
    const settings = create(db)
    await settings.ready
    expect(settings.setupSkipped.value).toBe(false)
    await settings.skipSetup()
    const again = create(db)
    await again.ready
    expect(again.setupSkipped.value).toBe(true)
  })

  it('remembers which source to take, and ignores nonsense', async () => {
    const db = memory()
    const settings = create(db)
    await settings.ready
    expect(settings.bulkSource.value).toBe('first')
    await settings.setBulkSource('best')
    const again = create(db)
    await again.ready
    expect(again.bulkSource.value).toBe('best')

    await db.setSetting('bulk-copy', 'tenth')
    const odd = create(db)
    await odd.ready
    expect(odd.bulkSource.value).toBe('first')
  })

  it('hides the notice for now if dismissing it cannot be saved', async () => {
    const db = memory()
    db.setSetting = vi.fn(async () => Promise.reject(new Error('full')))
    const settings = create(db)
    await settings.ready
    await settings.dismissWebNotice()
    expect(settings.webNoticeDismissed.value).toBe(true)
  })

  it('shows the notice when settings cannot be loaded', async () => {
    const settings = createSettings(Promise.reject(new Error('blocked')), {
      systemFolder: async () => null,
      validate: async () => {},
    })
    await settings.ready.catch(() => {})
    expect(settings.webNoticeDismissed.value).toBe(false)
  })
})
