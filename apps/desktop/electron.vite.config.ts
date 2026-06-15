import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/main/index.ts'),
        // discord.js stays a runtime require: bundling it trips on zlib-sync, an
        // OPTIONAL native compression dep we don't install (the gateway falls back
        // to plain JSON frames). Main runs in Node, so node_modules is right there.
        external: ['discord.js', 'zlib-sync'],
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.ts'),
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    // Pin the dev port. Electron localStorage is keyed to the origin (localhost:PORT),
    // so a drifting port = a fresh, empty store (chats/settings "vanish"). strictPort
    // keeps the origin stable, and fails loudly if 5173 is taken rather than drifting.
    server: { port: 5173, strictPort: true },
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
    plugins: [react()],
  },
})
