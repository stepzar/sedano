import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const shared = resolve(here, '../../packages/shared/src')

/**
 * Where `/api` is proxied: the development server (`scripts/lib/dev-env.ts`),
 * never the installed app on 7788. Same variable, same default as `dev.ts`;
 * not `SEDANO_PORT`, which a terminal inside the installed app inherits.
 */
const apiPort = process.env.SEDANO_DEV_PORT ?? '7789'

/**
 * An unmistakable "this is the development copy" mark, so a dev tab or window
 * is never taken for the installed app: an orange strip along the top and a
 * DEV pill. Only for the vite started by `bun run dev` / `desktop:dev`
 * (`SEDANO_INSTANCE=dev`), never in a build or in the browser checks. The Tauri
 * dev window adds the same mark itself (`lib.rs`), hence the id guard.
 */
const devBadge = `<script>
addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('sedano-dev-badge')) return
  const mark = document.createElement('div')
  mark.id = 'sedano-dev-badge'
  mark.setAttribute('style', 'position:fixed;top:0;left:0;right:0;height:3px;background:#f59e0b;z-index:2147483647;pointer-events:none')
  const pill = document.createElement('span')
  pill.textContent = 'DEV :${apiPort}'
  pill.setAttribute('style', 'position:fixed;top:4px;right:8px;padding:0 6px;border-radius:7px;background:#f59e0b;color:#1c1917;font:700 9px/14px -apple-system,system-ui,sans-serif;letter-spacing:.08em')
  mark.appendChild(pill)
  document.body.appendChild(mark)
  document.title = 'Sedano Dev'
})
</script>`

const devMark = {
  name: 'sedano-dev-mark',
  apply: 'serve' as const,
  transformIndexHtml: (html: string) =>
    process.env.SEDANO_INSTANCE === 'dev' ? html.replace('</head>', `${devBadge}\n</head>`) : html,
}

export default defineConfig({
  root: here,
  plugins: [react(), tailwindcss(), devMark],
  resolve: {
    alias: {
      '@shared': resolve(shared, 'index.ts'),
    },
  },
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${apiPort}`,
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
})
