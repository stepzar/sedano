#!/usr/bin/env bun
/**
 * The machine palette, the colour that has to survive a restart, and the model
 * name that has to stay readable.
 *
 * Everything here is either arithmetic or a real server against a throwaway
 * store, so none of it needs a browser — the rendered side is
 * `machine-ui-test.ts`. Three things are proved:
 *
 *   - every colour the picker offers clears 3:1 against every surface it is
 *     drawn on, in **both** themes, and the stylesheet's copy of the palette has
 *     not drifted from the one the code offers;
 *   - a colour chosen for a machine is still that machine's colour after the
 *     server has been stopped and started again, and a value that is not one of
 *     the offered ids is refused rather than stored;
 *   - a resolved model id renders as a name, while the id itself is untouched.
 *
 *   bun scripts/machine-color-test.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MACHINE_COLORS, asMachineColorId, machineColorOf } from '@shared'
import { modelName, readModel } from '../apps/ui/src/models.ts'
import { ROOT, installExitHandlers, runCleanups, startApi, tempHome } from './lib/harness.ts'

installExitHandlers()

const failures: string[] = []
const passed: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) passed.push(label)
  else failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

/* ------------------------------------------------------------------ */
/* 1. Contrast, in both themes                                         */
/* ------------------------------------------------------------------ */

function luminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16)
  const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((part) => {
    const unit = part / 255
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!
}

function ratio(a: string, b: string): number {
  const first = luminance(a)
  const second = luminance(b)
  const [high, low] = first > second ? [first, second] : [second, first]
  return Math.round(((high + 0.05) / (low + 0.05)) * 100) / 100
}

const styles = readFileSync(join(ROOT, 'apps', 'ui', 'src', 'styles.css'), 'utf8')

/**
 * The backgrounds a machine mark is actually drawn on, read out of the
 * stylesheet rather than copied here: a theme retuned tomorrow must re-run this
 * arithmetic, not pass it from memory.
 */
function surfaces(theme: 'light' | 'dark'): Record<string, string> {
  const block =
    theme === 'light'
      ? /:root,\s*:root\[data-theme='light'\]\s*\{([\s\S]*?)\n\}/.exec(styles)
      : /:root\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/.exec(styles)
  if (!block) throw new Error(`could not find the ${theme} theme block in styles.css`)
  const wanted = ['--bg', '--surface', '--surface-2', '--surface-3', '--rail-bg', '--sunken']
  const out: Record<string, string> = {}
  for (const name of wanted) {
    const match = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block[1]!)
    if (match) out[name] = match[1]!.toLowerCase()
  }
  return out
}

const lightSurfaces = surfaces('light')
const darkSurfaces = surfaces('dark')
check('the light theme block was parsed', Object.keys(lightSurfaces).length >= 5, lightSurfaces)
check('the dark theme block was parsed', Object.keys(darkSurfaces).length >= 5, darkSurfaces)

/**
 * 3:1 is the bar for a mark that is not text (WCAG 1.4.11): the machine dot, the
 * tab's edge and the swatch are shapes, not words. The measured numbers are
 * printed either way, because a palette that squeaks past is worth seeing.
 */
const MIN_RATIO = 3
console.log('\n=== machine palette contrast ===')
for (const colour of MACHINE_COLORS) {
  for (const [theme, value, backgrounds] of [
    ['light', colour.light, lightSurfaces],
    ['dark', colour.dark, darkSurfaces],
  ] as const) {
    const measured = Object.entries(backgrounds).map(([name, bg]) => ({ name, bg, r: ratio(value, bg) }))
    const worst = measured.reduce((low, entry) => (entry.r < low.r ? entry : low))
    console.log(
      `${worst.r >= MIN_RATIO ? 'ok  ' : 'FAIL'} ${String(worst.r).padStart(5)}:1  min ${MIN_RATIO}  ` +
        `${colour.label.padEnd(7)} ${theme.padEnd(5)} ${value} worst on ${worst.name} ${worst.bg}`,
    )
    check(
      `${colour.label} clears ${MIN_RATIO}:1 on every ${theme} surface`,
      worst.r >= MIN_RATIO,
      { worst: worst.name, background: worst.bg, ratio: worst.r },
    )
  }
}

/* ------------------------------------------------------------------ */
/* 2. The stylesheet's copy of the palette                             */
/* ------------------------------------------------------------------ */

const machineCss = readFileSync(join(ROOT, 'apps', 'ui', 'src', 'machine.css'), 'utf8')

function declared(theme: 'light' | 'dark'): Record<string, string> {
  const block =
    theme === 'light'
      ? /:root,\s*:root\[data-theme='light'\]\s*\{([\s\S]*?)\n\}/.exec(machineCss)
      : /:root\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/.exec(machineCss)
  if (!block) throw new Error(`could not find the ${theme} palette block in machine.css`)
  const out: Record<string, string> = {}
  for (const [, id, value] of block[1]!.matchAll(/--machine-([a-z]+):\s*(#[0-9a-fA-F]{6})/g)) {
    out[id!] = value!.toLowerCase()
  }
  return out
}

// The contrast above is computed from the TypeScript palette; the screen is
// painted from the stylesheet. If they disagree, the numbers are about colours
// nobody sees — so they are not allowed to disagree.
const cssLight = declared('light')
const cssDark = declared('dark')
for (const colour of MACHINE_COLORS) {
  check(`machine.css declares ${colour.label} light as the palette does`, cssLight[colour.id] === colour.light.toLowerCase(), {
    css: cssLight[colour.id],
    palette: colour.light,
  })
  check(`machine.css declares ${colour.label} dark as the palette does`, cssDark[colour.id] === colour.dark.toLowerCase(), {
    css: cssDark[colour.id],
    palette: colour.dark,
  })
}
check(
  'machine.css declares no colour the palette does not offer',
  Object.keys(cssLight).every((id) => MACHINE_COLORS.some((colour) => colour.id === id)),
  Object.keys(cssLight),
)

/* ------------------------------------------------------------------ */
/* 3. The default, and what is not a colour                            */
/* ------------------------------------------------------------------ */

check('a machine nobody chose for gets the default', machineColorOf({}, null).id === 'slate', machineColorOf({}, null))
check('a stored id we no longer offer falls back', machineColorOf({ vps: 'neon' as never }, 'vps').id === 'slate')
check('a hex is not a machine colour', asMachineColorId('#ff0000') === null)
check('an offered id is one', asMachineColorId('amber') === 'amber')

/* ------------------------------------------------------------------ */
/* 4. Survives a restart                                               */
/* ------------------------------------------------------------------ */

const { home, env } = tempHome('machine-color')
// `vps` is a literal alias in the fixture ssh config, and ticking it here is what
// the server's own gate checks — the same gate a session goes through.
await Bun.write(join(home, 'config.json'), `${JSON.stringify({ hosts: ['vps'] }, null, 2)}\n`)
const serverEnv = { ...env, SEDANO_SSH_CONFIG: join(ROOT, 'scripts', 'fixtures', 'ssh-config') }

const post = (url: string, body: unknown) =>
  fetch(`${url}/api/machine-colors`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

try {
  const first = await startApi(serverEnv)
  const setLocal = await post(first.url, { host: null, color: 'moss' })
  const setRemote = await post(first.url, { host: 'vps', color: 'rose' })
  check('this computer takes a colour', setLocal.ok, setLocal.status)
  check('an enabled host takes a colour', setRemote.ok, setRemote.status)

  const bogus = await post(first.url, { host: null, color: 'neon' })
  check('a colour nobody offers is refused', bogus.status === 400, bogus.status)
  const unknownHost = await post(first.url, { host: 'never-enabled', color: 'moss' })
  check('a machine nobody enabled is refused', unknownHost.status === 400, unknownHost.status)

  const before = (await (await fetch(`${first.url}/api/machine-colors`)).json()) as {
    colors: Record<string, string>
  }
  check('the refused values were not stored', before.colors[''] === 'moss' && !('never-enabled' in before.colors), before.colors)
  await first.stop()

  // A different process, the same store: this is the restart, not a cache flush.
  const second = await startApi(serverEnv)
  const after = (await (await fetch(`${second.url}/api/machine-colors`)).json()) as {
    colors: Record<string, string>
  }
  check('this computer keeps its colour across a restart', after.colors[''] === 'moss', after.colors)
  check('a host keeps its colour across a restart', after.colors['vps'] === 'rose', after.colors)

  const cleared = (await (await post(second.url, { host: null, color: null })).json()) as {
    colors: Record<string, string>
  }
  check('clearing a colour removes the entry rather than storing a default', !('' in cleared.colors), cleared.colors)
  check('clearing one machine leaves the others alone', cleared.colors['vps'] === 'rose', cleared.colors)
  await second.stop()
} finally {
  await runCleanups()
}

/* ------------------------------------------------------------------ */
/* 5. The resolved id, read as a name                                  */
/* ------------------------------------------------------------------ */

const resolved = 'claude-haiku-4-5-20251001'
check(`${resolved} reads as a name`, modelName(resolved) === 'Claude Haiku 4.5', modelName(resolved))
check('the snapshot date is dropped, not mangled', !modelName(resolved).includes('20251001'))
check('a dashed version becomes one number', modelName('claude-opus-4-1-20250805') === 'Claude Opus 4.1', modelName('claude-opus-4-1-20250805'))
check('a version already written with a dot is left alone', modelName('gpt-5.6-sol') === 'GPT 5.6 Sol', modelName('gpt-5.6-sol'))
// The one id where a dot and a dash are not interchangeable: `v2.5` is a name
// with a version in it, and splitting on the dot loses the version.
check(
  'a dot inside a word is not a word boundary',
  modelName('xiaomi/mimo-v2.5-pro') === 'Xiaomi Mimo V2.5 Pro',
  modelName('xiaomi/mimo-v2.5-pro'),
)
check('a trailing number that is not a date stays', modelName('llama-3-1-405b') === 'Llama 3.1 405b', modelName('llama-3-1-405b'))
check('an id with nothing to humanise comes back as it is', modelName('sonnet') === 'Sonnet', modelName('sonnet'))
// The label changes; the value does not. What ran is still exactly what ran.
const row = readModel({ id: resolved, label: modelName(resolved) })
check('the exact id survives the reading', row.id === resolved, row.id)
check('the row is labelled with the name', row.label === 'Claude Haiku 4.5', row.label)

/* ------------------------------------------------------------------ */

console.log(`\n${passed.length} checks passed`)
if (failures.length) {
  for (const failure of failures) console.error(`✗ ${failure}`)
  console.log(`\nverdict: MACHINE COLOUR PROBLEM (${failures.length})`)
  process.exit(1)
}
console.log('machine-color-test: PASSED')
