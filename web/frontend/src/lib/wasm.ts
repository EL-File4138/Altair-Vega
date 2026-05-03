import type { WasmBrowserNode } from 'altair-vega-browser'
import type { BrowserEvent, RawBrowserEvent, PersistedReceivedFile, PersistedReceivedFileChunk } from './types'
import { makeStorageKey } from './format'
import { loadReceivedFileManifest, loadReceivedChunk, storeReceivedChunk, storeReceivedManifest } from './storage'

export async function spawnNode(): Promise<WasmBrowserNode> {
  const { WasmBrowserNode } = await import('altair-vega-browser')
  return WasmBrowserNode.spawn()
}

export function normalizeBrowserEvent(event: RawBrowserEvent): BrowserEvent {
  const endpointId = event.endpointId ?? event.endpoint_id ?? ''
  switch (event.type) {
    case 'ready':
      return { type: 'ready', endpointId }
    case 'receivedMessage':
      return { type: 'receivedMessage', endpointId, body: event.body ?? '' }
    case 'sentMessage':
      return { type: 'sentMessage', endpointId, body: event.body ?? '' }
    case 'receivedFileChunk':
      return {
        type: 'receivedFileChunk',
        endpointId,
        transferId: event.transferId ?? event.transfer_id ?? 0,
        chunkIndex: event.chunkIndex ?? event.chunk_index ?? 0,
        name: event.name ?? 'received.bin',
        sizeBytes: event.sizeBytes ?? event.size_bytes ?? 0,
        chunkSizeBytes: event.chunkSizeBytes ?? event.chunk_size_bytes ?? 0,
        chunkBytes: event.chunkBytes ?? event.chunk_bytes ?? 0,
        bytesComplete: event.bytesComplete ?? event.bytes_complete ?? 0,
        hashHex: event.hashHex ?? event.hash_hex ?? '',
        mimeType: event.mimeType ?? event.mime_type ?? 'application/octet-stream',
      }
    case 'receivedFileCompleted':
      return {
        type: 'receivedFileCompleted',
        endpointId,
        transferId: event.transferId ?? event.transfer_id ?? 0,
        name: event.name ?? 'received.bin',
        sizeBytes: event.sizeBytes ?? event.size_bytes ?? 0,
        chunkSizeBytes: event.chunkSizeBytes ?? event.chunk_size_bytes ?? 0,
        hashHex: event.hashHex ?? event.hash_hex ?? '',
        mimeType: event.mimeType ?? event.mime_type ?? 'application/octet-stream',
      }
    case 'sentFile':
      return {
        type: 'sentFile',
        endpointId,
        transferId: event.transferId ?? event.transfer_id ?? 0,
        name: event.name ?? 'sent.bin',
        sizeBytes: event.sizeBytes ?? event.size_bytes ?? 0,
      }
    case 'sentFileChunk':
      return {
        type: 'sentFileChunk',
        endpointId,
        transferId: event.transferId ?? event.transfer_id ?? 0,
        chunkIndex: event.chunkIndex ?? event.chunk_index ?? 0,
        name: event.name ?? 'sent.bin',
        sizeBytes: event.sizeBytes ?? event.size_bytes ?? 0,
        chunkSizeBytes: event.chunkSizeBytes ?? event.chunk_size_bytes ?? 0,
        chunkBytes: event.chunkBytes ?? event.chunk_bytes ?? 0,
        bytesComplete: event.bytesComplete ?? event.bytes_complete ?? 0,
        hashHex: event.hashHex ?? event.hash_hex ?? '',
        mimeType: event.mimeType ?? event.mime_type ?? 'application/octet-stream',
      }
    case 'error':
      return { type: 'error', message: event.message ?? 'Unknown browser event error' }
    default:
      return { type: 'error', message: `Unknown browser event type: ${String(event.type)}` }
  }
}

export async function persistReceivedChunk(
  event: Extract<BrowserEvent, { type: 'receivedFileChunk' }>,
  node: WasmBrowserNode,
): Promise<PersistedReceivedFile> {
  const bytes = node.take_received_chunk(BigInt(event.transferId), BigInt(event.chunkIndex))
  const stableBytes = new Uint8Array(bytes.byteLength)
  stableBytes.set(bytes)

  const storageKey = makeStorageKey(event.endpointId, event.hashHex)
  const existing = await loadReceivedFileManifest(storageKey)
  const existingChunk = await loadReceivedChunk(storageKey, event.chunkIndex)
  const bytesComplete = (existing?.bytesComplete ?? 0) + (existingChunk ? 0 : event.chunkBytes)
  const record: PersistedReceivedFile = {
    storageKey,
    transferId: event.transferId,
    endpointId: event.endpointId,
    name: event.name,
    sizeBytes: event.sizeBytes,
    bytesComplete,
    chunkSizeBytes: event.chunkSizeBytes,
    hashHex: event.hashHex,
    mimeType: event.mimeType,
    storedAt: existing?.storedAt ?? Date.now(),
    completed: bytesComplete >= event.sizeBytes,
  }
  const chunk: PersistedReceivedFileChunk = {
    chunkKey: `${storageKey}:${event.chunkIndex}`,
    storageKey,
    chunkIndex: event.chunkIndex,
    chunkBytes: event.chunkBytes,
    bytes: stableBytes.buffer.slice(0),
  }
  await storeReceivedChunk(record, chunk)
  return record
}

export async function markReceivedFileCompleted(
  event: Extract<BrowserEvent, { type: 'receivedFileCompleted' }>,
): Promise<PersistedReceivedFile> {
  const storageKey = makeStorageKey(event.endpointId, event.hashHex)
  const existing = await loadReceivedFileManifest(storageKey)
  const record: PersistedReceivedFile = {
    storageKey,
    transferId: event.transferId,
    endpointId: event.endpointId,
    name: event.name,
    sizeBytes: event.sizeBytes,
    bytesComplete: event.sizeBytes,
    chunkSizeBytes: event.chunkSizeBytes,
    hashHex: event.hashHex,
    mimeType: event.mimeType,
    storedAt: existing?.storedAt ?? Date.now(),
    completed: true,
  }
  await storeReceivedManifest(record)
  return record
}
