#!/usr/bin/env bun
/**
 * The tab strip must reorder at pointer speed, without the delayed ghost made by
 * native HTML drag-and-drop. Runs against a throwaway store and real Chrome.
 */
import { chromium } from 'playwright'
import { installExitHandlers, runCleanups } from './lib/harness.ts'
import { resolveApp, expandRail } from './lib/app.ts'

installExitHandlers()
const target = await resolveApp()
const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const failures: string[] = []
const errors: string[] = []

page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text())
})
page.on('pageerror', (error) => errors.push(error.message))

function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

try {
  await page.goto(target.url, { waitUntil: 'networkidle' })
  await page.waitForTimeout(700)

  const workspace = page.locator('.rail-title.workspace').first()
  if (!(await page.locator('.rail .session-item:not(.draft)').count())) {
    await workspace.click()
    await page.waitForTimeout(250)
  }
  await expandRail(page)
  const rows = page.locator('.rail .session-item:not(.draft)')
  check('the fixture offers at least three sessions', (await rows.count()) >= 3)
  for (let index = 0; index < 3; index += 1) {
    await rows.nth(index).click()
    await page.waitForTimeout(180)
  }

  const tabs = page.locator('.tabs .tab')
  check('three tabs are open', (await tabs.count()) >= 3)
  // Stage a machine tint directly so drag geometry is tested with the coloured
  // tab surface, without depending on a particular SSH host.
  await tabs.evaluateAll((nodes) => {
    for (const node of nodes as HTMLElement[]) {
      node.style.setProperty('--machine', 'var(--machine-teal)')
    }
  })
  const before = await tabs.evaluateAll((nodes) =>
    nodes.map((node) => ({
      id: node.getAttribute('data-tab-id'),
      draggable: node.getAttribute('draggable'),
      cursor: getComputedStyle(node).cursor,
      border: getComputedStyle(node).borderLeftWidth,
      background: getComputedStyle(node).backgroundColor,
    })),
  )
  check('the machine colour has no side line', before.every((tab) => tab.border === '0px'), before)
  check(
    'the machine colour remains as a background tint',
    before.every((tab) => !['transparent', 'rgba(0, 0, 0, 0)'].includes(tab.background)),
    before,
  )
  check('native draggable ghosts are disabled', before.every((tab) => tab.draggable === null), before)
  check('resting tabs use the arrow cursor', before.every((tab) => tab.cursor === 'default'), before)

  const first = tabs.nth(0)
  const second = tabs.nth(1)
  const last = tabs.nth(2)
  const source = await first.boundingBox()
  const neighbour = await second.boundingBox()
  const destination = await last.boundingBox()
  if (!source || !neighbour || !destination) throw new Error('could not measure tabs')
  const grabX = source.x + source.width / 2
  const grabY = source.y + source.height / 2
  const endX = destination.x + destination.width + 10
  const offsetX = source.width / 2
  const sourceId = before[0]?.id
  const samples: Array<{ pointer: number; left: number; order: Array<string | null>; animated: boolean; cursor: string | null }> = []

  await page.mouse.move(grabX, grabY)
  await page.mouse.down()
  for (let step = 1; step <= 14; step += 1) {
    const pointer = grabX + ((endX - grabX) * step) / 14
    await page.mouse.move(pointer, grabY)
    await page.waitForTimeout(18)
    samples.push(await page.locator('.tabs').evaluate((strip, x) => {
      const held = strip.querySelector<HTMLElement>('.tab.dragging')
      return {
        pointer: x as number,
        left: held?.getBoundingClientRect().left ?? Number.NaN,
        order: [...strip.querySelectorAll('.tab')].map((tab) => tab.getAttribute('data-tab-id')),
        animated: [...strip.querySelectorAll<HTMLElement>('.tab:not(.dragging)')]
          .some((tab) => tab.getAnimations().length > 0),
        cursor: held ? getComputedStyle(held).cursor : null,
      }
    }, pointer))
  }

  const reorderedBeforeDrop = samples.some((sample) => sample.order.at(-1) === sourceId)
  const firstSwap = samples.find((sample) => sample.order.indexOf(sourceId ?? '') > 0)
  const trackingError = Math.max(...samples.map((sample) => Math.abs(sample.left - (sample.pointer - offsetX))))
  check('the tab changes position before pointer-up', reorderedBeforeDrop, samples.map((sample) => sample.order))
  check(
    'the neighbour moves at its 75% threshold, before the held tab reaches its centre',
    Boolean(firstSwap && firstSwap.pointer < neighbour.x + neighbour.width / 2),
    { firstSwap: firstSwap?.pointer, neighbourCentre: neighbour.x + neighbour.width / 2 },
  )
  check('the held tab follows the pointer frame-for-frame', trackingError < 3, { trackingError })
  check('the held tab shows the dragging cursor', samples.some((sample) => sample.cursor === 'grabbing'))
  check('neighbouring tabs animate out of the way', samples.some((sample) => sample.animated))

  await page.mouse.up()
  await page.waitForTimeout(180)
  const after = await tabs.evaluateAll((nodes) => nodes.map((node) => ({
    id: node.getAttribute('data-tab-id'),
    left: node.getBoundingClientRect().left,
    transform: getComputedStyle(node).transform,
  })))
  check('the dropped tab stays in its new position', after.at(-1)?.id === sourceId, after)
  check('all tabs settle without overlap', after.every((tab, index) => index === 0 || tab.left > after[index - 1]!.left), after)
  check('the drag leaves no transform behind', after.every((tab) => tab.transform === 'none'), after)
  check('the browser console stays clean', errors.length === 0, errors)

  await page.locator('.tabs').screenshot({ path: '.playwright-mcp/tab-drag-smooth.png' })
} catch (error) {
  failures.push(error instanceof Error ? error.stack ?? error.message : String(error))
} finally {
  await browser.close()
  await runCleanups()
}

if (failures.length) {
  console.error(`\ntab-drag-ui-test: FAILED\n${failures.join('\n')}`)
  process.exit(1)
}
console.log('\ntab-drag-ui-test: PASSED')
