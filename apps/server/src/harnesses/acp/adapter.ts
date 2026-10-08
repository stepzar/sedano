import type { HarnessId } from '@shared'
import type { Adapter, CreateOptions, Driver, DriverHooks, ModelInfo } from '../types.ts'
import { withImageSupport } from '../model-images.ts'
import {
  AcpDriver,
  agentAcceptsImages,
  discoveredElsewhere,
  discoveredModels,
  discoveredVersion,
  primeModels,
  type AcpSpec,
} from './driver.ts'
import { Transport } from '../../transport.ts'
import { which } from '../../which.ts'

/**
 * The ACP agents sedano knows how to drive.
 *
 * A table, not an adapter each: they all speak the same protocol, so a new one
 * is a row here. `bin` is what must exist for the harness to be offered, `args`
 * is how that binary is asked to speak ACP.
 */
export interface AcpAgentSpec extends AcpSpec {
  harness: HarnessId
  label: string
  note: string
  bin: string
}

export const ACP_AGENTS: AcpAgentSpec[] = [
  {
    harness: 'opencode',
    id: 'opencode',
    label: 'Opencode',
    bin: 'opencode',
    args: ['acp'],
    note: 'ACP · one continuous session',
    models: [],
    // Its prompt usage is the last assistant step's (each step overwrites it).
    promptUsage: 'lastCall',
  },
  {
    harness: 'codex',
    id: 'codex',
    // The bridge is what speaks ACP; `codex` itself does not (its own app-server
    // is a different, OpenAI-specific protocol).
    label: 'Codex',
    bin: 'codex-acp',
    args: [],
    note: 'ACP bridge · one continuous session',
    models: [],
    // `buildPromptUsage(lastTokenUsage)`: the turn's final model call.
    promptUsage: 'lastCall',
  },
  {
    harness: 'gemini',
    id: 'gemini',
    label: 'Gemini CLI',
    bin: 'gemini',
    args: ['--acp'],
    note: 'ACP · needs `gemini` logged in',
    models: [],
    // Gemini checks for updates and loads extensions before it answers.
    initTimeoutMs: 180_000,
  },
  {
    harness: 'grok',
    id: 'grok',
    label: 'Grok',
    bin: 'grok',
    args: ['agent', 'stdio'],
    // Its subcommand order is `grok agent [flags] stdio`, so the model and the
    // reasoning effort are flags of `agent`, not of `stdio`.
    argv: ({ model, effort }) => [
      'agent',
      ...(model ? ['-m', model] : []),
      ...(effort ? ['--reasoning-effort', effort] : []),
      'stdio',
    ],
    note: 'ACP · signs in on first use',
    models: [],
    // `_meta.usage` sums every call of the turn, and its input is the full prompt.
    inputIncludesCache: true,
  },
]

/**
 * The protocol half of a table row, with nothing dropped.
 *
 * Listing the fields by hand is how `argv` went missing: grok's model and effort
 * flags live there, so a spec rebuilt without it spawned `grok agent stdio` and
 * silently ignored both pickers. The row *is* an `AcpSpec` plus presentation, so
 * the presentation is removed instead of the protocol being re-listed — a field
 * added to `AcpSpec` later reaches the driver without anybody remembering to
 * copy it here.
 */
export function specOf(agent: AcpAgentSpec): AcpSpec {
  const { harness: _harness, label: _label, note: _note, bin: _bin, ...spec } = agent
  return spec
}

export function acpAdapter(agent: AcpAgentSpec): Adapter {
  return {
    id: agent.harness,
    label: agent.label,
    // What the agent said at its last handshake, per machine, and true only
    // until it says otherwise: the protocol has an image content block, but
    // whether this agent reads one is its own answer (see `agentAcceptsImages`).
    get images(): boolean {
      return agentAcceptsImages(agent.id, null) ?? true
    },

    async detect() {
      const bin = which(agent.bin)
      if (!bin) return { available: false, bin: null, version: null }
      // The version an ACP agent reports is the authoritative one, but it only
      // arrives with the handshake — until a session has run we have none.
      return { available: true, bin, version: discoveredVersion(agent.id) }
    },

    /**
     * The models of *that* machine's installation: the same agent on a server
     * has its own account and may offer a different set, so a list discovered
     * here is never handed to a picker pointed at a host.
     *
     * Mapped on the way out rather than only on the way in: a list discovered
     * before this build was written — the cache holds those for as long as the
     * agent does not report a new one — has no idea which of its models see.
     */
    models: (host) => {
      const known = discoveredModels(agent.id, host) ?? (host ? [] : agent.models)
      if (known.length) return known.map((model) => withImageSupport(model))
      // This machine's agent has not answered (not installed there, not signed
      // in, or too old to report models). Showing the list it reported somewhere
      // else is better than an empty menu for a harness we do handle — and the
      // picker says where the list came from, so nobody is misled about whose
      // account it belongs to.
      if (!host) return []
      const anywhere = discoveredElsewhere(agent.id)
      return (anywhere ?? []).map((model) => withImageSupport(model))
    },

    /**
     * Ask the agent what it can run, without running anything. Called in the
     * background when the picker would otherwise offer nothing.
     *
     * The machine asked is the one whose picker is empty: the same CLI on a server
     * has its own account and its own list, so a catalog learned here says nothing
     * about a host — and a host's picker stayed blank until somebody happened to
     * start a session there, which read as "Codex has one model" on every server.
     * The handshake runs over the transport, so asking a host is the same
     * exchange, one ssh away.
     */
    async refreshModels(host) {
      const transport = new Transport(host ?? null)
      const bin = host ? transport.which(agent.bin) : which(agent.bin)
      if (!bin) return
      // A session needs a directory that exists on that machine: its home.
      const cwd = host ? transport.home() : process.cwd()
      await primeModels(specOf(agent), bin, cwd, host ?? null)
    },

    async create(opts: CreateOptions, hooks: DriverHooks): Promise<Driver> {
      // On a host the binary lives there, so it is resolved there.
      const bin = opts.host ? new Transport(opts.host).which(agent.bin) : which(agent.bin)
      if (!bin) {
        throw new Error(
          opts.host
            ? `${agent.label} not found on ${opts.host} (looked for \`${agent.bin}\`)`
            : `${agent.label} not found in PATH (looked for \`${agent.bin}\`)`,
        )
      }
      const driver = new AcpDriver(opts, hooks, specOf(agent), bin)
      try {
        await driver.start()
      } catch (err) {
        // start() spawns the agent before the handshake completes, so a failure
        // here would otherwise leave an orphan process behind.
        driver.stop()
        throw err
      }
      return driver
    },
  }
}
