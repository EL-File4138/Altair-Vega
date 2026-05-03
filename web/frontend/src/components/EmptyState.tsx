import { Show, type JSX } from 'solid-js'

import './EmptyState.css'

type EmptyStateProps = {
  icon?: JSX.Element
  message: string
  submessage?: string
  variant?: 'default' | 'compact'
}

export default function EmptyState(props: EmptyStateProps) {
  return (
    <div class={`empty-state ${props.variant === 'compact' ? 'empty-state--compact' : ''}`} role="status" aria-live="polite">
      <Show when={props.icon}>
        <span class="empty-state-icon" aria-hidden="true">{props.icon}</span>
      </Show>
      <p class="empty-state-message">{props.message}</p>
      <Show when={props.submessage}>
        <p class="empty-state-submessage">{props.submessage}</p>
      </Show>
    </div>
  )
}
