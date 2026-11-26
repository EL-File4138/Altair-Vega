export const MAX_REPORT_BYTES = 32 * 1024
export const MAX_EVENTS = 96
export const STAGES = ['startup', 'endpoint', 'rendezvous', 'dial', 'handshake', 'path', 'transfer', 'close', 'network', 'visibility', 'session'] as const
export const OUTCOMES = ['start', 'ok', 'failed', 'timeout', 'retry', 'offline', 'online', 'hidden', 'visible', 'normal', 'transport', 'application', 'unknown'] as const
export type DiagnosticEvent = {
  atMs: number
  stage: typeof STAGES[number]
  outcome: typeof OUTCOMES[number]
  path?: 'direct' | 'relay' | 'unknown'
  rttMs?: number
  lostPackets?: number
  sentDatagrams?: number
  attempt?: number
}
export type DiagnosticReport = {
  schema: 1
  reportId: string
  version: string
  runtime: 'native' | 'web'
  platform: 'linux' | 'macos' | 'windows' | 'other' | 'browser'
  events: DiagnosticEvent[]
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function only(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).every((key) => keys.includes(key))
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max
}
export function validEvent(value: unknown): value is DiagnosticEvent {
  if (!object(value) || !only(value, ['atMs', 'stage', 'outcome', 'path', 'rttMs', 'lostPackets', 'sentDatagrams', 'attempt'])) return false
  return integer(value.atMs) && STAGES.some((s) => s === value.stage) && OUTCOMES.some((s) => s === value.outcome)
    && (value.path === undefined || ['direct', 'relay', 'unknown'].some((path) => path === value.path))
    && ['rttMs', 'lostPackets', 'sentDatagrams', 'attempt'].every((key) => value[key] === undefined || integer(value[key]))
}
export function validReport(value: unknown): value is DiagnosticReport {
  if (!object(value) || !only(value, ['schema', 'reportId', 'version', 'runtime', 'platform', 'events'])) return false
  return value.schema === 1
    && typeof value.reportId === 'string' && /^[0-9a-f]{32}$/.test(value.reportId)
    && typeof value.version === 'string' && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(value.version) && value.version.length <= 40
    && ['native', 'web'].some((runtime) => runtime === value.runtime)
    && ['linux', 'macos', 'windows', 'other', 'browser'].some((platform) => platform === value.platform)
    && Array.isArray(value.events) && value.events.length > 0 && value.events.length <= MAX_EVENTS
    && value.events.every(validEvent)
}
