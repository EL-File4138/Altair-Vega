/* Deterministic peer identity from endpoint ID */

const ADJECTIVES = [
  'Amber', 'Azure', 'Coral', 'Dusk', 'Ember', 'Frost', 'Gold', 'Haze',
  'Iris', 'Jade', 'Lark', 'Mint', 'Nova', 'Opal', 'Pine', 'Rust',
]

const ANIMALS = [
  'Bear', 'Crane', 'Deer', 'Eagle', 'Fox', 'Hare', 'Jay', 'Kite',
  'Lynx', 'Moth', 'Newt', 'Owl', 'Pike', 'Rook', 'Swan', 'Wolf',
]

function hashString(str: string): number {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0
  }
  return Math.abs(hash)
}

export function peerName(endpointId: string): string {
  const hash = hashString(endpointId)
  const adj = ADJECTIVES[hash % ADJECTIVES.length]
  const animal = ANIMALS[(hash >>> 4) % ANIMALS.length]
  return `${adj} ${animal}`
}

export function peerInitials(endpointId: string): string {
  const name = peerName(endpointId)
  const parts = name.split(' ')
  return parts.map((p) => p[0]).join('')
}

export function peerColor(endpointId: string): string {
  const hash = hashString(endpointId)
  const hue = hash % 360
  return `hsl(${hue}, 65%, 55%)`
}

export function peerColorSubtle(endpointId: string): string {
  const hash = hashString(endpointId)
  const hue = hash % 360
  return `hsl(${hue}, 40%, 92%)`
}

export function peerColorSubtleDark(endpointId: string): string {
  const hash = hashString(endpointId)
  const hue = hash % 360
  return `hsl(${hue}, 30%, 18%)`
}
