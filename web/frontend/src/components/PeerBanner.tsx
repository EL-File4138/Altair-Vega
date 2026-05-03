import { Show, For } from 'solid-js'
import { Check, Users, UsersRound } from 'lucide-solid'

import { peerName } from '../lib/identity'
import { selectPeer, state } from '../lib/state'

import PeerAvatar from './PeerAvatar'
import EmptyState from './EmptyState'

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
  const shortEndpoint = (endpointId: string) => {
    if (endpointId.length <= 16) return endpointId
    return `${endpointId.slice(0, 8)}...${endpointId.slice(-6)}`
  }

  return (
    <section class="peer-banner card">
      <div class="peer-banner-header-row">
        <div class="peer-banner-title">
          <Users size={15} />
          Peers
        </div>
        <span class="pill pill-neutral peer-banner-count">{state.peers.length}</span>
      </div>

      <Show
        when={state.peers.length > 0}
        fallback={<EmptyState variant="compact" icon={<UsersRound />} message="No peers" />}
      >
        <div class="peer-list" role="listbox" aria-label="Select a peer">
          <For each={state.peers}>
            {(peer) => {
              const selected = () => peer.endpointId === state.selectedPeerId
              return (
                <button
                  type="button"
                  class="peer-list-item"
                  classList={{ 'peer-list-item--selected': selected() }}
                  role="option"
                  aria-selected={selected()}
                  onClick={() => selectPeer(peer.endpointId)}
                  title={peer.endpointId}
                >
                  <PeerAvatar endpointId={peer.endpointId} size="sm" />
                  <span class="peer-list-info">
                    <span class="peer-list-name">{peerName(peer.endpointId)}</span>
                    <span class="peer-list-endpoint">{shortEndpoint(peer.endpointId)}</span>
                  </span>
                  <Show
                    when={selected()}
                    fallback={<span class="pill pill-neutral peer-list-kind">{peerTypeLabel(peer.peerType, peer.label)}</span>}
                  >
                    <span class="peer-list-check"><Check size={16} /></span>
                  </Show>
                </button>
              )
            }}
          </For>
        </div>
      </Show>
    </section>
  )
}
