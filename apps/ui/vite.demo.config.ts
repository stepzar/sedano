import { readFileSync } from 'node:fs'
import { defineConfig, mergeConfig, type Plugin } from 'vite'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import base from './vite.config.ts'

/**
 * The website demo (`bun run build:demo`): the real UI with an in-page fake
 * server (`src/demo/`), built as a static bundle into the site's public folder
 * so Astro serves it at `/demo/`. Relative `base`, so it works under any path.
 * `VITE_SEDANO_DEMO` is what keeps the demo out of every other build.
 */
const here = dirname(fileURLToPath(import.meta.url))
const outDir = process.env.SEDANO_DEMO_OUT ?? resolve(here, '../site/public/demo')

/**
 * Before the app's own pre-paint script: `?phone=1` (src/demo/phone-prepaint.js)
 * makes the page answer as a phone, then `?theme=` becomes the stored choice,
 * so the first frame is already in that theme (and the store loads it too).
 */
const phoneParam = `<script>${readFileSync(resolve(here, 'src/demo/phone-prepaint.js'), 'utf8')}</script>
    `

const themeParam = `${phoneParam}<script>
      try {
        var wanted = new URLSearchParams(location.search).get('theme')
        if (wanted === 'dark' || wanted === 'light' || wanted === 'system') {
          var current = JSON.parse(localStorage.getItem('sedano.settings') || '{}')
          current.theme = wanted
          localStorage.setItem('sedano.settings', JSON.stringify(current))
          var phone = JSON.parse(localStorage.getItem('sedano.settings.mobile') || '{}')
          phone.theme = wanted
          localStorage.setItem('sedano.settings.mobile', JSON.stringify(phone))
        }
      } catch (error) {}
    </script>
    <script>`

const demoHtml: Plugin = {
  name: 'sedano-demo-html',
  transformIndexHtml: (html) =>
    html
      .replace('<title>sedano</title>', '<title>Sedano — interactive demo</title>\n    <meta name="robots" content="noindex" />\n    <meta name="description" content="The real Sedano interface, running in your browser against a scripted, fake server." />')
      // A demo is not an app to install on a home screen.
      .replace(/\s*<!-- Home-screen app[^>]*-->/, '')
      .replace(/\s*<link rel="manifest"[^>]*>/, '')
      .replace(/\s*<meta name="apple-mobile-web-app-capable"[^>]*>/, '')
      .replace(/\s*<meta name="mobile-web-app-capable"[^>]*>/, '')
      .replace('<script>', themeParam),
}

export default mergeConfig(
  base,
  defineConfig({
    base: './',
    plugins: [demoHtml],
    define: {
      'import.meta.env.VITE_SEDANO_DEMO': JSON.stringify('1'),
    },
    build: {
      outDir,
      emptyOutDir: true,
    },
  }),
)
