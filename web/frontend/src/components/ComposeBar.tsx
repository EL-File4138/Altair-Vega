import { Show, createEffect, createSignal, onCleanup } from 'solid-js'

import { formatBytes, isImageMime } from '../lib/format'
import type { MessageRenderMode } from '../lib/message-format'
import { state } from '../lib/state'

import './ComposeBar.css'

type ComposeBarProps = {
  onSendMessage: (text: string, mode: MessageRenderMode) => void
  onSendFile: (file: File) => void
}

export default function ComposeBar(props: ComposeBarProps) {
  const [text, setText] = createSignal('')
  const [attachedFile, setAttachedFile] = createSignal<File | null>(null)
  const [previewUrl, setPreviewUrl] = createSignal<string | null>(null)
  const [dragDepth, setDragDepth] = createSignal(0)
  const [messageMode, setMessageMode] = createSignal<MessageRenderMode>('plain')

  let textareaRef: HTMLTextAreaElement | undefined
  let fileInputRef: HTMLInputElement | undefined

  const canSend = () => Boolean(state.selectedPeerId) && (text().trim().length > 0 || attachedFile() !== null)
  const attachedIsImage = () => {
    const f = attachedFile()
    return f !== null && isImageMime(f.type)
  }
  const isDraggingFile = () => dragDepth() > 0
  const selectedPeer = () => state.peers.find((peer) => peer.endpointId === state.selectedPeerId)
  const selectedPeerType = () => selectedPeer()?.peerType
  const modeSwitchDisabled = () => selectedPeerType() !== 'browser-web'

  const effectiveMessageMode = (): MessageRenderMode => {
    return modeSwitchDisabled() ? 'plain' : messageMode()
  }

  const cycleMessageMode = () => {
    if (modeSwitchDisabled()) return
    const current = messageMode()
    if (current === 'plain') setMessageMode('markdown')
    else if (current === 'markdown') setMessageMode('raw')
    else setMessageMode('plain')
  }

  const resizeTextarea = () => {
    const textarea = textareaRef
    if (!textarea) return
    textarea.style.height = '0px'
    const lineHeight = Number.parseFloat(window.getComputedStyle(textarea).lineHeight) || 24
    const maxHeight = lineHeight * 4
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden'
  }

  const revokePreview = () => {
    const url = previewUrl()
    if (url) URL.revokeObjectURL(url)
    setPreviewUrl(null)
  }

  const attachFile = (file: File) => {
    revokePreview()
    setAttachedFile(file)
    if (isImageMime(file.type)) {
      setPreviewUrl(URL.createObjectURL(file))
    }
  }

  const clearAttachment = () => {
    revokePreview()
    setAttachedFile(null)
    if (fileInputRef) fileInputRef.value = ''
  }

  const clearComposer = () => {
    setText('')
    clearAttachment()
  }

  onCleanup(revokePreview)

  const handleSubmit = () => {
    if (!canSend()) return
    const trimmed = text().trim()
    const file = attachedFile()
    if (trimmed) props.onSendMessage(trimmed, effectiveMessageMode())
    if (file) props.onSendFile(file)
    clearComposer()
  }

  const handleFileChange = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0] ?? null
    if (file) attachFile(file)
  }

  const hasDraggedFiles = (event: DragEvent) => {
    return Array.from(event.dataTransfer?.types ?? []).includes('Files')
  }

  const handleDragEnter = (event: DragEvent) => {
    if (!state.selectedPeerId || !hasDraggedFiles(event)) return
    event.preventDefault()
    setDragDepth((value) => value + 1)
  }

  const handleDragOver = (event: DragEvent) => {
    if (!state.selectedPeerId || !hasDraggedFiles(event)) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  }

  const handleDragLeave = (event: DragEvent) => {
    if (!state.selectedPeerId || !hasDraggedFiles(event)) return
    event.preventDefault()
    setDragDepth((value) => Math.max(0, value - 1))
  }

  const handleDrop = (event: DragEvent) => {
    if (!state.selectedPeerId || !hasDraggedFiles(event)) return
    event.preventDefault()
    setDragDepth(0)
    const file = event.dataTransfer?.files?.[0]
    if (file) attachFile(file)
  }

  const handlePaste = (event: ClipboardEvent) => {
    const items = event.clipboardData?.items
    if (!items) return
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item.kind === 'file' && isImageMime(item.type)) {
        event.preventDefault()
        const file = item.getAsFile()
        if (file) {
          const ext = item.type.split('/')[1] || 'png'
          const named = new File([file], `pasted-image.${ext}`, { type: file.type })
          attachFile(named)
        }
        return
      }
    }
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' || event.shiftKey) return
    event.preventDefault()
    handleSubmit()
  }

  createEffect(() => {
    text()
    queueMicrotask(resizeTextarea)
  })

  return (
    <div
      class={`compose-bar ${!state.selectedPeerId ? 'is-disabled' : ''} ${isDraggingFile() ? 'is-dragging-file' : ''}`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <Show when={!state.selectedPeerId}>
        <div class="compose-bar-hint">Select a peer to start</div>
      </Show>
      <Show when={state.selectedPeerId && isDraggingFile()}>
        <div class="compose-bar-hint compose-bar-drop-hint">Drop to attach file</div>
      </Show>

      <div class="compose-bar-shell">
        <input
          ref={fileInputRef}
          class="sr-only"
          type="file"
          accept="*/*"
          onChange={handleFileChange}
          tabIndex={-1}
        />

        <button
          type="button"
          class="btn btn-subtle btn-icon compose-bar-attach"
          onClick={() => fileInputRef?.click()}
          disabled={!state.selectedPeerId}
          aria-label="Attach file"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 11.5 12.8 19.7a5 5 0 0 1-7.1-7.1L14.6 3.7a3.5 3.5 0 0 1 5 5l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.4-8.4" />
          </svg>
        </button>

        <div class="compose-bar-input-wrap">
          <Show when={attachedFile()}>
            {(file) => (
              <Show
                when={attachedIsImage() && previewUrl()}
                fallback={
                  <div class="compose-bar-chip">
                    <span class="compose-bar-chip-name" title={file().name}>{file().name}</span>
                    <span class="compose-bar-chip-size">{formatBytes(file().size)}</span>
                    <button type="button" class="compose-bar-chip-remove" onClick={clearAttachment} aria-label="Remove attached file">×</button>
                  </div>
                }
              >
                <div class="compose-bar-image-preview">
                  <img src={previewUrl()!} alt={file().name} class="compose-bar-image-thumb" />
                  <div class="compose-bar-image-info">
                    <span class="compose-bar-chip-name" title={file().name}>{file().name}</span>
                    <span class="compose-bar-chip-size">{formatBytes(file().size)}</span>
                  </div>
                  <button type="button" class="compose-bar-chip-remove" onClick={clearAttachment} aria-label="Remove attached image">×</button>
                </div>
              </Show>
            )}
          </Show>

          <div class="compose-bar-text-row">
            <textarea
              ref={textareaRef}
              class="compose-bar-textarea"
              rows={1}
              value={text()}
              placeholder={state.selectedPeerId ? 'Write a message' : 'Select a peer to start'}
              disabled={!state.selectedPeerId}
              onInput={(event) => setText(event.currentTarget.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
            />

            <button
              type="button"
              class="compose-bar-mode"
              onClick={cycleMessageMode}
              disabled={!state.selectedPeerId || modeSwitchDisabled()}
              aria-label={`Message mode: ${effectiveMessageMode()}`}
              title={
                !state.selectedPeerId
                  ? 'Select a peer first'
                  : modeSwitchDisabled()
                    ? 'Formatting modes are browser-only'
                    : `Message mode: ${messageMode()}`
              }
            >
              <Show
                when={effectiveMessageMode() === 'plain'}
                fallback={
                  <Show
                    when={effectiveMessageMode() === 'markdown'}
                    fallback={
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <polyline points="9 8 4 12 9 16" />
                        <polyline points="15 8 20 12 15 16" />
                      </svg>
                    }
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <line x1="8" y1="5" x2="6" y2="19" />
                      <line x1="14" y1="5" x2="12" y2="19" />
                      <line x1="4" y1="10" x2="18" y2="10" />
                      <line x1="3" y1="14" x2="17" y2="14" />
                    </svg>
                  </Show>
                }
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <line x1="5" y1="8" x2="19" y2="8" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <line x1="5" y1="16" x2="13" y2="16" />
                </svg>
              </Show>
            </button>
          </div>
        </div>

        <button
          type="button"
          class="compose-bar-send"
          onClick={handleSubmit}
          disabled={!canSend()}
          aria-label="Send"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 18V6" />
            <path d="m7 11 5-5 5 5" />
          </svg>
        </button>
      </div>
    </div>
  )
}
