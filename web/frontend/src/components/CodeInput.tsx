import { createEffect, createSignal, onMount, type JSX } from 'solid-js'
import { normalize_short_code } from 'altair-vega-browser'

import './CodeInput.css'

type CodeInputProps = {
  code: string
  onCodeChange: (code: string) => void
  onSubmit: (code: string) => void
  onGenerate: () => void
}

type SegmentIndex = 0 | 1 | 2 | 3

const EMPTY_SEGMENTS = ['', '', '', '']

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
  const [lastSubmitted, setLastSubmitted] = createSignal('')
  const inputRefs: Array<HTMLInputElement | undefined> = []

  let syncingFromProps = false

  const syncFromCode = (code: string) => {
    syncingFromProps = true
    setSegments(parseSegments(code))
    setLastSubmitted('')
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
    setLastSubmitted(normalized)
    props.onCodeChange(normalized)
    props.onSubmit(normalized)
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
    await navigator.clipboard.writeText(normalized)
  }

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

    const normalized = getNormalizedCode(currentSegments)
    if (!normalized) {
      if (lastSubmitted()) setLastSubmitted('')
      return
    }

    if (normalized === lastSubmitted()) return

    setLastSubmitted(normalized)
    props.onSubmit(normalized)
  })

  return (
    <section class="code-input card">
      <label class="code-input-label" for="connection-code-slot">
        Connection Code
      </label>

      <div class="code-input-group" role="group" aria-label="Connection code">
        <div class={`code-input-segment ${focusedIndex() === 0 ? 'is-focused' : ''}`}>
          <input
            id="connection-code-slot"
            ref={(el) => {
              inputRefs[0] = el
            }}
            class="code-input-field"
            inputmode="numeric"
            autocomplete="off"
            autocapitalize="off"
            spellcheck={false}
            placeholder="0000"
            value={segments()[0]}
            onInput={(event) => handleSegmentInput(0, event.currentTarget.value)}
            onPaste={handlePaste}
            onFocus={() => setFocusedIndex(0)}
            onBlur={() => setFocusedIndex(null)}
          />
        </div>

        <span class="code-input-separator" aria-hidden="true">-</span>

        <div class={`code-input-segment ${focusedIndex() === 1 ? 'is-focused' : ''}`}>
          <input
            ref={(el) => {
              inputRefs[1] = el
            }}
            class="code-input-field"
            inputmode="text"
            autocomplete="off"
            autocapitalize="off"
            spellcheck={false}
            placeholder="word"
            value={segments()[1]}
            onInput={(event) => handleSegmentInput(1, event.currentTarget.value)}
            onPaste={handlePaste}
            onFocus={() => setFocusedIndex(1)}
            onBlur={() => setFocusedIndex(null)}
          />
        </div>

        <span class="code-input-separator" aria-hidden="true">-</span>

        <div class={`code-input-segment ${focusedIndex() === 2 ? 'is-focused' : ''}`}>
          <input
            ref={(el) => {
              inputRefs[2] = el
            }}
            class="code-input-field"
            inputmode="text"
            autocomplete="off"
            autocapitalize="off"
            spellcheck={false}
            placeholder="word"
            value={segments()[2]}
            onInput={(event) => handleSegmentInput(2, event.currentTarget.value)}
            onPaste={handlePaste}
            onFocus={() => setFocusedIndex(2)}
            onBlur={() => setFocusedIndex(null)}
          />
        </div>

        <span class="code-input-separator" aria-hidden="true">-</span>

        <div class={`code-input-segment ${focusedIndex() === 3 ? 'is-focused' : ''}`}>
          <input
            ref={(el) => {
              inputRefs[3] = el
            }}
            class="code-input-field"
            inputmode="text"
            autocomplete="off"
            autocapitalize="off"
            spellcheck={false}
            placeholder="word"
            value={segments()[3]}
            onInput={(event) => handleSegmentInput(3, event.currentTarget.value)}
            onPaste={handlePaste}
            onFocus={() => setFocusedIndex(3)}
            onBlur={() => setFocusedIndex(null)}
          />
        </div>
      </div>

      <div class="code-input-actions">
        <button type="button" class="btn btn-subtle" onClick={props.onGenerate}>
          New code
        </button>
        <button
          type="button"
          class="btn btn-ghost"
          onClick={handleCopy}
          disabled={!getNormalizedCode(segments())}
        >
          Copy
        </button>
      </div>
    </section>
  )
}
