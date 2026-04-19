import { WasmBrowserNode, generate_short_code, normalize_short_code } from 'altair-vega-browser'

type BrowserEvent =
  | { type: 'ready'; endpointId: string }
  | { type: 'receivedMessage'; endpointId: string; body: string }
  | { type: 'sentMessage'; endpointId: string; body: string }
  | { type: 'error'; message: string }

type RawBrowserEvent = {
  type?: string
  endpointId?: string
  endpoint_id?: string
  body?: string
  message?: string
}

type PresenceMessage = {
  type: 'presence'
  endpointId: string
  announcedAt: number
  requestReply: boolean
}

type RendezvousEvent =
  | { type: 'snapshot'; peers: Array<{ endpointId: string; connectedAt: number }> }
  | { type: 'peer-joined'; endpointId: string; connectedAt: number }
  | { type: 'peer-left'; endpointId: string }

type RoomConnection = {
  close: () => void
}

const app = document.querySelector<HTMLDivElement>('#app')!

type Peer = {
  endpointId: string
  lastSeenAt: number
}

const state = {
  node: null as WasmBrowserNode | null,
  endpointId: '',
  code: generate_short_code(),
  roomConnection: null as RoomConnection | null,
  peers: new Map<string, Peer>(),
  selectedPeerId: '',
  composeText: '',
  events: [] as Array<{ title: string; detail: string }>,
  announceTimer: 0 as number | 0,
}

await boot()

async function boot() {
  state.node = await WasmBrowserNode.spawn()
  state.endpointId = state.node.endpoint_id()
  attachEventStream(state.node)
  joinCode(state.code)
  render()
}

function render() {
  const peers = [...state.peers.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt)
  const currentPeer = state.selectedPeerId || 'none selected'

  app.innerHTML = `
    <div class="shell">
      <section class="card">
        <div class="row" style="justify-content: space-between;">
          <div>
            <h1>Altair Vega Web</h1>
            <p class="muted">Static-hosted browser endpoint with local short-code rendezvous for development.</p>
          </div>
          <div class="status ${state.node ? '' : 'offline'}">${state.node ? 'Browser endpoint online' : 'Offline'}</div>
        </div>
      </section>

      <section class="grid">
        <div class="card">
          <h2>Local Endpoint</h2>
          <p><code>${state.endpointId || 'spawning...'}</code></p>
          <p class="muted">For now, peers discover each other over a same-origin <code>BroadcastChannel</code> keyed by the typed short code below.</p>
        </div>
        <div class="card">
          <h2>Pairing Code</h2>
          <label for="pair-code">Type the same short code in another tab on the same origin.</label>
          <div class="row">
            <input id="pair-code" value="${escapeHtml(state.code)}" />
            <button id="normalize-code" class="secondary">Normalize</button>
            <button id="regenerate-code" class="secondary">Generate</button>
            <button id="join-code">Join Code</button>
          </div>
        </div>
      </section>

      <section class="grid">
        <div class="card">
          <h2>Peers In Current Code</h2>
          <p class="muted">Discovered peers are announced through the local development rendezvous channel.</p>
          <ul class="peer-list">
            ${peers.length === 0 ? '<li class="peer-item muted">No peers discovered yet.</li>' : peers
              .map((peer) => `
                <li class="peer-item">
                  <div class="row" style="justify-content: space-between; align-items: flex-start;">
                    <div>
                      <div><code>${peer.endpointId}</code></div>
                      <div class="muted">Last seen ${formatRelative(peer.lastSeenAt)}</div>
                    </div>
                    <button class="secondary select-peer" data-peer-id="${peer.endpointId}">${peer.endpointId === state.selectedPeerId ? 'Selected' : 'Select'}</button>
                  </div>
                </li>
              `)
              .join('')}
          </ul>
        </div>

        <div class="card">
          <h2>Send Message</h2>
          <p class="muted">Selected peer: <code>${currentPeer}</code></p>
          <textarea id="compose-text" placeholder="Write a message to the selected peer...">${escapeHtml(state.composeText)}</textarea>
          <div class="row">
            <button id="send-message" ${state.selectedPeerId ? '' : 'disabled'}>Send Over iroh</button>
          </div>
        </div>
      </section>

      <section class="card">
        <h2>Event Log</h2>
        <ul class="event-list">
          ${state.events.length === 0 ? '<li class="event-item muted">No events yet.</li>' : state.events
            .map((event) => `
              <li class="event-item">
                <strong>${escapeHtml(event.title)}</strong>
                <div class="muted">${escapeHtml(event.detail)}</div>
              </li>
            `)
            .join('')}
        </ul>
      </section>
    </div>
  `

  bindControls()
}

function bindControls() {
  const codeInput = document.querySelector<HTMLInputElement>('#pair-code')!
  const composeInput = document.querySelector<HTMLTextAreaElement>('#compose-text')!

  codeInput.addEventListener('input', () => {
    state.code = codeInput.value
  })

  composeInput.addEventListener('input', () => {
    state.composeText = composeInput.value
  })

  document.querySelector<HTMLButtonElement>('#normalize-code')!.onclick = async () => {
    try {
      state.code = normalize_short_code(codeInput.value)
      appendEvent('Normalized code', state.code)
      render()
    } catch (error) {
      appendEvent('Normalize failed', stringifyError(error))
      render()
    }
  }

  document.querySelector<HTMLButtonElement>('#regenerate-code')!.onclick = () => {
    state.code = generate_short_code()
    appendEvent('Generated code', state.code)
    render()
  }

  document.querySelector<HTMLButtonElement>('#join-code')!.onclick = () => {
    try {
      joinCode(codeInput.value)
      render()
    } catch (error) {
      appendEvent('Join failed', stringifyError(error))
      render()
    }
  }

  document.querySelectorAll<HTMLButtonElement>('.select-peer').forEach((button) => {
    button.onclick = () => {
      state.selectedPeerId = button.dataset.peerId || ''
      render()
    }
  })

  document.querySelector<HTMLButtonElement>('#send-message')!.onclick = async () => {
    if (!state.node || !state.selectedPeerId || !state.composeText.trim()) {
      return
    }
    try {
      await state.node.send_message(state.selectedPeerId, state.composeText.trim())
      state.composeText = ''
      render()
    } catch (error) {
      appendEvent('Send failed', stringifyError(error))
      render()
    }
  }
}

function joinCode(rawCode: string) {
  const normalized = normalize_short_code(rawCode)
  state.code = normalized
  state.peers.clear()
  state.selectedPeerId = ''
  state.roomConnection?.close()
  if (state.announceTimer) {
    window.clearInterval(state.announceTimer)
  }
  state.roomConnection = connectRoom(normalized)
  appendEvent('Joined code', normalized)
}

function connectRoom(code: string): RoomConnection {
  const wsUrl = new URL('/__altair_vega_dev_rendezvous', window.location.origin)
  wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  wsUrl.searchParams.set('code', code)
  wsUrl.searchParams.set('endpointId', state.endpointId)

  const socket = new WebSocket(wsUrl)
  let closedIntentionally = false

  socket.addEventListener('open', () => {
    appendEvent('Connected to room service', code)
    render()
  })

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as RendezvousEvent
    handleRendezvousEvent(message)
  })

  socket.addEventListener('close', () => {
    if (closedIntentionally) {
      return
    }
    appendEvent('Room service disconnected', code)
    render()
    fallbackToBroadcastChannel(code)
  })

  socket.addEventListener('error', () => {
    appendEvent('Room service unavailable', 'Falling back to same-browser BroadcastChannel mode.')
    render()
  })

  return {
    close() {
      closedIntentionally = true
      socket.close()
    },
  }
}

function fallbackToBroadcastChannel(code: string) {
  const channel = new BroadcastChannel(`altair-vega-dev::${code}`)
  channel.onmessage = (event: MessageEvent<PresenceMessage>) => {
    if (event.data.type !== 'presence' || event.data.endpointId === state.endpointId) {
      return
    }
    upsertPeer(event.data.endpointId, event.data.announcedAt)
    if (event.data.requestReply) {
      broadcastPresence(channel, false)
    }
    render()
  }
  broadcastPresence(channel, true)
  state.announceTimer = window.setInterval(() => broadcastPresence(channel, false), 5000)
  state.roomConnection = {
    close() {
      channel.close()
    },
  }
}

function broadcastPresence(channel: BroadcastChannel, requestReply: boolean) {
  channel.postMessage({
    type: 'presence',
    endpointId: state.endpointId,
    announcedAt: Date.now(),
    requestReply,
  } satisfies PresenceMessage)
}

function handleRendezvousEvent(event: RendezvousEvent) {
  switch (event.type) {
    case 'snapshot':
      state.peers.clear()
      for (const peer of event.peers) {
        upsertPeer(peer.endpointId, peer.connectedAt)
      }
      break
    case 'peer-joined':
      upsertPeer(event.endpointId, event.connectedAt)
      break
    case 'peer-left':
      if (state.peers.delete(event.endpointId)) {
        appendEvent('Peer left', event.endpointId)
      }
      if (state.selectedPeerId === event.endpointId) {
        state.selectedPeerId = ''
      }
      break
  }
  render()
}

function upsertPeer(endpointId: string, connectedAt: number) {
  if (endpointId === state.endpointId) {
    return
  }
  const existingPeer = state.peers.get(endpointId)
  state.peers.set(endpointId, {
    endpointId,
    lastSeenAt: connectedAt,
  })
  if (!existingPeer) {
    appendEvent('Discovered peer', endpointId)
  }
}

async function attachEventStream(node: WasmBrowserNode) {
  const reader = node.events().getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      appendEvent('Browser stream closed', 'No further browser events will be emitted.')
      render()
      return
    }

    const event = normalizeBrowserEvent(value as RawBrowserEvent)
    switch (event.type) {
      case 'ready':
        appendEvent('Browser endpoint ready', event.endpointId)
        break
      case 'receivedMessage':
        appendEvent(`Message from ${event.endpointId}`, event.body)
        break
      case 'sentMessage':
        appendEvent(`Message sent to ${event.endpointId}`, event.body)
        break
      case 'error':
        appendEvent('Browser error', event.message)
        break
    }
    render()
  }
}

function normalizeBrowserEvent(event: RawBrowserEvent): BrowserEvent {
  const endpointId = event.endpointId ?? event.endpoint_id ?? ''
  switch (event.type) {
    case 'ready':
      return { type: 'ready', endpointId }
    case 'receivedMessage':
      return { type: 'receivedMessage', endpointId, body: event.body ?? '' }
    case 'sentMessage':
      return { type: 'sentMessage', endpointId, body: event.body ?? '' }
    case 'error':
      return { type: 'error', message: event.message ?? 'Unknown browser event error' }
    default:
      return { type: 'error', message: `Unknown browser event type: ${String(event.type)}` }
  }
}

function appendEvent(title: string, detail: string) {
  state.events.unshift({ title, detail })
  state.events = state.events.slice(0, 24)
}

function stringifyError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function formatRelative(timestamp: number) {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
  return `${seconds}s ago`
}

function escapeHtml(value: string | number | null | undefined) {
  const text = value == null ? '' : String(value)
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
