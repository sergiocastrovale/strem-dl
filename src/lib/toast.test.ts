import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { showToast, TOAST_MS, toastMessage } from './toast'

describe('toast', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('goes away by itself', () => {
    showToast('Link copied')
    expect(toastMessage.value).toBe('Link copied')
    vi.advanceTimersByTime(TOAST_MS)
    expect(toastMessage.value).toBe('')
  })

  it('a new one replaces the current one, and gets its full time', () => {
    showToast('First')
    vi.advanceTimersByTime(TOAST_MS - 1)
    showToast('Second')
    vi.advanceTimersByTime(TOAST_MS - 1)
    expect(toastMessage.value).toBe('Second')
    vi.advanceTimersByTime(1)
    expect(toastMessage.value).toBe('')
  })
})
