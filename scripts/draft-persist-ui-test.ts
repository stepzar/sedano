#!/usr/bin/env bun
/**
 * What is written in a tab stays there until it is sent or the tab is closed:
 * across tab switches and across a reload, for a new-session tab (text,
 * pictures and chips, and the harness settings chosen on it) and for an open
 * session alike. Chrome and WebKit, against a throwaway store. Prompts and
 * launches are captured in the page and never reach the server, so no harness
 * is started; a launch is answered with a session built from the page's own
 * `hello`.
 *
 *   bun scripts/draft-persist-ui-test.ts
 */
import { chromium, webkit, type Page } from 'playwright'
import { installExitHandlers, runCleanups } from './lib/harness.ts'
import { resolveApp, expandRail } from './lib/app.ts'

installExitHandlers()
const failures: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

/** The field of whichever composer is on screen. */
const FIELD = '.composer textarea, .launchpad-field textarea'

function field(page: Page) {
  return page.evaluate((selector) => {
    const area = document.querySelector<HTMLTextAreaElement>(selector)
    return {
      value: area?.value ?? null,
      chips: [...document.querySelectorAll<HTMLElement>('.prompt-chips .image-chip')].map((chip) => chip.dataset.label),
      thumbs: [...document.querySelectorAll<HTMLImageElement>('.attach:not(.pending) img')]
        .filter((img) => !img.closest('.attach-strip.sent'))
        .map((img) => img.getAttribute('src')),
      active: document.querySelector('.tabs .tab.active')?.getAttribute('data-tab-id') ?? null,
    }
  }, FIELD)
}

function stored(page: Page) {
  return page.evaluate(() => ({
    composer: JSON.parse(localStorage.getItem('sedano.composer-drafts') ?? '{}') as Record<string, { text: string; attachments: unknown[] }>,
    drafts: JSON.parse(localStorage.getItem('sedano.drafts') ?? '{}') as Record<string, { permissionMode: string; harness: string; cwd: string }>,
  }))
}

async function pasteImage(page: Page): Promise<void> {
  await page.evaluate(async (selector) => {
    const area = document.querySelector<HTMLTextAreaElement>(selector)!
    area.focus()
    const canvas = document.createElement('canvas')
    canvas.width = 8
    canvas.height = 8
    const context = canvas.getContext('2d')!
    context.fillStyle = '#3a7'
    context.fillRect(0, 0, 8, 8)
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'))
    const data = new DataTransfer()
    data.items.add(new File([blob], 'shot.png', { type: 'image/png' }))
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: data })
    area.dispatchEvent(event)
  }, FIELD)
  await page.waitForFunction(() => !document.querySelector('.attach.pending'), undefined, { timeout: 5000 })
  await page.waitForTimeout(150)
}

async function selectTab(page: Page, id: string): Promise<void> {
  await page.locator(`.tabs .tab[data-tab-id="${id}"]`).click()
  await page.waitForTimeout(350)
}

const target = await resolveApp()
try {
  for (const which of ['chromium', 'webkit'] as const) {
    console.log(`\n— ${which}`)
    const browser = which === 'webkit' ? await webkit.launch() : await chromium.launch({ channel: 'chrome' })
    const page = await browser.newPage({ viewport: { width: 1360, height: 880 } })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript(() => {
      const Native = window.WebSocket
      const w = window as any
      w.__ws = []
      w.__sent = []
      window.WebSocket = class extends Native {
        constructor(...args: any[]) {
          super(...(args as [string]))
          w.__ws.push(this)
        }
        override set onmessage(handler: ((event: MessageEvent) => void) | null) {
          super.onmessage = handler
            ? (event: MessageEvent) => {
                try {
                  const message = JSON.parse(event.data)
                  if (message.t === 'hello') w.__hello = message
                } catch {
                  /* not ours */
                }
                handler.call(this, event)
              }
            : null
        }
        override get onmessage() {
          return super.onmessage
        }
        override send(data: string) {
          const message = JSON.parse(data)
          if (message.t === 'input' || message.t === 'new_session') {
            w.__sent.push(message)
            return
          }
          super.send(data)
        }
      } as any
    })
    try {
      await page.goto(target.url, { waitUntil: 'networkidle' })
      await page.waitForTimeout(700)
      if (!(await page.locator('.rail .session-item:not(.draft)').count())) {
        await page.locator('.rail-title.workspace').first().click()
        await page.waitForTimeout(250)
      }
      await expandRail(page)
      const rows = page.locator('.rail .session-item:not(.draft)')
      const agentRows = rows.filter({ hasNotText: /terminal/i })
      await agentRows.nth(0).click()
      await page.waitForTimeout(300)
      await agentRows.nth(1).click()
      await page.waitForTimeout(300)
      const sessionA = (await field(page)).active!
      const tabIds = await page.locator('.tabs .tab').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-tab-id')!))
      const sessionB = tabIds.find((id) => id !== sessionA)!

      /* A new-session tab ----------------------------------------------- */
      await page.keyboard.press('Meta+d')
      await page.waitForTimeout(400)
      const draftId = (await field(page)).active!
      check(`${which}: ⌘D opens a new-session tab`, draftId?.startsWith('draft:'), draftId)
      // Change a setting, so "kept" is about a choice and not a default.
      const approvals = page.locator('.launchpad [title="Tool approvals"] .select-trigger, .launchpad-controls [title="Tool approvals"]').first()
      await approvals.click()
      await page.waitForTimeout(200)
      await page.locator('.menu-pop .menu-item:not(.current)').first().click()
      await page.waitForTimeout(200)
      const chosenMode = (await stored(page)).drafts[draftId]?.permissionMode
      await page.locator(FIELD).click()
      await page.keyboard.type('plan the refactor ')
      await pasteImage(page)
      await page.keyboard.type(' carefully')
      const written = await field(page)
      check(`${which}: the new tab holds text, a chip and a thumbnail`, written.value === 'plan the refactor [image:1] carefully' && written.chips.length === 1 && written.thumbs.length === 1, written)
      const controls = await page.locator('.launchpad-controls').innerText()

      await selectTab(page, sessionA)
      await selectTab(page, draftId)
      let back = await field(page)
      check(`${which}: switching away and back keeps the new tab's draft`, back.value === written.value && back.chips.join() === 'Image 1' && back.thumbs.join() === written.thumbs.join(), back)

      /* An open session -------------------------------------------------- */
      await selectTab(page, sessionB)
      await page.locator(FIELD).click()
      await page.keyboard.type('look at ')
      await pasteImage(page)
      const sessionWritten = await field(page)
      await selectTab(page, draftId)
      await selectTab(page, sessionB)
      back = await field(page)
      check(`${which}: switching away and back keeps a session's draft`, back.value === 'look at [image:1]' && back.chips.length === 1 && back.thumbs.join() === sessionWritten.thumbs.join(), back)

      /* Reload ----------------------------------------------------------- */
      // The server sweeps uploads nobody sent (a day old, at its next start):
      // drop this one now, so the reload has to put it back from the copy.
      const swept = await page.evaluate(async (src) => (await fetch(src!, { method: 'DELETE' })).status, sessionWritten.thumbs[0])
      check(`${which}: the session draft's upload can be swept on the server`, swept === 200, swept)
      await page.reload({ waitUntil: 'networkidle' })
      await page.waitForTimeout(900)
      check(`${which}: the new-session tab is still in the strip after a reload`, (await page.locator(`.tabs .tab[data-tab-id="${draftId}"]`).count()) === 1)
      await selectTab(page, draftId)
      back = await field(page)
      check(`${which}: a reload keeps the new tab's text, chip and picture`, back.value === written.value && back.chips.join() === 'Image 1' && back.thumbs.join() === written.thumbs.join(), back)
      check(`${which}: a reload keeps the new tab's settings`, (await page.locator('.launchpad-controls').innerText()) === controls && (await stored(page)).drafts[draftId]?.permissionMode === chosenMode, { controls, now: await page.locator('.launchpad-controls').innerText(), chosenMode })
      await selectTab(page, sessionB)
      back = await field(page)
      await page.waitForTimeout(600)
      back = await field(page)
      const loaded = await page.evaluate(() => [...document.querySelectorAll<HTMLImageElement>('.composer .attach img')].map((img) => img.complete && img.naturalWidth > 0))
      check(`${which}: a reload keeps a session's draft, re-uploading a swept picture`, back.value === 'look at [image:1]' && back.chips.length === 1 && back.thumbs.length === 1 && back.thumbs[0] !== sessionWritten.thumbs[0] && loaded.every(Boolean), { back, loaded })
      if (which === 'chromium') await page.locator('.composer-inner').screenshot({ path: '.playwright-mcp/draft-after-reload.png' })

      /* Send clears ------------------------------------------------------ */
      await page.locator(FIELD).press('Enter')
      await page.waitForTimeout(500)
      back = await field(page)
      const sent = await page.evaluate(() => (window as any).__sent.at(-1))
      check(`${which}: sending a session's draft sends it and clears the box`, sent?.t === 'input' && sent.text === 'look at [image:1]' && back.value === '' && back.chips.length === 0 && back.thumbs.length === 0, { sent, back })
      check(`${which}: and nothing of it is left in storage`, !(sessionB in (await stored(page)).composer))

      await selectTab(page, draftId)
      await page.locator(FIELD).press('Enter')
      await page.waitForTimeout(300)
      const launch = await page.evaluate(() => {
        const w = window as any
        const request = w.__sent.at(-1)
        const template = w.__hello.sessions.find((s: any) => s.kind === 'agent') ?? w.__hello.sessions[0]
        const session = { ...template, id: request.req.id, title: 'launched', cwd: request.req.cwd, host: request.req.host ?? null, harness: request.req.harness, nativeId: null }
        const ws = w.__ws.find((s: WebSocket) => s.url.includes('/api/ws'))
        ws.onmessage({ data: JSON.stringify({ t: 'session', session }) })
        return { t: request.t, prompt: request.req.prompt, attachments: request.req.attachments?.length ?? 0, id: request.req.id }
      })
      await page.waitForTimeout(400)
      const storage = await stored(page)
      check(`${which}: launching sends the new tab's prompt and picture`, launch.t === 'new_session' && launch.prompt === written.value && launch.attachments === 1, launch)
      check(`${which}: once the session exists, the new tab's draft is gone`, !(draftId in storage.composer) && !(draftId in storage.drafts) && (await field(page)).active === launch.id, { storage, active: (await field(page)).active })

      /* Close clears ----------------------------------------------------- */
      await selectTab(page, sessionA)
      await page.locator(FIELD).click()
      await page.keyboard.type('never mind')
      await page.waitForTimeout(400)
      check(`${which}: a session's draft is stored while its tab is open`, (await stored(page)).composer[sessionA]?.text === 'never mind')
      await page.locator(`.tabs .tab[data-tab-id="${sessionA}"] .x`).click()
      await page.waitForTimeout(400)
      check(`${which}: closing a session's tab drops its draft`, !(sessionA in (await stored(page)).composer))
      await agentRows.nth(0).click()
      await page.waitForTimeout(400)
      check(`${which}: reopened, the session's box is empty`, (await field(page)).value === '', await field(page))

      await page.keyboard.press('Meta+d')
      await page.waitForTimeout(400)
      const second = (await field(page)).active!
      await page.locator(FIELD).click()
      await page.keyboard.type('scratch that')
      await pasteImage(page)
      await page.waitForTimeout(400)
      check(`${which}: a new tab's draft is stored while it is open`, (await stored(page)).composer[second]?.text === 'scratch that[image:1]' && second in (await stored(page)).drafts, { second, stored: await stored(page), field: await field(page) })
      await page.locator(`.tabs .tab[data-tab-id="${second}"] .x`).click()
      await page.waitForTimeout(400)
      const afterClose = await stored(page)
      check(`${which}: closing a new tab drops its draft and its settings`, !(second in afterClose.composer) && !(second in afterClose.drafts), afterClose)
      await page.reload({ waitUntil: 'networkidle' })
      await page.waitForTimeout(700)
      check(`${which}: and it does not come back on reload`, (await page.locator(`.tabs .tab[data-tab-id="${second}"]`).count()) === 0)

      check(`${which}: the page raised no errors`, errors.length === 0, errors)
    } finally {
      await browser.close()
    }
  }
} catch (error) {
  failures.push(error instanceof Error ? error.stack ?? error.message : String(error))
} finally {
  await runCleanups()
}

if (failures.length) {
  console.error(`\ndraft-persist-ui-test: FAILED\n${failures.join('\n')}`)
  process.exit(1)
}
console.log('\ndraft-persist-ui-test: PASSED')
