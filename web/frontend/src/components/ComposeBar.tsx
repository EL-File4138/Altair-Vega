import { Show, createEffect, createSignal, onCleanup } from 'solid-js'

import { formatBytes, isImageMime } from '../lib/format'
import { state } from '../lib/state'

import './ComposeBar.css'

type ComposeBarProps = {
  onSendMessage: (text: string) => void
  onSendFile: (file: File) => void
}

export default function ComposeBar(props: ComposeBarProps) {
  const [text, setText] = createSignal('')
  const [attachedFile, setAttachedFile] = createSignal<File | null>(null)
  const [previewUrl, setPreviewUrl] = createSignal<string | null>(null)

  let textareaRef: HTMLTextAreaElement | undefined
  let fileInputRef: HTMLInputElement | undefined

  const canSend = () => Boolean(state.selectedPeerId) && (text().trim().length > 0 || attachedFile() !== null)
  const attachedIsImage = () => {
    const f = attachedFile()
    return f !== null && isImageMime(f.type)
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
    if (trimmed) props.onSendMessage(trimmed)
    if (file) props.onSendFile(file)
    clearComposer()
  }

  const handleFileChange = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0] ?? null
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
    <div class={`compose-bar ${!state.selectedPeerId ? 'is-disabled' : ''}`}>
      <Show when={!state.selectedPeerId}>
        <div class="compose-bar-hint">Select a peer to start</div>
      </Show>

      <div class="compose-bar-shell">
        <input
          ref={fileInputRef}
          class="sr-only"
          type="file"
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
