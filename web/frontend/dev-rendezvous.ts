import type { ViteDevServer } from 'vite'
import { WebSocketServer, type WebSocket } from 'ws'

type RoomPeer = {
  endpointId: string
  connectedAt: number
  socket: WebSocket
}

type ServerEvent =
  | { type: 'snapshot'; peers: Array<{ endpointId: string; connectedAt: number }> }
  | { type: 'peer-joined'; endpointId: string; connectedAt: number }
  | { type: 'peer-left'; endpointId: string }

const DEV_RENDEZVOUS_PATH = '/__altair_vega_dev_rendezvous'

export function createDevRendezvousPlugin() {
  const rooms = new Map<string, Map<string, RoomPeer>>()

  return {
    name: 'altair-vega-dev-rendezvous',
    apply: 'serve' as const,
    configureServer(server: ViteDevServer) {
      const wss = new WebSocketServer({ noServer: true })

      server.httpServer?.on('upgrade', (request, socket, head) => {
        const url = request.url ? new URL(request.url, 'http://127.0.0.1') : null
        if (!url || url.pathname !== DEV_RENDEZVOUS_PATH) {
          return
        }

        const code = url.searchParams.get('code')?.trim()
        const endpointId = url.searchParams.get('endpointId')?.trim()
        if (!code || !endpointId) {
          socket.destroy()
          return
        }

        wss.handleUpgrade(request, socket, head, (ws) => {
          attachPeer(rooms, ws, code, endpointId)
        })
      })
    },
  }
}

function attachPeer(
  rooms: Map<string, Map<string, RoomPeer>>,
  socket: WebSocket,
  code: string,
  endpointId: string,
) {
  const room = rooms.get(code) ?? new Map<string, RoomPeer>()
  rooms.set(code, room)

  const existingPeers = [...room.values()].map((peer) => ({
    endpointId: peer.endpointId,
    connectedAt: peer.connectedAt,
  }))

  const duplicate = room.get(endpointId)
  if (duplicate) {
    duplicate.socket.close(1000, 'replaced by newer peer session')
    room.delete(endpointId)
  }

  const peer: RoomPeer = {
    endpointId,
    connectedAt: Date.now(),
    socket,
  }
  room.set(endpointId, peer)

  send(socket, {
    type: 'snapshot',
    peers: existingPeers,
  })
  broadcast(room, endpointId, {
    type: 'peer-joined',
    endpointId,
    connectedAt: peer.connectedAt,
  })

  socket.on('close', () => {
    const currentRoom = rooms.get(code)
    if (!currentRoom) {
      return
    }
    currentRoom.delete(endpointId)
    broadcast(currentRoom, endpointId, {
      type: 'peer-left',
      endpointId,
    })
    if (currentRoom.size === 0) {
      rooms.delete(code)
    }
  })
}

function broadcast(
  room: Map<string, RoomPeer>,
  sourceEndpointId: string,
  event: ServerEvent,
) {
  for (const peer of room.values()) {
    if (peer.endpointId === sourceEndpointId) {
      continue
    }
    send(peer.socket, event)
  }
}

function send(socket: WebSocket, event: ServerEvent) {
  if (socket.readyState !== socket.OPEN) {
    return
  }
  socket.send(JSON.stringify(event))
}
