import { For, Show, createSignal } from 'solid-js'
import { CheckCircle2, ChevronDown, Download, Files, Loader2, Trash2 } from 'lucide-solid'

import { formatBytes, formatRelative, joinChunks } from '../lib/format'
import { peerName } from '../lib/identity'
import { loadReceivedFileChunks, loadReceivedFileManifest, deleteReceivedFile, clearAllStoredFiles } from '../lib/storage'
import { removeReceivedFile, setReceivedFiles, state, addToast } from '../lib/state'

import './SidebarFiles.css'

export default function SidebarFiles() {
  const [open, setOpen] = createSignal(false)
  const [busyKey, setBusyKey] = createSignal<string | null>(null)

  const sortedFiles = () => [...state.receivedFiles].sort((a, b) => b.storedAt - a.storedAt)
  const fileCount = () => state.receivedFiles.length

  const handleDownload = async (storageKey: string) => {
    setBusyKey(`dl:${storageKey}`)
    try {
      const manifest = await loadReceivedFileManifest(storageKey)
      const file = manifest ?? state.receivedFiles.find((e) => e.storageKey === storageKey)
      if (!file || !file.completed) { addToast('warning', 'File not ready'); return }
      const chunks = await loadReceivedFileChunks(storageKey)
      const bytes = joinChunks(chunks, file.sizeBytes)
      const blob = new Blob([new Uint8Array(bytes).buffer], { type: file.mimeType || 'application/octet-stream' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = file.name; a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      addToast('error', `Download failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally { setBusyKey(null) }
  }

  const handleRemove = async (storageKey: string) => {
    setBusyKey(`rm:${storageKey}`)
    try {
      await deleteReceivedFile(storageKey)
      removeReceivedFile(storageKey)
    } catch (err) {
      addToast('error', `Remove failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally { setBusyKey(null) }
  }

  const handleClearAll = async () => {
    setBusyKey('clear-all')
    try {
      await clearAllStoredFiles()
      setReceivedFiles([])
      addToast('success', 'All stored files cleared')
    } catch (err) {
      addToast('error', `Clear failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally { setBusyKey(null) }
  }

  return (
    <div class="sidebar-card">
      <button class="sidebar-card__header" type="button" onClick={() => setOpen(!open())}>
        <span class="sidebar-card__title">
          <Files size={15} />
          Files
          <Show when={fileCount() > 0}>
            <span class="sidebar-card__badge">{fileCount()}</span>
          </Show>
        </span>
        <ChevronDown class={`sidebar-card__chevron ${open() ? 'is-open' : ''}`} size={16} />
      </button>

      <Show when={open()}>
        <div class="sidebar-card__body">
          <Show
            when={sortedFiles().length > 0}
            fallback={<div class="sidebar-files__empty">No files received yet</div>}
          >
            <div class="sidebar-files__list">
              <For each={sortedFiles()}>
                {(file) => (
                    <div class="sidebar-files__item">
                      <div class="sidebar-files__name" title={file.name}>{file.name}</div>
                      <div class="sidebar-files__meta">
                        <span>{peerName(file.endpointId)}</span>
                        <span>{formatBytes(file.sizeBytes)}</span>
                        <span>{formatRelative(file.storedAt)}</span>
                      </div>
                      <div class="sidebar-files__actions">
                        <span class={`sidebar-files__status ${file.completed ? 'sidebar-files__status--complete' : 'sidebar-files__status--partial'}`}>
                          {file.completed ? <CheckCircle2 size={14} /> : <Loader2 class="sidebar-files__status-spin" size={14} />}
                          {file.completed ? 'Complete' : 'Partial'}
                        </span>
                        <button class="btn btn-subtle btn-sm" type="button" disabled={!file.completed || busyKey() !== null} onClick={() => void handleDownload(file.storageKey)}>
                          <Download size={14} /> Download
                        </button>
                      <button class="btn btn-ghost btn-sm" type="button" disabled={busyKey() !== null} onClick={() => void handleRemove(file.storageKey)}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                )}
              </For>
            </div>

            <div class="sidebar-files__footer">
              <button class="btn btn-ghost btn-sm sidebar-files__clear-all" type="button" disabled={busyKey() !== null} onClick={() => void handleClearAll()}>
                <Trash2 size={14} /> Clear all files
              </button>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  )
}
