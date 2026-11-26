import { test } from 'node:test'
import assert from 'node:assert/strict'
import worker from '../src/index.ts'
import { validReport, MAX_REPORT_BYTES } from '../../diagnostics-protocol.ts'

const report = () => ({ schema: 1, reportId: 'a'.repeat(32), version: '0.9.3', runtime: 'web', platform: 'browser', events: [{ atMs: 12, stage: 'dial', outcome: 'failed' }] })
function fixture() {
  const stored: { key: string, value: string }[] = []
  let fail = false
  let limited = false
  const env = {
    INGEST_ENABLED: 'true', ALLOWED_ORIGINS: 'https://app.example',
    CLIENT_LIMIT: { limit: async (_input: { key: string }) => ({ success: !limited }) },
    TOTAL_LIMIT: { limit: async (_input: { key: string }) => ({ success: !limited }) },
    REPORTS: { put: async (key: string, value: string) => { if (fail) throw Error('storage unavailable'); stored.push({ key, value }) } },
  }
  // The handler uses only these methods; no Cloudflare runtime or remote services.
  const send = (value: unknown, options: RequestInit = {}) => worker.fetch(new Request('https://collector.example/v1/reports', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value), ...options,
  }), env as Env)
  return { env, stored, send, fail: () => { fail = true }, limit: () => { limited = true } }
}

test('strict allowlist rejects payload/identity fields and malformed metrics', () => {
  assert.equal(validReport(report()), true)
  for (const key of ['body', 'name', 'endpointId', 'code', 'ticket', 'ip', 'error', 'url', 'userAgent']) {
    assert.equal(validReport({ ...report(), [key]: 'SENTINEL_PRIVATE' }), false)
    assert.equal(validReport({ ...report(), events: [{ ...report().events[0], [key]: 'SENTINEL_PRIVATE' }] }), false)
  }
  for (const runtime of [null, ['web'], {}, 'other']) assert.equal(validReport({ ...report(), runtime }), false)
  for (const atMs of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(validReport({ ...report(), events: [{ atMs, stage: 'dial', outcome: 'ok' }] }), false)
  }
  assert.equal(validReport({ ...report(), events: Array(97).fill(report().events[0]) }), false)
  assert.equal(validReport({ ...report(), events: [] }), false)
})
test('persists only validated JSON with server-generated key before acknowledging', async () => {
  const f = fixture()
  assert.equal((await f.send(report())).status, 201)
  assert.equal(f.stored.length, 1)
  assert.match(f.stored[0].key, /^reports\/\d{4}-\d{2}-\d{2}\/[\da-f-]+\.json$/)
  assert.deepEqual(JSON.parse(f.stored[0].value), report())
  f.fail()
  assert.equal((await f.send(report())).status, 503)
})
test('rejects oversized streaming bodies, unknown fields, origins, disabled ingest and limits', async () => {
  const f = fixture()
  assert.equal((await f.send({ ...report(), code: 'PRIVATE' })).status, 400)
  assert.equal((await f.send(report(), { body: 'x'.repeat(MAX_REPORT_BYTES + 1) })).status, 400)
  assert.equal((await f.send(report(), { headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' } })).status, 403)
  const accepted = await f.send(report(), { headers: { Origin: 'https://app.example', 'Content-Type': 'application/json' } })
  assert.equal(accepted.headers.get('Access-Control-Allow-Origin'), 'https://app.example')
  assert.equal(accepted.status, 201)
  f.env.INGEST_ENABLED = 'false'
  assert.equal((await f.send(report())).status, 503)
  f.env.INGEST_ENABLED = 'true'
  f.limit()
  assert.equal((await f.send(report())).status, 429)
  assert.equal(f.stored.length, 1)
})
test('no read API, invalid content type and methods are rejected', async () => {
  const f = fixture()
  assert.equal((await f.send(report(), { method: 'GET', body: undefined })).status, 405)
  assert.equal((await f.send(report(), { headers: { 'Content-Type': 'text/plain' } })).status, 415)
  assert.equal((await f.send(report(), { headers: { 'Content-Type': 'application/json', 'Content-Length': String(MAX_REPORT_BYTES + 1) } })).status, 413)
  assert.equal(f.stored.length, 0)
})
test('client-rejected requests cannot consume another client shared quota', async () => {
  const f = fixture()
  const counts = new Map<string, number>()
  let total = 0
  f.env.CLIENT_LIMIT.limit = async ({ key }) => {
    const count = (counts.get(key) ?? 0) + 1
    counts.set(key, count)
    return { success: count <= 12 }
  }
  f.env.TOTAL_LIMIT.limit = async () => ({ success: ++total <= 120 })
  for (let i = 0; i < 120; i++) {
    const response = await f.send(report(), { headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1' } })
    assert.equal(response.status, i < 12 ? 201 : 429)
  }
  assert.equal(total, 12)
  assert.equal((await f.send(report(), { headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.2' } })).status, 201)
  assert.equal(total, 13)
})
