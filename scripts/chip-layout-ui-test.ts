#!/usr/bin/env bun
/**
 * An "Image N" chip sits in the text flow exactly where its `[image:N]` token
 * is — it can never drift from it, and the raw token can never show.
 *
 * The composer draws chips with a mirror over the textarea (see
 * `PromptField`). The proof is a pixel comparison of the same field drawn two
 * ways: by the textarea itself (mirror hidden, textarea glyphs visible) and by
 * the mirror alone (textarea glyphs hidden, chip labels off so the mirror shows
 * the token's own glyphs). If the mirror lays out a single glyph differently —
 * another wrap, a scroll it did not follow, a font property it did not copy —
 * the two pictures differ. Both composers (a session's and a new tab's
 * launchpad), long wrapped text with chips at line ends and starts, a scrolled
 * field, three widths; Chrome and WebKit, against a throwaway store.
 *
 *   bun scripts/chip-layout-ui-test.ts
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

const NATIVE = `
  .prompt-field.has-chips textarea { color: var(--fg) !important; caret-color: transparent !important; }
  .prompt-chips { visibility: hidden !important; }`
const MIRROR = `
  .prompt-field.has-chips textarea { color: transparent !important; caret-color: transparent !important; }
  .image-chip.in-field::before { display: none !important; }
  .image-chip.in-field { color: var(--fg) !important; }`

async function pasteImages(page: Page, selector: string, count: number): Promise<void> {
  await page.evaluate(async ({ selector, count }) => {
    const area = document.querySelector<HTMLTextAreaElement>(selector)!
    area.focus()
    area.setSelectionRange(area.value.length, area.value.length)
    const data = new DataTransfer()
    for (let index = 0; index < count; index += 1) {
      const canvas = document.createElement('canvas')
      canvas.width = 4
      canvas.height = 4
      canvas.getContext('2d')!.fillRect(0, 0, 4, 4)
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'))
      data.items.add(new File([blob], `s${index}.png`, { type: 'image/png' }))
    }
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: data })
    area.dispatchEvent(event)
  }, { selector, count })
  await page.waitForFunction(() => !document.querySelector('.attach.pending'), undefined, { timeout: 5000 })
}

/** Types a value as a user would, through React's own change path. */
async function setValue(page: Page, selector: string, value: string): Promise<void> {
  await page.evaluate(({ selector, value }) => {
    const area = document.querySelector<HTMLTextAreaElement>(selector)!
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(area, value)
    area.dispatchEvent(new Event('input', { bubbles: true }))
  }, { selector, value })
  await page.waitForTimeout(250)
}

/** The share of pixels that differ clearly between two PNG screenshots. */
async function difference(page: Page, a: Buffer, b: Buffer): Promise<number> {
  return page.evaluate(async ({ a, b }) => {
    const load = (data: string) =>
      new Promise<HTMLImageElement>((resolve) => {
        const image = new Image()
        image.onload = () => resolve(image)
        image.src = `data:image/png;base64,${data}`
      })
    const [first, second] = await Promise.all([load(a), load(b)])
    const width = Math.min(first.width, second.width)
    const height = Math.min(first.height, second.height)
    const read = (image: HTMLImageElement) => {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')!
      context.drawImage(image, 0, 0)
      return context.getImageData(0, 0, width, height).data
    }
    const x = read(first)
    const y = read(second)
    let differing = 0
    for (let index = 0; index < x.length; index += 4) {
      const delta = Math.abs(x[index]! - y[index]!) + Math.abs(x[index + 1]! - y[index + 1]!) + Math.abs(x[index + 2]! - y[index + 2]!)
      if (delta > 90) differing += 1
    }
    return differing / (width * height)
  }, { a: a.toString('base64'), b: b.toString('base64') })
}

/** The two drawings of the field, compared (see `compare`). */
async function sharedDifference(page: Page, selector: string): Promise<number> {
  await page.evaluate((selector) => document.querySelector<HTMLTextAreaElement>(selector)!.blur(), selector)
  const field = page.locator(selector)
  const native = await page.addStyleTag({ content: NATIVE })
  await page.waitForTimeout(60)
  const a = await field.screenshot()
  await native.evaluate((node) => (node as Element).remove())
  const mirror = await page.addStyleTag({ content: MIRROR })
  await page.waitForTimeout(60)
  const b = await field.screenshot()
  await mirror.evaluate((node) => (node as Element).remove())
  return difference(page, a, b)
}

/** Screenshot the field drawn natively and by the mirror, and compare. */
async function compare(page: Page, selector: string, label: string, shot?: string): Promise<void> {
  await page.evaluate((selector) => document.querySelector<HTMLTextAreaElement>(selector)!.blur(), selector)
  const field = page.locator(selector)
  const native = await page.addStyleTag({ content: NATIVE })
  await page.waitForTimeout(80)
  const a = await field.screenshot()
  await native.evaluate((node) => (node as Element).remove())
  const mirror = await page.addStyleTag({ content: MIRROR })
  await page.waitForTimeout(80)
  const b = await field.screenshot()
  await mirror.evaluate((node) => (node as Element).remove())
  await page.waitForTimeout(80)
  const share = await difference(page, a, b)
  check(`${label}: the mirror draws every glyph where the textarea does`, share < 0.001, { share })
  if (share >= 0.001 && process.env.CHIP_DEBUG) {
    const name = label.replace(/\W+/g, '-')
    await Bun.write(`.playwright-mcp/debug-${name}-native.png`, a)
    await Bun.write(`.playwright-mcp/debug-${name}-mirror.png`, b)
  }
  const state = await page.evaluate((selector) => {
    const area = document.querySelector<HTMLTextAreaElement>(selector)!
    return {
      color: getComputedStyle(area).color,
      chips: area.parentElement!.querySelectorAll('.image-chip').length,
      scrolled: area.scrollTop,
    }
  }, selector)
  check(`${label}: with chips in it, the textarea's own glyphs (the raw tokens) are invisible`, state.chips > 0 && /rgba\(.*,\s*0\)|transparent/.test(state.color), state)
  if (shot) await field.screenshot({ path: shot })
}

const WORDS =
  'Alessandro asked for the release checklist to be rewritten so that every step names its owner and the evidence it leaves behind'

const target = await resolveApp()
try {
  for (const which of ['chromium', 'webkit'] as const) {
    console.log(`\n— ${which}`)
    const browser = which === 'webkit' ? await webkit.launch() : await chromium.launch({ channel: 'chrome' })
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    try {
      await page.goto(target.url, { waitUntil: 'networkidle' })
      await page.waitForTimeout(700)
      await openRichestSession(page)

      for (const where of ['session', 'launchpad'] as const) {
        const selector = where === 'session' ? '.composer textarea' : '.launchpad-field textarea'
        if (where === 'launchpad') {
          await page.keyboard.press('Meta+d')
          await page.waitForTimeout(500)
        }
        await pasteImages(page, selector, 4)
        // Tokens glued to words, at the start of a line, at the end of the text,
        // after a newline, and one on a line of its own.
        const text = `${WORDS} Alessandro[image:1]\n[image:2] ${WORDS}, ${WORDS.slice(0, 57)}[image:3]\n\n${WORDS} ${WORDS}\n[image:4]\n`
        await setValue(page, selector, text)
        for (const width of [1280, 1040, 860]) {
          await page.setViewportSize({ width, height: 860 })
          await page.waitForTimeout(300)
          await compare(page, selector, `${which} ${where} ${width}px`, which === 'chromium' && width === 1040 ? `.playwright-mcp/chip-layout-${where}.png` : undefined)
        }
        // Fractional widths: a centred or percentage-sized field is rarely a
        // whole number of pixels wide, and a mirror that is a fraction narrower
        // wraps a token onto the next line while the textarea keeps it.
        await page.setViewportSize({ width: 1180, height: 860 })
        let worst = 0
        const drifted: number[] = []
        for (let step = 0; step < 24; step += 1) {
          const width = 560 + step * 1.37
          const sized = await page.addStyleTag({ content: `.prompt-field { width: ${width}px; }` })
          await page.waitForTimeout(120)
          const share = await sharedDifference(page, selector)
          await sized.evaluate((node) => (node as Element).remove())
          worst = Math.max(worst, share)
          if (share >= 0.001) drifted.push(width)
        }
        check(`${which} ${where}: at fractional widths the chips wrap exactly with the text`, drifted.length === 0, { drifted, worst })
        await page.setViewportSize({ width: 1280, height: 860 })

        // Scrolled: taller than the field's cap, and read from the middle.
        await setValue(page, selector, `${text}${WORDS}\n${WORDS} [image:1]\n`.repeat(1).replace(/\[image:1\]\n$/, 'end\n'))
        await page.evaluate((selector) => {
          const area = document.querySelector<HTMLTextAreaElement>(selector)!
          area.scrollTop = Math.round((area.scrollHeight - area.clientHeight) / 2)
          area.dispatchEvent(new Event('scroll'))
        }, selector)
        const scrollable = await page.evaluate((selector) => {
          const area = document.querySelector<HTMLTextAreaElement>(selector)!
          return area.scrollHeight > area.clientHeight && area.scrollTop > 0
        }, selector)
        check(`${which} ${where}: the long draft scrolls inside the field`, scrollable)
        await compare(page, selector, `${which} ${where} scrolled`)
        await page.evaluate((selector) => {
          const area = document.querySelector<HTMLTextAreaElement>(selector)!
          area.scrollTop = area.scrollHeight
          area.dispatchEvent(new Event('scroll'))
        }, selector)
        await compare(page, selector, `${which} ${where} scrolled to the end, past a trailing newline`, which === 'chromium' ? `.playwright-mcp/chip-layout-${where}-scrolled.png` : undefined)
      }
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
  console.error(`\nchip-layout-ui-test: FAILED\n${failures.join('\n')}`)
  process.exit(1)
}
console.log('\nchip-layout-ui-test: PASSED')
