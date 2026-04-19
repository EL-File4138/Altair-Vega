import { defineConfig } from 'vite'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'
import { createDevRendezvousPlugin } from './dev-rendezvous'

export default defineConfig({
  plugins: [wasm(), topLevelAwait(), createDevRendezvousPlugin()],
  build: {
    target: 'esnext',
  },
  server: {
    host: '127.0.0.1',
    port: 4173,
  },
})
