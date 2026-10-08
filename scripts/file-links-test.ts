#!/usr/bin/env bun
/**
 * Clickable files: which paths on screen open, and what the server agrees to open.
 *
 * Two halves. The UI decides what to underline (a tool's file, a path in a
 * reply) and whether a tool row has anything to expand; the server decides
 * what may actually be handed to `open`. The server half is the one that must
 * never be wrong: a click in a web page must not run a program. Nothing here
 * opens anything — the spawner is replaced by a recorder.
 *
 *   bun scripts/file-links-test.ts
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent, TimelineEvent } from '@shared'
import { checkOpenable, openFile } from '../apps/server/src/open-file.ts'
import { writeExportFile } from '../apps/server/src/export-file.ts'
import { fileReference, touchedFiles } from '../apps/ui/src/fileLinks.ts'
import { toolFilePath, toolHasMore, type ToolFacts } from '../apps/ui/src/view.ts'

const failures: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) return
  failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

type Tool = Extract<TimelineEvent, { k: 'tool' }>
const tool = (fields: Partial<Tool> & { name: string }): Tool => ({ k: 'tool', toolId: 't', input: {}, summary: '', ...fields })
type Result = Extract<TimelineEvent, { k: 'tool_result' }>
function answered(text: string, extra: Partial<Result> = {}): ToolFacts {
  return { result: { k: 'tool_result', toolId: 't', text, isError: false, truncated: false, ...extra } }
}

/* ------------------------------------------------------------------ */
/* A tool row opens only when opening shows something new              */
/* ------------------------------------------------------------------ */

{
  const claudeLs = tool({ name: 'Bash', input: { command: 'ls', description: 'List files' }, summary: 'ls' })
  check('claude: a one-line command with no output has nothing to open', !toolHasMore(claudeLs, answered('(Bash completed with no output)')))
  check('claude: a command still running has nothing to open yet', !toolHasMore(claudeLs))
  check('claude: a command with output opens onto it', toolHasMore(claudeLs, answered('a.txt\nb.txt')))
  const multiline = tool({ name: 'Bash', input: { command: 'cat <<EOF\nhello\nEOF' }, summary: 'cat <<EOF' })
  check('a multi-line command opens: the row shows its first line only', toolHasMore(multiline, answered('')))
  // Codex over ACP: the title is the command, the kind says it is a run.
  const codexRun = tool({ name: 'git status', kind: 'execute', input: { command: 'git status', cwd: '/w' }, summary: 'git status' })
  check('codex: a run whose result is the placeholder has nothing to open', !toolHasMore(codexRun, answered('done', { durationMs: 70 })))
  check('codex: a failed run reports its exit on the row, nothing more to open', !toolHasMore(codexRun, answered('failed', { isError: true, exitCode: 1 })))
  check('a truncated result always opens', toolHasMore(codexRun, answered('', { truncated: true })))
  // Command Code: the arguments are not on the row.
  const cmdShell = tool({ name: 'shell_command', input: { command: 'git', args: ['status', '--short'], cwd: '/w' }, summary: 'shell_command git' })
  check('command code: arguments the row does not show open', toolHasMore(cmdShell, answered('')))
  const write = tool({ name: 'Write', input: { file_path: '/w/a.md', content: '# hi' }, summary: '/w/a.md' })
  check('a write opens onto the content it wrote', toolHasMore(write, answered('')))
  // opencode's bash with only a cwd, and output.
  const opencodeBash = tool({ name: 'bash', input: { cwd: '/root/x' }, summary: 'bash' })
  check('opencode: nothing but plumbing and no output has nothing to open', !toolHasMore(opencodeBash, answered('')))
}

/* ------------------------------------------------------------------ */
/* The file a tool row names                                           */
/* ------------------------------------------------------------------ */

{
  check('claude Write names its file', toolFilePath(tool({ name: 'Write', input: { file_path: '/w/a.md' } })) === '/w/a.md')
  check('claude Read names its file', toolFilePath(tool({ name: 'Read', input: { file_path: '/w/a.md', offset: 1 } })) === '/w/a.md')
  check('claude NotebookEdit names its notebook', toolFilePath(tool({ name: 'NotebookEdit', input: { notebook_path: '/w/n.ipynb' } })) === '/w/n.ipynb')
  check('gemini write_file names its file', toolFilePath(tool({ name: 'write_file', input: { file_path: 'b.md' } })) === 'b.md')
  check('command code read_file names its path', toolFilePath(tool({ name: 'read_file', input: { path: 'src/a.ts' } })) === 'src/a.ts')
  check('an ACP edit names its location', toolFilePath(tool({ name: 'Editing files', kind: 'edit', input: null, paths: ['/w/c.ts'] })) === '/w/c.ts')
  check('an ACP read names its location', toolFilePath(tool({ name: 'Read c.ts', kind: 'read', paths: ['/w/c.ts'] })) === '/w/c.ts')
  check('a delete names nothing to open', toolFilePath(tool({ name: 'rm', kind: 'delete', paths: ['/w/gone.ts'] })) === null)
  check('a search path is a folder, not a file', toolFilePath(tool({ name: 'Grep', input: { pattern: 'x', path: '/w' } })) === null)
  check('a command names no file', toolFilePath(tool({ name: 'Bash', input: { command: 'cat /w/a.md' } })) === null)
}

/* ------------------------------------------------------------------ */
/* Paths in a reply                                                    */
/* ------------------------------------------------------------------ */

{
  let seq = 0
  const at = (ev: TimelineEvent): SessionEvent => ({ id: `e${++seq}`, sessionId: 's', seq, at: seq, ev })
  const events = [
    at(tool({ name: 'Write', input: { file_path: '/Users/x/Desktop/test.md', content: 'x' } })),
    at({ k: 'file_change', toolId: 't2', path: 'src/view.ts', change: 'edit', added: 1, removed: 0, preview: '' }),
    at(tool({ name: 'Read', input: { file_path: '/Users/x/proj/README.md' } })),
  ]
  const cwd = '/Users/x/proj'
  const touched = touchedFiles(events, cwd)
  check('touched files are absolute', touched.includes('/Users/x/Desktop/test.md') && touched.includes('/Users/x/proj/src/view.ts'), touched)
  check('a bare name matches the one touched file it ends', fileReference('test.md', cwd, touched) === '/Users/x/Desktop/test.md')
  check('a relative path resolves against the session folder', fileReference('src/view.ts', cwd, touched) === '/Users/x/proj/src/view.ts')
  check('a line suffix is not part of the name', fileReference('src/view.ts:42', cwd, touched) === '/Users/x/proj/src/view.ts')
  check('a name the session never touched is not a link', fileReference('other.md', cwd, touched) === null)
  check('an absolute path where files live is a link', fileReference('/Users/x/notes/plan.pdf', cwd, touched) === '/Users/x/notes/plan.pdf')
  check('a home path is a link', fileReference('~/notes.txt', cwd, touched) === '~/notes.txt')
  check('an API route is not a file', fileReference('/api/open-file', cwd, touched) === null)
  check('a command is not a file', fileReference('bun run build', cwd, touched) === null)
  check('a URL is not a file', fileReference('https://x.y/a.md', cwd, touched) === null)
  check('a word is not a file', fileReference('useState', cwd, touched) === null)
  const twice = [...touched, '/Users/x/other/test.md']
  check('an ambiguous bare name is not a guess', fileReference('test.md', cwd, twice) === null)
}

/* ------------------------------------------------------------------ */
/* What the server agrees to open                                      */
/* ------------------------------------------------------------------ */

{
  const dir = mkdtempSync(join(tmpdir(), 'sedano-open-'))
  const doc = join(dir, 'notes.md')
  writeFileSync(doc, '# notes')
  const script = join(dir, 'run-me')
  writeFileSync(script, '#!/bin/sh\necho hi\n')
  chmodSync(script, 0o755)
  const command = join(dir, 'Install.command')
  writeFileSync(command, 'echo hi\n')
  const python = join(dir, 'tool.py')
  writeFileSync(python, 'print(1)\n')
  const bundle = join(dir, 'Fake.app')
  mkdirSync(bundle)
  const link = join(dir, 'link.md')
  symlinkSync(script, link)
  const calls: string[][] = []
  const record = (argv: string[]) => { calls.push(argv) }

  const opened = openFile(doc, null, record, 'darwin')
  check('a document opens', opened.ok, opened)
  check('with `open` on macOS, as one argument', calls.at(-1)?.[0] === 'open' && calls.at(-1)?.length === 2, calls.at(-1))
  openFile(doc, null, record, 'linux')
  check('with `xdg-open` on Linux', calls.at(-1)?.[0] === 'xdg-open', calls.at(-1))
  const relative = openFile('notes.md', dir, record, 'darwin')
  check('a relative path opens from the session folder', relative.ok, relative)
  const before = calls.length
  const refused = (path: string, cwd: string | null = null) => checkOpenable(path, cwd)
  check('a missing file is refused as missing', (() => { const r = refused(join(dir, 'nope.md')); return !r.ok && r.status === 404 })())
  check('an executable is refused', !refused(script).ok)
  check('a symlink to an executable is refused', !refused(link).ok)
  check('a .command file is refused', !refused(command).ok)
  check('a .py file is refused (the launcher runs it)', !refused(python).ok)
  check('an .app bundle is refused', !refused(bundle).ok)
  check('a folder is refused', !refused(dir).ok)
  check('a relative path without a folder is refused', !refused('notes.md').ok)
  check('a relative folder that is not absolute cannot anchor a path', !refused('notes.md', 'relative/dir').ok)
  check('nothing refused was spawned', calls.length === before, calls.slice(before))
  const elsewhere = openFile(doc, null, record, 'win32')
  check('a platform without an opener says so', !elsewhere.ok && elsewhere.status === 501, elsewhere)
  rmSync(dir, { recursive: true, force: true })
}

/* ---------------- an export lands only where a person chose ---------------- */

{
  const home = mkdtempSync(join(tmpdir(), 'sedano-export-'))
  const realHome = process.env.HOME
  process.env.HOME = home
  try {
    const victim = join(home, 'notes.md')
    writeFileSync(victim, 'keep me')
    const byPath = await writeExportFile({ path: victim, content: 'overwritten' })
    check('a path sent by a page is refused', !byPath.ok && byPath.status === 400, byPath)
    check('and the file at that path is untouched', readFileSync(victim, 'utf8') === 'keep me')

    const first = await writeExportFile({ name: 'chat.md', content: 'one' })
    const second = await writeExportFile({ name: 'chat.md', content: 'two' })
    check('a name lands in ~/Downloads', first.ok && first.path === join(home, 'Downloads', 'chat.md'), first)
    check('and a second export never replaces the first', second.ok && second.path === join(home, 'Downloads', 'chat (2).md'), second)
    check('the first file keeps its content', readFileSync(join(home, 'Downloads', 'chat.md'), 'utf8') === 'one')
    const escape = await writeExportFile({ name: '../../notes.md', content: 'x' })
    check('a name cannot climb out of Downloads', escape.ok && escape.path.startsWith(join(home, 'Downloads') + '/'), escape)
    check('only .md and .txt are written', !(await writeExportFile({ name: 'run.sh', content: 'x' })).ok)
    symlinkSync(victim, join(home, 'Downloads', 'link.md'))
    const viaLink = await writeExportFile({ name: 'link.md', content: 'x' })
    check('a symlink in Downloads is not written through', readFileSync(victim, 'utf8') === 'keep me', viaLink)
  } finally {
    process.env.HOME = realHome
    rmSync(home, { recursive: true, force: true })
  }
}

if (failures.length) {
  console.log('--- failed checks ---')
  for (const failure of failures) console.log(`✗ ${failure}`)
  console.log(`\nfile-links-test: ${failures.length} FAILURES`)
  process.exit(1)
}
console.log('file-links-test: PASSED')
process.exit(0)
