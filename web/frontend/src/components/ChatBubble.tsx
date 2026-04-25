import type { ChatMessage } from '../lib/types'
import { formatTime } from '../lib/format'
import { peerName } from '../lib/identity'

import FileCard from './FileCard'

import './ChatBubble.css'

type ChatBubbleProps = {
  message: ChatMessage
}

export default function ChatBubble(props: ChatBubbleProps) {
  const isSent = () => props.message.direction === 'sent'

  return (
    <article
      class="chat-bubble-row"
      classList={{ 'chat-bubble-row-sent': isSent(), 'chat-bubble-row-received': !isSent() }}
    >
      <div
        class="chat-bubble"
        classList={{ 'chat-bubble-sent': isSent(), 'chat-bubble-received': !isSent() }}
      >
        <header class="chat-bubble-meta">
          <span class="chat-bubble-peer">{peerName(props.message.peerEndpointId)}</span>
          <span class="chat-bubble-time">{formatTime(props.message.timestamp)}</span>
        </header>

        {props.message.variant === 'text' ? (
          <p class="chat-bubble-text">{props.message.text ?? ''}</p>
        ) : (
          <div class="chat-bubble-file">
            <FileCard file={props.message.fileTransfer!} direction={props.message.direction} />
          </div>
        )}
      </div>
    </article>
  )
}
