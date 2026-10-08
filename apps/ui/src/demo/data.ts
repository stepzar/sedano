/**
 * The demo's machine: what a fake server says about the computer it runs on.
 *
 * Everything here is invented — a `/Users/you` home, a project called
 * `acme-api`, harnesses that are "installed" — and shaped exactly like what the
 * real server publishes, so the real UI renders it without knowing.
 */
import type {
  Capabilities,
  HarnessCommand,
  HarnessId,
  HarnessInfo,
  HostStatus,
  LimitSnapshot,
  PermissionMode,
  ProjectRef,
  VoiceStatus,
} from '@shared'

export const HOME = '/Users/you'
export const PROJECTS = `${HOME}/Projects`
export const ACME_API = `${PROJECTS}/acme-api`
export const ACME_WEB = `${PROJECTS}/acme-web`

/** The ssh aliases a real `~/.ssh/config` would offer. */
export const SSH_HOSTS = ['staging-box', 'gpu-runner']
export const REMOTE_HOME = '/home/deploy'

const CLAUDE_MODES: PermissionMode[] = ['default', 'acceptEdits', 'auto', 'manual', 'plan', 'bypassPermissions']
const FLAG_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions']

const CLAUDE_COMMANDS: HarnessCommand[] = [
  { name: 'compact', description: 'Summarise the conversation to free context' },
  { name: 'review', description: 'Review the current branch' },
  { name: 'init', description: 'Write a CLAUDE.md for this repository' },
  { name: 'clear', description: 'Start over with an empty context' },
  { name: 'cost', description: 'Show what this session has spent' },
  { name: 'frontend-design', description: 'Distinctive, intentional UI design', kind: 'skill' },
  { name: 'security-review', description: 'Audit the pending changes', kind: 'skill' },
]

const CODEX_COMMANDS: HarnessCommand[] = [
  { name: 'compact', description: 'Summarise the conversation to free context' },
  { name: 'review', description: 'Review the working tree' },
  { name: 'diff', description: 'Show the git diff, including untracked files' },
  { name: 'status', description: 'Session configuration and token usage' },
  { name: 'init', description: 'Create an AGENTS.md with instructions' },
]

const GEMINI_COMMANDS: HarnessCommand[] = [
  { name: 'compress', description: 'Replace the context with a summary' },
  { name: 'memory', description: 'Show or refresh the loaded GEMINI.md' },
  { name: 'stats', description: 'Session statistics' },
  { name: 'tools', description: 'List the available tools' },
]

const OPENCODE_COMMANDS: HarnessCommand[] = [
  { name: 'compact', description: 'Summarise the session' },
  { name: 'review', description: 'Review changes against the base branch' },
  { name: 'init', description: 'Create or update AGENTS.md' },
]

const CMD_COMMANDS: HarnessCommand[] = [
  { name: 'compact', description: 'Summarise the conversation' },
  { name: 'review', description: 'Review the staged changes' },
  { name: 'taste', description: 'Show what Command Code learned about your style' },
]

function harness(info: Omit<HarnessInfo, 'wired' | 'installed' | 'enabled'> & Partial<HarnessInfo>): HarnessInfo {
  return { wired: true, installed: true, enabled: true, ...info }
}

export function harnessCatalog(): HarnessInfo[] {
  const effort = ['low', 'medium', 'high', 'xhigh', 'max']
  return [
    harness({
      id: 'claude',
      label: 'Claude Code',
      note: 'Native adapter · live subagents',
      bin: 'claude',
      version: '2.3.14',
      models: [
        { id: 'claude-opus-4-6', label: 'Opus 4.6', isDefault: true, images: true, efforts: effort },
        { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', images: true, efforts: effort },
        { id: 'claude-haiku-4-5', label: 'Haiku 4.5', images: true, efforts: [] },
      ],
      commands: CLAUDE_COMMANDS,
      images: true,
      permissionModes: CLAUDE_MODES,
    }),
    harness({
      id: 'codex',
      label: 'Codex',
      note: 'ACP bridge · one continuous session',
      bin: 'codex-acp',
      version: '0.61.0',
      models: [
        { id: 'gpt-5.6-codex', label: 'GPT-5.6 Codex', isDefault: true, images: true, efforts: ['low', 'medium', 'high', 'xhigh'] },
        { id: 'gpt-5.6', label: 'GPT-5.6', images: true, efforts: ['minimal', 'low', 'medium', 'high'] },
        { id: 'gpt-5.6-mini', label: 'GPT-5.6 mini', images: true, efforts: ['low', 'medium', 'high'] },
      ],
      commands: CODEX_COMMANDS,
      images: true,
      permissionModes: FLAG_MODES,
    }),
    harness({
      id: 'gemini',
      label: 'Gemini CLI',
      note: 'ACP · needs `gemini` logged in',
      bin: 'gemini',
      version: '0.19.2',
      models: [
        { id: 'gemini-3-pro', label: 'Gemini 3 Pro', isDefault: true, images: true, efforts: [] },
        { id: 'gemini-3-flash', label: 'Gemini 3 Flash', images: true, efforts: [] },
      ],
      commands: GEMINI_COMMANDS,
      images: true,
      permissionModes: FLAG_MODES,
    }),
    harness({
      id: 'opencode',
      label: 'Opencode',
      note: 'ACP · one continuous session',
      bin: 'opencode',
      version: '1.4.3',
      models: [
        { id: 'opencode-zen/kimi-k2.7-code', label: 'Kimi K2.7 Code', isDefault: true, efforts: [] },
        { id: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6', images: true, efforts: [] },
        { id: 'opencode-go/glm-5.1', label: 'GLM 5.1', efforts: [] },
      ],
      commands: OPENCODE_COMMANDS,
      images: true,
      permissionModes: FLAG_MODES,
    }),
    harness({
      id: 'commandcode',
      label: 'Command Code',
      note: 'Headless NDJSON · one process per turn',
      bin: 'cmd',
      version: '0.9.8',
      models: [
        { id: 'cmd-large', label: 'cmd-large', isDefault: true, efforts: [] },
        { id: 'cmd-fast', label: 'cmd-fast', efforts: [] },
      ],
      commands: CMD_COMMANDS,
      images: false,
      imagesNote: 'Command Code reads text only',
      permissionModes: FLAG_MODES,
    }),
    harness({
      id: 'grok',
      label: 'Grok',
      note: 'ACP · signs in on first use',
      bin: 'grok',
      version: '0.4.1',
      models: [{ id: 'grok-5', label: 'Grok 5', isDefault: true, efforts: ['low', 'high'] }],
      commands: [],
      images: true,
      permissionModes: FLAG_MODES,
    }),
    harness({
      id: 'freebuff',
      label: 'Freebuff',
      note: 'Terminal UI only · opens as a tmux tab',
      bin: 'freebuff',
      version: '0.2.0',
      models: [],
      commands: [],
      images: false,
      tui: true,
      permissionModes: FLAG_MODES,
    }),
  ]
}

const CONTEXT_WINDOW: Record<string, number> = {
  'claude-opus-4-6': 200_000,
  'claude-sonnet-4-6': 200_000,
  'claude-haiku-4-5': 200_000,
  'gpt-5.6-codex': 272_000,
  'gpt-5.6': 272_000,
  'gpt-5.6-mini': 272_000,
  'gemini-3-pro': 1_000_000,
  'gemini-3-flash': 1_000_000,
}

export function contextWindowFor(model: string | null): number {
  return (model && CONTEXT_WINDOW[model]) || 256_000
}

/** The model a new session of this harness starts on when the client named none. */
export function defaultModel(harnessId: HarnessId): string | null {
  const info = harnessCatalog().find((item) => item.id === harnessId)
  return info?.models.find((model) => model.isDefault)?.id ?? info?.models[0]?.id ?? null
}

export function voiceStatus(configured: VoiceStatus['configured'] = 'auto'): VoiceStatus {
  const why = 'Dictation transcribes on your own machine — there is no machine behind this browser demo.'
  return {
    provider: 'none',
    model: null,
    endpoint: null,
    language: 'auto',
    ready: false,
    detail: why,
    configured,
    engines: [
      { id: 'whisper-cli', label: 'whisper.cpp', ready: false, detail: why, missing: 'Not available in the demo', install: null, models: [], catalog: [] },
      { id: 'openai', label: 'Local speech server', ready: false, detail: why, missing: 'Not available in the demo', install: null, endpoint: null },
    ],
    lastRun: null,
  }
}

export function hostStatus(enabled: Set<string>, reached: Map<string, HostStatus>): HostStatus[] {
  return SSH_HOSTS.map((host) => reached.get(host) ?? { host, enabled: enabled.has(host), reach: null, detail: null, checkedAt: null })
    .map((status) => ({ ...status, enabled: enabled.has(status.host) }))
}

export function capabilities(host: string | null, opts: {
  enabledHosts: Set<string>
  reached: Map<string, HostStatus>
  hidden: Set<string>
  voice: VoiceStatus
}): Capabilities {
  return {
    host,
    probeError: null,
    harnesses: harnessCatalog().map((info) => ({ ...info, enabled: !opts.hidden.has(`${host ?? ''}:${info.id}`) })),
    presets: [
      { id: 'shell', label: 'Shell', hint: 'Plain login shell', available: true },
      { id: 'claude-tui', label: 'Claude Code', hint: 'The official terminal UI', available: true },
      { id: 'codex-tui', label: 'Codex', hint: 'the official terminal UI', available: true },
      { id: 'freebuff', label: 'Freebuff', hint: 'Start a new Freebuff session in this workspace', available: true },
    ],
    hosts: SSH_HOSTS.filter((item) => opts.enabledHosts.has(item)),
    availableHosts: [...SSH_HOSTS],
    hostStatus: hostStatus(opts.enabledHosts, opts.reached),
    voice: opts.voice,
    unhandledEvents: [],
  }
}

export function projects(now: number): ProjectRef[] {
  return [
    { path: ACME_API, name: 'acme-api', lastUsed: now - 12 * 60_000, exists: true, hosts: [], harnesses: ['claude', 'codex', 'gemini', 'opencode', 'commandcode'] },
    { path: ACME_WEB, name: 'acme-web', lastUsed: now - 3 * 86_400_000, exists: true, hosts: [], harnesses: ['claude'] },
    { path: `${PROJECTS}/infra`, name: 'infra', lastUsed: now - 9 * 86_400_000, exists: true, hosts: [], harnesses: [] },
  ]
}

export function limits(now: number, readers: Record<'claude' | 'commandcode', boolean>): LimitSnapshot[] {
  const hour = 3_600_000
  const read = now - 60_000
  const claude: LimitSnapshot = readers.claude
    ? {
        harness: 'claude',
        plan: 'Max 20x',
        windows: [
          { label: '5h', usedPercent: 34, windowMinutes: 300, resetsAt: now + 2.4 * hour },
          { label: '7d', usedPercent: 61, windowMinutes: 10_080, resetsAt: now + 3.2 * 24 * hour },
        ],
        credits: null,
        updatedAt: read,
        error: null,
      }
    : { harness: 'claude', plan: null, windows: [], credits: null, updatedAt: now, error: null, off: true }
  const commandcode: LimitSnapshot = readers.commandcode
    ? {
        harness: 'commandcode',
        plan: 'Pro',
        windows: [{ label: '5h', usedPercent: 22, windowMinutes: 300, resetsAt: now + 3.6 * hour }],
        credits: { hasCredits: true, unlimited: false, balance: '$18.40' },
        updatedAt: read,
        error: null,
      }
    : { harness: 'commandcode', plan: null, windows: [], credits: null, updatedAt: now, error: null, off: true }
  return [
    claude,
    {
      harness: 'codex',
      plan: 'Pro',
      windows: [
        { label: '5h', usedPercent: 18, windowMinutes: 300, resetsAt: now + 4.1 * hour },
        { label: '7d', usedPercent: 42, windowMinutes: 10_080, resetsAt: now + 5 * 24 * hour },
      ],
      credits: null,
      updatedAt: read,
      error: null,
    },
    commandcode,
    {
      harness: 'gemini',
      plan: null,
      windows: [],
      credits: null,
      updatedAt: read,
      error: null,
      note: 'Billed against your own API key — there is no quota to read.',
    },
    {
      harness: 'opencode',
      plan: null,
      windows: [],
      credits: null,
      updatedAt: read,
      error: null,
      note: 'Opencode bills the provider keys you configured; it publishes no quota.',
    },
  ]
}

export const USAGE_READERS = {
  claude: {
    endpoint: 'https://api.anthropic.com/api/oauth/usage',
    credential: 'Claude Code’s OAuth token (CLAUDE_CODE_OAUTH_TOKEN, ~/.claude/.credentials.json, or the Keychain item “Claude Code-credentials”)',
  },
  commandcode: {
    endpoint: 'https://api.commandcode.ai/alpha/billing/credits and /alpha/billing/subscriptions',
    credential: 'Command Code’s API key (~/.commandcode/auth.json)',
  },
} as const

/* ------------------------------------------------------------------ */
/* A small, believable file tree                                       */
/* ------------------------------------------------------------------ */

/** A folder is an object of children; a file is `null`. */
type Tree = { [name: string]: Tree | null }

const ACME_API_TREE: Tree = {
  '.git': {},
  '.github': { workflows: { 'ci.yml': null } },
  '.env.example': null,
  docs: { 'architecture.md': null, 'runbook.md': null },
  scripts: { 'seed.ts': null, 'migrate.ts': null },
  src: {
    'index.ts': null,
    'router.ts': null,
    importers: { 'csv-importer.ts': null },
    lib: { 'db.ts': null, 'lru.ts': null, 'csv.ts': null, 'clock.ts': null },
    middleware: { 'auth.ts': null, 'index.ts': null, 'rate-limit.ts': null },
    routes: { 'health.ts': null, 'orders.ts': null, 'users.ts': null },
  },
  tests: {
    'auth.test.ts': null,
    'csv-importer.test.ts': null,
    'orders.test.ts': null,
    'rate-limit.test.ts': null,
  },
  'AGENTS.md': null,
  'CLAUDE.md': null,
  'README.md': null,
  'bun.lock': null,
  'package.json': null,
  'tsconfig.json': null,
}

const ACME_WEB_TREE: Tree = {
  '.git': {},
  public: { 'favicon.svg': null },
  src: {
    components: { 'Dashboard.tsx': null, 'OrdersTable.tsx': null, 'ThemeToggle.tsx': null },
    'App.tsx': null,
    'main.tsx': null,
    'theme.css': null,
  },
  'index.html': null,
  'package.json': null,
  'vite.config.ts': null,
}

const FS: Tree = {
  Users: {
    you: {
      '.config': {},
      '.ssh': {},
      '.zshrc': null,
      Desktop: {},
      Documents: { 'invoices': {}, 'notes.md': null },
      Downloads: {},
      Projects: {
        'acme-api': ACME_API_TREE,
        'acme-web': ACME_WEB_TREE,
        dotfiles: { 'install.sh': null, zsh: {} },
        infra: { k8s: { 'api.yaml': null, 'web.yaml': null }, terraform: { 'main.tf': null, 'variables.tf': null } },
      },
    },
  },
  home: {
    deploy: {
      '.bashrc': null,
      apps: { 'acme-api': ACME_API_TREE },
      logs: { 'api.log': null },
    },
  },
}

function lookup(path: string): Tree | null | undefined {
  const parts = path.split('/').filter(Boolean)
  let node: Tree | null | undefined = FS
  for (const part of parts) {
    if (!node) return undefined
    node = node[part]
  }
  return node
}

export function homeFor(host: string | null): string {
  return host ? REMOTE_HOME : HOME
}

/** One level of the fake tree, shaped like `/api/fs`; null for a path that is not a folder. */
export function listDirectory(rawPath: string, host: string | null) {
  const path = (rawPath || homeFor(host)).replace(/\/+$/, '') || '/'
  const node = lookup(path)
  if (!node) return null
  const name = path === '/' ? '/' : path.split('/').pop()!
  const parentPath = path === '/' ? null : path.slice(0, path.lastIndexOf('/')) || '/'
  const entries = Object.entries(node)
    .map(([entry, child]) => ({
      name: entry,
      path: `${path === '/' ? '' : path}/${entry}`,
      kind: child === null ? ('file' as const) : ('dir' as const),
      hidden: entry.startsWith('.'),
    }))
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
  return { path, name, parent: parentPath, entries }
}
