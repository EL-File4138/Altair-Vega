import { Show, For, createSignal } from 'solid-js'

import { peerName } from '../lib/identity'
import { selectPeer, state } from '../lib/state'

import PeerAvatar from './PeerAvatar'

import './PeerBanner.css'

function peerTypeLabel(peerType?: string, label?: string) {
  if (label) return label
  if (peerType === 'browser-web') return 'Browser'
  if (peerType === 'native-cli') return 'Native CLI'
  if (!peerType) return 'Peer'

  return peerType
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ')
}

export default function PeerBanner() {
  const [showEndpoint, setShowEndpoint] = createSignal(false)

  const currentPeer = () =>
    state.peers.find((peer) => peer.endpointId === state.selectedPeerId) ?? state.peers[0]

  const handleCopyEndpoint = async () => {
    const endpointId = currentPeer()?.endpointId
    if (!endpointId) return
    await navigator.clipboard.writeText(endpointId)
  }

  return (
    <section class="peer-banner card">
      <Show
        when={state.peers.length > 0}
        fallback={
          <div class="peer-banner-waiting">
            <span class="peer-banner-pulse" aria-hidden="true" />
            <div>
              <div class="peer-banner-title">Waiting for a peer to join...</div>
              <div class="peer-banner-subtitle">
                Stay on this code and we'll connect automatically.
              </div>
            </div>
          </div>
        }
      >
        {/* Single peer: show identity directly */}
        <Show when={state.peers.length === 1}>
          <div class="peer-banner-header">
            <PeerAvatar endpointId={currentPeer()!.endpointId} size="lg" />
            <div class="peer-banner-copy">
              <button
                type="button"
                class="peer-banner-identity"
                onClick={() => setShowEndpoint((v) => !v)}
                aria-expanded={showEndpoint()}
              >
                <span class="peer-banner-name">{peerName(currentPeer()!.endpointId)}</span>
                <span class="pill pill-neutral">
                  {peerTypeLabel(currentPeer()!.peerType, currentPeer()!.label)}
                </span>
              </button>
              <Show when={showEndpoint()}>
                <div class="peer-banner-endpoint-row">
                  <code class="peer-banner-endpoint">{currentPeer()!.endpointId}</code>
                  <button
                    type="button"
                    class="btn btn-subtle"
                    onClick={() => void handleCopyEndpoint()}
                  >
                    Copy
                  </button>
                </div>
              </Show>
            </div>
          </div>
          <div class="peer-banner-footnote">Connected peer</div>
        </Show>

        {/* Multiple peers: inline radio list */}
        <Show when={state.peers.length > 1}>
          <div class="peer-banner-multi-label">
            {state.peers.length} peers in room
          </div>
          <div class="peer-list" role="radiogroup" aria-label="Select a peer">
            <For each={state.peers}>
              {(peer) => {
                const selected = () => peer.endpointId === state.selectedPeerId
                return (
                  <label
                    class="peer-list-item"
                    classList={{ 'peer-list-item--selected': selected() }}
                  >
                    <input
                      type="radio"
                      name="peer-select"
                      class="peer-list-radio"
                      checked={selected()}
                      onChange={() => selectPeer(peer.endpointId)}
                    />
                    <PeerAvatar endpointId={peer.endpointId} size="sm" />
                    <div class="peer-list-info">
                      <span class="peer-list-name">{peerName(peer.endpointId)}</span>
                      <span class="pill pill-neutral">
                        {peerTypeLabel(peer.peerType, peer.label)}
                      </span>
                    </div>
                  </label>
                )
              }}
            </For>
          </div>
        </Show>
      </Show>
    </section>
  )
}
