#!/usr/bin/env bun
/**
 * The desktop's Content Security Policy, against the real bundle.
 *
 * The policy lives in `tauri.conf.json` and only a Tauri window enforces it, so
 * a directive the UI needs and the policy forgot shows up as a blank or broken
 * window after a release build. This loads the built bundle the way the
 * desktop does — `window.__SEDANO_API__` set, every call cross-origin to
 * 127.0.0.1 — under that exact policy (plus the inline-script hashes Tauri adds
 * at build time), opens a session, and fails on any violation. It also checks
 * the policy still refuses what it is there to refuse.
 *
 * `style-src 'unsafe-inline'` is there on purpose: xterm draws its theme and
 * cell sizes through `<style>` elements it creates at runtime.
 *
 *   bun scripts/csp-check.ts
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { installExitHandlers, ROOT, runCleanups, seedStore, startApi, tempHome } from './lib/harness.ts'
import { openRichestSession } from './lib/app.ts'

installExitHandlers()

const failures: string[] = []
const passed: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) passed.push(label)
  else failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

const conf = JSON.parse(readFileSync(join(ROOT, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8')) as {
  app?: { security?: { csp?: string | null } }
}
const csp = conf.app?.security?.csp
if (typeof csp !== 'string' || !csp) {
  console.log('csp: FAILED — tauri.conf.json has no app.security.csp')
  process.exit(1)
}

const index = join(ROOT, 'apps/ui/dist/index.html')
if (!existsSync(index)) {
  console.log('csp: FAILED — the UI bundle is missing; run "bun run build:ui" first')
  process.exit(1)
}

/** What Tauri does at build time: every inline script gets its hash in script-src. */
function withInlineHashes(policy: string, html: string): string {
  const hashes = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
    (match) => `'sha256-${createHash('sha256').update(match[1]!).digest('base64')}'`,
  )
  return policy.replace(/script-src ([^;]*)/, (_, sources: string) => `script-src ${sources} ${hashes.join(' ')}`)
}

try {
  const { env } = tempHome('csp')
  await seedStore(env, ROOT)
  const api = await startApi(env)
  // The page from one origin, the API on another — as in the desktop, where the
  // page is tauri://localhost. `localhost:<port>` is one the API accepts.
  const pageUrl = `http://localhost:${api.port}/`
  const policy = withInlineHashes(csp, readFileSync(index, 'utf8'))

  // A document answered by `route.fulfill` loses its loopback address space,
  // and Chrome's local-network checks would then refuse every call to the API
  // — a property of the test, not of the policy, so those checks are off.
  const args = ['--disable-features=LocalNetworkAccessChecks']
  const browser = await chromium.launch(process.env.SEDANO_BROWSER === 'chromium' ? { args } : { channel: 'chrome', args })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const violations: string[] = []
  page.on('console', (message) => {
    if (/Content Security Policy/i.test(message.text())) violations.push(message.text())
  })
  await page.addInitScript((apiHost: string) => {
    ;(window as unknown as { __SEDANO_API__: string }).__SEDANO_API__ = apiHost
    document.addEventListener('securitypolicyviolation', (event) => {
      console.error(`Content Security Policy violation: ${event.violatedDirective} ${event.blockedURI}`)
    })
  }, `127.0.0.1:${api.port}`)
  await page.route(`${pageUrl}**`, async (route) => {
    const response = await route.fetch()
    const type = response.headers()['content-type'] ?? ''
    if (!type.includes('text/html')) return route.fulfill({ response })
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': policy } })
  })

  await page.goto(pageUrl, { waitUntil: 'networkidle' })
  // The rail fills once the WebSocket has said hello: the cross-origin path.
  await page.waitForSelector('.rail .rail-title.workspace', { timeout: 15_000 })
  const opened = await openRichestSession(page)
  check('the app boots under the policy and opens a session', opened.clicked, opened)
  const connected = await page.evaluate(() => document.querySelectorAll('.rail .session-item').length)
  check('the API answers across origins (sessions listed)', connected > 0, connected)

  // What the policy is for: a page script cannot reach anything but the local
  // server. The "other site" is a local one, so the answer does not depend on
  // the network; without the policy both of these succeed.
  const otherSite = Bun.serve({
    port: 0,
    fetch: (req) =>
      new URL(req.url).pathname.endsWith('.js')
        ? new Response('window.__loaded = true', { headers: { 'content-type': 'text/javascript' } })
        : new Response('ok'),
  })
  const other = `http://localhost:${otherSite.port}`
  const refused = await page.evaluate(async (base: string) => {
    const outcomes: Record<string, string> = {}
    try {
      await fetch(`${base}/exfiltrate`, { mode: 'no-cors' })
      outcomes.fetch = 'sent'
    } catch {
      outcomes.fetch = 'refused'
    }
    outcomes.script = await new Promise<string>((resolve) => {
      const script = document.createElement('script')
      script.src = `${base}/x.js`
      script.onload = () => resolve('loaded')
      script.onerror = () => resolve('refused')
      document.head.append(script)
    })
    try {
      new Function('return 1')()
      outcomes.eval = 'ran'
    } catch {
      outcomes.eval = 'refused'
    }
    return outcomes
  }, other)
  otherSite.stop(true)
  check('a fetch to another site is refused', refused.fetch === 'refused', refused)
  check('a script from another site is refused', refused.script === 'refused', refused)
  check('eval is refused', refused.eval === 'refused', refused)

  const unexpected = violations.filter((text) => !text.includes(other) && !/eval/i.test(text))
  check('the app itself triggers no violation', unexpected.length === 0, unexpected)
  await browser.close()
} finally {
  await runCleanups()
}

for (const label of passed) console.log(`  ok   ${label}`)
for (const failure of failures) console.log(`  FAIL ${failure}`)
console.log(`\ncsp: ${passed.length} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
