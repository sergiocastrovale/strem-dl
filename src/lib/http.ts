import { platformFetch } from './platform'

const TIMEOUT_MS = 30_000
const HEADERS_TIMEOUT_MS = 10_000

/**
 * The response headers of a link, without downloading it. Some servers refuse
 * HEAD, so those get a GET that's dropped once the headers are in. Null if neither
 * works, which includes browsers blocking the request.
 */
export async function fetchHeaders(url: string): Promise<Headers | null> {
  const attempts: RequestInit[] = [{ method: 'HEAD' }, { method: 'GET', headers: { Range: 'bytes=0-0' } }]
  for (const init of attempts) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), HEADERS_TIMEOUT_MS)
    try {
      const response = await platformFetch(url, { ...init, signal: controller.signal })
      if (response.ok) return response.headers
    } catch {
      // Try the next way; the caller only needs to know if none worked.
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }
  return null
}

/** GET a JSON document, failing with a short message that the tree can display. */
export async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error('timed out'))
    }, TIMEOUT_MS)
  })

  const request = async () => {
    const response = await platformFetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const text = await response.text()
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new Error('not valid JSON')
    }
  }

  try {
    return await Promise.race([request(), timeout])
  } finally {
    clearTimeout(timer)
  }
}
