import { Show } from 'solid-js'

import './EmptyState.css'

type EmptyStateProps = {
  message: string
  submessage?: string
}

export default function EmptyState(props: EmptyStateProps) {
  return (
    <div class="empty-state" role="status" aria-live="polite">
      <p class="empty-state-message">{props.message}</p>
      <Show when={props.submessage}>
        <p class="empty-state-submessage">{props.submessage}</p>
      </Show>
    </div>
  )
}
