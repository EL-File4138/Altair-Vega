import './ConnectionStatus.css'

import { state } from '../lib/state'

const CONNECTION_STATUS_META = {
  starting: {
    label: 'Starting...',
    pillClass: 'pill-neutral',
    dotClass: 'status-dot-neutral',
  },
  ready: {
    label: 'Ready',
    pillClass: 'pill-neutral',
    dotClass: 'status-dot-neutral',
  },
  connecting: {
    label: 'Connecting...',
    pillClass: 'pill-neutral',
    dotClass: 'status-dot-neutral status-dot-pulse',
  },
  connected: {
    label: 'Connected',
    pillClass: 'pill-success',
    dotClass: 'status-dot-success',
  },
  reconnecting: {
    label: 'Reconnecting...',
    pillClass: 'pill-warning',
    dotClass: 'status-dot-warning status-dot-pulse',
  },
  fallback: {
    label: 'Local only',
    pillClass: 'pill-warning',
    dotClass: 'status-dot-warning',
  },
  disconnected: {
    label: 'Disconnected',
    pillClass: 'pill-danger',
    dotClass: 'status-dot-danger',
  },
  error: {
    label: 'Error',
    pillClass: 'pill-danger',
    dotClass: 'status-dot-danger',
  },
} as const

export default function ConnectionStatus() {
  const meta = () => CONNECTION_STATUS_META[state.connectionState]

  return (
    <span class={`pill connection-status ${meta().pillClass}`} aria-live="polite">
      <span class={`status-dot ${meta().dotClass}`} aria-hidden="true" />
      <span>{meta().label}</span>
    </span>
  )
}
