export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

export function formatRelative(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  return `${Math.floor(seconds / 3600)}h ago`
}

export function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function chunkCount(sizeBytes: number, chunkSizeBytes: number): number {
  if (sizeBytes === 0) return 0
  return Math.ceil(sizeBytes / chunkSizeBytes)
}

export function fullMissingRanges(sizeBytes: number, chunkSizeBytes: number) {
  const totalChunks = chunkCount(sizeBytes, chunkSizeBytes)
  return totalChunks === 0 ? [] : [{ start: 0, end: totalChunks }]
}

export function parseChunkLimit(value: string): number | null {
  const parsed = Number(value.trim())
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null
}

export function limitMissingRanges(
  ranges: Array<{ start: number; end: number }>,
  limit: number | null,
) {
  if (!limit) return ranges

  const result: Array<{ start: number; end: number }> = []
  let remaining = limit
  for (const range of ranges) {
    if (remaining <= 0) break
    const span = range.end - range.start
    if (span <= remaining) {
      result.push(range)
      remaining -= span
      continue
    }
    result.push({ start: range.start, end: range.start + remaining })
    break
  }
  return result
}

export function joinChunks(chunks: Array<{ bytes: ArrayBuffer }>, totalSize: number): Uint8Array {
  const result = new Uint8Array(totalSize)
  let offset = 0
  for (const chunk of chunks) {
    const bytes = new Uint8Array(chunk.bytes)
    result.set(bytes, offset)
    offset += bytes.byteLength
  }
  return result
}

export function makeStorageKey(endpointId: string, hashHex: string): string {
  return `${endpointId}:${hashHex}`
}

export function makeChunkKey(storageKey: string, chunkIndex: number): string {
  return `${storageKey}:${chunkIndex}`
}

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function formatPercent(bytesComplete: number, sizeBytes: number): string {
  if (sizeBytes === 0) return '100%'
  return `${Math.round((bytesComplete / sizeBytes) * 100)}%`
}

export function isImageMime(mimeType: string): boolean {
  return mimeType.startsWith('image/')
}

/** Types safe to open inline in a new tab (not executable in browser context) */
const SAFE_OPEN_MIMES = new Set([
  'application/pdf',
  'text/plain',
  'text/csv',
  'text/markdown',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'video/mp4',
  'video/webm',
  'video/ogg',
])

/** Returns true if the mime type is safe to open in a new tab */
export function isSafeToOpen(mimeType: string): boolean {
  if (mimeType.startsWith('image/')) return true
  if (SAFE_OPEN_MIMES.has(mimeType)) return true
  if (mimeType.startsWith('audio/') || mimeType.startsWith('video/')) return true
  return false
}

export function createObjectUrlFromFile(file: File): string {
  return URL.createObjectURL(file)
}
