import type { ResumeReplyPayload, ResumeRelayPayload, RoomConnection } from './types'
import { getResumeInfo } from './storage'
import { generateId } from './format'

type PendingQuery = {
  resolve: (value: ResumeReplyPayload) => void
  reject: (reason?: unknown) => void
  timeout: number
}

const pendingQueries = new Map<string, PendingQuery>()

export async function requestResumeInfo(
  roomConnection: RoomConnection | null,
  endpointId: string,
  targetEndpointId: string,
  descriptor: {
    storageKey: string
    hashHex: string
    sizeBytes: number
    chunkSizeBytes: number
    name: string
    mimeType: string
  },
): Promise<ResumeReplyPayload | null> {
  if (!roomConnection) return null

  const requestId = generateId()
  const result = new Promise<ResumeReplyPayload>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingQueries.delete(requestId)
      reject(new Error('resume query timed out'))
    }, 4000)
    pendingQueries.set(requestId, { resolve, reject, timeout })
  })

  roomConnection.sendRelay(targetEndpointId, {
    type: 'resume-query',
    requestId,
    sourceEndpointId: endpointId,
    ...descriptor,
  })

  try {
    return await result
  } catch {
    return null
  }
}

export async function handleRelayPayload(
  fromEndpointId: string,
  payload: ResumeRelayPayload,
  roomConnection: RoomConnection | null,
): Promise<void> {
  switch (payload.type) {
    case 'resume-query': {
      const resume = await getResumeInfo(payload.storageKey, payload.sizeBytes, payload.chunkSizeBytes)
      roomConnection?.sendRelay(fromEndpointId, {
        type: 'resume-reply',
        requestId: payload.requestId,
        storageKey: payload.storageKey,
        localBytes: resume.localBytes,
        missingRanges: resume.missingRanges,
      })
      break
    }
    case 'resume-reply': {
      const pending = pendingQueries.get(payload.requestId)
      if (!pending) return
      window.clearTimeout(pending.timeout)
      pendingQueries.delete(payload.requestId)
      pending.resolve(payload)
      break
    }
  }
}
