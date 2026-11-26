import { MAX_EVENTS, MAX_REPORT_BYTES, validEvent, type DiagnosticEvent, type DiagnosticReport } from '../../../diagnostics-protocol'
import packageInfo from '../../package.json'

// No storage, URL parameters, user agent, error text, or application events enter reports.
const events: DiagnosticEvent[] = []
const start = performance.now()
let attempts = 0
let pending = false
let lastAttempt = -Infinity
type Submission = 'normal' | 'failure' | 'terminal'
let queued: Exclude<Submission, 'normal'> | undefined

const uploadEndpoint = (() => {
  try {
    const url = new URL(import.meta.env.VITE_TELEMETRY_URL ?? '')
    return url.protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
})()

export function diagnostic(stage: DiagnosticEvent['stage'], outcome: DiagnosticEvent['outcome'], attempt?: number) {
  recordDiagnostic({ atMs: 0, stage, outcome, ...(attempt === undefined ? {} : { attempt }) })
}
export function recordDiagnostic(value: unknown) {
  if (!validEvent(value)) return
  if (events.length === MAX_EVENTS) events.splice(16, 1)
  events.push({ ...value, atMs: Math.max(0, Math.round(performance.now() - start)) })
}
export function diagnosticReport(): DiagnosticReport {
  return {
    schema: 1,
    reportId: Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''),
    version: packageInfo.version,
    runtime: 'web', platform: 'browser',
    events: events.map((event) => ({ ...event })),
  }
}
export async function submitDiagnostics(mode: Submission = 'normal') {
  if (!uploadEndpoint) return
  if (pending) {
    if (mode !== 'normal' && queued !== 'terminal') queued = mode
    return
  }
  const limit = mode === 'terminal' ? 8 : mode === 'failure' ? 7 : 6
  if (attempts >= limit || (mode === 'normal' && performance.now() - lastAttempt < 30_000)) return
  const body = JSON.stringify(diagnosticReport())
  if (new TextEncoder().encode(body).length > MAX_REPORT_BYTES) return
  pending = true
  attempts++
  lastAttempt = performance.now()
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), 4000)
  try {
    // Never send cookies or follow redirects, even if the endpoint is misconfigured.
    const response = await fetch(uploadEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal, keepalive: true })
    await response.body?.cancel()
  } catch { /* The bounded in-memory report remains available for explicit export. */ }
  finally {
    window.clearTimeout(timer)
    pending = false
    const next = queued
    queued = undefined
    if (next) void submitDiagnostics(next)
  }
}
export function startDiagnostics(): () => void {
  diagnostic('startup', 'start')
  const network = () => { diagnostic('network', navigator.onLine ? 'online' : 'offline'); void submitDiagnostics() }
  const visibility = () => { diagnostic('visibility', document.hidden ? 'hidden' : 'visible'); if (document.hidden) void submitDiagnostics() }
  const ending = () => { diagnostic('session', 'normal'); void submitDiagnostics('terminal') }
  diagnostic('network', navigator.onLine ? 'online' : 'offline')
  document.addEventListener('visibilitychange', visibility)
  window.addEventListener('online', network)
  window.addEventListener('offline', network)
  window.addEventListener('pagehide', ending)
  const timer = window.setInterval(() => { void submitDiagnostics() }, 60_000)
  return () => {
    clearInterval(timer)
    document.removeEventListener('visibilitychange', visibility)
    window.removeEventListener('online', network)
    window.removeEventListener('offline', network)
    window.removeEventListener('pagehide', ending)
  }
}
