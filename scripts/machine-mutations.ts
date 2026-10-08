#!/usr/bin/env bun
/**
 * Proof that `machine-color-test.ts` and `machine-ui-test.ts` can fail.
 *
 * A green suite means nothing on its own: an assertion that cannot go red is a
 * sentence, not a test. Each mutation below breaks exactly one thing in the
 * source — the palette's contrast, the status a `SessionStatus` maps to, the
 * colour's trip through the database, the word "tmux" — runs the suite that is
 * supposed to notice, and requires the named assertions to be among the
 * failures. Anything that stays green under the mutation that should have
 * killed it is reported as loudly as a failing test.
 *
 * The browser suite reads the built bundle, so a mutation to a UI source is
 * rebuilt before it is run and rebuilt again on the way out. Every file is
 * written back byte for byte and the hashes are printed, so the restoration can
 * be checked rather than believed.
 *
 *   bun scripts/machine-mutations.ts [--only <substring>]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const EVENTS = join(ROOT, 'packages', 'shared', 'src', 'events.ts')
const DB = join(ROOT, 'apps', 'server', 'src', 'db.ts')
const SERVER = join(ROOT, 'apps', 'server', 'src', 'index.ts')
const MODELS = join(ROOT, 'apps', 'ui', 'src', 'models.ts')
const STORE = join(ROOT, 'apps', 'ui', 'src', 'store.ts')
const CHROME = join(ROOT, 'apps', 'ui', 'src', 'components', 'Chrome.tsx')
const SETTINGS = join(ROOT, 'apps', 'ui', 'src', 'components', 'Settings.tsx')
const CSS = join(ROOT, 'apps', 'ui', 'src', 'machine.css')

const SUITES = {
  color: { script: join(ROOT, 'scripts', 'machine-color-test.ts'), marker: 'machine-color-test:', build: false },
  ui: { script: join(ROOT, 'scripts', 'machine-ui-test.ts'), marker: 'machine-ui-test:', build: true },
} as const

type SuiteId = keyof typeof SUITES

interface Mutation {
  /** What is being broken, in the words of the thing it protects. */
  name: string
  suite: SuiteId
  file: string
  from: string
  to: string
  /** Assertions that must go red. Each one is a label from the suite. */
  breaks: string[]
}

const MUTATIONS: Mutation[] = [
  /* ---------------- the palette ---------------- */
  {
    name: 'a colour is retuned to something that vanishes on a light background',
    suite: 'color',
    file: EVENTS,
    from: "{ id: 'amber', label: 'Amber', light: '#8a5a06', dark: '#dba54a' },",
    to: "{ id: 'amber', label: 'Amber', light: '#f2e6c0', dark: '#dba54a' },",
    breaks: ['Amber clears 3:1 on every light surface', 'machine.css declares Amber light as the palette does'],
  },
  {
    name: 'a colour is retuned to something that vanishes on a dark background',
    suite: 'color',
    file: EVENTS,
    from: "{ id: 'teal', label: 'Teal', light: '#1f6b63', dark: '#5fbfb2' },",
    to: "{ id: 'teal', label: 'Teal', light: '#1f6b63', dark: '#243b38' },",
    breaks: ['Teal clears 3:1 on every dark surface', 'machine.css declares Teal dark as the palette does'],
  },
  {
    name: 'the stylesheet drifts away from the palette the picker offers',
    suite: 'color',
    file: CSS,
    from: '  --machine-indigo: #3f51a8;',
    to: '  --machine-indigo: #3f52a8;',
    breaks: ['machine.css declares Indigo light as the palette does'],
  },
  {
    name: 'the stylesheet carries a colour nobody can choose',
    suite: 'color',
    file: CSS,
    from: '  --machine-clay: #9c4a2a;',
    to: '  --machine-clay: #9c4a2a;\n  --machine-neon: #00ff00;',
    breaks: ['machine.css declares no colour the palette does not offer'],
  },

  /* ---------------- the default, and what is not a colour ---------------- */
  {
    name: 'a machine nobody chose for gets some other colour',
    suite: 'color',
    file: EVENTS,
    from: "export const DEFAULT_MACHINE_COLOR: MachineColorId = 'slate'",
    to: "export const DEFAULT_MACHINE_COLOR: MachineColorId = 'clay'",
    breaks: ['a machine nobody chose for gets the default', 'a stored id we no longer offer falls back'],
  },
  {
    name: 'anything at all is accepted as a machine colour',
    suite: 'color',
    file: EVENTS,
    from: '  return MACHINE_COLORS.some((colour) => colour.id === value) ? (value as MachineColorId) : null',
    to: '  return value as MachineColorId',
    breaks: [
      'a hex is not a machine colour',
      'a colour nobody offers is refused',
      'the refused values were not stored',
    ],
  },
  {
    name: 'a stored value is drawn without being checked against the palette',
    suite: 'color',
    file: EVENTS,
    from: '  const chosen = asMachineColorId(colors?.[machineColorKey(host)]) ?? DEFAULT_MACHINE_COLOR',
    to: '  const chosen = (colors?.[machineColorKey(host)] ?? DEFAULT_MACHINE_COLOR) as MachineColorId',
    breaks: ['a stored id we no longer offer falls back'],
  },

  /* ---------------- the trip through the database ---------------- */
  {
    name: 'the colour is never written to the store',
    suite: 'color',
    file: DB,
    from: "  kvSet(MACHINE_COLORS_KEY, JSON.stringify(colors))",
    to: "  if (color === undefined) kvSet(MACHINE_COLORS_KEY, JSON.stringify(colors))",
    breaks: [
      'this computer keeps its colour across a restart',
      'a host keeps its colour across a restart',
      'the refused values were not stored',
    ],
  },
  {
    name: 'the store is read as if it were always empty',
    suite: 'color',
    file: DB,
    from: '  const raw = kvGet(MACHINE_COLORS_KEY)\n  if (!raw) return {}',
    to: '  const raw = kvGet(MACHINE_COLORS_KEY)\n  if (raw) return {}',
    breaks: [
      'this computer keeps its colour across a restart',
      'a host keeps its colour across a restart',
      'clearing one machine leaves the others alone',
    ],
  },
  {
    name: 'clearing a colour writes the default in instead of removing the entry',
    suite: 'color',
    file: DB,
    from: '  if (color) colors[key] = color\n  else delete colors[key]',
    to: "  colors[key] = color ?? 'slate'",
    breaks: ['clearing a colour removes the entry rather than storing a default'],
  },
  {
    name: 'a machine nobody enabled can be given a colour',
    suite: 'color',
    file: SERVER,
    from: '          const host = requireHost(body.host)\n          // `null` clears;',
    to: '          const host = (body.host ?? null) as string | null\n          // `null` clears;',
    breaks: ['a machine nobody enabled is refused'],
  },

  /* ---------------- the model, read as a name ---------------- */
  {
    name: 'the snapshot date is left on the end of the model name',
    suite: 'color',
    file: MODELS,
    from: 'const SNAPSHOT_DATE = /-(19|20)\\d{6}$/',
    to: 'const SNAPSHOT_DATE = /-(19|20)\\d{99}$/',
    breaks: [
      'claude-haiku-4-5-20251001 reads as a name',
      'the snapshot date is dropped, not mangled',
      'a dashed version becomes one number',
      'the row is labelled with the name',
    ],
  },
  {
    name: 'a version spelled with dashes stays a list of digits',
    suite: 'color',
    file: MODELS,
    from: "      out[out.length - 1] = `${out[out.length - 1]}.${part}`\n      continue",
    to: '      out.push(part)\n      continue',
    breaks: ['claude-haiku-4-5-20251001 reads as a name', 'a dashed version becomes one number'],
  },
  {
    name: 'a dot is treated as a word boundary, so a version is taken apart',
    suite: 'color',
    file: MODELS,
    from: "  const parts = id.replace(SNAPSHOT_DATE, '').split(/[-_/]/).filter(Boolean)",
    to: "  const parts = id.replace(SNAPSHOT_DATE, '').split(/[-_/.]/).filter(Boolean)",
    breaks: ['a dot inside a word is not a word boundary'],
  },
  {
    name: 'anything at the end of an id is taken for a snapshot date and dropped',
    suite: 'color',
    file: MODELS,
    from: 'const SNAPSHOT_DATE = /-(19|20)\\d{6}$/',
    to: 'const SNAPSHOT_DATE = /-\\w+$/',
    breaks: [
      'a trailing number that is not a date stays',
      'a version already written with a dot is left alone',
    ],
  },
  {
    name: 'the id is printed instead of read',
    suite: 'color',
    file: MODELS,
    from: 'export function modelName(id: string): string {\n  return humanise(id) || id',
    to: 'export function modelName(id: string): string {\n  return id',
    breaks: [
      'claude-haiku-4-5-20251001 reads as a name',
      'the snapshot date is dropped, not mangled',
      'a dashed version becomes one number',
      'the row is labelled with the name',
    ],
  },
  {
    name: 'the readable label replaces the id that is actually sent',
    suite: 'color',
    file: MODELS,
    from: '  return {\n    id: raw,\n    base: id,',
    to: '  return {\n    id: label,\n    base: id,',
    breaks: ['the exact id survives the reading'],
  },

  /* ---------------- the status mapping ---------------- */
  {
    name: 'a finished session reads as a stopped one',
    suite: 'ui',
    file: STORE,
    from: "  idle: 'ready',",
    to: "  idle: 'stopped',",
    breaks: [
      'a finished session is marked ready',
      'a finished session says so in words',
      'no two states share a mark',
    ],
  },
  {
    name: 'a failure is folded into the ordinary states',
    suite: 'ui',
    file: STORE,
    from: "  error: 'error',\n  running: 'working',",
    to: "  error: 'stopped',\n  running: 'working',",
    breaks: ['a failed session is marked as an error', 'a failed session says so in words'],
  },
  {
    name: 'a session still coming up is claimed to be working',
    suite: 'ui',
    file: STORE,
    from: "  starting: 'starting',",
    to: "  starting: 'working',",
    breaks: ['a starting session is told apart from a working one'],
  },
  {
    name: 'nothing moves while a turn is running',
    suite: 'ui',
    file: STORE,
    from: "  return state === 'working' || state === 'starting'",
    to: '  return false',
    breaks: [
      'a running session shows the moving indicator',
      'a starting session shows the moving indicator',
    ],
  },
  {
    name: 'the state is left to the colour alone, with no word for it',
    suite: 'ui',
    file: CHROME,
    from: '  return <span className={`sess-state ${state}`} title={word} role="img" aria-label={word} />',
    to: '  return <span className={`sess-state ${state}`} />',
    breaks: [
      'a finished session says so in words',
      'a stopped session says so in words',
      'a failed session says so in words',
    ],
  },

  /* ---------------- the model on screen ---------------- */
  {
    name: 'the sidebar prints the model id it was given',
    suite: 'ui',
    file: CHROME,
    from: '            <span title={session.model}>{modelName(session.model)}</span>',
    to: '            <span title={session.model}>{session.model}</span>',
    breaks: ['the resolved model id is drawn as a name'],
  },
  {
    name: 'the readable name is all that is left of the model',
    suite: 'ui',
    file: CHROME,
    from: '            <span title={session.model}>{modelName(session.model)}</span>',
    to: '            <span>{modelName(session.model)}</span>',
    breaks: ['the exact id is still reachable'],
  },

  /* ---------------- machines on the tabs ---------------- */
  {
    name: 'a tab of another machine is treated as one of this machine',
    suite: 'ui',
    file: CHROME,
    from: '        const foreign = host !== state.settings.machine',
    to: '        const foreign = false',
    breaks: [
      'a tab of a machine other than the selected one is marked foreign',
      'and it is drawn differently from a tab of the selected machine',
    ],
  },
  {
    // Every rule that marks it, at once: neutering one alone would leave the
    // other doing the work, and the assertion would rightly survive.
    name: 'a foreign tab is drawn exactly like the rest',
    suite: 'ui',
    file: CSS,
    from: `.tab.foreign {
  border-left: 3px solid var(--machine, var(--machine-slate));
  padding-left: 7px;
  background: color-mix(in srgb, var(--machine, var(--machine-slate)) 9%, transparent);
}

.tab.foreign .tab-machine {
  color: var(--fg-mute);
}

.tab.foreign.active {
  background: color-mix(in srgb, var(--machine, var(--machine-slate)) 14%, var(--surface));
}`,
    to: '.tab.foreign {\n  opacity: 0.999;\n}',
    breaks: ['and it is drawn differently from a tab of the selected machine'],
  },
  {
    name: 'a tab stops saying which machine it belongs to',
    suite: 'ui',
    file: CHROME,
    from: '            <span className="tab-machine">{machineName(host)}</span>',
    to: '            {null}',
    breaks: ['every tab says which machine it is on', 'and it names its own machine, not the selected one'],
  },
  {
    name: 'the machine selector loses its dot',
    suite: 'ui',
    file: CHROME,
    from: '        <MachineDot color={colorForMachine(state, current)} host={current} />\n        <span className="machine-name">',
    to: '        <span className="machine-name">',
    breaks: [
      'the machine selector carries a dot',
      'the machine selector shows the chosen colour',
      'and it is still there after a reload',
      'the dark theme uses the dark value of the same colour',
    ],
  },
  {
    name: 'the dark theme is left to paint machines with the light values',
    suite: 'ui',
    file: CSS,
    from: "  --machine-moss: #8fc06a;\n  --machine-clay: #e0916d;",
    to: "  --machine-moss: #3f6b25;\n  --machine-clay: #e0916d;",
    breaks: ['the dark theme uses the dark value of the same colour'],
  },

  /* ---------------- choosing, and keeping, a colour ---------------- */
  {
    name: 'the client ignores the colours the server broadcasts',
    suite: 'ui',
    file: STORE,
    from: "    case 'machine_colors': {\n      set({ machineColors: msg.colors })",
    to: "    case 'machine_colors': {\n      set({})",
    breaks: ['the swatch lights up once the server has stored the choice', 'the machine selector shows the chosen colour'],
  },
  {
    name: 'the greeting no longer carries the colours, so a reload forgets them',
    suite: 'ui',
    file: STORE,
    from: '        ...(msg.machineColors ? { machineColors: msg.machineColors } : {}),',
    to: '        ...({} as Record<string, never>),',
    breaks: ['and it is still there after a reload', 'the dark theme uses the dark value of the same colour'],
  },
  {
    name: 'Settings offers only some of the colours it stores',
    suite: 'ui',
    file: SETTINGS,
    from: '        {MACHINE_COLORS.map((colour) => (',
    to: '        {MACHINE_COLORS.slice(0, 3).map((colour) => (',
    breaks: ['every offered colour has a swatch'],
  },
  {
    name: 'a swatch is a colour and nothing else',
    suite: 'ui',
    file: SETTINGS,
    from: '            aria-label={colour.label}\n            aria-pressed={colour.id === current.id}',
    to: '            aria-pressed={colour.id === current.id}',
    breaks: ['each swatch is named, not only coloured'],
  },

  /* ---------------- the delete wording ---------------- */
  {
    name: 'the delete confirmation goes back to naming tmux',
    suite: 'ui',
    file: CHROME,
    from: "        ? 'The shell it is running stops, and anything still running in it is ended.'",
    to: "        ? 'Its tmux session on the host is closed too.'",
    breaks: ['the delete confirmation does not mention tmux'],
  },
  {
    name: 'the delete menu entry goes back to naming tmux',
    suite: 'ui',
    file: CHROME,
    from: "        Delete{session.kind === 'terminal' ? ' (and its shell)' : ''}",
    to: "        Delete (and its tmux)",
    breaks: ['the delete entry does not mention tmux'],
  },
]

/* ---------------- running ---------------- */

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null
const chosen = only ? MUTATIONS.filter((m) => m.name.includes(only)) : MUTATIONS

function hash(file: string): string {
  return Bun.spawnSync(['shasum', '-a', '256', file]).stdout.toString().trim()
}

function build(): void {
  const run = Bun.spawnSync(['bun', 'run', 'build:ui'], { cwd: ROOT })
  if (run.exitCode !== 0) {
    // A mutation that will not compile proves nothing about the assertion: it is
    // reported rather than counted.
    console.log(`  (the bundle did not build: ${run.stderr.toString().split('\n').slice(-6).join(' ').slice(0, 300)})`)
  }
}

/** Runs one suite and returns the labels it printed as failures. */
function runSuite(suite: SuiteId): { failed: Set<string>; passed: number; crashed: boolean } {
  if (SUITES[suite].build) build()
  const run = Bun.spawnSync(['bun', SUITES[suite].script], { cwd: ROOT })
  const out = run.stdout.toString() + run.stderr.toString()
  const failed = new Set<string>()
  for (const line of out.split('\n')) {
    const at = line.indexOf('✗ ')
    if (at >= 0) failed.add(line.slice(at + 2).split(' — ')[0]!.trim())
  }
  const passed = Number(/(\d+) checks passed/.exec(out)?.[1] ?? 0)
  return { failed, passed, crashed: !out.includes(SUITES[suite].marker) && !failed.size }
}

const files = [...new Set(MUTATIONS.map((m) => m.file))]
const before = Object.fromEntries(files.map((f) => [f, readFileSync(f, 'utf8')]))
const beforeHash = Object.fromEntries(files.map((f) => [f, hash(f)]))

console.log('--- hashes before ---')
for (const f of files) console.log(`  ${beforeHash[f]}`)

console.log('\n--- baseline ---')
const suitesUsed = [...new Set(chosen.map((m) => m.suite))]
for (const suite of suitesUsed) {
  const base = runSuite(suite)
  console.log(`  ${suite}: ${base.passed} assertions passed, ${base.failed.size} failed`)
  if (base.failed.size || base.crashed) {
    console.log('the suite is not green to begin with; nothing below would mean anything')
    for (const label of base.failed) console.log(`  ✗ ${label}`)
    process.exit(1)
  }
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
  const result = runSuite(mutation.suite)
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

// The bundle on disk is whatever the last mutation built; put the real one back.
if (suitesUsed.includes('ui')) build()

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
console.log(`\nmachine-mutations: ${chosen.length}/${chosen.length} mutations proved their assertions falsifiable`)
process.exit(0)
