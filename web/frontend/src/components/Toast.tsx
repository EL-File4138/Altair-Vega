import { For, createEffect, createSignal, onCleanup } from 'solid-js'

import { dismissToast, state } from '../lib/state'

import './Toast.css'

type VisibleToast = {
  id: string
  type: 'info' | 'success' | 'warning' | 'error'
  text: string
  timestamp: number
  closing?: boolean
}

const EXIT_DELAY_MS = 180

function toastColorClass(type: VisibleToast['type']) {
  if (type === 'success') return 'toast-card--success'
  if (type === 'warning') return 'toast-card--warning'
  if (type === 'error') return 'toast-card--error'
  return 'toast-card--info'
}

function ToastIcon(props: { type: VisibleToast['type'] }) {
  if (props.type === 'success') {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M4.5 10.5 8 14l7.5-8" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" />
      </svg>
    )
  }

  if (props.type === 'warning') {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M10 3.5 17 16.5H3L10 3.5Z" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="1.6" />
        <path d="M10 7.5v4" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.8" />
        <circle cx="10" cy="14" r="1" fill="currentColor" />
      </svg>
    )
  }

  if (props.type === 'error') {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.6" />
        <path d="M7.5 7.5l5 5m0-5-5 5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.8" />
      </svg>
    )
  }

  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.6" />
      <path d="M10 9v4" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.8" />
      <circle cx="10" cy="6.2" r="1" fill="currentColor" />
    </svg>
  )
}

export default function Toast() {
  const [visibleToasts, setVisibleToasts] = createSignal<VisibleToast[]>([])
  const exitTimers = new Map<string, number>()

  createEffect(() => {
    const next = [...state.toasts].slice(-3).reverse()
    const nextIds = new Set(next.map((toast) => toast.id))

    setVisibleToasts((current) => {
      const closing = current.filter((toast) => !nextIds.has(toast.id))

      for (const toast of closing) {
        if (exitTimers.has(toast.id)) continue
        const timer = window.setTimeout(() => {
          setVisibleToasts((items) => items.filter((item) => item.id !== toast.id))
          exitTimers.delete(toast.id)
        }, EXIT_DELAY_MS)
        exitTimers.set(toast.id, timer)
      }

      return [
        ...next.map((toast) => ({ ...toast, closing: false })),
        ...closing.map((toast) => ({ ...toast, closing: true })),
      ]
    })
  })

  onCleanup(() => {
    for (const timer of exitTimers.values()) {
      window.clearTimeout(timer)
    }
  })

  return (
    <div class="toast-stack" aria-live="polite" aria-atomic="false">
      <For each={visibleToasts()}>
        {(toast) => (
          <div class={`toast-card ${toastColorClass(toast.type)}${toast.closing ? ' toast-card--closing' : ''}`} role="status">
            <div class="toast-card__icon" aria-hidden="true">
              <ToastIcon type={toast.type} />
            </div>
            <div class="toast-card__text">{toast.text}</div>
            <button class="btn btn-ghost btn-icon toast-card__dismiss" type="button" onClick={() => dismissToast(toast.id)} aria-label="Dismiss notification">
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="M6 6l8 8m0-8-8 8" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.8" />
              </svg>
            </button>
          </div>
        )}
      </For>
    </div>
  )
}
