import { Show, For, createSignal, createEffect } from 'solid-js'

import { state, addToast } from '../lib/state'

import './SidebarSettings.css'

const RENDEZVOUS_URL_STORAGE_KEY = 'altair-vega:rendezvous-url'
const RENDEZVOUS_HISTORY_KEY = 'altair-vega:rendezvous-history'

/**
 * Compile-time default rendezvous URL.
 * Set via VITE_DEFAULT_RENDEZVOUS_URL env var at build time.
 * Falls back to empty string (meaning "same origin").
 */
const DEFAULT_RENDEZVOUS_URL = import.meta.env.VITE_DEFAULT_RENDEZVOUS_URL ?? ''

type RendezvousOption = 'same-origin' | 'webrtc-local' | 'custom'

function ChevronIcon(props: { open: boolean }) {
  return (
    <svg class={`sidebar-card__chevron ${props.open ? 'is-open' : ''}`} viewBox="0 0 20 20" aria-hidden="true">
      <path d="M7 8l3 3 3-3" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" />
    </svg>
  )
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M7 7.5h7.5v8H7zm-1.5 3H5V4.5h7.5V5" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="1.6" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.5 5.5h7m-6 0v6m2.5-6v6m2.5-6v6M5.5 5.5l.4-1.2h4.2l.4 1.2m-5.5 0 .4 7.2h4.2l.4-7.2" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.2" />
    </svg>
  )
}

function loadHistory(): string[] {
  try {
    const raw = window.localStorage.getItem(RENDEZVOUS_HISTORY_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((s: unknown) => typeof s === 'string' && s.length > 0) : []
  } catch {
    return []
  }
}

function saveHistory(urls: string[]) {
  // Never persist the default — it's always injected at render time
  const filtered = DEFAULT_RENDEZVOUS_URL
    ? urls.filter((u) => u !== DEFAULT_RENDEZVOUS_URL)
    : urls
  window.localStorage.setItem(RENDEZVOUS_HISTORY_KEY, JSON.stringify(filtered.slice(0, 10)))
}

/** Returns the full history list including the pinned default (if set). */
function fullHistory(): string[] {
  const user = loadHistory()
  if (!DEFAULT_RENDEZVOUS_URL) return user
  // Default always last, deduplicated
  return [...user.filter((u) => u !== DEFAULT_RENDEZVOUS_URL), DEFAULT_RENDEZVOUS_URL]
}

function addToHistory(url: string) {
  const history = loadHistory().filter((u) => u !== url)
  history.unshift(url)
  saveHistory(history)
}

function removeFromHistory(url: string) {
  if (url === DEFAULT_RENDEZVOUS_URL) return // pinned, cannot remove
  saveHistory(loadHistory().filter((u) => u !== url))
}

function validateWsUrl(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null
    return url.href
  } catch {
    // Try prepending wss:// if no protocol
    try {
      const url = new URL(`wss://${trimmed}`)
      if (url.protocol !== 'wss:') return null
      return url.href
    } catch {
      return null
    }
  }
}

function detectCurrentOption(): RendezvousOption {
  const stored = window.localStorage.getItem(RENDEZVOUS_URL_STORAGE_KEY)?.trim()
  if (!stored) return 'same-origin'
  // TODO: detect webrtc-local when backend supports it
  return 'custom'
}

function currentCustomUrl(): string {
  return window.localStorage.getItem(RENDEZVOUS_URL_STORAGE_KEY)?.trim() ?? ''
}

export default function SidebarSettings() {
  const [open, setOpen] = createSignal(false)
  const [copied, setCopied] = createSignal(false)
  const [selectedOption, setSelectedOption] = createSignal<RendezvousOption>(detectCurrentOption())
  const [customInput, setCustomInput] = createSignal(currentCustomUrl() || DEFAULT_RENDEZVOUS_URL)
  const [inputError, setInputError] = createSignal<string | null>(null)
  const [history, setHistory] = createSignal(fullHistory())

  const wasmStatus = () => {
    if (state.node) return 'Loaded'
    if (state.connectionState === 'starting') return 'Starting'
    return 'Unavailable'
  }

  const handleOptionChange = (option: RendezvousOption) => {
    setSelectedOption(option)
    setInputError(null)

    if (option === 'same-origin') {
      window.localStorage.removeItem(RENDEZVOUS_URL_STORAGE_KEY)
      addToast('info', 'Rendezvous set to same origin. Reload to apply.')
    } else if (option === 'webrtc-local') {
      // Placeholder: backend integration needed
      addToast('info', 'WebRTC local discovery is not yet available')
      setSelectedOption(detectCurrentOption()) // revert
    }
    // 'custom' just shows the input, doesn't apply until confirmed
    if (option === 'custom' && !customInput()) {
      setCustomInput(DEFAULT_RENDEZVOUS_URL)
    }
  }

  const handleApplyCustomUrl = () => {
    const validated = validateWsUrl(customInput())
    if (!validated) {
      setInputError('Enter a valid ws:// or wss:// URL')
      return
    }
    setInputError(null)
    window.localStorage.setItem(RENDEZVOUS_URL_STORAGE_KEY, validated)
    addToHistory(validated)
    setHistory(fullHistory())
    setCustomInput(validated)
    addToast('success', 'Rendezvous URL saved. Reload to apply.')
  }

  const handlePickHistory = (url: string) => {
    setCustomInput(url)
    setInputError(null)
    window.localStorage.setItem(RENDEZVOUS_URL_STORAGE_KEY, url)
    addToHistory(url)
    setHistory(fullHistory())
    addToast('success', 'Rendezvous URL saved. Reload to apply.')
  }

  const handleRemoveHistory = (url: string) => {
    removeFromHistory(url)
    setHistory(fullHistory())
  }

  const handleCopyEndpointId = async () => {
    if (!state.endpointId) return
    try {
      await navigator.clipboard.writeText(state.endpointId)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch (err) {
      addToast('error', `Copy failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const defaultLabel = () => {
    if (DEFAULT_RENDEZVOUS_URL) return `Same origin (default: ${DEFAULT_RENDEZVOUS_URL})`
    return 'Same origin'
  }

  return (
    <div class="sidebar-card">
      <button class="sidebar-card__header" type="button" onClick={() => setOpen(!open())}>
        <span class="sidebar-card__title">Settings</span>
        <ChevronIcon open={open()} />
      </button>

      <Show when={open()}>
        <div class="sidebar-card__body sidebar-settings__body">
          {/* Rendezvous URL selector */}
          <div class="sidebar-settings__section">
            <div class="sidebar-settings__label">Rendezvous Service</div>

            <div class="rendezvous-options" role="radiogroup" aria-label="Rendezvous service">
              <label class="rendezvous-option" classList={{ 'rendezvous-option--selected': selectedOption() === 'same-origin' }}>
                <input type="radio" name="rendezvous" class="rendezvous-radio" checked={selectedOption() === 'same-origin'} onChange={() => handleOptionChange('same-origin')} />
                <div class="rendezvous-option__content">
                  <span class="rendezvous-option__label">{defaultLabel()}</span>
                  <span class="rendezvous-option__desc">Connect via this server's built-in relay</span>
                </div>
              </label>

              <label class="rendezvous-option rendezvous-option--disabled" classList={{ 'rendezvous-option--selected': selectedOption() === 'webrtc-local' }}>
                <input type="radio" name="rendezvous" class="rendezvous-radio" checked={selectedOption() === 'webrtc-local'} onChange={() => handleOptionChange('webrtc-local')} />
                <div class="rendezvous-option__content">
                  <span class="rendezvous-option__label">Local network (WebRTC)</span>
                  <span class="rendezvous-option__desc">Discover peers on the same network</span>
                  <span class="pill pill-neutral">Coming soon</span>
                </div>
              </label>

              <label class="rendezvous-option" classList={{ 'rendezvous-option--selected': selectedOption() === 'custom' }}>
                <input type="radio" name="rendezvous" class="rendezvous-radio" checked={selectedOption() === 'custom'} onChange={() => handleOptionChange('custom')} />
                <div class="rendezvous-option__content">
                  <span class="rendezvous-option__label">Custom URL</span>
                  <span class="rendezvous-option__desc">Use a specific rendezvous server</span>
                </div>
              </label>
            </div>

            <Show when={selectedOption() === 'custom'}>
              <div class="rendezvous-custom">
                <div class="rendezvous-custom__input-row">
                  <input
                    type="text"
                    class="input rendezvous-custom__input"
                    classList={{ 'rendezvous-custom__input--error': inputError() !== null }}
                    placeholder="wss://example.com/__altair_vega_rendezvous"
                    value={customInput()}
                    onInput={(e) => { setCustomInput(e.currentTarget.value); setInputError(null) }}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleApplyCustomUrl() }}
                  />
                  <button class="btn btn-primary btn-sm" type="button" onClick={handleApplyCustomUrl}>Apply</button>
                </div>
                <Show when={inputError()}>
                  <div class="rendezvous-custom__error">{inputError()}</div>
                </Show>

                <Show when={history().length > 0}>
                  <div class="rendezvous-history">
                    <div class="rendezvous-history__label">Recent</div>
                    <For each={history()}>
                      {(url) => {
                        const isDefault = () => DEFAULT_RENDEZVOUS_URL && url === DEFAULT_RENDEZVOUS_URL
                        return (
                          <div class="rendezvous-history__item">
                            <button class="rendezvous-history__url" type="button" onClick={() => handlePickHistory(url)} title={url}>
                              {url}
                            </button>
                            <Show when={isDefault()}>
                              <span class="pill pill-neutral rendezvous-history__pin">Default</span>
                            </Show>
                            <Show when={!isDefault()}>
                              <button class="btn btn-ghost rendezvous-history__remove" type="button" onClick={() => handleRemoveHistory(url)} aria-label={`Remove ${url}`}>
                                <TrashIcon />
                              </button>
                            </Show>
                          </div>
                        )
                      }}
                    </For>
                  </div>
                </Show>
              </div>
            </Show>
          </div>

          {/* Debug info */}
          <div class="sidebar-settings__section">
            <div class="sidebar-settings__label">Endpoint ID</div>
            <div class="sidebar-settings__value sidebar-settings__value--mono">
              <code>{state.endpointId || 'Not assigned'}</code>
              <button class="btn btn-ghost btn-sm sidebar-settings__copy" type="button" onClick={() => void handleCopyEndpointId()} disabled={!state.endpointId}>
                <CopyIcon />
                {copied() ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>

          <div class="sidebar-settings__section">
            <div class="sidebar-settings__label">Status</div>
            <div class="sidebar-settings__value">{state.connectionState} / WASM: {wasmStatus()}</div>
          </div>
        </div>
      </Show>
    </div>
  )
}
