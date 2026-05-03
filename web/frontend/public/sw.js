const CACHE_NAME = 'altair-vega-web-v1'
const CORE_ASSETS = ['./', './index.html', './manifest.webmanifest', './logo.png']
const INDEX_URL = new URL('./index.html', self.registration.scope).toString()

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).catch(() => undefined),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
    ),
  )
})

function cacheFirstWithBackgroundUpdate(request) {
  return caches.open(CACHE_NAME).then(async (cache) => {
    const cached = await cache.match(request)
    const update = fetch(request).then((response) => {
      if (response.ok) cache.put(request, response.clone())
      return response
    })

    if (cached) {
      update.catch(() => undefined)
      return cached
    }

    return update.catch(async () => {
      const fallback = await caches.match(INDEX_URL)
      return fallback ?? new Response('Altair-Vega is unavailable offline.', { status: 503 })
    })
  })
}

function navigationResponse(request) {
  return caches.open(CACHE_NAME).then(async (cache) => {
    const cached = (await cache.match(request)) ?? (await cache.match(INDEX_URL))
    const update = fetch(request).then((response) => {
      if (response.ok) {
        cache.put(request, response.clone())
        cache.put(INDEX_URL, response.clone())
      }
      return response
    })

    if (cached) {
      update.catch(() => undefined)
      return cached
    }

    return update.catch(async () => {
      const fallback = await cache.match(INDEX_URL)
      return fallback ?? new Response('Altair-Vega is unavailable offline.', { status: 503 })
    })
  })
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith(navigationResponse(request))
    return
  }

  event.respondWith(cacheFirstWithBackgroundUpdate(request))
})
