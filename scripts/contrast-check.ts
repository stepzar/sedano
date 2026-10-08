#!/usr/bin/env bun
/**
 * Contrast audit.
 *
 * Reads the rendered app (or the gallery) and computes the real WCAG ratio for
 * every text/background pair a user actually reads, in both themes. Ships as a
 * check because contrast is exactly the kind of thing that silently rots when
 * a palette is tuned by eye.
 *
 * With no arguments it starts its own API server and vite against a temporary
 * store seeded with the transcript fixtures, so every surface listed below is on
 * screen and a missing one is a failure rather than a silent skip. Pass a URL to
 * audit a server you are already running instead.
 *
 *   bun scripts/contrast-check.ts [url] [galleryBase]
 */
import { chromium } from 'playwright'
import { installExitHandlers, runCleanups } from './lib/harness.ts'
import { openRichestSession, resolveApp } from './lib/app.ts'

installExitHandlers()
const target = await resolveApp(process.argv[2], process.argv[3])
const url = target.url
const galleryBase = target.galleryBase

/**
 * Minimum ratios: body text should clear AAA, secondary labels AA.
 *
 * `optional` marks a surface that only exists when something outside this repo
 * does — a vendor CLI reporting usage, a transient toast. Everything else must
 * be on screen: a palette can only rot unnoticed if a missing surface counts as
 * a pass.
 */
const TARGETS: Array<{
  selector: string
  min: number
  note: string
  optional?: string
  galleryOnly?: boolean
  appOnly?: boolean
  /** Measured on `preview.html?only=harnesses`, one settled turn per harness. */
  work?: boolean
}> = [
  { selector: '.msg-body', min: 7, note: 'message text' },
  { selector: '.session-item .title', min: 7, note: 'rail session title' },
  { selector: '.session-item .meta', min: 3.2, note: 'rail metadata' },
  { selector: '.rail-title', min: 3.2, note: 'section labels' },
  { selector: '.statusbar .group', min: 3.2, note: 'status bar' },
  // The header's facts are icons with counts now, and one token number.
  { selector: '.turn-file.edited', min: 3.2, note: 'files changed count' },
  { selector: '.turn-file.added', min: 3.2, note: 'files added count', galleryOnly: true },
  { selector: '.turn-tokens', min: 3.2, note: 'turn token count' },
  // The harness' routine bookkeeping now lives behind a disclosure, which
  // `reveal` opens: quiet is the point, unreadable is not.
  // Gallery only: the one `system` record the seeded store carries is the
  // `init` line, which is the turn header's tooltip now, not a line. The hook
  // rows that still use this class exist in the gallery fixtures.
  { selector: '.line-system', min: 3.2, note: 'system lines', galleryOnly: true },
  { selector: '.turn-notes-head', min: 3.2, note: 'harness notices disclosure' },
  // The two readings that tell a turn still working from one that has answered.
  // If either goes unreadable, the distinction goes with it.
  { selector: '.turn-elapsed', min: 3.2, note: 'live elapsed clock', galleryOnly: true },
  // A failure is the one card someone reads under pressure, so it is held to the
  // text ratio rather than the incidental one. Gallery-only: the seeded store has
  // no failed session, and a surface that never renders cannot be measured.
  { selector: '.error-headline', min: 4.5, note: 'failure explanation', galleryOnly: true },
  { selector: '.error-more', min: 3.2, note: 'failure detail disclosure', galleryOnly: true },
  { selector: '.error-detail', min: 4.5, note: 'raw failure report', galleryOnly: true },
  // Output still being written streams inside the work as a live progress
  // note, and only a settled turn gets a captioned reply. Reasoning has no
  // caption of its own any more; its text is measured below (`.msg-thinking`).
  { selector: '.work-update.activity-note.live .msg-body', min: 4, note: 'text still being written', galleryOnly: true },
  { selector: '.turn-output .msg-actions', min: 3.2, note: 'reply time' },
  { selector: '.msg-thinking', min: 4, note: 'the thinking itself' },
  { selector: '.tool .summary', min: 3.2, note: 'tool summary' },
  { selector: '.subagent-desc', min: 4, note: 'subagent description' },
  // The work area is ghost rows now: each kind is told apart by its label and a
  // faint preview, so both are held to a ratio rather than to taste.
  { selector: '.subagent-type', min: 4.5, note: 'subagent type' },
  { selector: '.subagent-preview', min: 3.2, note: 'subagent result preview, folded', work: true },
  { selector: '.tool .wr-label', min: 4.5, note: 'tool name' },
  { selector: '.wr-meta', min: 3.2, note: 'work row time and counts' },
  { selector: '.reasoning-chip .wr-label', min: 3.2, note: 'reasoning row label' },
  { selector: '.work-update.activity-note:not(.live) .msg-body', min: 4, note: 'a note in the work', work: true },
  { selector: '.plan-head .wr-detail', min: 3.2, note: 'plan progress', work: true },
  { selector: '.output-sep', min: 3.2, note: 'when each message of the turn arrived', work: true },
  // Inline code in prose is a pill on its own fill: it is text, so AA for text.
  { selector: '.msg-body .md-code', min: 4.5, note: 'inline code', work: true },
  { selector: '.file-group-head', min: 4, note: 'file group header', galleryOnly: true },
  { selector: '.msg-user .msg-body', min: 7, note: 'user message' },
  // The selected tab is a fill now, not an underline: its title has to read on it.
  { selector: '.tab.active .label', min: 4.5, note: 'selected tab title' },
  { selector: '.chip', min: 3.2, note: 'chips' },
  { selector: '.chip.accent', min: 3.5, note: 'accent chip', galleryOnly: true },
  { selector: '.file-badge.edit', min: 3.5, note: 'edited file badge' },
  { selector: '.file-badge.create', min: 3.5, note: 'new file badge', galleryOnly: true },
  { selector: '.diff-add', min: 4.5, note: 'added diff line' },
  { selector: '.diff-del', min: 4.5, note: 'removed diff line', appOnly: true },
  { selector: '.file-path', min: 4.5, note: 'file path' },
  // The settings window: measured with it open, which is the only state these
  // two are ever read in. They replaced `.empty .lead` and `.field > label`,
  // which no component renders any more.
  { selector: '.settings-label', min: 3.2, note: 'form labels', appOnly: true },
  { selector: '.settings-help', min: 3.2, note: 'setting help text', appOnly: true },
  // "We were not told" stands where a number would: quieter than a figure, but
  // still something you have to be able to read, or the absence goes unnoticed.
  // The richest seeded app session reports its usage, so the deterministic
  // unreported surface lives in the gallery fixture. `ui-check` separately
  // mutates a real app session into this state and asserts that it renders.
  { selector: '.unreported', min: 3.2, note: 'unreported readings', galleryOnly: true },
  { selector: '.btn-absent, .toast', min: 4.5, note: 'toast text', optional: 'a toast only exists while one is on screen' },
]

interface Sample {
  selector: string
  color: string
  background: string
  ratio: number
  fontSize: string
}

// Google Chrome locally, because that is what the app is looked at in; CI has
// only playwright's own build, and `SEDANO_BROWSER=chromium` asks for it. The
// ratios are computed from the DOM, so the engine is the same either way.
const browser = await chromium.launch(process.env.SEDANO_BROWSER === 'chromium' ? {} : { channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

/** Waits for the page to have a mounted React tree again. */
async function waitForRoot(): Promise<void> {
  await page.waitForFunction(() => (document.getElementById('root')?.childElementCount ?? 0) > 0, undefined, {
    timeout: 30_000,
  })
}

/**
 * Puts every surface this check measures on screen.
 *
 * Idempotent on purpose: it is re-run until the measurement finds what it needs,
 * so each step asks whether the work is already done instead of toggling.
 */
async function reveal(isApp: boolean): Promise<void> {
  if (isApp) {
    await openRichestSession(page)
    // ⌘, toggles, so pressing it again on an open window would close it.
    if (!(await page.$('.settings-label'))) {
      await page.keyboard.press('Meta+,')
      await page.waitForTimeout(400)
    }
  }
  // Patches are collapsed by design. Every card is opened, not just the first:
  // a file with no preview renders no diff lines at all, so clicking only the
  // first card made the diff colours depend on which file happened to lead.
  await page.evaluate(() => {
    // The file list is folded by default too; open it, then each file.
    for (const group of document.querySelectorAll<HTMLElement>('.file-group-head[aria-expanded="false"]')) group.click()
    for (const head of document.querySelectorAll<HTMLElement>('.file-head')) {
      if (head.querySelector('.chevron:not(.open)')) head.click()
    }
    // The hook and timing lines are folded by design now, so the only way to
    // measure their colour is to open the disclosure they moved behind.
    for (const head of document.querySelectorAll<HTMLElement>('.turn-notes-head')) {
      if (head.querySelector('.chevron:not(.open)')) head.click()
    }
    // Same for a subagent card that has settled: its work is folded away, and
    // the tool rows inside it are a surface this check owes a reading of.
    for (const head of document.querySelectorAll<HTMLElement>('.subagent-head')) {
      if (head.querySelector('.chevron:not(.open)')) head.click()
    }
    // Reasoning is a chip that opens now; its text is a surface this check owes.
    for (const chip of document.querySelectorAll<HTMLElement>('.reasoning-chip[aria-expanded="false"]')) chip.click()
  })
  await page.waitForTimeout(200)
}

async function audit(
  target: string,
  theme: 'light' | 'dark',
  isApp: boolean,
  required: string[],
): Promise<Sample[]> {
  // localStorage is only reachable once the page has an origin.
  await page.goto(target, { waitUntil: 'domcontentloaded' })
  await page.evaluate((value) => {
    localStorage.setItem(
      'sedano.settings',
      JSON.stringify({ theme: value, uiFontSize: 12.5, contentFontSize: 14.5, railVisible: true }),
    )
  }, theme)
  await page.reload({ waitUntil: 'networkidle' })
  // The gallery is compiled on demand by vite, and its first load can take a
  // while; waiting for the root to have children beats guessing a delay.
  await waitForRoot()

  // Then keep revealing and measuring until every surface this source owes is
  // actually there. The old code revealed once behind fixed sleeps, which made
  // the check a race it usually won: vite can optimise a dependency on first
  // load and force a full page reload *after* the cards were opened, throwing
  // the expanded state away and leaving `.diff-add` unrendered — the same run,
  // repeated, then passed. Waiting for the surface removes the guess.
  const deadline = Date.now() + 25_000
  let samples: Sample[] = []
  for (;;) {
    try {
      await reveal(isApp)
      samples = await measure()
    } catch (error) {
      // A navigation mid-flight destroys the execution context; that is the
      // race itself, so wait for the new tree and try again rather than fail.
      if (Date.now() > deadline) throw error
      await waitForRoot()
      continue
    }
    const missing = required.filter((selector) => !samples.some((sample) => sample.selector === selector))
    if (!missing.length || Date.now() > deadline) {
      if (missing.length) console.log(`(gave up waiting for ${missing.join(', ')})`)
      return samples
    }
    // Printed, not swallowed: a retry means the race is still there, and a gate
    // that hides how hard it had to try is how a flake gets rediscovered.
    console.log(`(waiting for ${missing.join(', ')})`)
    await page.waitForTimeout(250)
  }
}

function measure(): Promise<Sample[]> {
  return page.evaluate((selectors: string[]) => {
    const parse = (value: string): [number, number, number, number] => {
      const match = value.match(/rgba?\(([^)]+)\)/)
      if (!match) return [0, 0, 0, 0]
      const parts = match[1]!.split(',').map((n) => Number(n.trim()))
      return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1]
    }
    const luminance = ([r, g, b]: [number, number, number, number]): number => {
      const channel = (input: number) => {
        const v = input / 255
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
    }
    const ratio = (a: [number, number, number, number], b: [number, number, number, number]) => {
      const l1 = luminance(a)
      const l2 = luminance(b)
      const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]
      return (hi + 0.05) / (lo + 0.05)
    }
    /** Walk up until an actually painted background is found. */
    const backgroundOf = (node: Element): [number, number, number, number] => {
      let current: Element | null = node
      while (current) {
        const bg = getComputedStyle(current).backgroundColor
        const parsed = parse(bg)
        if (parsed[3] > 0.6) return parsed
        current = current.parentElement
      }
      return [255, 255, 255, 1]
    }

    const out: Array<{ selector: string; color: string; background: string; ratio: number; fontSize: string }> = []
    for (const selector of selectors) {
      const node = document.querySelector(selector)
      if (!node) continue
      const style = getComputedStyle(node)
      const fg = parse(style.color)
      const bg = backgroundOf(node)
      out.push({
        selector,
        color: style.color,
        background: `rgb(${bg.slice(0, 3).join(', ')})`,
        ratio: Math.round(ratio(fg, bg) * 100) / 100,
        fontSize: style.fontSize,
      })
    }
    return out
  }, selectors)
}

const report: Array<{ label: string; failures: string[] }> = []
const skipped: string[] = []
const sources = [
  { label: 'app', gallery: false, urlFor: () => url },
  // The gallery takes its theme from the query string, so each theme needs its
  // own URL — otherwise the dark pass would silently measure the light theme.
  { label: 'gallery', gallery: true, urlFor: (theme: string) => `${galleryBase}/preview.html?theme=${theme}` },
  // Every kind of work row, from every harness's shapes.
  { label: 'work', gallery: true, urlFor: (theme: string) => `${galleryBase}/preview.html?only=harnesses&theme=${theme}` },
]

/** Selectors the app must show; the gallery is a superset of them. */
const selectors = TARGETS.map((t) => t.selector)

try {
  for (const source of sources) {
    const missingExcuse = (target: (typeof TARGETS)[number]): string | null => {
      if (target.optional) return target.optional
      // The work page is measured for the work rows only; they are owed there.
      if (source.label === 'work') return target.work ? null : 'measured on the other pages'
      if (target.work) return 'owed on the work page'
      if (target.galleryOnly && !source.gallery) return 'only rendered in the gallery'
      if (target.appOnly && source.gallery) return 'only rendered in the app'
      return null
    }
    // What this source owes: the audit waits for exactly these before measuring.
    const required = TARGETS.filter((target) => !missingExcuse(target)).map((target) => target.selector)
    for (const theme of ['light', 'dark'] as const) {
      const samples = await audit(source.urlFor(theme), theme, !source.gallery, required)
      console.log(`\n=== ${source.label} · ${theme} ===`)
      const failures: string[] = []
      for (const target of TARGETS) {
        const sample = samples.find((s) => s.selector === target.selector)
        if (!sample) {
          // A surface that is simply not on the app screen (only the gallery
          // renders it) is not a contrast problem; one that should be there is.
          const excused = missingExcuse(target)
          if (excused) skipped.push(`${source.label}/${theme} ${target.selector} — ${excused}`)
          else failures.push(`${target.selector} is missing — the surface it colours never rendered`)
          continue
        }
        const ok = sample.ratio >= target.min
        if (!ok) failures.push(`${target.selector} ${sample.ratio}:1 (min ${target.min})`)
        console.log(
          `${ok ? 'ok  ' : 'FAIL'} ${String(sample.ratio).padStart(5)}:1  min ${String(target.min).padStart(4)}  ${sample.fontSize.padStart(6)}  ${target.note}  ${sample.selector}`,
        )
      }
      if (samples.length === 0) failures.push('no elements matched — did the page render?')
      report.push({ label: `${source.label}/${theme}`, failures })
    }
  }
} finally {
  await browser.close()
  await runCleanups()
}

if (skipped.length) {
  console.log('\n--- surfaces not measured (optional) ---')
  for (const entry of skipped) console.log(`… ${entry}`)
}

const failed = report.flatMap((entry) => entry.failures.map((failure) => `${entry.label} ${failure}`))
if (failed.length) {
  console.log('\n--- contrast failures ---')
  for (const entry of failed) console.log(`✗ ${entry}`)
}
console.log(`\nverdict: ${failed.length ? `CONTRAST PROBLEM (${failed.length})` : 'CONTRAST OK'}`)
if (failed.length) process.exit(1)
