import { defineConfig } from 'vite'
import wasm from 'vite-plugin-wasm'
import solidPlugin from 'vite-plugin-solid'
import { createDevRendezvousPlugin } from './dev-rendezvous'

export default defineConfig({
  plugins: [wasm(), solidPlugin(), createDevRendezvousPlugin()],
  build: {
    target: 'esnext',
  },
  server: {
    host: '127.0.0.1',
    port: 4173,
  },
})
