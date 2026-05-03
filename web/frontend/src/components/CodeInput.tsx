import { For, Show, createEffect, createSignal, onCleanup, onMount, type JSX } from 'solid-js'
import qrcode from 'qrcode-generator'
import { Check, Copy, Link2, QrCode, RefreshCcw } from 'lucide-solid'

import { addToast, state } from '../lib/state'
import { normalize_short_code } from '../lib/short-code'

import './CodeInput.css'

type CodeInputProps = {
  code: string
  onCodeChange: (code: string) => void
  onSubmit: (code: string) => void
  onGenerate: () => void
}

type SegmentIndex = 0 | 1 | 2 | 3

const EMPTY_SEGMENTS = ['', '', '', '']
const SEGMENT_PLACEHOLDERS = ['0000', 'word', 'word', 'word']
const SEGMENT_INDEXES: SegmentIndex[] = [0, 1, 2, 3]

function copyWithCommand(text: string) {
  if (!document.queryCommandSupported?.('copy')) return false

  const selection = window.getSelection()
  const previousRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null
  const range = document.createRange()
  const span = document.createElement('span')
  span.textContent = text
  span.style.position = 'fixed'
  span.style.top = '0'
  span.style.left = '0'
  span.style.whiteSpace = 'pre'
  span.style.opacity = '0'
  document.body.appendChild(span)
  range.selectNodeContents(span)
  selection?.removeAllRanges()
  selection?.addRange(range)

  let copied = false
  try {
    copied = document.execCommand('copy')
  } finally {
    selection?.removeAllRanges()
    if (previousRange) selection?.addRange(previousRange)
    span.remove()
  }

  return copied
}

function copyWithTextarea(text: string) {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.readOnly = true
  textarea.style.position = 'fixed'
  textarea.style.top = '0'
  textarea.style.left = '0'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  textarea.setSelectionRange(0, textarea.value.length)

  let copied = false
  try {
    copied = document.execCommand('copy')
  } finally {
    textarea.remove()
  }

  return copied
}

async function copyText(text: string) {
  if (copyWithCommand(text)) return
  if (copyWithTextarea(text)) return
  await navigator.clipboard.writeText(text)
}

function sanitizeSlot(value: string) {
  return value.replace(/\D/g, '').slice(0, 4)
}

function sanitizeWord(value: string) {
  return value.replace(/[^a-z]/gi, '').toLowerCase().slice(0, 5)
}

function parseSegments(code: string) {
  if (!code.trim()) return [...EMPTY_SEGMENTS]

  try {
    return normalize_short_code(code).split('-').slice(0, 4)
  } catch {
    const parts = code.split('-', 4)
    return [
      sanitizeSlot(parts[0] ?? ''),
      sanitizeWord(parts[1] ?? ''),
      sanitizeWord(parts[2] ?? ''),
      sanitizeWord(parts[3] ?? ''),
    ]
  }
}

function joinPartial(segments: string[]) {
  let lastFilledIndex = -1
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (segments[index].length > 0) {
      lastFilledIndex = index
      break
    }
  }
  if (lastFilledIndex < 0) return ''
  return segments.slice(0, lastFilledIndex + 1).join('-')
}

function joinFull(segments: string[]) {
  return segments.join('-')
}

function getNormalizedCode(segments: string[]) {
  if (!segments[0] || !segments[1] || !segments[2] || !segments[3]) return null

  try {
    return normalize_short_code(joinFull(segments))
  } catch {
    return null
  }
}

export default function CodeInput(props: CodeInputProps) {
  const [segments, setSegments] = createSignal([...EMPTY_SEGMENTS])
  const [focusedIndex, setFocusedIndex] = createSignal<SegmentIndex | null>(null)
  const [copied, setCopied] = createSignal(false)
  const [linkCopied, setLinkCopied] = createSignal(false)
  const [showQr, setShowQr] = createSignal(false)
  const inputRefs: Array<HTMLInputElement | undefined> = []

  let syncingFromProps = false
  let copiedTimer = 0
  let linkCopiedTimer = 0

  const syncFromCode = (code: string) => {
    syncingFromProps = true
    setSegments(parseSegments(code))
    queueMicrotask(() => {
      syncingFromProps = false
    })
  }

  const focusNext = (index: SegmentIndex) => {
    inputRefs[index + 1]?.focus()
    inputRefs[index + 1]?.select()
  }

  const handleSegmentInput = (index: SegmentIndex, rawValue: string) => {
    const value = index === 0 ? sanitizeSlot(rawValue) : sanitizeWord(rawValue)
    const nextSegments = [...segments()]
    nextSegments[index] = value
    setSegments(nextSegments)

    const maxLength = index === 0 ? 4 : 5
    if (value.length === maxLength && index < 3) {
      focusNext(index)
    }
  }

  const handleFullCodePaste = async (rawCode: string) => {
    let normalized: string
    try {
      normalized = normalize_short_code(rawCode)
    } catch {
      return false
    }

    const nextSegments = normalized.split('-').slice(0, 4)
    setSegments(nextSegments)
    props.onCodeChange(normalized)
    inputRefs[3]?.focus()
    inputRefs[3]?.select()
    return true
  }

  const handlePaste: JSX.EventHandlerUnion<HTMLInputElement, ClipboardEvent> = async (event) => {
    const rawCode = event.currentTarget.value + event.clipboardData?.getData('text/plain')
    if (!(await handleFullCodePaste(rawCode.trim()))) return
    event.preventDefault()
  }

  const handleCopy = async () => {
    const normalized = getNormalizedCode(segments())
    if (!normalized) return
    try {
      await copyText(normalized)
      setCopied(true)
      if (copiedTimer) window.clearTimeout(copiedTimer)
      copiedTimer = window.setTimeout(() => {
        setCopied(false)
        copiedTimer = 0
      }, 1200)
    } catch (err) {
      addToast('error', `Copy failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const directLink = () => {
    const normalized = getNormalizedCode(segments())
    if (!normalized) return null
    const url = new URL(window.location.href)
    url.searchParams.set('code', normalized)
    return url.toString()
  }

  const qrDataUrl = () => {
    const link = directLink()
    if (!link) return null
    const qr = qrcode(0, 'M')
    qr.addData(link)
    qr.make()
    return qr.createDataURL(5, 2)
  }

  const handleCopyLink = async () => {
    const link = directLink()
    if (!link) return
    try {
      await copyText(link)
      setLinkCopied(true)
      if (linkCopiedTimer) window.clearTimeout(linkCopiedTimer)
      linkCopiedTimer = window.setTimeout(() => {
        setLinkCopied(false)
        linkCopiedTimer = 0
      }, 1200)
    } catch (err) {
      addToast('error', `Link copy failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const handleConnect = () => {
    const normalized = getNormalizedCode(segments())
    if (!normalized || !state.node || !state.endpointId) return
    props.onSubmit(normalized)
  }

  const canConnect = () => Boolean(getNormalizedCode(segments()) && state.node && state.endpointId)

  onMount(() => {
    syncFromCode(props.code)
  })

  createEffect(() => {
    syncFromCode(props.code)
  })

  createEffect(() => {
    const currentSegments = segments()
    if (syncingFromProps) return

    const partialCode = joinPartial(currentSegments)
    props.onCodeChange(partialCode)
  })

  onCleanup(() => {
    if (copiedTimer) window.clearTimeout(copiedTimer)
    if (linkCopiedTimer) window.clearTimeout(linkCopiedTimer)
  })

  const displayCode = () => getNormalizedCode(segments()) ?? joinPartial(segments())

  return (
    <section class="code-input card">
      <div class="code-input-header">
        <label class="code-input-label" for="connection-code-slot">
          Connection Code
        </label>
        <div class="code-input-primary-actions">
          <button type="button" class="btn btn-subtle" onClick={props.onGenerate}>
            <RefreshCcw size={12} />
            New
          </button>
          <button
            type="button"
            class="btn btn-primary"
            onClick={handleConnect}
            disabled={!canConnect()}
          >
            Connect
          </button>
        </div>
      </div>

      <div class="code-input-row">
        <div class="code-input-group" role="group" aria-label="Connection code">
          <div class="code-input-display" title={displayCode()} onClick={() => inputRefs[0]?.focus()}>
            <For each={SEGMENT_INDEXES}>
              {(index) => (
                <>
                  <span class={`code-input-segment ${focusedIndex() === index ? 'is-focused' : ''} ${!segments()[index] ? 'is-placeholder' : ''}`}>
                    <input
                      id={index === 0 ? 'connection-code-slot' : undefined}
                      ref={(el) => {
                        inputRefs[index] = el
                      }}
                      class="code-input-field"
                      inputmode={index === 0 ? 'numeric' : 'text'}
                      autocomplete="off"
                      autocapitalize="off"
                      spellcheck={false}
                      placeholder={SEGMENT_PLACEHOLDERS[index]}
                      value={segments()[index]}
                      onInput={(event) => handleSegmentInput(index, event.currentTarget.value)}
                      onPaste={handlePaste}
                      onFocus={() => setFocusedIndex(index)}
                      onBlur={() => setFocusedIndex(null)}
                    />
                  </span>
                  <Show when={index < 3}>
                    <span class="code-input-separator" aria-hidden="true">-</span>
                  </Show>
                </>
              )}
            </For>
          </div>
        </div>
        <button
          type="button"
          class={`btn btn-ghost btn-icon code-input-copy ${copied() ? 'is-copied' : ''}`}
          onClick={handleCopy}
          disabled={!getNormalizedCode(segments())}
          aria-label={copied() ? 'Connection code copied' : 'Copy connection code'}
          title={copied() ? 'Connection code copied' : 'Copy connection code'}
        >
          {copied() ? <Check size={14} /> : <Copy size={14} />}
        </button>
        <Show when={copied()}>
          <span class="code-input-copied-tip" role="status" aria-live="polite">Copied</span>
        </Show>
      </div>

      <div class="code-input-share-actions">
        <button
          type="button"
          class={`btn btn-ghost ${linkCopied() ? 'is-copied' : ''}`}
          onClick={() => void handleCopyLink()}
          disabled={!directLink()}
          aria-label={linkCopied() ? 'Connection link copied' : 'Copy connection link'}
          title={linkCopied() ? 'Connection link copied' : 'Copy connection link'}
        >
          <Link2 size={14} />
          {linkCopied() ? 'Link copied' : 'Copy link'}
        </button>
        <button
          type="button"
          class="btn btn-ghost"
          onClick={() => setShowQr((open) => !open)}
          disabled={!qrDataUrl()}
          aria-expanded={showQr()}
          aria-controls="code-input-qr-panel"
        >
          <QrCode size={14} />
          {showQr() ? 'Hide QR' : 'Show QR'}
        </button>
      </div>

      <Show when={showQr() && qrDataUrl()}>
        <div id="code-input-qr-panel" class="code-input-qr-panel">
          <img src={qrDataUrl()!} alt="QR code for connection link" class="code-input-qr-image" />
        </div>
      </Show>
    </section>
  )
}
