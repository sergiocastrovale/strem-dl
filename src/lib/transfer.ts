/** What the desktop's download engine needs to know. See src-tauri/src/transfers.rs. */
export interface TransferJob {
  id: string
  url: string
  fallbackName: string
  /** Where to save a new download. Unused once filePath is known. */
  folder: string | null
  filePath: string | null
  validator: string | null
  /** `media`: a stream, saved with yt-dlp. See src-tauri/src/media.rs. */
  mode: 'file' | 'media'
  referer: string | null
  userAgent: string | null
  /** Name it fallbackName, because the address says nothing useful. */
  exactName: boolean
}

export type TransferEvent =
  | {
      kind: 'started'
      id: string
      filePath: string
      total: number | null
      validator: string | null
      done: number
      /** Had bytes to continue from, but the server made it start over. */
      restarted: boolean
    }
  | { kind: 'progress'; id: string; done: number; total: number | null; speed: number }
  | { kind: 'stage'; id: string; stage: string }
  | { kind: 'finished'; id: string; filePath: string; done: number }
  | { kind: 'paused'; id: string; done: number }
  | {
      kind: 'failed'
      id: string
      done: number
      error: string
      /** The link stopped working. Finding it again might fix this. */
      expired: boolean
    }

/** Something a page's player loaded. See src-tauri/src/capture.rs. */
export interface CaptureFind {
  url: string
  via: string
  contentType: string | null
  duration: number | null
  width: number | null
  referer: string
  userAgent: string | null
}

export type CaptureEvent = ({ kind: 'found'; id: string } & CaptureFind) | { kind: 'closed'; id: string }

export interface TransferEngine {
  start(job: TransferJob): Promise<void>
  pause(id: string): Promise<void>
  /** Stops it and deletes the partial file. Never touches a finished one. */
  cancel(id: string, filePath: string | null): Promise<void>
  listen(handler: (event: TransferEvent) => void): Promise<void>
  /** Whether yt-dlp understands this page. */
  probe(url: string): Promise<boolean>
  captureOpen(id: string, url: string, visible: boolean): Promise<void>
  captureShow(id: string): Promise<void>
  captureClose(id: string): Promise<void>
  captureListen(handler: (event: CaptureEvent) => void): Promise<void>
}
