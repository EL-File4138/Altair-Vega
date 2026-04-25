import { Show, createSignal, createEffect, onCleanup } from 'solid-js'

import { formatBytes, formatPercent, joinChunks, isImageMime, isSafeToOpen } from '../lib/format'
import { loadReceivedFileChunks, loadReceivedFileManifest } from '../lib/storage'
import { addToast } from '../lib/state'
import type { ChatMessage } from '../lib/types'
import ImageViewer from './ImageViewer'

import './FileCard.css'

type FileCardProps = {
  direction: 'sent' | 'received'
  fileTransfer?: NonNullable<ChatMessage['fileTransfer']>
  file?: NonNullable<ChatMessage['fileTransfer']>
}

export default function FileCard(props: FileCardProps) {
  const [downloading, setDownloading] = createSignal(false)
  const [imageUrl, setImageUrl] = createSignal<string | null>(null)
  const [viewerOpen, setViewerOpen] = createSignal(false)
  const ft = () => props.fileTransfer ?? props.file!

  const isReceived = () => props.direction === 'received'
  const isCompleted = () => ft().completed
  const isImage = () => isImageMime(ft().mimeType)
  const progressPercent = () => formatPercent(ft().bytesComplete, ft().sizeBytes)
  const hashPrefix = () => ft().hashHex.slice(0, 8)

  // Build image preview URL (sent via blobUrl, received from IndexedDB)
  createEffect(async () => {
    if (!isImage()) return
    const blob = ft().blobUrl
    if (blob) { setImageUrl(blob); return }
    if (isReceived() && isCompleted()) {
      try {
        const url = await buildBlobUrl()
        if (url) setImageUrl(url)
      } catch { /* fall back to generic icon */ }
    }
  })

  onCleanup(() => {
    const url = imageUrl()
    // Only revoke URLs we created from IndexedDB, not blobUrls from sender
    if (url && !ft().blobUrl) URL.revokeObjectURL(url)
  })

  /** Build a blob URL from IndexedDB for received files */
  const buildBlobUrl = async (): Promise<string | null> => {
    const manifest = await loadReceivedFileManifest(ft().storageKey)
    if (!manifest) return null
    const chunks = await loadReceivedFileChunks(ft().storageKey)
    const bytes = joinChunks(chunks, manifest.sizeBytes)
    const blob = new Blob([new Uint8Array(bytes).buffer], {
      type: manifest.mimeType || ft().mimeType,
    })
    return URL.createObjectURL(blob)
  }

  /** Resolve a usable blob URL for the file */
  const resolveUrl = async (): Promise<string | null> => {
    // Sent files always have a blobUrl
    if (ft().blobUrl) return ft().blobUrl!
    // Received files: build from IndexedDB
    if (isReceived()) return buildBlobUrl()
    return null
  }

  /** Open: images → lightbox, safe types → new tab, others → download */
  const handleOpen = async () => {
    if (!isCompleted()) return
    const mime = ft().mimeType

    if (isImage()) {
      if (!imageUrl()) {
        const url = await resolveUrl()
        if (url) setImageUrl(url)
      }
      if (imageUrl()) {
        setViewerOpen(true)
      } else {
        addToast('warning', 'Image not available for preview')
      }
      return
    }

    const url = await resolveUrl()
    if (!url) {
      addToast('warning', 'File not available')
      return
    }

    if (isSafeToOpen(mime)) {
      window.open(url, '_blank', 'noopener,noreferrer')
    } else {
      triggerDownload(url, ft().name)
    }
  }

  const handleDownload = async () => {
    if (!isCompleted() || downloading()) return
    setDownloading(true)
    try {
      const url = await resolveUrl()
      if (!url) return
      triggerDownload(url, ft().name)
    } finally {
      setDownloading(false)
    }
  }

  const clickable = () => isCompleted()

  return (
    <>
      <article
        class={`file-card ${isImage() ? 'file-card--image' : ''} ${clickable() ? 'file-card--clickable' : ''}`}
        onClick={() => { if (clickable()) void handleOpen() }}
        role={clickable() ? 'button' : undefined}
        tabIndex={clickable() ? 0 : undefined}
        onKeyDown={(e: KeyboardEvent) => {
          if (clickable() && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault()
            void handleOpen()
          }
        }}
      >
        <Show
          when={isImage() && imageUrl()}
          fallback={
            <div class="file-card-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M7 3.75h7l4.25 4.25v12.25a1.5 1.5 0 0 1-1.5 1.5h-9.5a1.5 1.5 0 0 1-1.5-1.5v-15a1.5 1.5 0 0 1 1.5-1.5Z" />
                <path d="M14 3.75V8h4.25" />
                <path d="M8.5 12.25h7" />
                <path d="M8.5 15.75h7" />
              </svg>
            </div>
          }
        >
          <img src={imageUrl()!} alt={ft().name} class="file-card-image" loading="lazy" />
        </Show>

        <div class="file-card-body">
          <div class="file-card-header">
            <div class="file-card-name" title={ft().name}>{ft().name}</div>
            <div class="file-card-size">{formatBytes(ft().sizeBytes)}</div>
          </div>

          <Show when={props.direction === 'sent' && isCompleted()}>
            <div class="file-card-status file-card-status-sent">
              <span class="file-card-check" aria-hidden="true">✓</span>
              <span>Sent</span>
            </div>
          </Show>

          <Show when={!isCompleted()}>
            <div class="file-card-progress-wrap">
              <div class="progress-bar" aria-hidden="true">
                <div class="progress-bar-fill" style={{ width: progressPercent() }} />
              </div>
              <div class="file-card-progress-meta">
                <span>{formatBytes(ft().bytesComplete)} of {formatBytes(ft().sizeBytes)}</span>
                <span>{progressPercent()}</span>
              </div>
              <span class="pill pill-warning">{isReceived() ? 'Incomplete' : 'Sending'}</span>
            </div>
          </Show>

          <Show when={isReceived() && isCompleted()}>
            <div class="file-card-actions">
              <button
                type="button"
                class="btn btn-subtle"
                onClick={(e) => { e.stopPropagation(); void handleDownload() }}
                disabled={downloading()}
              >
                {downloading() ? 'Preparing...' : 'Download'}
              </button>
              <span class="file-card-hash" title={ft().hashHex}>#{hashPrefix()}</span>
            </div>
          </Show>
        </div>
      </article>

      <Show when={viewerOpen() && imageUrl()}>
        <ImageViewer
          src={imageUrl()!}
          alt={ft().name}
          onClose={() => setViewerOpen(false)}
        />
      </Show>
    </>
  )
}

function triggerDownload(url: string, filename: string) {
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
}
