import type { PresetInfo } from '@shared'
import { basename } from 'node:path'
import { which } from '../../which.ts'

/**
 * What a terminal tab can run.
 *
 * Every tab is a tmux session on the target machine (local or over SSH), so the
 * work survives the app closing, a crash, or the laptop sleeping. The preset
 * only decides which command tmux starts the first time.
 */
export interface Preset {
  id: string
  label: string
  hint: string
  /** Binary that must exist for the preset to be offered. */
  bin: string
  /** Extra search paths, for tools installed outside PATH (GUI launchers). */
  extraPaths?: string[]
  args: string[]
  /** Terminals do not resume a native session the way agent harnesses do. */
  resumable?: boolean
}

export const PRESETS: Preset[] = [
  { id: 'shell', label: 'Shell', hint: 'Plain login shell', bin: '', args: [] },
  {
    id: 'freebuff',
    label: 'Freebuff',
    hint: 'Start a new Freebuff session in this workspace',
    bin: 'freebuff',
    args: [],
  },
  {
    id: 'freebuff-continue',
    label: 'Freebuff · continue',
    hint: 'Pick up the last Freebuff conversation in this workspace',
    bin: 'freebuff',
    args: ['--continue'],
  },
  { id: 'claude-tui', label: 'Claude Code', hint: 'The official terminal UI', bin: 'claude', args: [] },
  { id: 'codex-tui', label: 'Codex', hint: 'the official terminal UI', bin: 'codex', args: [] },
]

export function getPreset(id: string | null | undefined): Preset {
  return PRESETS.find((preset) => preset.id === id) ?? PRESETS[0]!
}

/** Where the tool may live when the app was launched from Finder. */
function candidatePaths(bin: string): string[] {
  const home = process.env.HOME ?? ''
  const names = [
    `${home}/.nvm/versions/node`,
    `${home}/.local/bin`,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    `${home}/.bun/bin`,
  ]
  return names.map((dir) => `${dir}/${bin}`)
}

export function findBinary(bin: string): string | null {
  if (!bin) return process.env.SHELL ?? '/bin/zsh'
  const direct = which(bin)
  if (direct) return direct
  if (process.env.SEDANO_EXPLICIT_PATH === '1') return null
  const home = process.env.HOME ?? ''
  // nvm keeps one directory per node version; the newest one wins.
  if (bin === 'freebuff' && home) {
    try {
      const versions = [...new Bun.Glob('*').scanSync({ cwd: `${home}/.nvm/versions/node` })].sort().reverse()
      for (const version of versions) {
        const candidate = `${home}/.nvm/versions/node/${version}/bin/${bin}`
        if (Bun.file(candidate).size !== 0) return candidate
      }
    } catch {
      /* nvm not installed */
    }
  }
  for (const candidate of candidatePaths(bin)) {
    if (Bun.file(candidate).size !== 0) return candidate
  }
  return null
}

export function presetList(): PresetInfo[] {
  return PRESETS.map((preset) => ({
    id: preset.id,
    label: preset.label,
    hint: preset.hint,
    available: findBinary(preset.bin) !== null,
  }))
}

/** `sedano-<short>` — namespaced so user tmux sessions are never touched. */
export function tmuxName(sessionId: string): string {
  return `sedano-${sessionId.replace(/-/g, '').slice(0, 8)}`
}

/**
 * Tab titles read like a place, not like a log line: "Terminal · Freebuff",
 * "Terminal · shell · acme-api", "Terminal · nimbus". The word Terminal always
 * comes first so a terminal tab is never mistaken for a session.
 */
export function terminalTitle(presetId: string | null, cwd: string, host?: string | null): string {
  const preset = getPreset(presetId)
  const where = basename(cwd) || cwd
  if (host) return `Terminal · ${host}`
  if (preset.id === 'shell') return `Terminal · Shell · ${where}`
  return `Terminal · ${preset.label}`
}
