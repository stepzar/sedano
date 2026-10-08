/**
 * The tailscale CLI, for remote mode.
 *
 * Sedano never listens on anything but 127.0.0.1. Reaching it from a phone is
 * `tailscale serve` terminating HTTPS on this machine's tailnet name and
 * proxying to the loopback port — tailnet-only, never `funnel`.
 *
 * Two instances are supported:
 *
 *   - `app`: the Tailscale.app daemon, through its default socket. Simple, but it
 *     exposes Sedano on whatever tailnet the app is logged into.
 *   - `dedicated`: a second `tailscaled` in userspace-networking mode with its own
 *     state and socket under `~/.sedano/tailscale`, logged into a different
 *     (personal) account. The app keeps its own tailnet untouched. It runs as a
 *     launchd agent, written only by an explicit install action.
 *
 * Every path is overridable by environment so the tests drive fakes and never the
 * operator's real tailnet.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { SEDANO_HOME } from './paths.ts'

export type TailscaleInstance = 'app' | 'dedicated'

export const DEDICATED_DIR = join(SEDANO_HOME, 'tailscale')
export const DEDICATED_SOCKET = join(DEDICATED_DIR, 'tailscaled.sock')
export const LAUNCH_LABEL = 'dev.sedano.tailscaled'

const LAUNCH_AGENTS = process.env.SEDANO_LAUNCH_AGENTS_DIR ?? join(homedir(), 'Library', 'LaunchAgents')
const LAUNCHCTL = process.env.SEDANO_LAUNCHCTL ?? '/bin/launchctl'
const PLIST = join(LAUNCH_AGENTS, `${LAUNCH_LABEL}.plist`)

function firstExisting(paths: Array<string | null | undefined>): string | null {
  for (const path of paths) if (path && existsSync(path)) return path
  return null
}

/** The open-source daemon. Tailscale.app does not ship one; `brew install tailscale` does. */
export function daemonBinary(): string | null {
  if (process.env.SEDANO_TAILSCALED) return process.env.SEDANO_TAILSCALED
  return firstExisting(['/opt/homebrew/bin/tailscaled', '/usr/local/bin/tailscaled', Bun.which('tailscaled')])
}

/**
 * The CLI to talk to an instance with. The dedicated daemon is driven by the CLI
 * installed next to it, so client and daemon are the same version; the app is
 * driven by the app's own CLI.
 */
export function cliBinary(instance: TailscaleInstance): string | null {
  if (process.env.SEDANO_TAILSCALE) return process.env.SEDANO_TAILSCALE
  const daemon = instance === 'dedicated' ? daemonBinary() : null
  return firstExisting([
    daemon ? join(dirname(daemon), 'tailscale') : null,
    '/usr/local/bin/tailscale',
    '/Applications/Tailscale.app/Contents/MacOS/tailscale',
    Bun.which('tailscale'),
  ])
}

function socketArgs(instance: TailscaleInstance): string[] {
  return instance === 'dedicated' ? ['--socket', DEDICATED_SOCKET] : []
}

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

async function run(argv: string[], timeoutMs = 15_000): Promise<RunResult> {
  const proc = Bun.spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs)
  try {
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const code = await proc.exited
    return { code, stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}

async function cli(instance: TailscaleInstance, args: string[], timeoutMs?: number): Promise<RunResult> {
  const bin = cliBinary(instance)
  if (!bin) throw new Error('the tailscale CLI was not found (install Tailscale, or `brew install tailscale`)')
  return run([bin, ...socketArgs(instance), ...args], timeoutMs)
}

/* ------------------------------------------------------------------ */
/* Node status                                                         */
/* ------------------------------------------------------------------ */

export interface NodeStatus {
  /** False when the daemon did not answer at all. */
  reachable: boolean
  /** `Running`, `NeedsLogin`, `Stopped`, ... as tailscaled reports it. */
  backendState: string | null
  /** This node's MagicDNS name, without the trailing dot. */
  dnsName: string | null
  /** The account this node is logged in as. */
  login: string | null
  tailnet: string | null
  authUrl: string | null
  error: string | null
}

interface StatusJson {
  BackendState?: string
  AuthURL?: string
  Self?: { DNSName?: string; UserID?: number }
  User?: Record<string, { LoginName?: string }>
  CurrentTailnet?: { Name?: string } | null
}

export async function nodeStatus(instance: TailscaleInstance): Promise<NodeStatus> {
  const empty: NodeStatus = {
    reachable: false,
    backendState: null,
    dnsName: null,
    login: null,
    tailnet: null,
    authUrl: null,
    error: null,
  }
  let result: RunResult
  try {
    result = await cli(instance, ['status', '--json'], 8_000)
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message : String(err) }
  }
  let parsed: StatusJson
  try {
    parsed = JSON.parse(result.stdout) as StatusJson
  } catch {
    return { ...empty, error: (result.stderr || result.stdout).trim() || `tailscale exited ${result.code}` }
  }
  const dns = parsed.Self?.DNSName?.replace(/\.$/, '').toLowerCase() || null
  const userId = parsed.Self?.UserID
  const login = userId !== undefined ? (parsed.User?.[String(userId)]?.LoginName ?? null) : null
  return {
    reachable: true,
    backendState: parsed.BackendState ?? null,
    dnsName: parsed.BackendState === 'Running' ? dns : null,
    login: login ? login.toLowerCase() : null,
    tailnet: parsed.CurrentTailnet?.Name ?? null,
    authUrl: parsed.AuthURL || null,
    error: null,
  }
}

/* ------------------------------------------------------------------ */
/* Serve                                                               */
/* ------------------------------------------------------------------ */

export interface ServeStatus {
  /** `https://<name>/` proxies to this server. */
  active: boolean
  url: string | null
  /** What `https://<name>:443/` points at today, when it is something else. */
  conflict: string | null
  /** Funnel (public internet) is on for this name: Sedano refuses to run behind it. */
  funnel: boolean
}

interface ServeJson {
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>
  AllowFunnel?: Record<string, boolean>
}

function ourTarget(port: number): string {
  return `http://127.0.0.1:${port}`
}

export async function serveStatus(instance: TailscaleInstance, dnsName: string, port: number): Promise<ServeStatus> {
  const result = await cli(instance, ['serve', 'status', '--json'])
  let parsed: ServeJson = {}
  try {
    parsed = result.stdout.trim() ? (JSON.parse(result.stdout) as ServeJson) : {}
  } catch {
    throw new Error((result.stderr || result.stdout).trim() || `tailscale serve status exited ${result.code}`)
  }
  const key = `${dnsName}:443`
  const proxy = parsed.Web?.[key]?.Handlers?.['/']?.Proxy ?? null
  const target = ourTarget(port)
  const active = proxy !== null && proxy.replace(/\/$/, '') === target
  return {
    active,
    url: active ? `https://${dnsName}/` : null,
    conflict: proxy !== null && !active ? proxy : null,
    funnel: parsed.AllowFunnel?.[key] === true,
  }
}

/** Idempotent: an existing proxy to us is left alone, anything else on :443 is never overwritten. */
export async function serveStart(instance: TailscaleInstance, dnsName: string, port: number): Promise<ServeStatus> {
  const before = await serveStatus(instance, dnsName, port)
  if (before.funnel) throw new Error(`funnel is on for ${dnsName}; turn it off (tailscale funnel reset) — Sedano is tailnet-only`)
  if (before.active) return before
  if (before.conflict) {
    throw new Error(`https://${dnsName}/ already serves ${before.conflict}; not overwriting it (tailscale serve reset to clear)`)
  }
  const result = await cli(instance, ['serve', '--bg', '--https=443', ourTarget(port)], 30_000)
  const after = await serveStatus(instance, dnsName, port)
  if (!after.active) {
    const said = (result.stderr || result.stdout).trim()
    throw new Error(`tailscale serve did not take effect${said ? `: ${said}` : ''}`)
  }
  return after
}

/** Idempotent: nothing to stop is success; someone else's handler is not ours to remove. */
export async function serveStop(instance: TailscaleInstance, dnsName: string, port: number): Promise<ServeStatus> {
  const before = await serveStatus(instance, dnsName, port)
  if (!before.active) return before
  const result = await cli(instance, ['serve', '--https=443', 'off'])
  const after = await serveStatus(instance, dnsName, port)
  if (after.active) throw new Error(`tailscale serve is still on: ${(result.stderr || result.stdout).trim()}`)
  return after
}

/* ------------------------------------------------------------------ */
/* Login (dedicated instance only)                                     */
/* ------------------------------------------------------------------ */

let pendingLogin: { proc: ReturnType<typeof Bun.spawn>; url: string | null; timer: Timer } | null = null

/**
 * Starts `tailscale up` on the dedicated instance and returns the URL the user
 * must open to authenticate. The CLI blocks until that happens, so it is left
 * running (bounded to ten minutes) and exits by itself once the login lands.
 */
export async function login(nodeName: string): Promise<{ state: 'running' | 'needs-auth'; authUrl: string | null }> {
  const status = await nodeStatus('dedicated')
  if (!status.reachable) throw new Error(`the dedicated tailscaled is not answering${status.error ? `: ${status.error}` : ''}`)
  if (status.backendState === 'Running') return { state: 'running', authUrl: null }
  if (pendingLogin?.url && pendingLogin.proc.exitCode === null) return { state: 'needs-auth', authUrl: pendingLogin.url }
  stopLogin()

  const bin = cliBinary('dedicated')
  if (!bin) throw new Error('the tailscale CLI was not found')
  const proc = Bun.spawn(
    [bin, ...socketArgs('dedicated'), 'up', `--hostname=${nodeName}`, '--accept-dns=false', '--accept-routes=false'],
    { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  )
  const timer = setTimeout(stopLogin, 10 * 60_000)
  pendingLogin = { proc, url: null, timer }
  const current = pendingLogin

  const url = await new Promise<string | null>((resolve) => {
    const deadline = setTimeout(() => resolve(null), 15_000)
    const watch = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder()
      let text = ''
      const reader = stream.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        text += decoder.decode(value, { stream: true })
        const found = text.match(/https:\/\/\S+/)
        if (found) {
          clearTimeout(deadline)
          resolve(found[0])
        }
      }
    }
    void watch(proc.stdout as ReadableStream<Uint8Array>)
    void watch(proc.stderr as ReadableStream<Uint8Array>)
    void proc.exited.then(() => {
      clearTimeout(deadline)
      resolve(null)
    })
  })
  current.url = url
  if (url) return { state: 'needs-auth', authUrl: url }
  const after = await nodeStatus('dedicated')
  if (after.backendState === 'Running') return { state: 'running', authUrl: null }
  throw new Error('tailscale up gave no login URL')
}

/** Ends a login still waiting for the browser; called on shutdown too. */
export function stopLogin(): void {
  if (!pendingLogin) return
  clearTimeout(pendingLogin.timer)
  if (pendingLogin.proc.exitCode === null) pendingLogin.proc.kill('SIGTERM')
  pendingLogin = null
}

/* ------------------------------------------------------------------ */
/* The dedicated daemon, as a launchd agent                            */
/* ------------------------------------------------------------------ */

export interface DaemonStatus {
  binary: string | null
  installed: boolean
  loaded: boolean
  plist: string
  socket: string
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function plistFor(binary: string): string {
  const args = [
    binary,
    '--tun=userspace-networking',
    `--statedir=${DEDICATED_DIR}`,
    `--socket=${DEDICATED_SOCKET}`,
    '--port=0',
  ]
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${escapeXml(arg)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(join(DEDICATED_DIR, 'tailscaled.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(DEDICATED_DIR, 'tailscaled.log'))}</string>
</dict>
</plist>
`
}

function domain(): string {
  return `gui/${process.getuid?.() ?? 501}`
}

async function isLoaded(): Promise<boolean> {
  const result = await run([LAUNCHCTL, 'print', `${domain()}/${LAUNCH_LABEL}`], 5_000)
  return result.code === 0
}

export async function daemonStatus(): Promise<DaemonStatus> {
  return {
    binary: daemonBinary(),
    installed: existsSync(PLIST),
    loaded: await isLoaded(),
    plist: PLIST,
    socket: DEDICATED_SOCKET,
  }
}

/** Writes the agent and loads it. Idempotent: an unchanged, loaded agent is left running. */
export async function daemonInstall(): Promise<DaemonStatus> {
  const binary = daemonBinary()
  if (!binary) throw new Error('tailscaled was not found; install it with `brew install tailscale`')
  const wanted = plistFor(binary)
  const current = existsSync(PLIST) ? readFileSync(PLIST, 'utf8') : null
  const loaded = await isLoaded()
  if (current === wanted && loaded) return daemonStatus()

  mkdirSync(DEDICATED_DIR, { recursive: true, mode: 0o700 })
  mkdirSync(LAUNCH_AGENTS, { recursive: true })
  if (loaded) await run([LAUNCHCTL, 'bootout', `${domain()}/${LAUNCH_LABEL}`], 10_000)
  writeFileSync(PLIST, wanted)
  const result = await run([LAUNCHCTL, 'bootstrap', domain(), PLIST], 10_000)
  if (result.code !== 0) throw new Error(`launchctl bootstrap failed: ${(result.stderr || result.stdout).trim()}`)
  return daemonStatus()
}

/** Unloads and removes the agent. The login state in the state dir is kept. */
export async function daemonUninstall(): Promise<DaemonStatus> {
  if (await isLoaded()) await run([LAUNCHCTL, 'bootout', `${domain()}/${LAUNCH_LABEL}`], 10_000)
  rmSync(PLIST, { force: true })
  return daemonStatus()
}
