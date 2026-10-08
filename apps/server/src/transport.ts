/**
 * Where a harness actually runs.
 *
 * Every driver used to talk to the local machine directly — `Bun.spawn` with a
 * local `cwd`, `node:fs` for transcripts and file access. A workspace on an SSH
 * host needs exactly the same operations, only executed on the other side, so
 * they all go through this one object: a `Transport` bound to a host (or to
 * `null` for this machine). Drivers never branch on local vs remote; they ask
 * the transport and it does the right thing.
 *
 * Remote work shells out to the system `ssh` client — the same client a terminal
 * tab already uses — so there is no new dependency and the behaviour matches
 * what you would type by hand. `BatchMode=yes` keeps it non-interactive (the
 * server has no terminal to prompt on) and fails fast instead of hanging.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
  type Dirent,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { Subprocess } from 'bun'
import { SEDANO_HOME } from './paths.ts'
import { assertAuthorizedHost, assertSafeHost, isAuthorizedHost, isSafeHost } from './hosts.ts'
import { remoteDiscoveryPathPrelude, which as localWhich } from './which.ts'

// Re-exported from here because this is where every caller already asks about
// destinations; the allowlist itself lives with the settings that own it.
export { assertAuthorizedHost, assertSafeHost, isAuthorizedHost, isSafeHost }

/** A long-lived process with pipes on all three streams, local or remote. */
export type Proc = Subprocess<'pipe', 'pipe', 'pipe'>

/**
 * What went wrong on the other machine, as a kind rather than as an absence.
 *
 * Every remote operation used to collapse into `null`/`[]`/`void`, so a dropped
 * connection was indistinguishable from an empty directory, a missing file or a
 * home directory that happens to be this laptop's. These five kinds are the only
 * distinctions a caller ever needs to make:
 *
 * - `unreachable`  — ssh could not get there (down, refused, auth, no route)
 * - `timeout`      — it got there and nothing came back in time
 * - `not_found`    — the path is not on that machine
 * - `permission`   — it is there and we may not touch it
 * - `command_failed` — the remote command ran and said no
 */
export type RemoteErrorKind = 'unreachable' | 'timeout' | 'not_found' | 'permission' | 'command_failed'

export class RemoteError extends Error {
  readonly kind: RemoteErrorKind
  readonly host: string | null
  /** The message without the host prefix, for wrapping it in another one. */
  readonly reason: string
  /** The remote command's exit code, when one was produced. */
  readonly code: number | undefined
  readonly stderr: string | undefined

  constructor(
    kind: RemoteErrorKind,
    host: string | null,
    message: string,
    detail: { code?: number; stderr?: string } = {},
  ) {
    super(host ? `${host}: ${message}` : message)
    this.name = 'RemoteError'
    this.kind = kind
    this.host = host
    this.reason = message
    this.code = detail.code
    this.stderr = detail.stderr
  }
}

export function isRemoteError(value: unknown): value is RemoteError {
  return value instanceof RemoteError
}

/**
 * ssh reserves 255 for its own failures, so an exit of 255 means the connection
 * never happened (or died) rather than "the command said no" — the one signal
 * that separates "that host is not answering" from "that path is not there".
 * A remote command is free to exit 255 too; misreading that as unreachable costs
 * a retry and a clearer message, which is the safer way round.
 */
const SSH_FAILURE = 255

function classify(
  host: string | null,
  code: number,
  stderr: string,
  timedOut: boolean,
): RemoteErrorKind {
  if (timedOut) return 'timeout'
  if (host && code === SSH_FAILURE) return 'unreachable'
  if (/permission denied|operation not permitted/i.test(stderr)) return 'permission'
  if (/no such file or directory|not found/i.test(stderr)) return 'not_found'
  return 'command_failed'
}

/** Names we are willing to put on the left of an `export` (see `spawn`). */
const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Tags name a pid file on the host, so they stay boring on purpose. */
const SAFE_TAG = /^[A-Za-z0-9._-]+$/

/**
 * Run a command with a deadline that is actually enforced.
 *
 * `Bun.spawnSync({ timeout })` is accepted and ignored on the Bun this runs on
 * (1.2.2: a `sleep 5` with a 500ms timeout returns after 5s, exit 0), so every
 * deadline in this file was decoration — one unanswering host froze the server
 * for as long as it felt like. The watchdog is a POSIX shell one-liner: run the
 * command, and if it is still there after N seconds, TERM it and then KILL it.
 *
 * Whole seconds, because `sleep 0.5` is not portable; sub-second deadlines are
 * rounded up to one, which is still finite.
 */
function spawnWithDeadline(
  argv: string[],
  timeoutMs: number,
  stdin?: Uint8Array,
): { exitCode: number | null; stdout: Uint8Array; stderr: Uint8Array } {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000))
  // `exec 3<&0` then `<&3`: a shell gives a *background* command /dev/null for
  // stdin unless it is redirected explicitly, which silently wrote empty files
  // for every `writeText` until the input was handed over by descriptor.
  const script =
    'exec 3<&0; ' +
    `${argv.map(shq).join(' ')} <&3 & p=$!; ` +
    `(sleep ${seconds}; kill -TERM $p 2>/dev/null; sleep 1; kill -KILL $p 2>/dev/null) >/dev/null 2>&1 & w=$!; ` +
    'wait $p; c=$?; kill -KILL $w 2>/dev/null; exit $c'
  const proc = Bun.spawnSync(['sh', '-c', script], {
    stdout: 'pipe',
    stderr: 'pipe',
    ...(stdin ? { stdin } : {}),
  })
  return { exitCode: proc.exitCode, stdout: proc.stdout, stderr: proc.stderr }
}

/** 128 + SIGTERM: how a shell reports the child the watchdog stopped. */
const TERMINATED = 143

/** Where a long-lived remote process records its pid, for explicit cleanup. */
export function remotePidPath(tag: string): string {
  if (!SAFE_TAG.test(tag)) throw new Error(`refusing unsafe process tag: ${tag}`)
  return `"$HOME/.sedano/procs/${tag}.pid"`
}

/**
 * The shell prologue that makes a remote process identifiable.
 *
 * A remote process is started by an `ssh` client here, and the usual assumption
 * — "kill the client and the far side dies with it" — is only true when the far
 * side notices its channel closing. A `tail -F`, a read loop or an agent that
 * ignores SIGHUP happily outlives it, and those leftovers accumulate on the
 * server. So the remote shell writes its own pid down *before* it becomes the
 * program (`exec` keeps the pid), and `cleanupRemote` kills that pid's group by
 * name later — no guessing from `ps`, and it works after this process restarted.
 */
export function remotePidPrologue(tag: string): string {
  const file = remotePidPath(tag)
  return `${privateMkdir('"$HOME/.sedano/procs"', '"$HOME/.sedano"')} 2>/dev/null; printf %s "$$" > ${file}; `
}

/**
 * Shell that creates `dir` readable by its owner only, and tightens `root` (the
 * Sedano folder it lives in, possibly left open by an older build). On a host
 * that folder holds agent logs, prompts in transit and terminal scrollback.
 *
 * The umask is set in a subshell so it ends there: whatever runs after this
 * line — an agent, a person's shell — keeps the host's own umask for the files
 * it writes in a project.
 */
export function privateMkdir(dir: string, root: string): string {
  return `(umask 077; mkdir -p ${dir} && chmod 700 ${root} ${dir})`
}

/**
 * Run a local long-lived reader (a `tail -F`) so it cannot outlive this server.
 *
 * A `tail -F` only dies when it writes into a closed pipe, so a server that
 * exits without stopping it — a crash, a SIGKILL, a test harness tearing down —
 * left one behind per stream, re-opening its file forever (`-F` retries even
 * once the file is deleted). The wrapper polls its parent, this server, and
 * takes the command down when it is gone; the trap does the same for an
 * ordinary stop, and `wait` is what lets that trap run at once instead of after
 * the sleep. Local only: on a host the parent is a shared ssh connection that
 * outlives the channel, so there the pid file (`remotePidPrologue`) is the
 * mechanism. `command` is shell source and must not be `exec`.
 */
export function watchedByServer(command: string): string {
  return (
    `${command} & t=$!; ` +
    `trap 'kill $t 2>/dev/null; exit 0' TERM INT HUP; ` +
    'while kill -0 $PPID 2>/dev/null && kill -0 $t 2>/dev/null; do sleep 2 & wait $!; done; ' +
    'kill $t 2>/dev/null'
  )
}

/** Escape a single argument for the remote login shell. */
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Options every `ssh` invocation carries: never prompt (the server has no
 * terminal to prompt on) and never hang on a host that is not answering.
 *
 * And one connection per host, reused: a server is a network round trip away,
 * so a fresh handshake per command costs ~1s. A terminal sends one command per
 * keystroke batch and the picker sends one per scan; over a shared connection
 * the same command costs a single round trip (~130ms on the VPS this was
 * measured against) instead. The master is kept for a few minutes so a session
 * you are actually typing into stays fast, and `auto` falls back to a fresh
 * connection whenever the master is gone.
 */
export const SSH_OPTS = process.platform === 'win32'
  ? // Windows ssh has no control sockets; asking for one is an error there.
    ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8']
  : [
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=8',
      '-o',
      'ControlMaster=auto',
      '-o',
      `ControlPath=${join(SEDANO_HOME, 'ssh', '%C')}`,
      '-o',
      'ControlPersist=300',
    ]

/**
 * The multiplexing sockets live here. ssh refuses a control path whose directory
 * is missing, so it is made once, before the first connection is attempted.
 */
function ensureControlDir(): void {
  try {
    mkdirSync(join(SEDANO_HOME, 'ssh'), { recursive: true, mode: 0o700 })
  } catch {
    /* someone else's problem: ssh will simply open a direct connection */
  }
}

// Made once, at import: nothing may turn into an ssh call before it exists.
if (process.platform !== 'win32') ensureControlDir()

export interface SpawnOptions {
  cwd?: string
  env?: Record<string, string | undefined>
  /**
   * Variables that must be set on the far side as well, for a process that runs
   * there and checks its own environment (see `remoteEnv` in `spawn`). `env` is
   * still local-only: forwarding this machine's whole environment to a host would
   * be wrong, and these are the few names a driver actually needs over there.
   */
  remoteEnv?: Record<string, string>
  stdin?: 'pipe' | 'ignore'
  stdout?: 'pipe' | 'ignore'
  stderr?: 'pipe' | 'ignore'
  /**
   * A name for a long-lived remote process, so it can be killed on the host
   * later even if this process (or the ssh client) is long gone. See
   * `remotePidPrologue`.
   */
  procTag?: string
}

export interface DirItem {
  name: string
  dir: boolean
  hidden: boolean
}

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
  /**
   * Why the command did not run, when it did not run. Present for a connection
   * that failed or timed out as well as for a command that exited non-zero, so
   * a caller that only looks at `stdout` cannot read a dead link as an answer.
   */
  error?: RemoteError
}

/** What a write actually did, so no caller has to assume it happened. */
export interface WriteResult {
  path: string
  bytes: number
}

/**
 * A poll of a growing file: the size seen, the bytes handed over, and the only
 * offset a caller may continue from.
 *
 * `next` is the contract. It is `offset + bytes.length` — what was *delivered* —
 * never "where the file ends", because the two differ exactly when a read is
 * short and advancing to the end is how bytes get skipped.
 */
export interface PollResult {
  size: number
  bytes: Uint8Array
  next: number
  /**
   * Set when the poll could not reach the file at all. `size`/`next` are pinned
   * to the offset asked for, so a failed poll can never be mistaken for progress
   * or for a truncation — but it is still visible, rather than an empty read.
   */
  error?: RemoteError
}

export class Transport {
  constructor(readonly host: string | null) {
    if (host) assertAuthorizedHost(host)
  }

  get remote(): boolean {
    return this.host !== null
  }

  /** The argv that runs one shell command string on the target. */
  private argv(command: string): string[] {
    return this.host ? ['ssh', ...SSH_OPTS, this.host, command] : ['sh', '-lc', command]
  }

  /**
   * Start a long-lived process on the target and keep its stdio. A remote
   * process is a local `ssh` whose channel closes with it; killing that ssh is
   * how a driver stops it. `env` is applied locally only — forwarding this
   * machine's PATH to a remote host would be wrong, and the drivers only use it
   * for cosmetic flags (FORCE_COLOR/NO_COLOR).
   */
  spawn(bin: string, args: string[], opts: SpawnOptions = {}): Proc {
    if (!this.host) {
      return Bun.spawn([bin, ...args], {
        cwd: opts.cwd,
        stdin: opts.stdin ?? 'pipe',
        stdout: opts.stdout ?? 'pipe',
        stderr: opts.stderr ?? 'pipe',
        env: opts.env,
      }) as Proc
    }
    // `export FOO=…` is shell source, so the *name* is code. A name carrying a
    // space, a `;` or a `$()` would run on the host with the session's rights;
    // only a shell variable name is ever composed into the script.
    const exported = Object.entries(opts.remoteEnv ?? {})
      .map(([name, value]) => {
        if (!SHELL_NAME.test(name)) throw new Error(`refusing unsafe remote environment name: ${name}`)
        return `export ${name}=${shq(value)}; `
      })
      .join('')
    const prologue = opts.procTag ? remotePidPrologue(opts.procTag) : ''
    const parts = [
      prologue,
      exported,
      opts.cwd ? `cd ${shq(opts.cwd)} && ` : '',
      `exec ${shq(bin)}`,
      ...args.map(shq),
    ]
    return Bun.spawn(['ssh', ...SSH_OPTS, this.host, parts.join(' ')], {
      stdin: opts.stdin ?? 'pipe',
      stdout: opts.stdout ?? 'pipe',
      stderr: opts.stderr ?? 'pipe',
    }) as Proc
  }

  /**
   * Kill a process started with `procTag`, on the host, by name.
   *
   * The group first (`kill -TERM -pid`): a harness that spawned children of its
   * own leaves them behind otherwise, and those are what a `stop` is supposed to
   * take with it. Best effort by design — the pid may already be gone — but it
   * is an explicit round trip rather than a hope about the ssh client.
   */
  cleanupRemote(tag: string): void {
    if (!this.host) return
    const file = remotePidPath(tag)
    this.exec(
      `p=$(cat ${file} 2>/dev/null); ` +
        `if [ -n "$p" ]; then kill -TERM -"$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null; fi; ` +
        `rm -f ${file}; exit 0`,
      { timeoutMs: 6000 },
    )
  }

  /** `cleanupRemote`, without holding the event loop. */
  async cleanupRemoteAsync(tag: string): Promise<void> {
    if (!this.host) return
    const file = remotePidPath(tag)
    await this.execAsync(
      `p=$(cat ${file} 2>/dev/null); ` +
        `if [ -n "$p" ]; then kill -TERM -"$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null; fi; ` +
        `rm -f ${file}; exit 0`,
      { timeoutMs: 6000 },
    )
  }

  /**
   * Run one shell command to completion and collect its output.
   *
   * Never throws: the failure travels in `error`, typed, so a caller can tell a
   * refused connection from a command that answered "no". `retries` is for the
   * idempotent calls only (a scan, a size, a read) — a connection that dropped
   * mid-handshake is the single most common failure here and repeating a read is
   * free, while repeating a write is not.
   */
  exec(command: string, opts: { timeoutMs?: number; retries?: number } = {}): ExecResult {
    const result = this.runBytes(command, opts.timeoutMs ?? 8000, opts.retries ?? 0)
    return {
      code: result.code,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      ...(result.error ? { error: result.error } : {}),
    }
  }

  /** The same, for a caller that wants the typed failure raised at the call. */
  execOrThrow(command: string, opts: { timeoutMs?: number; retries?: number } = {}): ExecResult {
    const result = this.exec(command, opts)
    if (result.error) throw result.error
    return result
  }

  private runBytes(
    command: string,
    timeoutMs: number,
    retries = 0,
  ): { code: number; stdout: Buffer; stderr: Buffer; error?: RemoteError } {
    let last = this.runOnce(command, timeoutMs)
    for (let attempt = 0; attempt < retries; attempt += 1) {
      // Only the failures a second attempt can fix. A command that ran and said
      // no says the same thing twice, and re-running it wastes a round trip.
      if (!last.error || (last.error.kind !== 'unreachable' && last.error.kind !== 'timeout')) break
      Bun.sleepSync(RETRY_DELAY_MS * (attempt + 1))
      last = this.runOnce(command, timeoutMs)
    }
    return last
  }

  private runOnce(
    command: string,
    timeoutMs: number,
  ): { code: number; stdout: Buffer; stderr: Buffer; error?: RemoteError } {
    const started = Date.now()
    try {
      const proc = spawnWithDeadline(this.argv(command), timeoutMs)
      const code = proc.exitCode ?? SSH_FAILURE
      const stdout = Buffer.from(proc.stdout)
      const stderr = Buffer.from(proc.stderr)
      if (code === 0) return { code, stdout, stderr }
      // A watchdog kill arrives as 128+SIGTERM, and a slow link is otherwise
      // indistinguishable from a dead one without looking at the clock.
      const elapsed = Date.now() - started
      const timedOut = (code === TERMINATED || proc.exitCode === null) && elapsed >= timeoutMs - TIMEOUT_SLACK_MS
      const text = stderr.toString().trim()
      const kind = classify(this.host, code, text, timedOut)
      const why = timedOut ? `timed out after ${timeoutMs}ms` : text || `exited ${code}`
      return { code, stdout, stderr, error: new RemoteError(kind, this.host, why, { code, stderr: text }) }
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      return {
        code: SSH_FAILURE,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        error: new RemoteError(this.host ? 'unreachable' : 'command_failed', this.host, why),
      }
    }
  }

  /** Resolve a binary to a path, or null when it is not on the target. */
  which(bin: string): string | null {
    if (!this.host) return localWhich(bin)
    const found = this.exec(`${remoteDiscoveryPathPrelude()}command -v ${shq(bin)}`).stdout.trim().split('\n')[0]?.trim()
    return found || null
  }

  /**
   * Resolve several binaries in one round trip — a harness picker must not pay
   * one SSH handshake per harness. Every name asked for is in the answer: a
   * missing binary maps to null, so a caller cannot read "not asked" as
   * "not installed".
   *
   * The answer ends with a marker and a reply without it is a throw rather than
   * half a catalog.
   */
  whichAll(bins: string[]): Map<string, string | null> {
    if (!this.host) return localWhichAll(bins)
    const command = whichAllCommand(bins)
    // One retry: the first ssh to a cold host is the flakiest thing this does.
    let result = this.exec(command, { timeoutMs: 15_000, retries: 1 })
    if (!result.stdout.includes(PROBE_END)) result = this.exec(command, { timeoutMs: 15_000 })
    return parseWhichAll(this.host, bins, result)
  }

  /**
   * `whichAll` without holding the event loop.
   *
   * The synchronous version blocks the whole server for as long as ssh takes,
   * and for a host that is down that is up to three connect timeouts — every
   * socket, every terminal and every stream frozen while a background catalog
   * sweep waited on one machine. Same probe, same retries, same answer.
   */
  async whichAllAsync(bins: string[]): Promise<Map<string, string | null>> {
    if (!this.host) return localWhichAll(bins)
    const command = whichAllCommand(bins)
    let result = await this.execAsync(command, { timeoutMs: 15_000, retries: 1 })
    if (!result.stdout.includes(PROBE_END)) result = await this.execAsync(command, { timeoutMs: 15_000 })
    return parseWhichAll(this.host, bins, result)
  }

  /** `which`, without holding the event loop while a host answers. */
  async whichAsync(bin: string): Promise<string | null> {
    if (!this.host) return localWhich(bin)
    const found = (await this.execAsync(`${remoteDiscoveryPathPrelude()}command -v ${shq(bin)}`)).stdout
      .trim()
      .split('\n')[0]
      ?.trim()
    return found || null
  }

  /** `exec`, asynchronously: same deadline, retries and typed failure. */
  async execAsync(command: string, opts: { timeoutMs?: number; retries?: number } = {}): Promise<ExecResult> {
    const timeoutMs = opts.timeoutMs ?? 8000
    let last = await this.runOnceAsync(command, timeoutMs)
    for (let attempt = 0; attempt < (opts.retries ?? 0); attempt += 1) {
      if (!last.error || (last.error.kind !== 'unreachable' && last.error.kind !== 'timeout')) break
      await Bun.sleep(RETRY_DELAY_MS * (attempt + 1))
      last = await this.runOnceAsync(command, timeoutMs)
    }
    return last
  }

  private async runOnceAsync(command: string, timeoutMs: number): Promise<ExecResult> {
    const result = await this.runBytesOnceAsync(command, timeoutMs)
    return { ...result, stdout: Buffer.from(result.stdout).toString(), stderr: String(result.stderr) }
  }

  private async runBytesAsync(command: string, timeoutMs: number, retries = 0): Promise<BytesResult> {
    let last = await this.runBytesOnceAsync(command, timeoutMs)
    for (let attempt = 0; attempt < retries; attempt += 1) {
      if (!last.error || (last.error.kind !== 'unreachable' && last.error.kind !== 'timeout')) break
      await Bun.sleep(RETRY_DELAY_MS * (attempt + 1))
      last = await this.runBytesOnceAsync(command, timeoutMs)
    }
    return last
  }

  private async runBytesOnceAsync(command: string, timeoutMs: number): Promise<BytesResult> {
    const result = await runAsyncRaw(this.argv(command), timeoutMs)
    if (result.code === 0 && !result.timedOut) return { code: 0, stdout: result.stdout, stderr: result.stderr }
    const text = result.stderr.trim()
    const kind = classify(this.host, result.code, text, result.timedOut)
    const why = result.timedOut ? `timed out after ${timeoutMs}ms` : text || `exited ${result.code}`
    return {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      error: new RemoteError(kind, this.host, why, { code: result.code, stderr: text }),
    }
  }

  /*
   * The asynchronous twins of the reads below. Remote only in effect: on this
   * machine a read is a local syscall of microseconds and the synchronous code
   * is kept, while on a host every one of them is an ssh round trip that used to
   * hold the whole event loop — every socket, stream and terminal — until it
   * came back or timed out. Same commands, same answers, same typed failures.
   */

  async homeAsync(): Promise<string> {
    if (!this.host) return this.home()
    const result = await this.execAsync('printf %s "$HOME"', { timeoutMs: 8000, retries: 1 })
    if (result.error) throw result.error
    const found = result.stdout.trim()
    if (!found) throw new RemoteError('command_failed', this.host, 'the host reported no home directory')
    return found
  }

  async readTextAsync(path: string): Promise<string | null> {
    if (!this.host) return this.readText(path)
    const result = await this.execAsync(`[ -r ${shq(path)} ] || exit 3; cat -- ${shq(path)}`, { retries: 1 })
    if (result.code === 0) return result.stdout
    if (result.code === 3) return null
    throw result.error ?? new RemoteError('command_failed', this.host, `cannot read ${path}`, { code: result.code })
  }

  async existsAsync(path: string): Promise<boolean> {
    if (!this.host) return this.exists(path)
    const result = await this.execAsync(`test -e ${shq(path)}`, { timeoutMs: 5000, retries: 1 })
    if (result.code === 0) return true
    if (result.code === 1) return false
    throw result.error ?? new RemoteError('command_failed', this.host, `cannot stat ${path}`, { code: result.code })
  }

  async listDirAsync(path: string): Promise<DirItem[]> {
    if (!this.host) return this.listDir(path)
    const result = await this.execAsync(LIST_DIR_SCRIPT(path), { timeoutMs: 10000, retries: 1 })
    if (result.code !== 0) {
      throw result.error ?? new RemoteError('not_found', this.host, `cannot read ${path}`, { code: result.code })
    }
    return parseListing(result.stdout)
  }

  async writeTextAsync(path: string, text: string): Promise<WriteResult> {
    if (!this.host) return this.writeText(path, text)
    const command = `mkdir -p ${shq(dirname(path))} && cat > ${shq(path)}`
    const result = await runAsync(shellArgv(this.host, command), 15_000, new TextEncoder().encode(text))
    if (result.code === 0 && !result.timedOut) return { path, bytes: Buffer.byteLength(text) }
    const stderr = result.stderr.trim()
    throw new RemoteError(classify(this.host, result.code, stderr, result.timedOut), this.host, `cannot write ${path}: ${stderr || `exited ${result.code}`}`, { code: result.code, stderr })
  }

  /** `poll`, asynchronously on a host; see `poll` for the contract and `maxBytes`. */
  async pollAsync(path: string, offset: number, maxBytes = POLL_MAX_BYTES): Promise<PollResult | null> {
    if (!this.host) return this.poll(path, offset, maxBytes)
    const result = await this.runBytesAsync(pollScript(path, offset, maxBytes), 8000, 1)
    return this.parsePoll(path, offset, result)
  }

  /**
   * The target's home directory (the picker's starting point).
   *
   * Throws when the host cannot answer, and deliberately so: the old fallback to
   * *this* machine's home handed back a path like `/Users/me` for a Linux server,
   * which the picker then rendered as that server's home and every later command
   * ran in a directory nobody has. A host that is not answering has no home we
   * know of, and saying so is the only honest answer.
   */
  home(): string {
    if (!this.host) return process.env.HOME ?? homedir()
    const result = this.exec('printf %s "$HOME"', { timeoutMs: 8000, retries: 1 })
    if (result.error) throw result.error
    const found = result.stdout.trim()
    if (!found) throw new RemoteError('command_failed', this.host, 'the host reported no home directory')
    return found
  }

  /**
   * A file's contents, or null when there is no such file. Anything else — a
   * refused connection, a directory we may not read — is thrown: "not there" and
   * "could not look" are different answers and only one of them is null.
   */
  readText(path: string): string | null {
    if (!this.host) {
      try {
        return readFileSync(path, 'utf8')
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return null
        throw new RemoteError(code === 'EACCES' ? 'permission' : 'command_failed', null, String(err))
      }
    }
    // `test -f` first, so a missing file is a fact rather than an inference from
    // whatever `cat` printed on stderr.
    const result = this.exec(`[ -r ${shq(path)} ] || exit 3; cat -- ${shq(path)}`, { retries: 1 })
    if (result.code === 0) return result.stdout
    if (result.code === 3) return null
    throw result.error ?? new RemoteError('command_failed', this.host, `cannot read ${path}`, { code: result.code })
  }

  /** Whether the path is there. Throws when the host cannot be asked. */
  exists(path: string): boolean {
    if (!this.host) return existsSync(path)
    const result = this.exec(`test -e ${shq(path)}`, { timeoutMs: 5000, retries: 1 })
    if (result.code === 0) return true
    // `test` exits 1 for "no". Anything else is the connection, not the path.
    if (result.code === 1) return false
    throw result.error ?? new RemoteError('command_failed', this.host, `cannot stat ${path}`, { code: result.code })
  }

  /**
   * Write a file on the target, and say whether it happened.
   *
   * This used to swallow every failure. A protocol that depends on the file —
   * an ACP `fs/write_text_file`, a config an agent is about to read — then
   * carried on as if the write had landed, and the mistake surfaced much later
   * as the agent reading something stale. The exit code and stderr of the remote
   * shell come back as a typed error instead.
   */
  writeText(path: string, text: string): WriteResult {
    const bytes = Buffer.byteLength(text)
    if (!this.host) {
      try {
        const dir = dirname(path)
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        writeFileSync(path, text)
        return { path, bytes }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        throw new RemoteError(code === 'EACCES' ? 'permission' : 'command_failed', null, String(err))
      }
    }
    const command = `mkdir -p ${shq(dirname(path))} && cat > ${shq(path)}`
    let proc: { exitCode: number | null; stderr: Uint8Array }
    try {
      proc = spawnWithDeadline(
        ['ssh', ...SSH_OPTS, this.host, command],
        15_000,
        new TextEncoder().encode(text),
      )
    } catch (err) {
      throw new RemoteError('unreachable', this.host, err instanceof Error ? err.message : String(err))
    }
    const code = proc.exitCode ?? SSH_FAILURE
    if (code === 0) return { path, bytes }
    const stderr = Buffer.from(proc.stderr).toString().trim()
    throw new RemoteError(classify(this.host, code, stderr, proc.exitCode === null), this.host, `cannot write ${path}: ${stderr || `exited ${code}`}`, { code, stderr })
  }

  /**
   * One level of a directory, as the picker and the subagent scan see it.
   * Throws when the directory cannot be read — an unreachable host must say so
   * rather than render as an empty folder. Callers that treat absence as normal
   * (the subagent scan, before a session writes anything) catch it.
   */
  listDir(path: string): DirItem[] {
    if (!this.host) {
      const names: Dirent[] = readdirSync(path, { withFileTypes: true })
      return names.map((entry) => {
        let dir = entry.isDirectory()
        if (entry.isSymbolicLink()) {
          try {
            dir = statSync(resolve(path, entry.name)).isDirectory()
          } catch {
            dir = false
          }
        }
        return { name: entry.name, dir, hidden: entry.name.startsWith('.') }
      })
    }
    // A portable listing that also classifies (test -d follows symlinks, as the
    // local branch does). `.[!.]*` picks up dotfiles without `.`/`..`. The
    // trailing `exit 0` keeps an empty directory from looking like a failure;
    // a bad path still exits early, so the error survives.
    const result = this.exec(LIST_DIR_SCRIPT(path), { timeoutMs: 10000, retries: 1 })
    if (result.code !== 0) {
      throw (
        result.error ??
        new RemoteError('not_found', this.host, `cannot read ${path}`, { code: result.code })
      )
    }
    return parseListing(result.stdout)
  }

  /**
   * The file's size and the bytes written after `offset`, in one coherent read.
   *
   * Null means the file is not there yet — the normal state before a session
   * writes its first line — and *only* that. A host that could not be reached
   * comes back with `error` set and the offsets untouched, because a tailer that
   * reads a dropped connection as "no new bytes, and the file is now this long"
   * skips whatever arrived while the link was down.
   *
   * Atomic on purpose. The old version asked for the size and then asked for the
   * tail, as two statements whose answers came from two different moments: a file
   * that grew in between delivered more bytes than the size accounted for, the
   * caller advanced the offset to that stale size, and the extra bytes were
   * replayed on the next poll — duplicated lines in the transcript. Now one
   * script measures, announces how many bytes it is about to send, and sends
   * exactly that many (`head -c`), so growth is simply the next poll's business.
   *
   * The delta travels as bytes, never as a string: a read can land in the middle
   * of a multi-byte character, and only a streaming decoder that sees the next
   * read can put it back together.
   *
   * `next` is what a caller must advance to — the bytes actually delivered. When
   * a transfer is cut short, the size reported is pulled back to match it, so
   * `next === size` always holds and nothing between them can be skipped.
   */
  poll(path: string, offset: number, maxBytes = Number.POSITIVE_INFINITY): PollResult | null {
    if (!this.host) {
      let size: number
      try {
        size = statSync(path).size
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR') return null
        return failedPoll(offset, new RemoteError('command_failed', null, String(err)))
      }
      if (size <= offset) return { size, bytes: EMPTY, next: size }
      try {
        const fd = openSync(path, 'r')
        try {
          // Capped, so a first read of a huge file hands over a slice and the
          // caller comes back for the rest, instead of one read of everything.
          const want = Math.min(size - offset, maxBytes)
          const buffer = Buffer.alloc(want)
          let read = 0
          // A single `read` is allowed to return less than asked for; looping is
          // what keeps the delivered range equal to the range we report.
          while (read < want) {
            const got = readSync(fd, buffer, read, want - read, offset + read)
            if (got <= 0) break
            read += got
          }
          return { size: offset + read, bytes: buffer.subarray(0, read), next: offset + read }
        } finally {
          closeSync(fd)
        }
      } catch (err) {
        return failedPoll(offset, new RemoteError('command_failed', null, String(err)))
      }
    }
    const result = this.runBytes(pollScript(path, offset, maxBytes), 8000, 1)
    return this.parsePoll(path, offset, result)
  }

  private parsePoll(path: string, offset: number, result: BytesResult): PollResult | null {
    if (result.code === 3) return null
    if (result.error) return failedPoll(offset, result.error)
    const newline = result.stdout.indexOf(0x0a)
    const header = newline < 0 ? '' : Buffer.from(result.stdout.subarray(0, newline)).toString()
    const found = new RegExp(`^${POLL_HEAD} (\\d+) (\\d+)$`).exec(header)
    if (!found) {
      // A reply without the header is a reply that was cut off, not a short file.
      return failedPoll(
        offset,
        new RemoteError('command_failed', this.host, `unreadable poll reply for ${path}`, { code: result.code }),
      )
    }
    const announced = Number(found[2])
    const delivered = result.stdout.subarray(newline + 1, newline + 1 + announced)
    // Fewer bytes than announced means the file was truncated under us (or the
    // stream was cut): report what arrived, never what was promised. A capped
    // read reports where it stopped too, so `next === size` always holds.
    const next = offset + delivered.length
    const size = Number(found[1])
    return { size: delivered.length === announced && size <= next ? size : next, bytes: new Uint8Array(delivered), next }
  }
}

/* ------------------------------------------------------------------ */
/* Durable processes: an agent that outlives this server               */
/* ------------------------------------------------------------------ */

/**
 * A harness process that keeps working when sedano is not watching.
 *
 * A terminal tab survives because tmux owns its shell, and the obvious idea is
 * to put the agents in tmux too. It does not work, and the reason is not a
 * detail: a tmux pane is a *terminal*. The agents here are driven over
 * line-oriented protocols on stdin/stdout — Claude Code's `stream-json`, Command
 * Code's NDJSON, ACP's JSON-RPC — and a pty rewrites exactly those bytes. It
 * echoes what is written to it, it translates `\n` into `\r\n`, it wraps at the
 * pane's width, and the CLI on the other end sees a tty and turns on spinners,
 * colour and its own line editing. `capture-pane` then hands back a *picture* of
 * the output, from which the original JSON cannot be recovered. So tmux is right
 * for a terminal and wrong for a protocol, and this is what a protocol needs
 * instead.
 *
 * The mechanism is a detached process whose three streams are plain files on the
 * machine it runs on:
 *
 *  - **stdin is a fifo held open read-write** by the wrapper shell (`exec 3<>`).
 *    That is the whole trick behind "closing the tab does not kill the agent":
 *    an ordinary pipe ends when its writer goes away, and a CLI reading stdin
 *    treats that EOF as "we are finished". A fifo with a permanent reader-writer
 *    never reaches EOF, so sedano can connect, write a prompt, disconnect and
 *    come back an hour later, and the agent never notices.
 *  - **stdout and stderr are append-only log files**, which makes catching up
 *    after a restart a byte offset rather than a guess (see `DurableTail`).
 *  - **the process is its own process group** (`set -m` before the background
 *    job), reparented to init and started under `nohup`, so neither this server
 *    exiting nor an ssh channel closing takes it down — and so one `kill -pgid`
 *    later takes down the agent *and* everything it spawned.
 *
 * It is discoverable after a restart because nothing about it is held in
 * memory: the pid is in a file next to the streams, and both are named after the
 * session. `durableAlive`, `durableWrite` and `durableDestroy` all work on a
 * process this server never started, which is what stops a detached agent from
 * becoming a process nobody can find on somebody's server.
 */
export interface DurableRecord {
  /** Names the files and the pid; derived from the session id. */
  tag: string
  host: string | null
  /** The target's home directory, resolved once at launch. */
  home: string
  /** The base path of the stream files on the target: `<base>.in/.out/.err/.pid`. */
  base: string
  pid: number
  startedAt: number
}

/** Marks the launch reply: the pid it started and the home it started in. */
const DURABLE_HEAD = '__sedano_durable__'

/** Tags are file names on somebody's server, so they stay boring on purpose. */
export function durableTag(sessionId: string): string {
  return `agent-${sessionId.replace(/[^A-Za-z0-9._-]/g, '')}`
}

export interface DurableSpec {
  tag: string
  bin: string
  args: string[]
  cwd: string
  /**
   * Variables the agent must see on the machine it runs on. Only a shell
   * variable name is ever composed into the script (see `spawn`).
   */
  env?: Record<string, string>
  /**
   * The whole of stdin, for a harness that reads its prompt and then expects
   * end-of-input.
   *
   * The fifo above is exactly wrong for those. Command Code runs one process per
   * turn and reads stdin to EOF; a fifo nobody ever closes means an EOF that
   * never comes, so the CLI would sit waiting for a prompt it has already been
   * given. When this is set, stdin is an ordinary file written before the
   * process starts: the prompt is all of it, EOF arrives on its own, and the
   * process is still detached with its output in a log — which is the part
   * durability actually needs.
   */
  input?: string
}

/**
 * Run one command on the target and collect its stdout, without blocking this
 * process.
 *
 * `Transport.exec` is synchronous, and a synchronous ssh round trip on the event
 * loop is what made the server stutter under load. Everything a durable process
 * asks of its machine is a wait, so nothing is gained by holding the loop.
 */
async function runAsync(
  argv: string[],
  timeoutMs: number,
  stdin?: Uint8Array,
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  const result = await runAsyncRaw(argv, timeoutMs, stdin)
  return { ...result, stdout: Buffer.from(result.stdout).toString() }
}

/** `runAsync` with stdout as bytes, for a reader that must not split a character. */
async function runAsyncRaw(
  argv: string[],
  timeoutMs: number,
  stdin?: Uint8Array,
): Promise<{ code: number; stdout: Uint8Array; stderr: string; timedOut: boolean }> {
  let timer: ReturnType<typeof setTimeout> | null = null
  let timedOut = false
  try {
    const proc = Bun.spawn(argv, {
      stdin: stdin ? 'pipe' : 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      // Spelled out, never inherited. Bun hands a spawned process the
      // environment *this* process was started with, not the one it has now, so
      // anything set at runtime — a test pointing `CLAUDE_CONFIG_DIR` at a
      // scratch directory, a harness root chosen after boot — silently failed to
      // reach the agent. `Transport.spawn` has always passed it explicitly for
      // the same reason.
      env: { ...process.env } as Record<string, string>,
    })
    // Armed before stdin is written: a host that stops reading mid-payload
    // (megabytes of pasted image) used to hang here with no deadline at all.
    timer = setTimeout(() => {
      timedOut = true
      try {
        proc.kill()
      } catch {
        /* already gone */
      }
    }, timeoutMs)
    if (stdin) {
      try {
        const sink = proc.stdin as { write(data: Uint8Array): unknown; end(): unknown } | undefined
        sink?.write(stdin)
        await sink?.end()
      } catch {
        /* the far side went away mid-write; the exit code below says so */
      }
    }
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
    ])
    const code = await proc.exited
    return { code: code ?? 1, stdout: new Uint8Array(stdout), stderr, timedOut }
  } catch (err) {
    return { code: SSH_FAILURE, stdout: EMPTY, stderr: err instanceof Error ? err.message : String(err), timedOut }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * The argv that runs one shell script on the target, asynchronously.
 *
 * `sh -c` and deliberately not `sh -lc`: a login shell builds its own `PATH`
 * from the system profile, and the harness binary this server resolved — a
 * version manager's shim, a path a test put in front — is on *our* `PATH`, not
 * on that one. `Bun.spawn` inherited this process' environment, and a durable
 * launch has to run the same program the ordinary spawn would have.
 */
function shellArgv(host: string | null, script: string): string[] {
  return host ? ['ssh', ...SSH_OPTS, host, script] : ['sh', '-c', script]
}

/**
 * Whether we may still talk to the machine a record names.
 *
 * A host the user has since un-ticked is a host we may not connect to, not even
 * to tidy up — the allowlist is the one gate and a cleanup path is not an
 * exception to it. Deleting the session locally still succeeds; re-enabling the
 * host makes the leftover reachable, and the sweep finds it again.
 */
function durableReachable(host: string | null): boolean {
  if (!host) return true
  return isSafeHost(host) && isAuthorizedHost(host)
}

/**
 * Where a durable session's files live on the machine it runs on.
 *
 * Locally that is this process' own state directory, so a test with its own
 * `SEDANO_HOME` is genuinely hermetic. On a host it can only be that machine's
 * `$HOME`, which is why the launch script reports it back.
 */
function durableDirExpr(host: string | null): string {
  return host ? '"$HOME/.sedano/agents"' : shq(join(SEDANO_HOME, 'agents'))
}

/** The Sedano folder that durable directory lives in, on the same machine. */
function durableRootExpr(host: string | null): string {
  return host ? '"$HOME/.sedano"' : shq(SEDANO_HOME)
}

/**
 * Start a durable process and hand back everything needed to find it again.
 *
 * `fresh` truncates the logs and is the start of a new byte stream; an attach
 * never truncates, because the offsets a caller has stored are offsets into
 * these very files.
 */
export async function durableLaunch(
  host: string | null,
  spec: DurableSpec,
  opts: { fresh?: boolean; timeoutMs?: number } = {},
): Promise<DurableRecord> {
  if (host) assertAuthorizedHost(host)
  if (!SAFE_TAG.test(spec.tag)) throw new Error(`refusing unsafe process tag: ${spec.tag}`)
  const exported = Object.entries(spec.env ?? {})
    .map(([name, value]) => {
      if (!SHELL_NAME.test(name)) throw new Error(`refusing unsafe remote environment name: ${name}`)
      return `export ${name}=${shq(value)}; `
    })
    .join('')
  // The agent's argv travels as positional parameters of the wrapper, never
  // inside its single-quoted body: an argument holding a quote (a prompt flag, a
  // path with an apostrophe) would otherwise end the wrapper's own quoting and
  // the rest of it would run as the host's shell code.
  const argv = [spec.bin, ...spec.args].map(shq).join(' ')
  const oneShot = spec.input !== undefined
  const script =
    // Job control, so the background job becomes a process group of its own:
    // that is what makes one `kill -TERM -pid` later take the agent *and* the
    // children it spawned, and what keeps a signal aimed at this shell's group
    // from reaching it.
    'set -m; ' +
    `d=${durableDirExpr(host)}; ${privateMkdir('"$d"', durableRootExpr(host))} || exit 9; ` +
    `b="$d/${spec.tag}"; ` +
    // Its files are the owner's only (the prompt travels through `.in`); the
    // umask goes back before the agent starts, which must not inherit it.
    'm=$(umask); umask 077; ' +
    // A fifo cannot be reused across launches: the old one may still have the
    // previous process on the other end of it.
    'rm -f "$b.in" "$b.pid" "$b.rc"; ' +
    (oneShot ? 'cat > "$b.in" || exit 9; ' : 'mkfifo "$b.in" || exit 9; ') +
    (opts.fresh ? ': > "$b.out"; : > "$b.err"; ' : '[ -f "$b.out" ] || : > "$b.out"; [ -f "$b.err" ] || : > "$b.err"; ') +
    'umask "$m"; ' +
    `cd ${shq(spec.cwd)} || exit 8; ` +
    exported +
    // `exec 3<> "$0.in"` opens the fifo read *and* write, which is the one open
    // mode that neither blocks waiting for a peer nor ever delivers EOF. The
    // agent inherits it as stdin, so a writer coming and going is invisible to
    // it. A one-shot harness gets the file instead, and with it the EOF its
    // protocol is waiting for.
    // The wrapper deliberately does not `exec` into the agent: it waits for it
    // and writes down how it ended. Without that, a detached process that dies
    // is only ever "not there any more", and the whole of `watchExit` — a
    // conversation the CLI could not resume, a crash worth reporting, a clean
    // finish — collapses into one silent disappearance. The cost is one extra
    // shell per session; the group kill takes it with the agent either way.
    (oneShot
      ? `nohup sh -c '"$@" < "$0.in" >> "$0.out" 2>> "$0.err"; printf %s $? > "$0.rc"' "$b" ${argv} </dev/null >/dev/null 2>&1 & `
      : `nohup sh -c 'exec 3<> "$0.in"; "$@" <&3 >> "$0.out" 2>> "$0.err"; printf %s $? > "$0.rc"' "$b" ${argv} </dev/null >/dev/null 2>&1 & `) +
    // `$!` is the wrapper's pid and the wrapper is the group leader, so it is
    // both what `kill -0` asks about and what `kill -pgid` aims at — known here,
    // synchronously, with no polling for a pid file that may not exist yet.
    'p=$!; printf %s "$p" > "$b.pid"; ' +
    `printf '${DURABLE_HEAD} %s %s\\n' "$p" "$HOME"`

  const result = await runAsync(
    shellArgv(host, script),
    opts.timeoutMs ?? (host ? 20_000 : 10_000),
    oneShot ? new TextEncoder().encode(spec.input) : undefined,
  )
  const found = new RegExp(`${DURABLE_HEAD} (\\d+) (.*)`).exec(result.stdout)
  if (!found) {
    const why = result.stderr.trim() || `exited ${result.code}`
    throw new RemoteError(
      classify(host, result.code, result.stderr, false),
      host,
      `could not start a durable process: ${why}`,
      { code: result.code, stderr: result.stderr.trim() },
    )
  }
  const home = (found[2] ?? '').trim()
  const base = host ? `${home}/.sedano/agents/${spec.tag}` : join(SEDANO_HOME, 'agents', spec.tag)
  return { tag: spec.tag, host, home, base, pid: Number(found[1]), startedAt: Date.now() }
}

/**
 * Whether the process is still there — or `null` when the question could not be
 * put.
 *
 * The three answers are kept apart for the same reason the terminal driver keeps
 * them apart: a host that blipped says nothing about a process that is still
 * running on it, and reporting that as "the agent is gone" is how a session gets
 * declared dead while it is working.
 */
export async function durableAlive(record: DurableRecord): Promise<boolean | null> {
  if (!durableReachable(record.host)) return null
  const script =
    `p=$(cat ${shq(`${record.base}.pid`)} 2>/dev/null); ` +
    `if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then echo alive; else echo gone; fi`
  const result = await runAsync(shellArgv(record.host, script), record.host ? 10_000 : 5000)
  if (result.stdout.includes('alive')) return true
  if (result.stdout.includes('gone')) return false
  return null
}

/**
 * How the agent ended, or `null` while it has not.
 *
 * The wrapper writes the status down as its last act, so this is an answer that
 * survives both the agent and this server — which is the point: a session
 * reattached after a restart has to be able to say "it finished" or "it crashed
 * with code 1" about a process it never watched.
 */
export async function durableExit(record: DurableRecord): Promise<number | null> {
  if (!durableReachable(record.host)) return null
  const result = await runAsync(
    shellArgv(record.host, `cat ${shq(`${record.base}.rc`)} 2>/dev/null; exit 0`),
    record.host ? 10_000 : 5000,
  )
  const value = Number(result.stdout.trim())
  return Number.isFinite(value) && result.stdout.trim() !== '' ? value : null
}

/**
 * The tail of the agent's stderr — the only diagnostic most harnesses give when
 * they die. Bounded, because it travels over the wire and a chatty CLI can write
 * megabytes of progress there.
 */
export async function durableStderr(record: DurableRecord, maxBytes = 8000): Promise<string> {
  if (!durableReachable(record.host)) return ''
  const result = await runAsync(
    shellArgv(record.host, `tail -c ${maxBytes} ${shq(`${record.base}.err`)} 2>/dev/null; exit 0`),
    record.host ? 10_000 : 5000,
  )
  return result.stdout
}

/**
 * Hand a line to the agent's stdin.
 *
 * Through a shell with a deadline rather than by opening the fifo here: opening
 * a fifo for writing blocks until somebody is reading it, so an agent that died
 * between the liveness check and this call would otherwise hang the server for
 * good. The payload travels on stdin, never in the command line, because a
 * prompt carrying a pasted image is megabytes and `ARG_MAX` is not.
 */
export async function durableWrite(record: DurableRecord, text: string): Promise<boolean> {
  if (!durableReachable(record.host)) return false
  const script = `exec 3> ${shq(`${record.base}.in`)} || exit 7; cat >&3`
  const result = await runAsync(
    shellArgv(record.host, script),
    record.host ? 20_000 : 10_000,
    new TextEncoder().encode(text),
  )
  return result.code === 0
}

/**
 * End the process and remove every trace of it from the machine it ran on.
 *
 * The group first (`kill -TERM -pid`): an agent that spawned a shell of its own
 * leaves it behind otherwise, and those are exactly the leftovers a delete is
 * supposed to take with it. Then `KILL`, because a harness that ignores `TERM`
 * must not survive a delete, and then the files — the fifo, both logs and the
 * pid — so `~/.sedano/agents` on a server does not fill up with the remains of
 * sessions that no longer exist.
 */
export async function durableDestroy(record: DurableRecord): Promise<void> {
  if (!durableReachable(record.host)) return
  const pidFile = shq(`${record.base}.pid`)
  // The pid this record describes, never whatever the pid file says by now. A
  // session relaunched within this script's one-second grace (a settings change
  // and the next prompt, a recycle, a stop and a start) has already written its
  // *new* pid there and reuses the same stream files: reading the file killed
  // the replacement, and the unconditional `rm` deleted its fifo, its log and
  // its pid — a live agent nothing could see or reach any more. The files go
  // only while they still belong to this process.
  const pid = Number.isInteger(record.pid) && record.pid > 0 ? String(record.pid) : ''
  const script =
    `p=${pid ? shq(pid) : `$(cat ${pidFile} 2>/dev/null)`}; ` +
    'if [ -n "$p" ]; then kill -TERM -"$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null; fi; ' +
    // A moment for a clean exit, then the one signal nothing can refuse.
    'sleep 1; ' +
    'if [ -n "$p" ]; then kill -KILL -"$p" 2>/dev/null || kill -KILL "$p" 2>/dev/null; fi; ' +
    `c=$(cat ${pidFile} 2>/dev/null); ` +
    'if [ -z "$c" ] || [ "$c" = "$p" ]; then ' +
    `rm -f ${shq(`${record.base}.in`)} ${shq(`${record.base}.out`)} ${shq(`${record.base}.err`)} ${shq(`${record.base}.rc`)} ${pidFile}; ` +
    'fi; exit 0'
  await runAsync(shellArgv(record.host, script), record.host ? 20_000 : 10_000)
}

/**
 * The agent's output as a byte stream, starting exactly where the last reader
 * stopped.
 *
 * `tail -c +N -F` is the byte-oriented follow, and the byte count is the whole
 * point: the caller stored how far it had read before it went away, so what
 * comes back is precisely what was produced in the meantime — nothing replayed,
 * nothing skipped. (`-n`, the line-oriented form, cannot express "from here".)
 *
 * On a host the tail is a process on *that* machine, so it writes its own pid
 * down and is killed by name: a `tail -F` waiting for output never notices its
 * ssh channel closing, and one of those left behind per session per restart is
 * how a server ends up full of them.
 */
/**
 * Every tail that is currently following a stream, so a shutting-down server
 * can end them. A local `tail -F` does not notice its reader going away until
 * the file grows again, so each server stop used to leave one behind per
 * session, reparented to init and following a log nobody reads.
 */
const liveTails = new Set<DurableTail>()

/**
 * End every tail, for a server that is about to exit. The durable agents they
 * follow are left running on purpose — surviving a restart is their point; only
 * this server's readers go. Bounded, because the caller has a hard deadline.
 */
export async function stopAllTails(timeoutMs = 1000): Promise<void> {
  const pending = [...liveTails].map((tail) => tail.stop())
  await Promise.race([Promise.all(pending), Bun.sleep(timeoutMs)])
}

export class DurableTail {
  private proc: ReturnType<typeof Bun.spawn> | null = null
  private stopped = false
  private retry: ReturnType<typeof setTimeout> | null = null
  private attempts = 0

  constructor(
    private readonly record: DurableRecord,
    /** Where to resume from, in bytes. */
    private offsetValue: number,
    private readonly onBytes: (bytes: Uint8Array, offset: number) => void,
  ) {}

  get offset(): number {
    return this.offsetValue
  }

  private get tailTag(): string {
    return `${this.record.tag}-tail`
  }

  start(): void {
    if (this.stopped || this.proc) return
    if (!durableReachable(this.record.host)) return
    liveTails.add(this)
    const follow = `tail -c +${this.offsetValue + 1} -F ${shq(`${this.record.base}.out`)}`
    const script = this.record.host
      ? `${remotePidPrologue(this.tailTag)}exec ${follow}`
      : watchedByServer(follow)
    let proc: ReturnType<typeof Bun.spawn>
    try {
      proc = Bun.spawn(shellArgv(this.record.host, script), {
        stdout: 'pipe',
        stderr: 'ignore',
        env: { ...process.env } as Record<string, string>,
      })
    } catch {
      this.scheduleRestart()
      return
    }
    this.proc = proc
    void this.pump(proc)
    void (async () => {
      try {
        await proc.exited
      } catch {
        /* gone either way */
      }
      // A tail that ends on its own is a dropped link, not a finished agent: the
      // process is still running on the host and only the live stream was lost.
      if (this.proc === proc && !this.stopped) {
        this.proc = null
        this.scheduleRestart()
      }
    })()
  }

  private scheduleRestart(): void {
    if (this.stopped || this.retry) return
    const wait = Math.min(TAIL_RECONNECT_MAX_MS, TAIL_RECONNECT_BASE_MS * 2 ** this.attempts)
    this.attempts += 1
    this.retry = setTimeout(() => {
      this.retry = null
      if (!this.stopped && !this.proc) this.start()
    }, wait)
  }

  private async pump(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value?.byteLength) continue
        // Output arriving means the link is good again, so the next drop starts
        // its backoff from scratch rather than from where a long outage left it.
        this.attempts = 0
        this.offsetValue += value.byteLength
        this.onBytes(value, this.offsetValue)
      }
    } catch {
      /* the stream closed: the agent keeps working, only live output stops */
    }
  }

  /** Resolves once the far side has been asked to end its tail, if there is one. */
  stop(): Promise<void> {
    this.stopped = true
    liveTails.delete(this)
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    try {
      this.proc?.kill()
    } catch {
      /* ignore */
    }
    this.proc = null
    if (this.record.host) {
      // Killing the local ssh is not enough: the far `tail -F` sits waiting for
      // output and never discovers its channel is gone.
      const file = remotePidPath(this.tailTag)
      return runAsync(
        shellArgv(
          this.record.host,
          `p=$(cat ${file} 2>/dev/null); ` +
            `if [ -n "$p" ]; then kill -TERM -"$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null; fi; ` +
            `rm -f ${file}; exit 0`,
        ),
        10_000,
      ).then(() => undefined)
    }
    return Promise.resolve()
  }
}

/**
 * How long a dropped tail waits before it is dialled again, doubling per failed
 * attempt: a host that is down should not be knocked on once a second for as
 * long as a session exists, and a blip should cost a fraction of a second.
 */
const TAIL_RECONNECT_BASE_MS = 500
const TAIL_RECONNECT_MAX_MS = 15_000

/* ------------------------------------------------------------------ */
/* What this machine remembers about a durable session                 */
/* ------------------------------------------------------------------ */

/**
 * The note that lets a restarted server find an agent it started before.
 *
 * Deliberately a file on *this* machine and not a row in the database: this is
 * the only thing that has to be readable before anything else is loaded, it is
 * one small object per session, and deleting a session is then a single
 * `unlink`. It carries no secrets — a pid, a host alias, a path and a byte
 * offset — and losing it costs one orphan that the sweep below still finds.
 */
export interface DurableState extends DurableRecord {
  sessionId: string
  /** How far into the agent's stdout this server has already read. */
  outOffset: number
  /** Whether a turn was with the agent when we last looked. */
  busy: boolean
  /** The harness that owns it, so a sweep can say what it is removing. */
  harness: string
}

function durableStateDir(): string {
  return join(SEDANO_HOME, 'durable')
}

function durableStatePath(sessionId: string): string {
  return join(durableStateDir(), `${sessionId.replace(/[^A-Za-z0-9._-]/g, '')}.json`)
}

export function readDurableState(sessionId: string): DurableState | null {
  try {
    const text = readFileSync(durableStatePath(sessionId), 'utf8')
    const value = JSON.parse(text) as DurableState
    // A record without a base or a pid names nothing we could kill, so it is
    // worse than no record at all: it would have the manager believe a session
    // is recoverable when there is nothing to recover.
    if (!value || typeof value.base !== 'string' || typeof value.pid !== 'number') return null
    return value
  } catch {
    return null
  }
}

export function writeDurableState(state: DurableState): void {
  try {
    mkdirSync(durableStateDir(), { recursive: true, mode: 0o700 })
    writeFileSync(durableStatePath(state.sessionId), JSON.stringify(state))
  } catch {
    /* a state we could not write is one orphan the sweep will find */
  }
}

export function clearDurableState(sessionId: string): void {
  try {
    rmSync(durableStatePath(sessionId), { force: true })
  } catch {
    /* ignore */
  }
}

/** Every durable session this machine knows about, live or not. */
export function listDurableStates(): DurableState[] {
  try {
    return readdirSync(durableStateDir())
      .filter((name) => name.endsWith('.json'))
      .map((name) => readDurableState(name.slice(0, -'.json'.length)))
      .filter((value): value is DurableState => value !== null)
  } catch {
    return []
  }
}

type BytesResult = { code: number; stdout: Uint8Array; stderr: string | Uint8Array; error?: RemoteError }

/**
 * The most one poll hands over. A transcript first read over ssh can be tens of
 * megabytes, and an uncapped read moved all of it through one ssh call and one
 * buffer before a single line was shown — or timed out and made no progress at
 * all, forever. The caller simply polls again for the rest.
 */
const POLL_MAX_BYTES = 4 * 1024 * 1024

/** One script that measures, announces how many bytes follow, and sends them. */
function pollScript(path: string, offset: number, maxBytes: number): string {
  const cap = Number.isFinite(maxBytes) ? `if [ $((n)) -gt ${Math.floor(maxBytes)} ]; then n=${Math.floor(maxBytes)}; fi; ` : ''
  return (
    `f=${shq(path)}; [ -f "$f" ] || exit 3; s=$(wc -c < "$f") || exit 4; ` +
    `if [ $((s)) -le ${offset} ]; then printf '${POLL_HEAD} %s %s\\n' $((s)) 0; exit 0; fi; ` +
    `n=$((s-${offset})); ${cap}printf '${POLL_HEAD} %s %s\\n' $((s)) "$n"; ` +
    `tail -c +${offset + 1} -- "$f" | head -c "$n"`
  )
}

/**
 * A portable listing that also classifies (test -d follows symlinks, as the
 * local branch does). `.[!.]*` picks up dotfiles without `.`/`..`. The trailing
 * `exit 0` keeps an empty directory from looking like a failure; a bad path
 * still exits early, so the error survives.
 */
const LIST_DIR_SCRIPT = (path: string): string =>
  `cd ${shq(path)} || exit 1; ` +
  'for f in * .[!.]*; do [ -e "$f" ] || continue; ' +
  'if [ -d "$f" ]; then echo "d:$f"; else echo "f:$f"; fi; done; exit 0'

function parseListing(stdout: string): DirItem[] {
  const items: DirItem[] = []
  for (const line of stdout.split('\n')) {
    if (line.length < 2) continue
    const name = line.slice(2)
    if (!name) continue
    items.push({ name, dir: line[0] === 'd', hidden: name.startsWith('.') })
  }
  return items
}

function localWhichAll(bins: string[]): Map<string, string | null> {
  const found = new Map<string, string | null>()
  for (const bin of bins) found.set(bin, localWhich(bin))
  return found
}

/** One remote script that resolves every binary and ends with a marker. */
function whichAllCommand(bins: string[]): string {
  const probe = bins
    .map((bin) => `printf '%s=%s\n' ${shq(bin)} "$(command -v ${shq(bin)} 2>/dev/null || true)"`)
    .join('; ')
  return `${remoteDiscoveryPathPrelude()}${probe}; echo ${PROBE_END}; exit 0`
}

function parseWhichAll(host: string, bins: string[], result: ExecResult): Map<string, string | null> {
  const found = new Map<string, string | null>()
  const end = result.stdout.indexOf(PROBE_END)
  // Half an answer is not an answer: a dropped connection must not be read as
  // "that CLI is not installed" — which is the whole point of the marker.
  if (end < 0) {
    const why = result.error?.reason ?? result.stderr.trim() ?? `ssh exited ${result.code}`
    throw new RemoteError(result.error?.kind ?? 'command_failed', host, `could not list installed tools: ${why}`, {
      code: result.code,
      stderr: result.stderr.trim(),
    })
  }
  for (const line of result.stdout.slice(0, end).split('\n')) {
    const at = line.indexOf('=')
    if (at <= 0) continue
    const bin = line.slice(0, at)
    const path = line.slice(at + 1).trim()
    if (bins.includes(bin)) found.set(bin, path || null)
  }
  for (const bin of bins) if (!found.has(bin)) found.set(bin, null)
  return found
}

/** A poll that did not happen: no progress, no truncation, and a reason. */
function failedPoll(offset: number, error: RemoteError): PollResult {
  return { size: offset, bytes: EMPTY, next: offset, error }
}

const EMPTY = new Uint8Array(0)

/** Last line of a probe reply: its absence means the probe did not finish. */
const PROBE_END = '__sedano_probe_end__'

/** First line of a poll reply: the size measured and the byte count that follows. */
const POLL_HEAD = '__sedano_poll__'

/**
 * How long a retry waits, multiplied by the attempt. Long enough for a ssh
 * control socket to be torn down and rebuilt, short enough that a picker still
 * feels like it answered.
 */
const RETRY_DELAY_MS = 200

/** A child killed at the deadline may be reaped a few ms early; still a timeout. */
const TIMEOUT_SLACK_MS = 50
