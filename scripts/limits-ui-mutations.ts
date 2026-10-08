#!/usr/bin/env bun
/**
 * Proof that `limits-ui-test.ts` can fail.
 *
 * A green suite means nothing on its own: an assertion that cannot go red is a
 * sentence, not a test. So each mutation below breaks exactly one thing in the
 * source — the union that keeps a section from vanishing, the floor that keeps
 * it from shrinking, the caret's place in the trigger, the overflow that lets
 * the panel scroll — runs the suite, and requires the named assertions to be
 * among the failures. Anything that stays green under the mutation that should
 * have killed it is reported here as loudly as a failing test.
 *
 * Every file is written back byte for byte afterwards and the hashes are printed
 * so the restoration can be checked rather than believed.
 *
 *   bun scripts/limits-ui-mutations.ts [--only <substring>]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const LIMITS = join(ROOT, 'apps', 'ui', 'src', 'components', 'Limits.tsx')
const MENU = join(ROOT, 'apps', 'ui', 'src', 'components', 'Menu.tsx')
const CSS = join(ROOT, 'apps', 'ui', 'src', 'limits.css')
const SUITE = join(ROOT, 'scripts', 'limits-ui-test.ts')

interface Mutation {
  /** What is being broken, in the words of the thing it protects. */
  name: string
  file: string
  from: string
  to: string
  /** Assertions that must go red. Each one is a label from the suite. */
  breaks: string[]
}

const MUTATIONS: Mutation[] = [
  {
    name: 'the panel rebuilds its row list from each push instead of holding what it showed',
    file: LIMITS,
    from: '  for (const snapshot of limits) seen.current.set(snapshot.harness, snapshot)',
    to: '  seen.current.clear()\n  for (const snapshot of limits) seen.current.set(snapshot.harness, snapshot)',
    breaks: [
      'the panel keeps its box when a reading arrives',
      'a row already on screen does not move when a reading arrives',
      'a harness left out of a push keeps its row rather than vanishing',
    ],
  },
  {
    name: 'a section is free to get shorter again',
    file: LIMITS,
    from: '      element.style.minHeight = `${height}px`',
    to: '      element.style.minHeight = ``',
    breaks: [
      'the panel keeps its box when a reading arrives',
      'a row already on screen does not move when a reading arrives',
    ],
  },
  {
    name: 'a harness still reading holds no room open for its windows',
    file: LIMITS,
    from: 'const RESERVED_WINDOW_ROWS = 2',
    to: 'const RESERVED_WINDOW_ROWS = 0',
    breaks: ['a reading with fewer windows than were reserved does not shrink its section'],
  },
  {
    name: 'the panel sorts by severity, so a row changes place when its state changes',
    file: LIMITS,
    from: '  return readLimits(limits).sort((a, b) => panelRank(a.harness) - panelRank(b.harness))',
    to: '  return readLimits(limits)',
    breaks: ['the rows keep their order when a reading arrives'],
  },
  {
    name: 'the room held for a reading is filled with a number nobody reported',
    file: LIMITS,
    from: '              <span className="value" />',
    to: '              <span className="value">0%</span>',
    breaks: ['the room held for a reading shows no invented value'],
  },
  {
    name: 'the panel is sized from its content and may reach past the window',
    file: MENU,
    from: '                maxHeight: pos?.maxHeight,',
    to: '                maxHeight: 4000,',
    breaks: [
      'at a short viewport the panel is inside the window',
      'at a short viewport the panel scrolls rather than clipping',
      'at a window too short for either side the panel is still inside it',
    ],
  },
  {
    name: 'the panel clips what does not fit instead of scrolling',
    file: MENU,
    from: "                overflowY: 'auto',",
    to: "                overflowY: 'hidden',",
    breaks: [
      'at a short viewport the panel scrolls rather than clipping',
      'at a short viewport the last row can be scrolled to',
    ],
  },
  {
    // The one case the viewport-derived `maxHeight` cannot cover on its own: a
    // panel small enough to fit is still wrong if it is hung off the bottom edge.
    name: 'the panel is hung below the edge of the window',
    file: MENU,
    from: '{ left, top: null, bottom: window.innerHeight - anchor.top + gap, maxHeight: Math.min(above, viewport) }',
    to: '{ left, top: null, bottom: -400, maxHeight: Math.min(above, viewport) }',
    breaks: [
      'at a normal viewport the panel is inside the window',
      'at a normal viewport nothing is cut off',
    ],
  },
  {
    name: 'the panel loses the control it is supposed to end with',
    file: LIMITS,
    from: '        Refresh now\n      </button>',
    to: '        Refresh\n      </button>',
    breaks: ['the panel ends with the control it is supposed to end with'],
  },
  {
    name: 'the caret goes back to sitting after the word',
    file: LIMITS,
    from: `            <span className={\`limits-caret\${open ? ' open' : ''}\`} aria-hidden>
              <IconCaret size={17} />
            </span>
            Limits`,
    to: `            Limits
            <span className={\`limits-caret\${open ? ' open' : ''}\`} aria-hidden>
              <IconCaret size={17} />
            </span>`,
    breaks: [
      'the caret is the first thing in the trigger',
      'the caret sits to the left of the word it labels',
    ],
  },
  {
    name: 'the caret is moved out past the chips, dividing the bar again',
    file: LIMITS,
    from: `          <span className="limits-title">
            <span className={\`limits-caret\${open ? ' open' : ''}\`} aria-hidden>
              <IconCaret size={17} />
            </span>
            Limits
          </span>`,
    to: `          <span className="limits-title">Limits</span>`,
    breaks: [
      'the caret is the first thing in the trigger',
      'the caret sits to the left of the word it labels',
      'the caret sits to the left of every harness chip, so it divides nothing',
      'the caret is not a control of its own',
      'clicking the caret opens the panel',
      'the caret turns over when the panel opens',
    ],
  },
  {
    name: 'the caret becomes a second control inside the trigger',
    file: LIMITS,
    from: `            <span className={\`limits-caret\${open ? ' open' : ''}\`} aria-hidden>
              <IconCaret size={17} />
            </span>`,
    to: `            <button
              type="button"
              className={\`limits-caret\${open ? ' open' : ''}\`}
              onClick={(event) => event.stopPropagation()}
            >
              <IconCaret size={17} />
            </button>`,
    breaks: ['the caret is not a control of its own', 'clicking the caret opens the panel'],
  },
  {
    name: 'the trigger never closes once opened',
    file: MENU,
    from: '        onClick={() => setOpen((value) => !value)}',
    to: '        onClick={() => setOpen(true)}',
    breaks: ['clicking the caret again closes it'],
  },
  {
    name: 'the trigger stops saying whether it is open',
    file: MENU,
    from: '        aria-expanded={open}',
    to: '        aria-expanded={undefined}',
    breaks: ['the trigger says whether it is open', 'Enter opens the panel from the keyboard'],
  },
  {
    name: 'the caret no longer turns over',
    file: CSS,
    from: '.limits-caret.open {\n  transform: rotate(180deg);\n}',
    to: '.limits-caret.open {\n  opacity: 0.99;\n}',
    breaks: ['the caret turns over when the panel opens'],
  },
  {
    name: 'the trigger stops being a button, so the keyboard cannot reach it',
    file: MENU,
    from: `      <button
        type="button"
        className={\`select-trigger\${open ? ' open' : ''}\`}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {trigger(open)}
      </button>`,
    to: `      <span
        className={\`select-trigger\${open ? ' open' : ''}\`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {trigger(open)}
      </span>`,
    breaks: [
      'the caret is not a control of its own',
      'the trigger takes keyboard focus',
      'Enter opens the panel from the keyboard',
    ],
  },
  {
    name: 'Escape stops closing the panel',
    file: MENU,
    from: "      if (event.key === 'Escape') setOpen(false)",
    to: "      if (event.key === 'Nothing') setOpen(false)",
    breaks: ['Escape closes it again'],
  },
]

/* ---------------- running ---------------- */

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null
const chosen = only ? MUTATIONS.filter((m) => m.name.includes(only)) : MUTATIONS

function hash(file: string): string {
  return Bun.spawnSync(['shasum', '-a', '256', file]).stdout.toString().trim()
}

/** Runs the suite and returns the labels it printed as failures. */
function runSuite(): { failed: Set<string>; passedCount: number; crashed: boolean } {
  const run = Bun.spawnSync(['bun', SUITE], { cwd: ROOT })
  const out = run.stdout.toString() + run.stderr.toString()
  const failed = new Set<string>()
  for (const line of out.split('\n')) {
    const at = line.indexOf('✗ ')
    if (at >= 0) failed.add(line.slice(at + 2).split(' — ')[0]!.trim())
  }
  const passedCount = (out.match(/^✓ /gm) ?? []).length
  return { failed, passedCount, crashed: !out.includes('limits-ui-test:') }
}

const files = [...new Set(MUTATIONS.map((m) => m.file))]
const before = Object.fromEntries(files.map((f) => [f, readFileSync(f, 'utf8')]))
const beforeHash = Object.fromEntries(files.map((f) => [f, hash(f)]))

console.log('--- hashes before ---')
for (const f of files) console.log(`  ${beforeHash[f]}`)

console.log('\n--- baseline ---')
const base = runSuite()
console.log(`  ${base.passedCount} assertions passed, ${base.failed.size} failed`)
if (base.failed.size || base.crashed) {
  console.log('the suite is not green to begin with; nothing below would mean anything')
  for (const label of base.failed) console.log(`  ✗ ${label}`)
  process.exit(1)
}

const unproven: string[] = []
const covered = new Set<string>()

for (const mutation of chosen) {
  const source = before[mutation.file]!
  if (!source.includes(mutation.from)) {
    console.log(`\n✗ ${mutation.name}\n  the code it patches is not there any more: ${mutation.from.slice(0, 60)}…`)
    unproven.push(mutation.name)
    continue
  }
  writeFileSync(mutation.file, source.replace(mutation.from, mutation.to))
  const result = runSuite()
  writeFileSync(mutation.file, source)

  const survived = mutation.breaks.filter((label) => !result.failed.has(label))
  console.log(`\n${survived.length ? '✗' : '✓'} ${mutation.name}`)
  console.log(`  broke: ${[...result.failed].join(' | ') || '(nothing — the suite stayed green)'}`)
  if (result.crashed) console.log('  the suite did not finish')
  for (const label of mutation.breaks) if (!survived.includes(label)) covered.add(label)
  if (survived.length) {
    for (const label of survived) console.log(`  survived, and should not have: ${label}`)
    unproven.push(mutation.name)
  }
}

console.log('\n--- hashes after ---')
let restored = true
for (const f of files) {
  const now = hash(f)
  const same = now === beforeHash[f]
  restored &&= same
  console.log(`  ${same ? 'unchanged' : 'CHANGED  '} ${now}`)
}

console.log(`\n${covered.size} assertions shown to be falsifiable`)
for (const label of [...covered].sort()) console.log(`  ✓ ${label}`)

if (!restored) {
  console.log('\na file was not written back exactly as it was')
  process.exit(1)
}
if (unproven.length) {
  console.log(`\n${unproven.length} mutations did not prove what they were meant to:`)
  for (const name of unproven) console.log(`  ✗ ${name}`)
  process.exit(1)
}
console.log('\nlimits-ui-mutations: every assertion under test was made to fail on demand')
process.exit(0)
