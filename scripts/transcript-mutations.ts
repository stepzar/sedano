#!/usr/bin/env bun
/**
 * Proof that the transcript assertions in `ui-check.ts` can fail.
 *
 * A green check means nothing on its own: an assertion that cannot go red is a
 * sentence, not a test. Each mutation below puts back exactly one of the defects
 * this pass fixed — the negative margin that let `overflow: hidden` eat the first
 * characters of every thinking block, the placeholder that made a starting
 * subagent read as "agent · agent", the eleven-pixel caret, the seven-by-eight
 * dot, the jump control that only recomputed on scroll — then runs `check:ui`
 * and requires the named assertions to be among its failures. Anything that
 * stays green under the mutation that should have killed it is reported here as
 * loudly as a failing test.
 *
 * Every file is written back byte for byte afterwards and the hashes are printed
 * so the restoration can be checked rather than believed.
 *
 *   bun scripts/transcript-mutations.ts [--only <substring>]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const TRANSCRIPT = join(ROOT, 'apps', 'ui', 'src', 'components', 'Transcript.tsx')
const VIEW = join(ROOT, 'apps', 'ui', 'src', 'view.ts')
const CSS = join(ROOT, 'apps', 'ui', 'src', 'styles.css')

interface Mutation {
  /** What is being broken, in the words of the thing it protects. */
  name: string
  file: string
  from: string
  to: string
  /** Assertions that must go red. Each one is a label from `check:ui`. */
  breaks: string[]
}

const MUTATIONS: Mutation[] = [
  {
    name: 'the thinking hangs back out into the gutter, inside the fold that clips it',
    file: CSS,
    from: '.think {\n  display: flex;',
    to: '.turn-body > .think {\n  margin-left: -51px;\n}\n\n.think {\n  display: flex;',
    breaks: ['no text in the transcript is painted outside the box that clips it'],
  },
  {
    name: 'the pinned thinking is pulled past the left edge of the transcript',
    file: CSS,
    from: '.think-pin {\n  position: sticky;',
    to: '.think-pin {\n  margin-left: -60px;\n  position: sticky;',
    breaks: ['no text in the transcript is painted outside the box that clips it'],
  },
  {
    name: 'a message stops wrapping and hides the rest of the line inside itself',
    file: CSS,
    from: '.msg-body {\n  color: var(--fg);\n  line-height: 1.65;\n  white-space: pre-wrap;',
    to: '.msg-body {\n  color: var(--fg);\n  line-height: 1.65;\n  white-space: pre;\n  overflow-x: hidden;',
    breaks: ['no text block hides its own content sideways'],
  },
  {
    name: 'the thinking block stops saying what it is',
    file: TRANSCRIPT,
    from: '<span className="block-label">Thinking</span>',
    to: '<span className="block-label">Notes</span>',
    breaks: ['the thinking block says it is thinking'],
  },
  {
    name: 'the thinking stops being a kind of block the tree can name',
    file: TRANSCRIPT,
    from: "className={`think${open ? ' open' : ''}${pinned ? ' pinned' : ''}`} data-block=\"thinking\"",
    to: "className={`think${open ? ' open' : ''}${pinned ? ' pinned' : ''}`}",
    breaks: ['the thinking and the reply are separate blocks in the DOM', 'the thinking block says it is thinking'],
  },
  {
    name: 'the spawn call stops being read, so a starting card knows nothing about its agent',
    file: VIEW,
    from:
      "    agentType: text('subagent_type') || text('agent_type') || UNTYPED_AGENT,\n" +
      "    description: text('description'),\n" +
      "    prompt: text('prompt'),",
    to: '    agentType: UNTYPED_AGENT,\n    description: \'\',\n    prompt: \'\',',
    breaks: [
      'a subagent still starting names its type (card 1)',
      'a subagent still starting says what it was sent to do (card 1)',
      'a subagent still starting carries its prompt (card 1)',
      'a subagent still starting names its type (card 2)',
      'a subagent still starting says what it was sent to do (card 2)',
      'a subagent still starting carries its prompt (card 2)',
    ],
  },
  {
    name: 'a later source that knows nothing overwrites one that did',
    file: VIEW,
    from: "  const named = [next.agentType, previous.agentType].find((type) => type && type !== UNTYPED_AGENT)",
    to: '  const named = next.agentType',
    breaks: ['a subagent still starting names its type (card 2)'],
  },
  {
    name: 'the disclosure caret goes back to being a speck',
    file: CSS,
    from: '.chevron {\n  color: var(--fg-mute);\n  font-size: 0.9em;\n  width: 24px;\n  height: 24px;',
    to: '.chevron {\n  color: var(--fg-mute);\n  font-size: 0.9em;\n  width: 12px;\n  height: 12px;',
    breaks: ['every disclosure caret is at least 24px on both sides'],
  },
  {
    name: 'the caret keeps its box but loses its glyph',
    file: TRANSCRIPT,
    from: '<span className={`chevron${open ? \' open\' : \'\'}`} aria-hidden="true">\n      <IconCaret size={16} />',
    to: '<span className={`chevron${open ? \' open\' : \'\'}`} aria-hidden="true">\n      <IconCaret size={9} />',
    breaks: ['and carries a real glyph, not a character'],
  },
  {
    name: 'the status dot goes back to being one pixel taller than it is wide',
    file: CSS,
    from: '.dot {\n  width: 8px;\n  height: 8px;',
    to: '.dot {\n  width: 7px;\n  height: 8px;',
    breaks: ['the status dot is a square box'],
  },
  {
    name: 'the status dot stops being round at all',
    file: CSS,
    from: '.dot {\n  width: 8px;\n  height: 8px;\n  border-radius: 50%;',
    to: '.dot {\n  width: 8px;\n  height: 8px;\n  border-radius: 2px;',
    breaks: ['and is drawn as a circle in it'],
  },
  {
    name: 'the jump control goes back to recomputing only when the user scrolls',
    file: TRANSCRIPT,
    from: '    const observer = new ResizeObserver(() => measure())\n    observer.observe(content)\n    observer.observe(node)\n    return () => observer.disconnect()',
    to: '    const observer = new ResizeObserver(() => undefined)\n    observer.observe(content)\n    observer.observe(node)\n    return () => observer.disconnect()',
    breaks: ['and the control goes with it, without waiting for a scroll'],
  },
]

/* ---------------- running ---------------- */

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null
const chosen = only ? MUTATIONS.filter((m) => m.name.includes(only!)) : MUTATIONS

function hash(file: string): string {
  return Bun.spawnSync(['shasum', '-a', '256', file]).stdout.toString().trim()
}

/**
 * Runs `check:ui` and returns the labels it printed as failures.
 *
 * The app itself is served from the built bundle, which these mutations never
 * touch; every assertion they are about reads the gallery, which vite serves
 * from source. So nothing has to be rebuilt between runs, and a mutation cannot
 * make an unrelated check fail by accident.
 */
function runSuite(): { failed: Set<string>; green: boolean; finished: boolean } {
  const run = Bun.spawnSync(['bun', join(ROOT, 'scripts', 'ui-check.ts')], { cwd: ROOT })
  const out = run.stdout.toString() + run.stderr.toString()
  const failed = new Set<string>()
  for (const line of out.split('\n')) {
    if (!line.startsWith('✗ ')) continue
    failed.add(line.slice(2).split(' — ')[0]!.trim())
  }
  return { failed, green: out.includes('verdict: UI OK'), finished: out.includes('verdict: UI') }
}

const files = [...new Set(MUTATIONS.map((m) => m.file))]
const before = Object.fromEntries(files.map((f) => [f, readFileSync(f, 'utf8')]))
const beforeHash = Object.fromEntries(files.map((f) => [f, hash(f)]))

console.log('--- hashes before ---')
for (const f of files) console.log(`  ${beforeHash[f]}`)

console.log('\n--- baseline ---')
const base = runSuite()
console.log(`  ${base.green ? 'green' : `${base.failed.size} failed`}`)
if (!base.green) {
  console.log('the check is not green to begin with; nothing below would mean anything')
  for (const label of base.failed) console.log(`  ✗ ${label}`)
  process.exit(1)
}

const unproven: string[] = []
const covered = new Set<string>()

for (const mutation of chosen) {
  const source = before[mutation.file]!
  if (!source.includes(mutation.from)) {
    console.log(`\n✗ ${mutation.name}\n  the code it patches is not there any more: ${mutation.from.slice(0, 70)}…`)
    unproven.push(mutation.name)
    continue
  }
  writeFileSync(mutation.file, source.replace(mutation.from, mutation.to))
  const result = runSuite()
  writeFileSync(mutation.file, source)

  const survived = mutation.breaks.filter((label) => !result.failed.has(label))
  console.log(`\n${survived.length ? '✗' : '✓'} ${mutation.name}`)
  console.log(`  broke: ${[...result.failed].join(' | ') || '(nothing — the check stayed green)'}`)
  if (!result.finished) console.log('  the check did not finish')
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
if (unproven.length) {
  console.log(`\n${unproven.length} mutation(s) nothing caught:`)
  for (const name of unproven) console.log(`  ✗ ${name}`)
}
console.log(`\nverdict: ${unproven.length === 0 && restored ? 'MUTATIONS ALL CAUGHT' : 'GAPS'}`)
process.exit(unproven.length === 0 && restored ? 0 : 1)
