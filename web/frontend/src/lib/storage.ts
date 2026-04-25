import type { PersistedReceivedFile, PersistedReceivedFileChunk } from './types'
import { makeChunkKey, chunkCount } from './format'

const STORAGE_DB_NAME = 'altair-vega-web'
const STORAGE_DB_VERSION = 2
const RECEIVED_FILE_STORE = 'received-files'
const RECEIVED_FILE_CHUNK_STORE = 'received-file-chunks'

function openStorage(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(STORAGE_DB_NAME, STORAGE_DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(RECEIVED_FILE_STORE)) {
        db.createObjectStore(RECEIVED_FILE_STORE, { keyPath: 'storageKey' })
      }
      if (!db.objectStoreNames.contains(RECEIVED_FILE_CHUNK_STORE)) {
        const chunkStore = db.createObjectStore(RECEIVED_FILE_CHUNK_STORE, {
          keyPath: 'chunkKey',
        })
        chunkStore.createIndex('storageKey', 'storageKey', { unique: false })
      }
    }
    request.onerror = () => reject(request.error ?? new Error('failed to open IndexedDB'))
    request.onsuccess = () => resolve(request.result)
  })
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
    request.onsuccess = () => resolve(request.result)
  })
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
  })
}

export async function listReceivedFiles(): Promise<PersistedReceivedFile[]> {
  const db = await openStorage()
  const tx = db.transaction(RECEIVED_FILE_STORE, 'readonly')
  const store = tx.objectStore(RECEIVED_FILE_STORE)
  const rows = await requestToPromise<PersistedReceivedFile[]>(store.getAll())
  await transactionDone(tx)
  return rows.sort((a, b) => a.storedAt - b.storedAt)
}

export async function loadReceivedFileManifest(storageKey: string): Promise<PersistedReceivedFile | null> {
  const db = await openStorage()
  const tx = db.transaction(RECEIVED_FILE_STORE, 'readonly')
  const store = tx.objectStore(RECEIVED_FILE_STORE)
  const row = await requestToPromise<PersistedReceivedFile | undefined>(store.get(storageKey))
  await transactionDone(tx)
  return row ?? null
}

export async function storeReceivedManifest(record: PersistedReceivedFile): Promise<void> {
  const db = await openStorage()
  const tx = db.transaction(RECEIVED_FILE_STORE, 'readwrite')
  tx.objectStore(RECEIVED_FILE_STORE).put(record)
  await transactionDone(tx)
}

export async function storeReceivedChunk(
  record: PersistedReceivedFile,
  chunk: PersistedReceivedFileChunk,
): Promise<void> {
  const db = await openStorage()
  const tx = db.transaction([RECEIVED_FILE_STORE, RECEIVED_FILE_CHUNK_STORE], 'readwrite')
  tx.objectStore(RECEIVED_FILE_STORE).put(record)
  tx.objectStore(RECEIVED_FILE_CHUNK_STORE).put(chunk)
  await transactionDone(tx)
}

export async function loadReceivedFileChunks(storageKey: string): Promise<PersistedReceivedFileChunk[]> {
  const db = await openStorage()
  const tx = db.transaction(RECEIVED_FILE_CHUNK_STORE, 'readonly')
  const store = tx.objectStore(RECEIVED_FILE_CHUNK_STORE)
  const index = store.index('storageKey')
  const rows = await requestToPromise<PersistedReceivedFileChunk[]>(index.getAll(storageKey))
  await transactionDone(tx)
  return rows.sort((a, b) => a.chunkIndex - b.chunkIndex)
}

export async function loadReceivedChunk(
  storageKey: string,
  chunkIndex: number,
): Promise<PersistedReceivedFileChunk | null> {
  const db = await openStorage()
  const tx = db.transaction(RECEIVED_FILE_CHUNK_STORE, 'readonly')
  const store = tx.objectStore(RECEIVED_FILE_CHUNK_STORE)
  const row = await requestToPromise<PersistedReceivedFileChunk | undefined>(
    store.get(makeChunkKey(storageKey, chunkIndex)),
  )
  await transactionDone(tx)
  return row ?? null
}

export async function deleteReceivedFile(storageKey: string): Promise<void> {
  const db = await openStorage()
  const tx = db.transaction([RECEIVED_FILE_STORE, RECEIVED_FILE_CHUNK_STORE], 'readwrite')
  tx.objectStore(RECEIVED_FILE_STORE).delete(storageKey)
  const chunkStore = tx.objectStore(RECEIVED_FILE_CHUNK_STORE)
  const index = chunkStore.index('storageKey')
  const rows = await requestToPromise<PersistedReceivedFileChunk[]>(index.getAll(storageKey))
  for (const row of rows) {
    chunkStore.delete(row.chunkKey)
  }
  await transactionDone(tx)
}

export async function getResumeInfo(
  storageKey: string,
  sizeBytes: number,
  chunkSizeBytes: number,
): Promise<{ localBytes: number; missingRanges: Array<{ start: number; end: number }> }> {
  const manifest = await loadReceivedFileManifest(storageKey)
  if (!manifest) {
    return {
      localBytes: 0,
      missingRanges: chunkCount(sizeBytes, chunkSizeBytes) === 0
        ? []
        : [{ start: 0, end: chunkCount(sizeBytes, chunkSizeBytes) }],
    }
  }

  const chunks = await loadReceivedFileChunks(storageKey)
  const present = new Set(chunks.map((chunk) => chunk.chunkIndex))
  const totalChunks = chunkCount(sizeBytes, chunkSizeBytes)
  const missingRanges: Array<{ start: number; end: number }> = []
  let rangeStart: number | null = null
  for (let index = 0; index < totalChunks; index += 1) {
    if (!present.has(index)) {
      rangeStart ??= index
      continue
    }
    if (rangeStart != null) {
      missingRanges.push({ start: rangeStart, end: index })
      rangeStart = null
    }
  }
  if (rangeStart != null) {
    missingRanges.push({ start: rangeStart, end: totalChunks })
  }
  return {
    localBytes: manifest.bytesComplete,
    missingRanges,
  }
}

export async function clearAllStoredFiles(): Promise<void> {
  const db = await openStorage()
  const tx = db.transaction([RECEIVED_FILE_STORE, RECEIVED_FILE_CHUNK_STORE], 'readwrite')
  tx.objectStore(RECEIVED_FILE_STORE).clear()
  tx.objectStore(RECEIVED_FILE_CHUNK_STORE).clear()
  await transactionDone(tx)
}
