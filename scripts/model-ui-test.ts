#!/usr/bin/env bun
/** Model names and effort capabilities as the real composer renders them. */
import { chromium } from 'playwright'
import { installExitHandlers, runCleanups } from './lib/harness.ts'
import { openRichestSession, resolveApp } from './lib/app.ts'

installExitHandlers()
if (!process.argv[2]) process.env.SEDANO_SEED_CODEX_MODELS = '1'
const target = await resolveApp(process.argv[2])
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
  await openRichestSession(page)
  const claudeCaps = await page.evaluate(async () => {
    const caps = await fetch('/api/caps').then((response) => response.json()) as {
      harnesses?: Array<{ id?: string; models?: Array<{ label?: string }> }>
    }
    return caps.harnesses?.find((harness) => harness.id === 'claude')?.models?.map((model) => model.label) ?? []
  })

  const controls = page.locator('.composer-controls .select-trigger')
  check('the composer exposes model and effort controls', (await controls.count()) >= 3)

  await controls.nth(0).click()
  check('the model menu can force a fresh catalog', await page.getByRole('button', { name: 'Refresh models & version' }).count() === 1)
  const modelLabels = await page.locator('.menu-pop .menu-item-name').allTextContents()
  check('Claude aliases name the concrete Opus version', modelLabels.some((label) => /^Opus \d+\.\d+/.test(label)), { modelLabels, claudeCaps })
  check('Claude aliases name the concrete Fable version', modelLabels.some((label) => /^Fable \d+\.\d+/.test(label)), { modelLabels, claudeCaps })
  await page.screenshot({ path: '.playwright-mcp/model-version-picker.png' })
  await page.keyboard.press('Escape')

  await controls.nth(1).click()
  const effortLabels = await page.locator('.menu-pop .menu-item-name').allTextContents()
  for (const label of ['Auto', 'Low', 'Medium', 'High', 'Xhigh', 'Max']) {
    check(`the effort menu offers ${label}`, effortLabels.includes(label), effortLabels)
  }
  await page.getByRole('button', { name: 'High', exact: true }).click()
  await page.waitForFunction(() =>
    [...document.querySelectorAll<HTMLElement>('.composer-controls .select-trigger')][1]?.innerText.includes('High'),
  ).catch(() => undefined)
  const selectedEffort = await controls.nth(1).innerText()
  check('choosing an effort updates the composer immediately', selectedEffort.includes('High'), selectedEffort)
  check('the browser console stays clean', errors.length === 0, errors)

  await page.locator('.composer').screenshot({ path: '.playwright-mcp/model-effort-picker.png' })

  /* ACP effort options are dynamic for each model, not a harness-wide list. */
  const openCodeInstalled = await page.evaluate(async () => {
    const caps = await fetch('/api/caps').then((response) => response.json()) as {
      harnesses?: Array<{ id?: string; installed?: boolean }>
    }
    return caps.harnesses?.some((harness) => harness.id === 'opencode' && harness.installed) ?? false
  })
  if (openCodeInstalled) {
    await page.waitForFunction(async () => {
      const caps = await fetch('/api/caps').then((response) => response.json()) as {
        harnesses?: Array<{ id?: string; models?: Array<{ efforts?: string[] }> }>
      }
      const models = caps.harnesses?.find((harness) => harness.id === 'opencode')?.models ?? []
      return models.length > 0 && models.every((model) => model.efforts !== undefined)
    }, null, { timeout: 20_000 })
    // Reload so the UI consumes the completed background capability scan even
    // when the websocket notification raced the first page load.
    await page.reload({ waitUntil: 'networkidle' })
    await openRichestSession(page)
    await page.keyboard.press('Meta+d')
    await page.waitForSelector('.launchpad-row')
    // The folder chip's workspace menu is also a trigger; skip it so nth(0) is the harness.
    const launchControls = page.locator('.launchpad-row .menu:not(.workspace-menu) > .select-trigger')

    await launchControls.nth(0).click()
    await page.locator('.menu-pop .menu-item', { hasText: 'Opencode' }).click()

    await launchControls.nth(1).click()
    check('the new-session picker also offers a force refresh', await page.getByRole('button', { name: 'Refresh models & version' }).count() === 1)
    await page.locator('.menu-pop .menu-search input').fill('mimo-v2.6-flash-free')
    await page.locator('.menu-pop .menu-item').first().click()
    const fixedEffort = launchControls.nth(2)
    check('OpenCode MiMo is reported as having no effort setting', (await fixedEffort.innerText()).includes('Default'))
    check('a fixed model cannot send a guessed effort', await fixedEffort.isDisabled())

    await launchControls.nth(1).click()
    await page.locator('.menu-pop .menu-search input').fill('gpt-5.6-luna')
    await page.locator('.menu-pop .menu-item').first().click()
    check('an adjustable OpenCode model enables its effort control', !(await fixedEffort.isDisabled()))
    await fixedEffort.click()
    const openCodeEfforts = await page.locator('.menu-pop .menu-item-name').allTextContents()
    for (const label of ['Auto', 'Low', 'Medium', 'High', 'Xhigh', 'Max']) {
      check(`OpenCode Luna offers only its reported ${label}`, openCodeEfforts.includes(label), openCodeEfforts)
    }
    await page.screenshot({ path: '.playwright-mcp/opencode-model-efforts.png' })
    await page.keyboard.press('Escape')
  }

  // Codex ACP reports effort as separate model ids (`gpt-6-luna[low]`), not
  // as `model.efforts`. This is the real draft regression: the label was shown
  // but the adjacent trigger was disabled, so nobody could change it.
  const codexWithEncodedEfforts = await page.evaluate(async () => {
    const caps = await fetch('/api/caps').then((response) => response.json()) as {
      harnesses?: Array<{ id?: string; installed?: boolean; models?: Array<{ id?: string }> }>
    }
    return caps.harnesses?.some((harness) => harness.id === 'codex' && harness.installed &&
      harness.models?.some((model) => model.id === 'gpt-6-luna[low]')) ?? false
  })
  if (codexWithEncodedEfforts) {
    await page.keyboard.press('Meta+d')
    await page.waitForSelector('.launchpad-row')
    // The folder chip's workspace menu is also a trigger; skip it so nth(0) is the harness.
    const launchControls = page.locator('.launchpad-row .menu:not(.workspace-menu) > .select-trigger')
    await launchControls.nth(0).click()
    await page.locator('.menu-pop .menu-item', { hasText: 'Codex' }).click()
    await launchControls.nth(1).click()
    if (await page.locator('.menu-pop .menu-search input').count()) {
      await page.locator('.menu-pop .menu-search input').fill('gpt-6-luna')
    }
    await page.locator('.menu-pop .menu-item').first().click()
    const codexEffort = launchControls.nth(2)
    check('Codex Luna encoded effort is not disabled on a new draft', !(await codexEffort.isDisabled()))
    await codexEffort.click()
    const levels = await page.locator('.menu-pop .menu-item-name').allTextContents()
    check('Codex Luna exposes the encoded levels', levels.includes('Low') && levels.includes('High'), levels)
    await page.getByRole('button', { name: 'High', exact: true }).click()
    check('Codex Luna effort can actually be changed', (await codexEffort.innerText()).includes('High'))
  }
} catch (error) {
  failures.push(error instanceof Error ? error.stack ?? error.message : String(error))
} finally {
  await browser.close()
  await runCleanups()
}

if (failures.length) {
  console.error(`\nmodel-ui-test: FAILED\n${failures.join('\n')}`)
  process.exit(1)
}
console.log('\nmodel-ui-test: PASSED')
