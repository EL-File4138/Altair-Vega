import { Check, Copy, Link, Loader2, RefreshCcw } from 'lucide-solid'
import { For, Show, createSignal, onCleanup, type JSX } from 'solid-js'
import { normalize_short_code } from 'altair-vega-browser'

import { state } from '../lib/state'
import { cx } from '../lib/cx'
import { Button, IconButton } from './ui/Button'
import { Card } from './ui/Card'

type CodeInputProps = {
  code: string
  onCodeChange: (code: string) => void
  onSubmit: (code: string) => void
  onGenerate: () => void
}

const connectionClass = 'flex shrink-0 select-none flex-col gap-[var(--space-2)] px-[var(--space-3)] pb-[var(--space-3)] pt-[var(--space-2)]'
const connectionHeaderClass = 'flex min-h-7 items-center justify-between gap-[var(--space-2)]'
const connectionLabelClass = 'text-[var(--color-text-secondary)] text-[length:var(--text-sm)] font-600 leading-[var(--leading-tight)]'
const connectionNewClass = [
  '!min-h-[24px] rounded-[var(--radius-full)] px-[7px] py-[2px]',
  'text-[length:0.72rem] leading-[var(--leading-tight)] [&_svg]:!h-[12px] [&_svg]:!w-[12px]',
].join(' ')
const connectionRowClass = [
  'grid min-w-0 grid-cols-[minmax(0,1fr)_32px] items-center gap-[var(--space-1)]',
  'border border-[var(--color-border)] rounded-[var(--radius-lg)]',
  'bg-[color-mix(in_srgb,var(--color-bg-muted)_72%,var(--color-bg))]',
  'p-[var(--space-1)] shadow-[inset_0_1px_0_color-mix(in_srgb,var(--color-surface)_58%,transparent)]',
].join(' ')
const connectionRowNoActionClass = 'grid-cols-[minmax(0,1fr)]'
const connectionCodeRowClass = [
  'grid min-w-0 grid-cols-[minmax(0,1fr)_32px] items-center gap-[var(--space-1)]',
  'border border-[var(--color-border)] rounded-[var(--radius-lg)]',
  'bg-[color-mix(in_srgb,var(--color-bg-muted)_72%,var(--color-bg))]',
  'p-[var(--space-1)] shadow-[inset_0_1px_0_color-mix(in_srgb,var(--color-surface)_58%,transparent)]',
].join(' ')
const connectionInputClass = [
  'h-[32px] min-h-[32px] min-w-0 border border-[var(--color-border-subtle)]',
  'rounded-[calc(var(--radius-lg)-4px)] bg-[color-mix(in_srgb,var(--color-surface-raised)_86%,var(--color-surface))]',
  'px-[var(--space-3)] py-0 text-[var(--color-text)] text-[length:0.78rem] font-650',
  '[font-family:var(--font-mono)] leading-[32px] outline-none shadow-[var(--shadow-sm)]',
  'transition-[background-color,border-color,box-shadow] duration-[var(--duration-fast)] ease-[var(--ease-out)]',
  'placeholder:[font-family:var(--font-sans)] placeholder:font-500 placeholder:text-[var(--color-text-muted)] placeholder:opacity-72',
  'focus:border-[var(--color-accent)] focus:shadow-[var(--shadow-sm),0_0_0_2px_var(--color-accent-subtle)]',
  'selection:bg-[var(--color-accent-subtle)]',
].join(' ')
const connectionActionClass = [
  'aspect-square !h-[32px] !min-h-[32px] !min-w-[32px] !w-[32px]',
  'rounded-[calc(var(--radius-lg)-4px)] [&_svg]:!h-[13px] [&_svg]:!w-[13px]',
].join(' ')
const connectionBusyIconClass = 'animate-spin'
const codeDisplayClass = [
  'min-h-[32px] min-w-0 cursor-text select-text overflow-x-auto whitespace-nowrap',
  'text-[length:0.72rem] leading-[32px] [font-family:var(--font-mono)]',
  '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
].join(' ')
const codeSegmentClass = [
  'inline-flex h-[32px] min-w-0 select-text items-center justify-center align-middle',
  'border border-[var(--color-border-subtle)] rounded-[calc(var(--radius-lg)-4px)]',
  'bg-[color-mix(in_srgb,var(--color-surface-raised)_86%,var(--color-surface))]',
  'px-[5px] font-650 text-[var(--color-text)] shadow-[var(--shadow-sm)]',
].join(' ')
const codeSlotSegmentClass = 'w-[43px]'
const codeWordSegmentClass = 'w-[52px]'
const codeSeparatorClass = [
  'inline-flex shrink-0 select-text items-center justify-center px-[2px] align-middle text-[var(--color-text-muted)] [font-family:var(--font-mono)]',
  'text-[length:0.7rem] font-700',
].join(' ')
const codeCopyClass = [
  'aspect-square !h-[32px] !min-h-[32px] !min-w-[32px] !w-[32px] rounded-[calc(var(--radius-lg)-4px)]',
  '!border-[var(--color-border-subtle)] !bg-[var(--color-surface-raised)]',
  'not-disabled:hover:!bg-[var(--color-surface)]',
  '[&_svg]:!h-[13px] [&_svg]:!w-[13px]',
].join(' ')
const codeCopyWrapClass = 'relative min-w-[32px]'
const codeCopySuccessClass = [
  '!border-[color-mix(in_srgb,var(--color-success)_26%,transparent)]',
  '!bg-[var(--color-success-subtle)] !text-[var(--color-success)]',
].join(' ')
const codeCopiedTipClass = [
  'pointer-events-none absolute bottom-[calc(100%+6px)] right-0 z-[2]',
  'rounded-[var(--radius-sm)] bg-[var(--color-success)] px-[var(--space-2)] py-[3px]',
  'text-white text-[length:0.68rem] font-650 leading-[var(--leading-tight)] shadow-[var(--shadow-sm)]',
  'animate-[fade-in_var(--duration-fast)_var(--ease-out)]',
].join(' ')

const CODE_SEGMENT_INDEXES = [0, 1, 2, 3] as const

function normalizeCode(rawCode: string) {
  if (!rawCode.trim()) return null

  try {
    return normalize_short_code(rawCode)
  } catch {
    return null
  }
}

function codeSegments(code: string) {
  const normalized = normalizeCode(code)
  return normalized ? normalized.split('-').slice(0, 4) : []
}

function copyWithCommand(text: string) {
  let copied = false
  const handleCopyEvent = (event: ClipboardEvent) => {
    event.clipboardData?.setData('text/plain', text)
    event.preventDefault()
    copied = true
  }

  document.addEventListener('copy', handleCopyEvent)
  try {
    return document.execCommand('copy') && copied
  } finally {
    document.removeEventListener('copy', handleCopyEvent)
  }
}

function copyWithTextarea(text: string) {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.left = '0'
  textarea.style.top = '0'
  textarea.style.width = '1px'
  textarea.style.height = '1px'
  textarea.style.opacity = '0'
  textarea.style.pointerEvents = 'none'
  document.body.appendChild(textarea)
  textarea.focus({ preventScroll: true })
  textarea.select()
  textarea.setSelectionRange(0, text.length)

  try {
    return document.execCommand('copy')
  } finally {
    textarea.remove()
  }
}

async function copyText(text: string) {
  if (copyWithCommand(text)) return
  if (copyWithTextarea(text)) return

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  throw new Error('Clipboard unavailable')
}

export default function CodeInput(props: CodeInputProps) {
  const [isEditingCode, setIsEditingCode] = createSignal(false)
  const [copied, setCopied] = createSignal(false)
  let inputRef: HTMLInputElement | undefined
  let copiedTimer = 0

  const normalizedCode = () => normalizeCode(props.code)
  const displayedSegments = () => codeSegments(props.code)
  const hasInput = () => props.code.trim().length > 0
  const isBusy = () => state.connectionState === 'starting' || state.connectionState === 'connecting' || state.connectionState === 'reconnecting'
  const isCurrentRoomCode = () => Boolean(normalizedCode() && normalizedCode() === state.roomCode)
  const showCodeDisplay = () => Boolean(!isEditingCode() && normalizedCode() && state.roomCode && normalizedCode() === state.roomCode)
  const canSubmit = () => Boolean(state.node && normalizedCode() && !isBusy())

  const handleInput: JSX.EventHandlerUnion<HTMLInputElement, InputEvent> = (event) => {
    props.onCodeChange(event.currentTarget.value)
  }

  const handleSubmit = () => {
    const normalized = normalizedCode()
    if (!normalized || isBusy()) return
    props.onSubmit(normalized)
    setIsEditingCode(false)
  }

  const startEditingCode = () => {
    setIsEditingCode(true)
    queueMicrotask(() => {
      inputRef?.focus()
      inputRef?.select()
    })
  }

  const handleCopy = async () => {
    const normalized = normalizedCode()
    if (!normalized) return
    try {
      await copyText(normalized)
      setCopied(true)
      if (copiedTimer) window.clearTimeout(copiedTimer)
      copiedTimer = window.setTimeout(() => {
        setCopied(false)
        copiedTimer = 0
      }, 2400)
    } catch {
      setCopied(false)
    }
  }

  const handleGenerate = () => {
    props.onGenerate()
  }

  const handleKeyDown: JSX.EventHandlerUnion<HTMLInputElement, KeyboardEvent> = (event) => {
    if (event.key !== 'Enter') return
    handleSubmit()
    event.preventDefault()
  }

  onCleanup(() => {
    if (copiedTimer) window.clearTimeout(copiedTimer)
  })

  return (
    <Card class={connectionClass}>
      <div class={connectionHeaderClass}>
        <label class={connectionLabelClass} for="connection-code">
          Connection
        </label>

        <Button type="button" class={connectionNewClass} variant="secondary" size="sm" onClick={handleGenerate}>
          <RefreshCcw size={14} />
          New
        </Button>
      </div>

      <Show
        when={showCodeDisplay()}
        fallback={
          <div class={cx(connectionRowClass, !hasInput() && connectionRowNoActionClass)}>
            <input
              id="connection-code"
              ref={(element) => {
                inputRef = element
              }}
              class={connectionInputClass}
              autocomplete="off"
              autocapitalize="off"
              spellcheck={false}
              value={props.code}
              placeholder="Use code to connect a peer"
              onInput={handleInput}
              onKeyDown={handleKeyDown}
            />

            {hasInput() && (
              <IconButton
                class={connectionActionClass}
                variant="default"
                label={isBusy() && isCurrentRoomCode() ? 'Connecting' : 'Connect'}
                onClick={handleSubmit}
                disabled={!canSubmit()}
              >
                {isBusy() && isCurrentRoomCode() ? <Loader2 class={connectionBusyIconClass} size={14} /> : <Link size={14} />}
              </IconButton>
            )}
          </div>
        }
      >
        <div class={connectionCodeRowClass}>
          <div
            class={codeDisplayClass}
            title={normalizedCode() ?? undefined}
            role="button"
            tabindex="0"
            aria-label="Edit connection code"
            onClick={startEditingCode}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              startEditingCode()
            }}
          >
            <For each={CODE_SEGMENT_INDEXES}>
              {(index) => (
                <>
                  <span
                    class={cx(codeSegmentClass, index === 0 ? codeSlotSegmentClass : codeWordSegmentClass)}
                  >
                    {displayedSegments()[index]}
                  </span>
                  <Show when={index < 3}>
                    <span class={codeSeparatorClass} aria-hidden="true">-</span>
                  </Show>
                </>
              )}
            </For>
          </div>

          <div class={codeCopyWrapClass}>
            <IconButton
              class={cx(codeCopyClass, copied() && codeCopySuccessClass)}
              variant="ghost"
              label={copied() ? 'Connection code copied' : 'Copy connection code'}
              onClick={(event) => {
                event.stopPropagation()
                void handleCopy()
              }}
              disabled={!normalizedCode()}
            >
              {copied() ? <Check size={14} /> : <Copy size={14} />}
            </IconButton>
            <Show when={copied()}>
              <span class={codeCopiedTipClass} role="status" aria-live="polite">Copied</span>
            </Show>
          </div>
        </div>
      </Show>
    </Card>
  )
}
