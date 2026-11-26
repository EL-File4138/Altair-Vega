import { MAX_REPORT_BYTES, validReport } from '../../diagnostics-protocol.ts'

async function boundedJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader()
  if (!reader) throw new Error('body')
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_REPORT_BYTES) { await reader.cancel(); throw new Error('size') }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes))
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const headers = new Headers({ 'Cache-Control': 'no-store', Vary: 'Origin' })
    const respond = (status: number) => new Response(null, { status, headers })
    if (new URL(request.url).pathname !== '/v1/reports') return respond(404)
    const origin = request.headers.get('Origin')
    if (origin) {
      if (!env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean).includes(origin)) return respond(403)
      headers.set('Access-Control-Allow-Origin', origin)
      headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS')
      headers.set('Access-Control-Allow-Headers', 'Content-Type')
    }
    if (request.method === 'OPTIONS') return respond(204)
    if (request.method !== 'POST') return respond(405)
    if (env.INGEST_ENABLED !== 'true') return respond(503)
    if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') return respond(415)
    if (Number(request.headers.get('Content-Length')) > MAX_REPORT_BYTES) return respond(413)
    // IP is used only in Cloudflare's ephemeral limiter, never in the stored report.
    // This may throttle shared NATs. Neither limiter is a strict global cost cap.
    try {
      if (!(await env.CLIENT_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'local' })).success
        || !(await env.TOTAL_LIMIT.limit({ key: 'ingest' })).success) return respond(429)
      let report: unknown
      try { report = await boundedJson(request) } catch { return respond(400) }
      if (!validReport(report)) return respond(400)
      const day = new Date().toISOString().slice(0, 10)
      // Server-generated object key: no caller-controlled storage paths or read route.
      await env.REPORTS.put(`reports/${day}/${crypto.randomUUID()}.json`, JSON.stringify(report), {
        httpMetadata: { contentType: 'application/json' },
      })
      return respond(201)
    } catch { return respond(503) }
  },
} satisfies ExportedHandler<Env>
