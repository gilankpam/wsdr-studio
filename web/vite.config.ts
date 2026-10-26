import react from '@vitejs/plugin-react'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

// The web build's engine (wasm/build.sh jspi -> wasm/web/core/), copied next to the page as core/.
function wsdrCore(): Plugin {
  const from = resolve(__dirname, '../wasm/web/core')
  return {
    name: 'wsdr-core',
    apply: 'build',
    closeBundle() {
      const out = resolve(__dirname, 'dist-web/core')
      mkdirSync(out, { recursive: true })
      for (const f of ['wsdr-core.js', 'wsdr-core.wasm']) {
        if (!existsSync(`${from}/${f}`)) throw new Error(`${from}/${f} is missing: run wasm/build.sh jspi first`)
        copyFileSync(`${from}/${f}`, `${out}/${f}`)
      }
    },
  }
}

// https://vite.dev/config/
// `npm run dev`: the backend serves /api and /ws (start it with --dev-origin http://localhost:5173).
// `npm run build`: the desktop app's page (dist/). `npm run build:web`: the web version (dist-web/: the
// page, its worker and the engine; relative paths, so it can live under any URL, e.g. GitHub Pages).
export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === 'web' ? [wsdrCore()] : [])],
  ...(mode === 'web' ? { base: './', build: { outDir: 'dist-web' } } : {}),
  worker: { format: 'es' },
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:8073', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:8073', ws: true, changeOrigin: true },
    },
  },
}))
