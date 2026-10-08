import type { HarnessCommand, HarnessId } from '@shared'

/**
 * The slash commands a harness exposes under the hood.
 *
 * ACP agents advertise theirs at session start (`available_commands_update`), so
 * those are learned at runtime. Harnesses whose commands are fixed are listed
 * here; a harness we know nothing about simply offers none, rather than a menu
 * of commands that would do nothing.
 */
const discovered = new Map<HarnessId, HarnessCommand[]>()

/** Record what an agent advertised (ACP). Called from the driver. */
export function rememberCommands(harness: HarnessId, commands: HarnessCommand[]): void {
  if (!commands.length) return
  discovered.set(harness, commands)
}

const CLAUDE: HarnessCommand[] = [
  { name: 'help', description: 'Show Claude Code help and available commands' },
  { name: 'clear', description: 'Clear the conversation history' },
  { name: 'compact', description: 'Summarise the conversation to free context' },
  { name: 'model', description: 'Switch the model for this session' },
  { name: 'agents', description: 'Manage subagents' },
  { name: 'config', description: 'Open the configuration' },
  { name: 'permissions', description: 'Review tool permissions' },
  { name: 'hooks', description: 'Manage hooks' },
  { name: 'mcp', description: 'Manage MCP servers' },
  { name: 'memory', description: 'Edit CLAUDE.md memory files' },
  { name: 'init', description: 'Generate a CLAUDE.md for this project' },
  { name: 'add-dir', description: 'Add another working directory' },
  { name: 'review', description: 'Review a pull request' },
  { name: 'cost', description: 'Show token usage and cost' },
  { name: 'status', description: 'Show version, model and account' },
  { name: 'doctor', description: 'Check the installation for problems' },
  { name: 'login', description: 'Sign in to your account' },
  { name: 'logout', description: 'Sign out' },
]

const CURATED: Partial<Record<HarnessId, HarnessCommand[]>> = {
  claude: CLAUDE,
}

/** The commands to offer for a harness: what it advertised, else what we know. */
export function commandsFor(harness: HarnessId): HarnessCommand[] {
  return discovered.get(harness) ?? CURATED[harness] ?? []
}
