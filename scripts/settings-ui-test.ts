#!/usr/bin/env bun
/**
 * Settings, in a real browser: the typefaces and the panels that were lying.
 *
 * Three things can only be proved here, because they are about what is rendered
 * rather than about what is stored:
 *
 *   - choosing a typeface changes the font the conversation is actually drawn
 *     in — not only the value in `localStorage`, which is what a store-level
 *     assertion would happily accept while the screen stayed the same;
 *   - it changes *only* the prose: code, tool output and anything monospace keep
 *     their font, because a proportional face there loses the alignment those
 *     surfaces exist to show;
 *   - the type scale and the big-font mode still hold with a custom typeface,
 *     and both survive a reload.
 *
 * Plus the two panels the user reported as useless: the dictation selector has
 * to move when it is clicked (it read the *resolved* engine, so pressing "Auto"
 * lit up "whisper.cpp" and looked like nothing happened), and the machines panel
 * has to list what was found.
 *
 * With no arguments it builds its own world, like the other browser checks: a
 * temporary store seeded with the fixtures and an API server on a free port.
 * Nothing already running is touched.
 *
 *   bun scripts/settings-ui-test.ts [url]
 */
import { chromium } from 'playwright'
import { installExitHandlers, runCleanups } from './lib/harness.ts'
import { openRichestSession, resolveApp } from './lib/app.ts'

installExitHandlers()
const target = await resolveApp(process.argv[2])

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

const failures: string[] = []
const passed: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) passed.push(label)
  else failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

const errors: string[] = []
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))

await page.goto(target.url, { waitUntil: 'networkidle' })
// Settings remembers nothing between runs, and a stale choice from a previous
// one would make the first assertion pass for the wrong reason.
await page.evaluate(() => localStorage.removeItem('sedano.settings'))
await page.reload({ waitUntil: 'networkidle' })
await openRichestSession(page)

const openSettings = async (section: string): Promise<void> => {
  await page.evaluate(() => {
    const dialog = document.querySelector('.settings')
    if (!dialog) (document.querySelector('button[title^="Settings"]') as HTMLElement | null)?.click()
  })
  await page.waitForSelector('.settings', { timeout: 5000 })
  await page.evaluate((wanted: string) => {
    const item = [...document.querySelectorAll<HTMLElement>('.settings-nav-item')].find(
      (button) => button.firstElementChild?.textContent?.trim() === wanted,
    )
    item?.click()
  }, section)
  await page.waitForTimeout(150)
}

const closeSettings = async (): Promise<void> => {
  await page.evaluate(() => {
    const done = [...document.querySelectorAll<HTMLElement>('.settings-head button')].find(
      (button) => button.textContent?.trim() === 'Done',
    )
    done?.click()
  })
  await page.waitForTimeout(150)
}

/* ------------------------------------------------------------------ */
/* The sections exist at all                                           */
/* ------------------------------------------------------------------ */

await openSettings('Appearance')
const sections = await page.$$eval('.settings-nav-item', (items) =>
  items.map((item) => item.firstElementChild?.textContent?.trim() ?? ''),
)
check('there is a Machines section', sections.includes('Machines'), sections)
check('there is a Dictation section', sections.includes('Dictation'), sections)

/* A typeface is a name people compare, not a thing that may be clipped to
   “Helvet…”. This is a rendering assertion: the menu has to be wide enough and
   every visible family name has to fit in the line that paints it. */
const fontMenu = await page.evaluate(async () => {
  const row = [...document.querySelectorAll<HTMLElement>('.settings-row')].find(
    (node) => node.querySelector('.settings-label')?.textContent?.trim() === 'Interface typeface',
  )
  ;(row?.querySelector('.select-trigger') as HTMLElement | null)?.click()
  await new Promise((resolve) => setTimeout(resolve, 150))
  const pop = document.querySelector('.menu-pop') as HTMLElement | null
  return {
    width: pop?.getBoundingClientRect().width ?? 0,
    names: [...(pop?.querySelectorAll<HTMLElement>('.menu-item-name') ?? [])].map((node) => ({
      text: node.textContent?.trim() ?? '',
      clipped: node.scrollWidth > node.clientWidth + 1,
    })),
  }
})
check('the typeface menu is wide enough to compare font names', fontMenu.width >= 400, fontMenu)
check('no typeface name is horizontally clipped', fontMenu.names.every((entry) => !entry.clipped), fontMenu)
await page.screenshot({ path: '.playwright-mcp/sedano-font-menu.png', fullPage: false })
// Escape also closes the settings dialog itself, so close this one menu through
// its own trigger and keep the rest of the typeface test on the same panel.
await page.evaluate(() => {
  const row = [...document.querySelectorAll<HTMLElement>('.settings-row')].find(
    (node) => node.querySelector('.settings-label')?.textContent?.trim() === 'Interface typeface',
  )
  ;(row?.querySelector('.select-trigger') as HTMLElement | null)?.click()
})

/* ------------------------------------------------------------------ */
/* Typefaces                                                           */
/* ------------------------------------------------------------------ */

/** How wide a fixed string is in the transcript's own font. */
const proseWidth = (): Promise<number> =>
  page.evaluate(() => {
    const transcript = document.querySelector('.transcript')
    if (!transcript) return -1
    const probe = document.createElement('span')
    probe.textContent = 'Handgloves 0123456789 quick brown fox'
    probe.style.position = 'absolute'
    probe.style.visibility = 'hidden'
    probe.style.whiteSpace = 'pre'
    transcript.appendChild(probe)
    const width = probe.getBoundingClientRect().width
    probe.remove()
    return width
  })

const prose = (): Promise<{ family: string; size: string }> =>
  page.evaluate(() => {
    const node = document.querySelector('.transcript')
    const style = node ? getComputedStyle(node) : null
    return { family: style?.fontFamily ?? '', size: style?.fontSize ?? '' }
  })

/** Any monospace surface inside the transcript: a tool line, a code block. */
const monoFamily = (): Promise<string> =>
  page.evaluate(() => {
    const node = document.querySelector('.transcript .mono, .transcript code, .transcript pre')
    return node ? getComputedStyle(node).fontFamily : ''
  })

const before = await prose()
const beforeWidth = await proseWidth()
const beforeMono = await monoFamily()
check('the transcript is on screen to measure', beforeWidth > 0, beforeWidth)
check('and something monospace is in it', beforeMono.length > 0, beforeMono)

/** The families the picker actually offers, which is the truth about this machine. */
const offered = await page.evaluate(() => {
  const label = [...document.querySelectorAll<HTMLElement>('.settings-label')].find(
    (node) => node.textContent?.trim() === 'Conversation typeface',
  )
  const row = label?.closest('.settings-row')
  const trigger = row?.querySelector<HTMLElement>('.select-wrap .select-trigger')
  trigger?.click()
  return new Promise<string[]>((resolve) => {
    setTimeout(() => {
      const items = [...document.querySelectorAll<HTMLElement>('.menu-pop .menu-item')]
      resolve(items.map((item) => item.querySelector('.menu-item-name')?.textContent?.trim() ?? ''))
    }, 200)
  })
})
check('the typeface picker offers something beyond the default', offered.length > 1, offered)
// Nothing on offer may be a font this machine cannot render — the whole reason
// the list is curated and then filtered.
const unavailable = await page.evaluate(
  (names: string[]) =>
    names
      .filter((name) => name && name !== 'System Default')
      .filter((name) => !document.fonts.check(`12px "${name}"`)),
  offered,
)
check('and every offered font is really installed', unavailable.length === 0, unavailable)

/**
 * Which offered font to pick.
 *
 * Not simply the first: on a Mac the first one is SF Pro Text, which is what the
 * shipped stack already resolves to — choosing it would change the stack and
 * nothing on screen, and the measurement below would fail for a reason that has
 * nothing to do with the feature. The one that differs most from what is drawn
 * now is the one that can actually prove the text changed.
 */
const wanted = await page.evaluate((names: string[]) => {
  const transcript = document.querySelector('.transcript')
  if (!transcript) return ''
  const probe = document.createElement('span')
  probe.textContent = 'Handgloves 0123456789 quick brown fox'
  probe.style.position = 'absolute'
  probe.style.visibility = 'hidden'
  probe.style.whiteSpace = 'pre'
  transcript.appendChild(probe)
  const current = probe.getBoundingClientRect().width
  let best = ''
  let spread = 0
  for (const name of names) {
    if (!name || name === 'System Default') continue
    probe.style.fontFamily = `"${name}"`
    const delta = Math.abs(probe.getBoundingClientRect().width - current)
    if (delta > spread) {
      spread = delta
      best = name
    }
  }
  probe.remove()
  return best
}, offered)
check('at least one offered font renders differently from the default', wanted !== '', offered)
await page.evaluate((name: string) => {
  const item = [...document.querySelectorAll<HTMLElement>('.menu-pop .menu-item')].find(
    (node) => node.querySelector('.menu-item-name')?.textContent?.trim() === name,
  )
  item?.click()
}, wanted)
await page.waitForTimeout(250)
await closeSettings()
await page.waitForTimeout(150)

const after = await prose()
const afterWidth = await proseWidth()
const afterMono = await monoFamily()

check('the conversation asks for the chosen family first', after.family.startsWith(`"${wanted}"`) || after.family.startsWith(wanted), {
  wanted,
  family: after.family,
})
// The stack being right is not the same as the text being drawn in it, so the
// text is measured: a name that fell back would leave the width untouched.
check('and the text is really drawn in it', Math.abs(afterWidth - beforeWidth) > 0.5, { beforeWidth, afterWidth })
check('while the monospace surfaces keep theirs', afterMono === beforeMono, { beforeMono, afterMono })
check('and the type scale is untouched', after.size === before.size, { before: before.size, after: after.size })

/* It has to survive a restart, or it is not a setting. */
await page.reload({ waitUntil: 'networkidle' })
await openRichestSession(page)
const reloaded = await prose()
check('the typeface survives a reload', reloaded.family === after.family, { after: after.family, reloaded: reloaded.family })

/* ------------------------------------------------------------------ */
/* Big-font mode, with a custom typeface in place                      */
/* ------------------------------------------------------------------ */

const scaleBefore = await prose()
// ⌘ + is the conversation scale; it must still move with a font chosen, and it
// must move the conversation only.
const chromeBefore = await page.evaluate(() => getComputedStyle(document.body).fontSize)
for (let press = 0; press < 6; press += 1) {
  await page.keyboard.press('Meta+Equal')
  await page.waitForTimeout(40)
}
await page.waitForTimeout(200)
const scaleAfter = await prose()
const chromeAfter = await page.evaluate(() => getComputedStyle(document.body).fontSize)
check(
  'the conversation still scales up with a custom typeface',
  parseFloat(scaleAfter.size) > parseFloat(scaleBefore.size),
  { before: scaleBefore.size, after: scaleAfter.size },
)
check('and it is still the chosen typeface at that size', scaleAfter.family === scaleBefore.family, scaleAfter.family)
check('while the interface scale is left alone', chromeAfter === chromeBefore, { chromeBefore, chromeAfter })

await openSettings('Advanced')
await page.evaluate(() => {
  const reset = [...document.querySelectorAll<HTMLElement>('.settings-row button')].find(
    (button) => button.textContent?.trim() === 'Reset to defaults',
  )
  reset?.click()
})
await page.waitForTimeout(200)
const reset = await page.evaluate(() => {
  const node = document.querySelector('.transcript')
  return node ? getComputedStyle(node).fontFamily : ''
})
check('reset puts the shipped typeface back', reset !== after.family, { after: after.family, reset })

/* ------------------------------------------------------------------ */
/* Dictation: the normal path is one honest, on-device route           */
/* ------------------------------------------------------------------ */

await openSettings('Dictation')
// A working engine is not news: its card appears only when dictation is not
// ready, and then it is the on-device engine, never the optional server.
const engineCards = await page.$$eval('.settings-row .set-card:not(.voice-models) .set-title', (nodes) =>
  nodes.map((node) => node.textContent?.trim() ?? ''),
)
check('the panel shows at most the on-device engine, without server noise', engineCards.length <= 1, engineCards)
check('and a shown engine is whisper.cpp', engineCards.length === 0 || engineCards[0] === 'whisper.cpp', engineCards)

// The model list: official whisper.cpp models, each with its own action.
const modelActions = await page.$$eval('.settings-row .voice-models .set-item button', (nodes) =>
  nodes.map((node) => node.textContent?.trim() ?? ''),
)
check('the model list offers downloads for missing models', modelActions.includes('Download'), modelActions)
check('and switching or deleting for the ones on disk', modelActions.includes('Delete'), modelActions)
await page.$eval('.voice-models', (node) => node.scrollIntoView({ block: 'start' }))
await page.screenshot({ path: '.playwright-mcp/sedano-dictation-models.png', fullPage: false })

/* ------------------------------------------------------------------ */
/* Machines: what was found, and whether it answered                   */
/* ------------------------------------------------------------------ */

await openSettings('Machines')
const syncActions = await page.locator('.harness-sync-actions button').allTextContents()
check('one control refreshes every machine without installing', syncActions.some((label) => label.includes('Refresh models & versions')), syncActions)
check('one explicit control updates all available harnesses', syncActions.some((label) => label.includes('Update all available')), syncActions)
const machines = await page.$$eval('.settings-row .set-card-head', (heads) =>
  heads.map((head) => ({
    name: head.querySelector('.set-title')?.textContent?.trim() ?? '',
    state: head.querySelector('.set-sub')?.textContent?.trim() ?? '',
  })),
)
check('this computer is a machine like any other', machines[0]?.name === 'This Computer', machines[0])
check(
  'and no machine is left with a blank state',
  machines.every((machine) => machine.state.length > 0),
  machines,
)
const harnessRows = await page.$$eval('.settings-row .set-item-name', (nodes) => nodes.length)
check('the harnesses of this computer are listed', harnessRows > 0, harnessRows)
const switches = await page.$$eval('.settings-row .set-item .switch', (nodes) => nodes.length)
check('and each installed one has a switch of its own', switches > 0, switches)

/* ------------------------------------------------------------------ */
/* Hiding a harness takes it out of the pickers, and only out of those  */
/* ------------------------------------------------------------------ */

/** The harnesses a new agent tab offers, straight from its own picker. */
const launchpadHarnesses = async (): Promise<string[]> => {
  await page.keyboard.press('Meta+d')
  await page.waitForTimeout(500)
  return page.evaluate(() => {
    const trigger = [...document.querySelectorAll<HTMLElement>('.launchpad .select-trigger')].find(
      (node) => node.closest('.menu')?.getAttribute('title') === 'Harness',
    )
    trigger?.click()
    return new Promise<string[]>((resolve) => {
      setTimeout(() => {
        const names = [...document.querySelectorAll<HTMLElement>('.menu-pop .menu-item .menu-item-name')].map(
          (node) => node.textContent?.trim() ?? '',
        )
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
        resolve(names)
      }, 250)
    })
  })
}

const offeredBefore = await launchpadHarnesses()
check('the launchpad offers the installed harnesses', offeredBefore.length > 0, offeredBefore)

/**
 * A harness no session is using.
 *
 * Which matters: a harness that a session is already running is deliberately
 * kept in the catalog even when it is hidden, because that session still needs
 * its models and its approval modes. Picking one of those as the victim would
 * fail this assertion for the one reason that is not a bug.
 */
const inUse = await page.evaluate(() =>
  [...document.querySelectorAll('.rail .session-item .meta')].map((node) => node.textContent ?? ''),
)
const spare = offeredBefore.filter((name) => !inUse.some((meta) => meta.includes(name)))
check('some installed harness has no session on it', spare.length > 0, { offeredBefore, inUse })

if (spare.length > 0 && offeredBefore.length > 1) {
  const victim = spare[0]!
  await openSettings('Machines')
  const toggled = await page.evaluate((name: string) => {
    const item = [...document.querySelectorAll<HTMLElement>('.set-item')].find(
      (node) => node.querySelector('.set-item-name')?.textContent?.trim() === name,
    )
    const toggle = item?.querySelector<HTMLElement>('.switch')
    if (!toggle) return false
    toggle.click()
    return true
  }, victim)
  check(`the harness "${victim}" has a switch in Settings`, toggled, victim)
  // The switch is driven by the server's answer, so this is also the round trip.
  await page.waitForTimeout(900)
  const switchedOff = await page.evaluate((name: string) => {
    const item = [...document.querySelectorAll<HTMLElement>('.set-item')].find(
      (node) => node.querySelector('.set-item-name')?.textContent?.trim() === name,
    )
    return item?.querySelector('.switch')?.classList.contains('on') === false
  }, victim)
  check('and the switch stays off once the server confirms', switchedOff, victim)
  check('the row is still listed, so it can be turned back on', await page.evaluate((name: string) =>
    [...document.querySelectorAll<HTMLElement>('.set-item-name')].some((node) => node.textContent?.trim() === name),
  victim))

  await closeSettings()
  const offeredAfter = await launchpadHarnesses()
  check('a hidden harness disappears from the picker', !offeredAfter.includes(victim), { victim, offeredAfter })
  check('and the others stay', offeredAfter.length === offeredBefore.length - 1, { offeredBefore, offeredAfter })

  // Put it back, and prove the panel is the way back.
  await openSettings('Machines')
  await page.evaluate((name: string) => {
    const item = [...document.querySelectorAll<HTMLElement>('.set-item')].find(
      (node) => node.querySelector('.set-item-name')?.textContent?.trim() === name,
    )
    item?.querySelector<HTMLElement>('.switch')?.click()
  }, victim)
  await page.waitForTimeout(900)
  await closeSettings()
  const restored = await launchpadHarnesses()
  check('and turning it back on brings it back', restored.includes(victim), { victim, restored })
}

/**
 * The exception, which is the whole safety of the feature: a harness a session
 * is already running stays available even when it is hidden. Dropping it would
 * leave that session with no model list, no approval modes and no label — a
 * preference about a picker is not allowed to reach into work already open.
 */
const used = offeredBefore.find((name) => inUse.some((meta) => meta.includes(name)))
check('a session is open on one of the installed harnesses', Boolean(used), { offeredBefore, inUse })
if (used) {
  await openSettings('Machines')
  await page.evaluate((name: string) => {
    const item = [...document.querySelectorAll<HTMLElement>('.set-item')].find(
      (node) => node.querySelector('.set-item-name')?.textContent?.trim() === name,
    )
    item?.querySelector<HTMLElement>('.switch')?.click()
  }, used)
  await page.waitForTimeout(900)
  await closeSettings()
  const stillThere = await launchpadHarnesses()
  check('hiding a harness a session uses does not take it away', stillThere.includes(used), { used, stillThere })

  await openSettings('Machines')
  await page.evaluate((name: string) => {
    const item = [...document.querySelectorAll<HTMLElement>('.set-item')].find(
      (node) => node.querySelector('.set-item-name')?.textContent?.trim() === name,
    )
    item?.querySelector<HTMLElement>('.switch')?.click()
  }, used)
  await page.waitForTimeout(900)
  await closeSettings()
}

check('nothing threw while doing any of this', errors.length === 0, errors)

for (const line of passed) console.log(`  ok  ${line}`)
await browser.close()
await runCleanups()

if (failures.length) {
  console.error(`\nsettings-ui-test: ${failures.length} failure(s)`)
  for (const line of failures) console.error(`  ✗ ${line}`)
  process.exit(1)
}
console.log(`\nsettings-ui-test: ${passed.length} checks passed`)
process.exit(0)
