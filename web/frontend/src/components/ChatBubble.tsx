import type { ChatMessage } from '../lib/types'
import { formatTime } from '../lib/format'
import { peerName } from '../lib/identity'
import { decodeMessageBody } from '../lib/message-format'
import { Check, Copy } from 'lucide-solid'
import { createMemo, createSignal, onCleanup } from 'solid-js'
import DOMPurify from 'dompurify'
import { marked } from 'marked'

import FileCard from './FileCard'

import './ChatBubble.css'

type ChatBubbleProps = {
  message: ChatMessage
}

export default function ChatBubble(props: ChatBubbleProps) {
  const isSent = () => props.message.direction === 'sent'
  const [rawCopied, setRawCopied] = createSignal(false)
  let rawCopiedTimer = 0

  const decodedText = createMemo(() => decodeMessageBody(props.message.text ?? ''))
  const markdownHtml = createMemo(() => {
    const parsed = marked.parse(decodedText().text, {
      gfm: true,
      breaks: false,
    }) as string
    return DOMPurify.sanitize(parsed)
  })

  const handleCopyRaw = async () => {
    try {
      await navigator.clipboard.writeText(decodedText().text)
      setRawCopied(true)
      if (rawCopiedTimer) window.clearTimeout(rawCopiedTimer)
      rawCopiedTimer = window.setTimeout(() => {
        setRawCopied(false)
        rawCopiedTimer = 0
      }, 1200)
    } catch {
      setRawCopied(false)
    }
  }

  onCleanup(() => {
    if (rawCopiedTimer) window.clearTimeout(rawCopiedTimer)
  })

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
          decodedText().mode === 'markdown' ? (
            <div class="chat-bubble-markdown" innerHTML={markdownHtml()} />
          ) : decodedText().mode === 'raw' ? (
            <section class="chat-bubble-raw-card">
              <header class="chat-bubble-raw-head">
                <span class="chat-bubble-raw-label">raw</span>
                <button
                  type="button"
                  class="chat-bubble-raw-copy"
                  onClick={handleCopyRaw}
                  aria-label={rawCopied() ? 'Copied raw message' : 'Copy raw message'}
                  title={rawCopied() ? 'Copied' : 'Copy'}
                >
                  {rawCopied() ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </header>
              <pre class="chat-bubble-raw"><code>{decodedText().text}</code></pre>
            </section>
          ) : (
            <p class="chat-bubble-text">{decodedText().text}</p>
          )
        ) : (
          <div class="chat-bubble-file">
            <FileCard file={props.message.fileTransfer!} direction={props.message.direction} />
          </div>
        )}
      </div>
    </article>
  )
}
