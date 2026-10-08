#!/usr/bin/env bun
/**
 * The docs' phone screenshots (apps/site/public/shots/phone-{light,dark}.webp):
 * the landing page's phone mockup with the real demo inside, upright, at 2×,
 * on a question card. Needs the built site served:
 *
 *   cd apps/site && bun run build && bun x astro preview --port 4401
 *   bun scripts/site-phone-shots.ts            # SITE_URL=… to use another server
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { ROOT } from './lib/harness.ts'

const site = process.env.SITE_URL ?? 'http://localhost:4401'
const shots = join(ROOT, 'apps/site/public/shots')
// sharp is the site's own dependency (Astro uses it for images).
type Sharp = (input: Buffer) => { webp(options: object): { toFile(path: string): Promise<{ width: number; height: number; size: number }> } }
const sharp = createRequire(join(ROOT, 'apps/site/package.json'))('sharp') as Sharp

const browser = await chromium.launch({ channel: 'chrome' })
try {
  for (const theme of ['light', 'dark'] as const) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 2 })
    await context.addInitScript((t) => localStorage.setItem('starlight-theme', t), theme)
    const page = await context.newPage()
    await page.goto(`${site}/`, { waitUntil: 'networkidle' })
    const device = page.locator('[data-phone-stage]')
    await device.scrollIntoViewIfNeeded()
    const iframe = await page.waitForSelector('iframe[data-phone-demo][src]')
    // Upright, full size, on a transparent page; the demo on a waiting question.
    await page.evaluate((t) => {
      const fit = document.querySelector<HTMLElement>('[data-phone-fit]')!
      fit.style.setProperty('--s', '1')
      fit.style.setProperty('--tilt', '0deg')
      document.querySelector('[data-phone-stage]')!.classList.add('is-active')
      document.documentElement.style.background = 'transparent'
      document.body.style.background = 'transparent'
      document.querySelector<HTMLIFrameElement>('iframe[data-phone-demo]')!.src = `/demo/?embed=1&phone=1&theme=${t}&session=demo-question`
    }, theme)
    const frame = await iframe.contentFrame()
    await frame!.waitForSelector('.question.request[data-request-state="pending"]', { timeout: 20_000 })
    await frame!.evaluate(() => document.querySelectorAll('.demo-pill, .demo-tips').forEach((el) => el.remove()))
    await page.waitForTimeout(1200)
    // A little margin, so the side keys outside the frame are in the picture.
    const box = (await device.boundingBox())!
    const clip = { x: box.x - 6, y: box.y - 2, width: box.width + 12, height: box.height + 4 }
    const png = await page.screenshot({ clip, omitBackground: true, animations: 'disabled' })
    const out = join(shots, `phone-${theme}.webp`)
    const info = await sharp(png).webp({ quality: 82, alphaQuality: 90 }).toFile(out)
    console.log(`wrote ${out} (${info.width}×${info.height}, ${Math.round(info.size / 1024)} KB)`)
    await context.close()
  }
} finally {
  await browser.close()
}
