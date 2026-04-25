declare module 'cloudflare:workers' {
  export class DurableObject {
    protected readonly ctx: DurableObjectState
    constructor(ctx: DurableObjectState, env: unknown)
  }
}

declare class WebSocketPair {
  0: WebSocket
  1: WebSocket
}

interface ResponseInit {
  webSocket?: WebSocket
}

interface DurableObjectNamespace<T = unknown> {
  idFromName(name: string): DurableObjectId
  get(id: DurableObjectId): DurableObjectStub<T>
}

interface DurableObjectId {}

interface DurableObjectStub<T = unknown> {
  fetch(request: Request): Promise<Response>
}

interface DurableObjectState {
  acceptWebSocket(socket: WebSocket): void
  getWebSockets(): WebSocket[]
}

interface WebSocket {
  serializeAttachment(value: unknown): void
  deserializeAttachment(): unknown
}
