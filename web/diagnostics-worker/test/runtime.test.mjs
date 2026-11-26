import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'

const bundled = await build({
  entryPoints: [fileURLToPath(new URL('../src/index.ts', import.meta.url))],
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
})
const origin = 'https://app.example'
const report = {
  schema: 1, reportId: 'b'.repeat(32), version: '0.9.3', runtime: 'web', platform: 'browser',
  events: [{ atMs: 14, stage: 'dial', outcome: 'failed' }],
}
const headers = { 'Content-Type': 'application/json', Origin: origin }
function options(persist, enabled = 'true') {
  const converted = convertV4MiniflareOptions({
    modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-10-19',
    bindings: { INGEST_ENABLED: enabled, ALLOWED_ORIGINS: origin },
    r2Buckets: ['REPORTS'],
    ratelimits: {
      CLIENT_LIMIT: { namespace_id: '413801', simple: { limit: 12, period: 60 } },
      TOTAL_LIMIT: { namespace_id: '413802', simple: { limit: 120, period: 60 } },
    },
  })
  // Miniflare 5 uses one persistence root; the v4 adapter does not carry r2Persist over.
  return { ...converted, resourcePersistencePath: persist }
}

test('real local Worker HTTP ingestion persists sanitized R2 JSON before 201 and across restart', async () => {
  const persist = await mkdtemp(join(tmpdir(), 'altair-vega-diagnostics-test-'))
  let mf = new Miniflare(options(persist))
  try {
    const url = new URL('/v1/reports', await mf.ready)
    const preflight = await fetch(url, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } })
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), origin)
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(report) })
    assert.equal(response.status, 201)
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
    const bucket = await mf.getR2Bucket('REPORTS')
    const { objects } = await bucket.list()
    assert.equal(objects.length, 1)
    const key = objects[0].key
    assert.match(key, /^reports\/\d{4}-\d{2}-\d{2}\/[\da-f-]+\.json$/)
    const stored = await bucket.get(key)
    assert.ok(stored)
    assert.equal(stored.httpMetadata.contentType, 'application/json')
    assert.deepEqual(stored.customMetadata, {})
    assert.deepEqual(await stored.json(), report)
    assert.equal((await fetch(new URL('/' + key, url))).status, 404)
    assert.equal((await fetch(url)).status, 405)
    await mf.dispose()
    mf = new Miniflare(options(persist))
    const restored = await (await mf.getR2Bucket('REPORTS')).get(key)
    assert.ok(restored)
    assert.deepEqual(await restored.json(), report)
  } finally {
    await mf.dispose()
    await rm(persist, { recursive: true, force: true })
  }
})

test('real local Worker rejects private fields, disallowed origins, oversized bodies, and disabled ingest without R2 writes', async () => {
  const persist = await mkdtemp(join(tmpdir(), 'altair-vega-diagnostics-test-'))
  let mf = new Miniflare(options(persist))
  try {
    const url = new URL('/v1/reports', await mf.ready)
    const send = (body, extraHeaders = {}) => fetch(url, { method: 'POST', headers: { ...headers, ...extraHeaders }, body })
    assert.equal((await send(JSON.stringify({ ...report, body: 'PRIVATE_PAYLOAD_SENTINEL' }))).status, 400)
    assert.equal((await send(JSON.stringify(report), { Origin: 'https://untrusted.example' })).status, 403)
    assert.equal((await send('x'.repeat(32769))).status, 413)
    assert.equal((await (await mf.getR2Bucket('REPORTS')).list()).objects.length, 0)
    await mf.dispose()
    mf = new Miniflare(options(persist, 'false'))
    const disabledUrl = new URL('/v1/reports', await mf.ready)
    assert.equal((await fetch(disabledUrl, { method: 'POST', headers, body: JSON.stringify(report) })).status, 503)
    assert.equal((await (await mf.getR2Bucket('REPORTS')).list()).objects.length, 0)
  } finally {
    await mf.dispose()
    await rm(persist, { recursive: true, force: true })
  }
})
