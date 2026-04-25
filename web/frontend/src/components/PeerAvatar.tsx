import { peerColor, peerInitials } from '../lib/identity'

import './PeerAvatar.css'

type PeerAvatarProps = {
  endpointId: string
  size?: 'sm' | 'md' | 'lg'
}

const sizeClass = {
  sm: 'peer-avatar-sm',
  md: 'peer-avatar-md',
  lg: 'peer-avatar-lg',
} as const

export default function PeerAvatar(props: PeerAvatarProps) {
  const size = () => props.size ?? 'md'

  return (
    <div
      class={`peer-avatar ${sizeClass[size()]}`}
      style={{ 'background-color': peerColor(props.endpointId) }}
      aria-hidden="true"
    >
      <span class="peer-avatar-initials">{peerInitials(props.endpointId)}</span>
    </div>
  )
}
