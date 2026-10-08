/**
 * The slash commands and skills a harness actually has.
 *
 * ACP agents advertise theirs at runtime, and a few harnesses have a fixed set
 * (see `commands.ts`). Claude Code keeps the interesting ones on disk, and they
 * are per-workspace, which is why this is a lookup and not a static list:
 *
 *   ~/.claude/commands/<sub>/<name>.md   → /<sub>:<name>
 *   <cwd>/.claude/commands/<sub>/<name>.md
 *   ~/.claude/skills/<name>/SKILL.md     → /<name>
 *   <cwd>/.claude/skills/<name>/SKILL.md
 *
 * The files live on the machine the session runs on, so the scan goes through
 * the session's transport: a remote workspace lists its own skills.
 */
import { join } from 'node:path'
import type { HarnessCommand, HarnessId } from '@shared'
import { Transport, type DirItem } from '../transport.ts'
import { claudeConfigRoot } from '../paths.ts'
import { commandsFor } from './commands.ts'

/** A long list is noise in a popup, and a remote scan is one call per file. */
const MAX_SCAN = 160

function list(transport: Transport, dir: string): DirItem[] {
  try {
    return transport.listDir(dir)
  } catch {
    return []
  }
}

/** One line of what a command does: its frontmatter, else its first real line. */
function describe(text: string): string {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (frontmatter) {
    const description = /^\s*description:\s*(.+)$/im.exec(frontmatter[1]!)
    if (description) return description[1]!.trim().replace(/^["']|["']$/g, '').slice(0, 200)
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed === '---' || /^[a-z-]+:\s/i.test(trimmed)) continue
    return trimmed.replace(/^#+\s*/, '').slice(0, 200)
  }
  return ''
}

/** `commands/**\/*.md`: nested folders read as `sub:name`, the way Claude types them. */
function readCommands(transport: Transport, dir: string): HarnessCommand[] {
  const found: Array<{ name: string; path: string }> = []

  const walk = (current: string, prefix: string, depth: number): void => {
    if (found.length >= MAX_SCAN || depth < 0) return
    for (const item of list(transport, current)) {
      if (found.length >= MAX_SCAN) return
      if (item.name.startsWith('.') || item.name.startsWith('_')) continue
      const full = join(current, item.name)
      if (item.dir) walk(full, `${prefix}${item.name}:`, depth - 1)
      else if (item.name.endsWith('.md')) found.push({ name: `${prefix}${item.name.slice(0, -3)}`, path: full })
    }
  }
  walk(dir, '', 2)

  return found.map((entry) => ({
    name: entry.name,
    // Reading the file is free locally and one ssh round trip remotely — and a
    // workspace full of commands turned that into dozens of them, which is both
    // slow and enough process churn to upset the runtime. On a host the name is
    // what you pick from; the description is a nicety, not the feature.
    description: transport.remote ? '' : describe(transport.readText(entry.path) ?? ''),
    kind: 'command' as const,
  }))
}

/** `skills/<name>/SKILL.md`: the folder is the name, the file the description. */
function readSkills(transport: Transport, dir: string): HarnessCommand[] {
  const out: HarnessCommand[] = []
  for (const item of list(transport, dir)) {
    if (out.length >= MAX_SCAN) break
    if (!item.dir || item.name.startsWith('.') || item.name.startsWith('_')) continue
    if (transport.remote) {
      // Every folder under skills/ is a skill on a host: checking for SKILL.md
      // would be one ssh call per skill for a line of text.
      out.push({ name: item.name, description: '', kind: 'skill' })
      continue
    }
    const text = transport.readText(join(dir, item.name, 'SKILL.md'))
    // No SKILL.md means it is not a skill folder, and we do not go guessing.
    if (text === null) continue
    out.push({ name: item.name, description: describe(text), kind: 'skill' })
  }
  return out
}

/** Everything a harness offers here, merged: skills and commands, project wins. */
export function harnessCommands(harness: HarnessId, cwd: string, host: string | null): HarnessCommand[] {
  const base = commandsFor(harness)
  if (harness !== 'claude') return base

  const transport = new Transport(host)
  const root = claudeConfigRoot(transport)
  const project = cwd ? join(cwd, '.claude') : ''

  const commands = [
    ...readCommands(transport, join(root, 'commands')),
    ...(project ? readCommands(transport, join(project, 'commands')) : []),
  ]
  const skills = [
    ...readSkills(transport, join(root, 'skills')),
    ...(project ? readSkills(transport, join(project, 'skills')) : []),
  ]

  // Later entries win: a project command of the same name beats the personal one.
  const merged = new Map<string, HarnessCommand>()
  for (const command of [...base, ...commands, ...skills]) {
    if (!command.name) continue
    const existing = merged.get(command.name)
    merged.set(command.name, {
      name: command.name,
      description: command.description || existing?.description || '',
      kind: command.kind ?? existing?.kind,
    })
  }
  // Your own work first: skills and the commands you wrote are why the menu was
  // opened. The harness' built-in list is reference material and belongs last.
  const rank = (command: HarnessCommand): number =>
    command.kind === 'skill' ? 0 : command.kind === 'command' ? 1 : 2
  return [...merged.values()].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}
