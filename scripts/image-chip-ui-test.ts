#!/usr/bin/env bun
/**
 * Pasted images read as "Image N" chips in the composer, and the chip, the
 * thumbnail and the `[image:N]` token sent to the harness are one thing:
 *
 * - a paste puts a chip where the caret was, and the caret cannot enter it;
 * - Backspace (or Delete) beside a chip removes the chip *and* its picture;
 * - removing a thumbnail removes its chip;
 * - what is left renumbers, so chips, thumbnails and tokens always agree;
 * - the text sent carries tokens that match the attachments sent with it;
 * - the sent bubble shows the same chips, and a cancelled prompt brought back
 *   with Edit keeps its pictures in step with the draft it joins.
 *
 * Chrome and WebKit, against a throwaway store. Outgoing prompts are captured
 * in the page and never reach the server, so no harness is started.
 *
 *   bun scripts/image-chip-ui-test.ts
 */
import { chromium, webkit, type Page } from 'playwright'
import { installExitHandlers, runCleanups } from './lib/harness.ts'
import { openRichestSession, resolveApp } from './lib/app.ts'

installExitHandlers()
const failures: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

/** Everything the composer shows, read at once. */
function composer(page: Page) {
  return page.evaluate(() => {
    const area = document.querySelector<HTMLTextAreaElement>('.composer textarea')!
    const box = area.getBoundingClientRect()
    return {
      value: area.value,
      caret: [area.selectionStart, area.selectionEnd],
      chips: [...document.querySelectorAll<HTMLElement>('.composer .prompt-chips .image-chip')].map((chip) => {
        const rect = chip.getBoundingClientRect()
        return {
          label: chip.dataset.label ?? '',
          inside: rect.width > 4 && rect.left >= box.left - 1 && rect.right <= box.right + 1 && rect.top >= box.top - 1,
        }
      }),
      thumbs: [...document.querySelectorAll<HTMLElement>('.composer .attach:not(.pending)')].map((node) => ({
        tag: node.querySelector('.attach-tag')?.textContent ?? '',
        src: node.querySelector('img')?.getAttribute('src') ?? '',
      })),
      uploading: Boolean(document.querySelector('.composer .attach.pending')),
    }
  })
}

type Snapshot = Awaited<ReturnType<typeof composer>>
const tokens = (value: string) => [...value.matchAll(/\[image:(\d+)\]/g)].map((match) => Number(match[1]))
const labels = (snap: Snapshot) => snap.chips.map((chip) => chip.label)

/** Pastes `count` distinct PNGs at the caret, the way a clipboard does. */
async function pasteImages(page: Page, count: number): Promise<void> {
  await page.evaluate(async (count) => {
    const area = document.querySelector<HTMLTextAreaElement>('.composer textarea')!
    const data = new DataTransfer()
    for (let index = 0; index < count; index += 1) {
      const canvas = document.createElement('canvas')
      canvas.width = 8
      canvas.height = 8
      const context = canvas.getContext('2d')!
      context.fillStyle = `hsl(${Math.floor(Math.random() * 360)}, 70%, 50%)`
      context.fillRect(0, 0, 8, 8)
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'))
      data.items.add(new File([blob], `shot-${Date.now()}-${index}.png`, { type: 'image/png' }))
    }
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: data })
    area.dispatchEvent(event)
  }, count)
  await page.waitForFunction(() => !document.querySelector('.composer .attach.pending'), undefined, { timeout: 5000 })
  await page.waitForTimeout(150)
}

/** Pastes plain text, as a copied chip would arrive. */
async function pasteText(page: Page, text: string): Promise<void> {
  await page.evaluate((text) => {
    const area = document.querySelector<HTMLTextAreaElement>('.composer textarea')!
    const data = new DataTransfer()
    data.setData('text/plain', text)
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: data })
    area.dispatchEvent(event)
  }, text)
  await page.waitForTimeout(120)
}

async function setCaret(page: Page, at: number): Promise<void> {
  await page.evaluate((at) => {
    const area = document.querySelector<HTMLTextAreaElement>('.composer textarea')!
    area.focus()
    area.setSelectionRange(at, at)
  }, at)
  await page.waitForTimeout(80)
}

const target = await resolveApp()
try {
  for (const which of ['chromium', 'webkit'] as const) {
    console.log(`\n— ${which}`)
    const browser = which === 'webkit' ? await webkit.launch() : await chromium.launch({ channel: 'chrome' })
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    // Prompts are kept in the page: the check is about what *would* be sent.
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
        override send(data: string) {
          const message = JSON.parse(data)
          if (message.t === 'input') {
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
      const opened = await openRichestSession(page)
      check(`${which}: an agent session with a composer is open`, opened.composer, opened)
      const area = page.locator('.composer textarea')
      await area.click()

      // 1. Paste puts a chip where the caret is.
      await page.keyboard.type('look at ')
      await pasteImages(page, 1)
      await page.keyboard.type(' and ')
      await pasteImages(page, 1)
      await page.keyboard.type(' then')
      let snap = await composer(page)
      check(`${which}: the text keeps a token per paste`, snap.value === 'look at [image:1] and [image:2] then', snap.value)
      check(`${which}: each token is drawn as an "Image N" chip`, labels(snap).join() === 'Image 1,Image 2', labels(snap))
      check(`${which}: the chips sit over the text box`, snap.chips.every((chip) => chip.inside), snap.chips)
      check(`${which}: one thumbnail per chip, numbered alike`, snap.thumbs.map((t) => t.tag).join() === '1,2', snap.thumbs)
      const badges = await page.evaluate(() => {
        const shape = (node: Element | null) => {
          if (!node) return null
          const rect = node.getBoundingClientRect()
          const glyph = node.querySelector('svg')?.getBoundingClientRect()
          return {
            width: rect.width,
            height: rect.height,
            radius: getComputedStyle(node).borderTopLeftRadius,
            // How far the X's centre is from the circle's.
            offset: glyph ? Math.hypot(glyph.left + glyph.width / 2 - (rect.left + rect.width / 2), glyph.top + glyph.height / 2 - (rect.top + rect.height / 2)) : 0,
            text: node.textContent,
          }
        }
        return { tag: shape(document.querySelector('.composer .attach-tag')), remove: shape(document.querySelector('.composer .attach-remove')) }
      })
      const round = (b: typeof badges.tag) => Boolean(b && b.width === b.height && b.width >= 16 && b.radius === '50%')
      check(`${which}: the number and the X are exact circles of one size`, round(badges.tag) && round(badges.remove) && badges.tag!.width === badges.remove!.width, badges)
      check(`${which}: the X is an icon, centred in its circle`, badges.remove?.text === '' && (badges.remove?.offset ?? 9) <= 0.5, badges.remove)
      if (which === 'chromium') {
        // A touch screen: the X keeps its size but takes a finger-sized hit.
        const cdp = await page.context().newCDPSession(page)
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
        // Chrome flips `(pointer: coarse)` asynchronously; under load a fixed
        // pause was not always enough, so wait for the media query itself.
        await page.waitForFunction(() => matchMedia('(pointer: coarse)').matches, undefined, { timeout: 5000 }).catch(() => {})
        const touch = await page.evaluate(() => {
          const remove = document.querySelector<HTMLElement>('.composer .attach-remove')!
          const rect = remove.getBoundingClientRect()
          const x = rect.left + rect.width / 2
          const y = rect.top + rect.height / 2
          const hit = (dx: number, dy: number) => document.elementFromPoint(x + dx, y + dy)?.closest('.attach-remove') === remove
          return { coarse: matchMedia('(pointer: coarse)').matches, visual: rect.width, reach: [hit(0, -20), hit(0, 20), hit(20, 0)] }
        })
        check(`${which}: on a touch screen the X is hit 20px out from its centre`, touch.coarse && touch.visual < 24 && touch.reach.every(Boolean), touch)
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false })
        await cdp.detach()
      }
      const [firstSrc, secondSrc] = snap.thumbs.map((t) => t.src)
      if (which === 'chromium') await page.locator('.composer-inner').screenshot({ path: '.playwright-mcp/image-chips-composer.png' })
      if (which === 'webkit') await page.locator('.composer-inner').screenshot({ path: '.playwright-mcp/image-chips-composer-webkit.png' })

      // 2. The caret cannot enter a chip.
      const firstEnd = snap.value.indexOf('[image:1]') + '[image:1]'.length
      const firstStart = snap.value.indexOf('[image:1]')
      await setCaret(page, firstEnd)
      await page.keyboard.press('ArrowLeft')
      await page.waitForTimeout(80)
      snap = await composer(page)
      check(`${which}: ← from after a chip jumps over it`, snap.caret[0] === firstStart && snap.caret[1] === firstStart, snap.caret)
      await page.keyboard.press('ArrowRight')
      await page.waitForTimeout(80)
      snap = await composer(page)
      check(`${which}: → from before a chip jumps over it`, snap.caret[0] === firstEnd, snap.caret)
      const chipBox = await page.locator('.composer .prompt-chips .image-chip').first().boundingBox()
      if (chipBox) {
        await page.mouse.click(chipBox.x + chipBox.width * 0.3, chipBox.y + chipBox.height / 2)
        await page.waitForTimeout(120)
        snap = await composer(page)
        check(`${which}: a click on a chip leaves the caret at its edge`, [firstStart, firstEnd].includes(snap.caret[0]!) && snap.caret[0] === snap.caret[1], snap.caret)
      }

      // 3. Backspace beside a chip removes the chip and its picture, and the
      //    other one renumbers.
      await setCaret(page, firstEnd)
      await page.keyboard.press('Backspace')
      await page.waitForTimeout(150)
      snap = await composer(page)
      check(`${which}: one Backspace removes the whole chip`, snap.value === 'look at  and [image:1] then', snap.value)
      check(`${which}: the remaining chip is renumbered`, labels(snap).join() === 'Image 1', labels(snap))
      check(`${which}: the picture went with it, and the other one stayed`, snap.thumbs.length === 1 && snap.thumbs[0]!.src === secondSrc && snap.thumbs[0]!.tag === '1', { thumbs: snap.thumbs, firstSrc, secondSrc })

      // 4. Removing a thumbnail removes its chip.
      await setCaret(page, snap.value.length)
      await page.keyboard.type(' plus ')
      await pasteImages(page, 2)
      snap = await composer(page)
      check(`${which}: a two-image paste adds two chips`, labels(snap).join() === 'Image 1,Image 2,Image 3' && snap.thumbs.length === 3, { labels: labels(snap), thumbs: snap.thumbs.length })
      const thirdSrc = snap.thumbs[2]!.src
      await page.locator('.composer .attach').nth(1).hover()
      await page.locator('.composer .attach-remove').nth(1).click()
      await page.waitForTimeout(150)
      snap = await composer(page)
      check(`${which}: removing thumbnail 2 removes chip 2`, tokens(snap.value).join() === '1,2' && labels(snap).join() === 'Image 1,Image 2', { value: snap.value, labels: labels(snap) })
      check(`${which}: the thumbnails renumber with the chips`, snap.thumbs.map((t) => t.tag).join() === '1,2' && snap.thumbs[1]!.src === thirdSrc, snap.thumbs)

      // 5. Delete before a chip removes it too.
      const lastStart = snap.value.indexOf('[image:2]')
      await setCaret(page, lastStart)
      await page.keyboard.press('Delete')
      await page.waitForTimeout(150)
      snap = await composer(page)
      check(`${which}: Delete before a chip removes chip and picture`, tokens(snap.value).join() === '1' && snap.thumbs.length === 1, { value: snap.value, thumbs: snap.thumbs.length })

      // 6. Undo brings the text back but never a chip without its picture.
      await page.keyboard.press('Meta+z')
      await page.waitForTimeout(150)
      snap = await composer(page)
      check(`${which}: after undo, every chip still has a picture`, tokens(snap.value).every((n) => n <= snap.thumbs.length) && snap.chips.length === snap.thumbs.length, { value: snap.value, thumbs: snap.thumbs.length })

      // 7. A copied chip pasted as text does not point at a picture it lacks.
      await setCaret(page, (await composer(page)).value.length)
      await pasteText(page, ' see [image:7] here')
      snap = await composer(page)
      check(`${which}: pasted text loses its tokens, keeps its words`, snap.value.endsWith(' see here') && tokens(snap.value).length === snap.thumbs.length, snap.value)

      // 8. What is sent: tokens and attachments agree.
      await setCaret(page, (await composer(page)).value.length)
      await pasteImages(page, 1)
      snap = await composer(page)
      const expectedIds = snap.thumbs.map((t) => t.src.split('/').pop())
      await area.press('Enter')
      await page.waitForTimeout(200)
      const sent = await page.evaluate(() => (window as any).__sent.at(-1) as { sessionId: string; text: string; attachments?: Array<{ id: string; name: string; mediaType: string }> })
      const sentTokens = tokens(sent?.text ?? '')
      check(
        `${which}: the sent text numbers its tokens 1…N, one per attachment`,
        sentTokens.length === (sent?.attachments?.length ?? 0) && [...sentTokens].sort().every((n, index) => n === index + 1),
        { text: sent?.text, attachments: sent?.attachments?.length },
      )
      check(`${which}: the attachments sent are the thumbnails shown, in order`, JSON.stringify(sent?.attachments?.map((a) => a.id)) === JSON.stringify(expectedIds), { sent: sent?.attachments?.map((a) => a.id), expectedIds })
      snap = await composer(page)
      check(`${which}: the composer is empty after sending`, snap.value === '' && snap.thumbs.length === 0 && snap.chips.length === 0, snap)

      // 9. The sent bubble draws the same chips (fed to the page's own socket).
      const bubble = await page.evaluate(async (sent) => {
        const w = window as any
        const ws = w.__ws.find((s: WebSocket) => s.url.includes('/api/ws'))
        const at = Date.now()
        ws.onmessage({ data: JSON.stringify({ t: 'event', sessionId: sent.sessionId, event: { id: 'chip-sent', sessionId: sent.sessionId, seq: 990001, at, turnId: 'chip-turn', ev: { k: 'user', text: sent.text, attachments: sent.attachments, delivery: 'delivered' } } }) })
        ws.onmessage({ data: JSON.stringify({ t: 'event', sessionId: sent.sessionId, event: { id: 'chip-cancelled', sessionId: sent.sessionId, seq: 990002, at: at + 1, turnId: 'chip-turn-2', ev: { k: 'user', text: 'restored [image:1]', attachments: sent.attachments!.slice(0, 1), delivery: 'cancelled', cancelledBy: 'server', promptId: 'chip-p' } } }) })
        await new Promise((r) => setTimeout(r, 500))
        const scroller = document.querySelector('.transcript') as HTMLElement
        scroller.scrollTop = scroller.scrollHeight
        await new Promise((r) => setTimeout(r, 200))
        const bodies = [...document.querySelectorAll<HTMLElement>('.msg-user .msg-body')]
        const node = bodies.find((body) => body.textContent?.startsWith('look at'))
        return {
          found: Boolean(node),
          text: node?.textContent ?? '',
          chips: [...(node?.querySelectorAll('.image-chip') ?? [])].map((chip) => chip.textContent),
        }
      }, sent)
      check(`${which}: the sent bubble shows chips, not raw tokens`, bubble.found && !bubble.text.includes('[image:') && bubble.chips.length === sentTokens.length && bubble.chips.every((label, index) => label === `Image ${sentTokens[index]}`), bubble)
      const sentBubble = page.locator('.msg-user', { hasText: 'look at' }).last()
      await sentBubble.scrollIntoViewIfNeeded()
      if (which === 'chromium') await sentBubble.screenshot({ path: '.playwright-mcp/image-chips-bubble.png' })
      const layout = await sentBubble.evaluate((node) => {
        const strip = node.querySelector('.attach-strip.sent')!.getBoundingClientRect()
        const card = node.querySelector('.msg-user-card')!.getBoundingClientRect()
        const chip = node.querySelector('.image-chip')!
        return { stripBottom: strip.bottom, cardTop: card.top, margin: getComputedStyle(chip).marginLeft }
      })
      check(`${which}: the pictures sit above the bubble`, layout.stripBottom <= layout.cardTop, layout)
      check(`${which}: a chip keeps some room from the words beside it`, Number.parseFloat(layout.margin) >= 2, layout)
      await sentBubble.locator('.image-chip').first().click()
      await page.waitForTimeout(400)
      const zoomed = await page.evaluate(() => {
        const img = document.querySelector<HTMLImageElement>('.lightbox img')
        const rect = img?.getBoundingClientRect()
        return { open: Boolean(img), width: rect?.width ?? 0, height: rect?.height ?? 0, vw: innerWidth, vh: innerHeight, src: img?.getAttribute('src') }
      })
      check(`${which}: a chip in the bubble opens its picture`, zoomed.open)
      check(
        `${which}: the picture opens fitted to the window, not at its own size`,
        zoomed.width <= zoomed.vw * 0.921 && zoomed.height <= zoomed.vh * 0.901 && (zoomed.width >= zoomed.vw * 0.9 || zoomed.height >= zoomed.vh * 0.88),
        zoomed,
      )
      if (which === 'chromium') await page.screenshot({ path: '.playwright-mcp/image-lightbox.png' })
      await page.mouse.click(zoomed.vw / 2, zoomed.vh / 2)
      await page.waitForTimeout(400)
      check(`${which}: a click on the picture closes it`, !(await page.locator('.lightbox').count()))
      await sentBubble.locator('.attach img').first().click()
      await page.waitForTimeout(300)
      check(`${which}: a thumbnail opens it too`, (await page.locator('.lightbox').count()) === 1)
      await page.keyboard.press('Escape')
      await page.waitForTimeout(400)
      check(`${which}: Esc closes it`, !(await page.locator('.lightbox').count()))

      // 10. Edit on a cancelled prompt brings it back ahead of the draft: its
      //     picture goes first, the draft's own chips shift past it.
      await area.click()
      await page.keyboard.type('draft ')
      await pasteImages(page, 1)
      const draftSrc = (await composer(page)).thumbs[0]!.src
      await page.locator('.msg-user', { hasText: 'restored' }).last().locator('.prompt-cancel').click()
      await page.waitForTimeout(300)
      snap = await composer(page)
      check(`${which}: the restored prompt and the draft agree after renumbering`, snap.value === 'restored [image:1]\n\ndraft [image:2]' && labels(snap).join() === 'Image 1,Image 2', { value: snap.value, labels: labels(snap) })
      check(`${which}: the restored picture comes first, the draft's second`, snap.thumbs.length === 2 && snap.thumbs[1]!.src === draftSrc, snap.thumbs)
      if (which === 'chromium') await page.locator('.composer-inner').screenshot({ path: '.playwright-mcp/image-chips-restored.png' })

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
  console.error(`\nimage-chip-ui-test: FAILED\n${failures.join('\n')}`)
  process.exit(1)
}
console.log('\nimage-chip-ui-test: PASSED')
