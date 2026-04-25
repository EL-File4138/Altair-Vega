import { For, Show, createEffect, onMount } from 'solid-js'

import { state } from '../lib/state'

import ChatBubble from './ChatBubble'
import EmptyState from './EmptyState'

import './ChatThread.css'

export default function ChatThread() {
  let containerRef: HTMLDivElement | undefined

  const messages = () => state.chatMessages[state.selectedPeerId] ?? []

  const scrollToBottom = (behavior: ScrollBehavior = 'auto') => {
    containerRef?.scrollTo({ top: containerRef.scrollHeight, behavior })
  }

  onMount(() => {
    scrollToBottom()
  })

  createEffect(() => {
    messages().length
    requestAnimationFrame(() => scrollToBottom('smooth'))
  })

  return (
    <section class="chat-thread">
      <Show
        when={messages().length > 0}
        fallback={<EmptyState message="Send a message or drop a file to get started" />}
      >
        <div class="chat-thread-scroll" ref={containerRef}>
          <div class="chat-thread-list">
            <For each={messages()}>{(message) => <ChatBubble message={message} />}</For>
          </div>
        </div>
      </Show>
    </section>
  )
}
