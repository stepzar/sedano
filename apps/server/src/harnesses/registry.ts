import type { HarnessId, PermissionMode, SessionKind } from '@shared'
import * as db from '../db.ts'
import type { Adapter } from './types.ts'
import { ACP_AGENTS, acpAdapter } from './acp/adapter.ts'
import { claudeAdapter } from './claude/adapter.ts'
import { commandCodeAdapter } from './commandcode/adapter.ts'
import { terminalAdapter } from './terminal/adapter.ts'

/**
 * Wired harnesses.
 *
 * The architecture is ACP-first: `gemini --acp`, `opencode acp`,
 * `@agentclientprotocol/codex-acp` and `grok agent stdio` all speak the same
 * protocol, so those adapters share one client. Claude gets a native adapter
 * because its transcript exposes subagent internals that the ACP bridge does
 * not forward.
 */
const ADAPTERS: Partial<Record<HarnessId, Adapter>> = {
  claude: claudeAdapter,
  commandcode: commandCodeAdapter,
  shell: terminalAdapter,
  // One adapter per ACP agent, all built from the same client: the protocol is
  // the integration, not the vendor.
  ...Object.fromEntries(ACP_AGENTS.map((agent) => [agent.harness, acpAdapter(agent)])),
}

/**
 * The approval modes a harness can actually be asked for.
 *
 * `PermissionMode` is the union of everything any protocol ever needed, and the
 * pickers offered all six of them to every harness, which is how a choice the
 * backend cannot honour ended up on screen.
 *
 * Claude Code really does have all six: `--permission-mode` takes `acceptEdits`,
 * `auto`, `bypassPermissions`, `manual`, `dontAsk` and `plan` (and accepts
 * `default`), and its print mode routes a request back to us, so "ask me" asks.
 *
 * Command Code does not. `cmd --help` lists `standard`, `plan` and `auto-accept`
 * plus `--yolo`, with nothing to map "ask me" onto: a headless `-p` run installs
 * its own `headlessInteraction`, which denies anything risky and answers a
 * question with the first option, so nothing ever reaches this client. `manual`
 * there was a promise the CLI cannot keep, and `auto` is the same flag as
 * `acceptEdits`.
 *
 * The ACP agents answer permission requests through the driver rather than a
 * flag, and the driver resolves `manual` exactly like `default` and `auto`
 * exactly like `acceptEdits` — two rows that changed nothing.
 *
 * This is the single source: `probeCatalog` in `manager.ts` publishes the answer
 * as `HarnessInfo.permissionModes`, and the picker reads it from there. The
 * table in `apps/ui/src/models.ts` is only what a UI believes when it is sitting
 * in front of a server too old to have said anything.
 */
const CLAUDE_PERMISSION_MODES: PermissionMode[] = [
  'default',
  'acceptEdits',
  'auto',
  'manual',
  'plan',
  'bypassPermissions',
]

/** Everyone else: the four that are distinct, without the two that are aliases. */
const FLAG_PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions']

export function permissionModesFor(id: HarnessId): PermissionMode[] {
  // A terminal tab runs a shell: nothing approves anything on its behalf.
  if (id === 'shell') return []
  return id === 'claude' ? CLAUDE_PERMISSION_MODES : FLAG_PERMISSION_MODES
}

export function getAdapter(id: HarnessId): Adapter | null {
  return ADAPTERS[id] ?? null
}

/** Terminal tabs are a different beast from agent harnesses. */
export function getAdapterFor(kind: SessionKind, harness: HarnessId): Adapter | null {
  if (kind === 'terminal') return terminalAdapter
  return getAdapter(harness)
}

export function wiredHarnesses(): HarnessId[] {
  return Object.keys(ADAPTERS) as HarnessId[]
}

/** Everything the UI may offer, with the binary we would look for. */
export const HARNESS_CATALOG: Array<{
  id: HarnessId
  label: string
  bin: string
  note: string
  /** TUI-only tools: offered, but they open as a terminal tab. */
  tui?: boolean
}> = [
  { id: 'claude', label: 'Claude Code', bin: 'claude', note: 'Native adapter · live subagents' },
  {
    id: 'commandcode',
    label: 'Command Code',
    bin: 'cmd',
    note: 'Headless NDJSON · one process per turn',
  },
  ...ACP_AGENTS.map((agent) => ({
    id: agent.harness,
    label: agent.label,
    bin: agent.bin,
    note: agent.note,
  })),
  {
    id: 'freebuff',
    label: 'Freebuff',
    bin: 'freebuff',
    // Checked against the real binary: no print mode, no JSON, no ACP — only the
    // TUI. Saying so is better than a chat tab that never streams anything.
    note: 'Terminal UI only · opens as a tmux tab',
    tui: true,
  },
]

/* ------------------------------------------------------------------ */
/* Which of the detected harnesses you actually want offered           */
/* ------------------------------------------------------------------ */

/**
 * Detection answers "what is here". This answers "what do I want to see".
 *
 * They were the same question, and that is the complaint: a machine with six
 * CLIs installed put six rows in every picker whether or not you use them. So
 * the catalog keeps reporting everything it finds, and this decides which of it
 * is offered.
 *
 * Two deliberate choices.
 *
 * **Per machine.** A harness installed on a server is a different installation
 * from the one on this laptop — its own login, its own limits — so hiding
 * Gemini here must not hide it there. The key is the host, with `''` for this
 * computer, exactly like the capabilities cache.
 *
 * **Opt-out, not opt-in.** The hosts allowlist is opt-in because it is a
 * security boundary: an entry nobody ticked must never reach `ssh`. This is not
 * one. Nothing is granted by showing a harness that is already installed and
 * already runnable, so the default is "offered" and a CLI installed tomorrow
 * appears by itself. Storing the *hidden* set rather than the enabled one is
 * what makes that true without a migration.
 */
const KV_HIDDEN = 'harnesses.hidden'

type HiddenMap = Record<string, HarnessId[]>

function hostKey(host: string | null | undefined): string {
  return host ?? ''
}

function readHidden(): HiddenMap {
  try {
    const raw = db.kvGet(KV_HIDDEN)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: HiddenMap = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue
      out[key] = value.filter((id): id is HarnessId => typeof id === 'string')
    }
    return out
  } catch {
    // A preference file we cannot read means "nothing is hidden", never "nothing
    // is available": the worst case is a picker with one row too many.
    return {}
  }
}

/** The harnesses you hid on one machine. */
export function hiddenHarnesses(host: string | null = null): HarnessId[] {
  return readHidden()[hostKey(host)] ?? []
}

/** Whether a harness is offered in the pickers of one machine. */
export function isHarnessEnabled(host: string | null, id: HarnessId): boolean {
  return !hiddenHarnesses(host).includes(id)
}

/**
 * Show or hide one harness on one machine.
 *
 * Only a harness this build knows about: writing an id nobody can render would
 * leave a preference that no screen can ever undo.
 */
export function setHarnessEnabled(host: string | null, id: HarnessId, enabled: boolean): void {
  if (!HARNESS_CATALOG.some((item) => item.id === id)) {
    throw new Error(`unknown harness: ${id}`)
  }
  const map = readHidden()
  const key = hostKey(host)
  const current = new Set(map[key] ?? [])
  if (enabled) current.delete(id)
  else current.add(id)
  const next: HiddenMap = { ...map }
  if (current.size) next[key] = [...current]
  else delete next[key]
  db.kvSet(KV_HIDDEN, JSON.stringify(next))
}
