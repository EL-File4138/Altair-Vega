declare module 'cloudflare:workers' {
  export class DurableObject {}
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
