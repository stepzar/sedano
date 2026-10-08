import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { EffortLevel, PermissionMode, SessionStatus } from '@shared'
import type { CreateOptions, Driver, DriverHooks, SendResult, TerminalScreen } from '../types.ts'
import { SEDANO_HOME } from '../../paths.ts'
import { SSH_OPTS, assertSafeHost, privateMkdir, remotePidPath, remotePidPrologue, shq, watchedByServer } from '../../transport.ts'
import { isAuthorizedHost } from '../../hosts.ts'
import { findBinary, getPreset, tmuxName } from './presets.ts'

/**
 * A terminal tab: one tmux session on the target machine.
 *
 * There is no PTY in this process. tmux is the terminal: it owns the shell, its
 * size and its scrollback, which is exactly what makes a tab survive the app
 * closing. We talk to it over its own CLI — `send-keys` for input, `pipe-pane`
 * into a log file for output, `capture-pane` for the current screen — so the
 * protocol is stable, scriptable and identical locally and over SSH.
 *
 * (Bun's `terminal: true` spawn was tried first and delivers no output at all
 * on Bun 1.2.2/macOS, which is why this design exists.)
 */
const LOG_DIR = join(SEDANO_HOME, 'panes')

/**
 * How long a keystroke may wait for company before it is sent on its own.
 *
 * Only the fallback path uses it: a keystroke should not cost a process spawn
 * (or an SSH round trip) when a few more characters are a moment away, and a
 * keystroke should not wait longer than this when they are not.
 */
const COALESCE_MS = 25

/**
 * How far into the scrollback an attach reaches, in lines. The pane keeps 20000;
 * a replay is a screenful of text per line, so this is the part that is worth a
 * round trip without being a file transfer.
 */
const SCROLLBACK_LINES = 1000

/**
 * How long a dropped output stream or keystroke channel waits before it is
 * dialled again, doubling per failed attempt up to the cap: a host that is down
 * should not be knocked on once a second for as long as a tab is open, and a
 * blip should cost a fraction of a second.
 */
const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 15_000

/** Marks the first line the tail's script prints: the offset it started from. */
const TAIL_OFFSET = '__sedano_tail_offset__'

/** Marks where a captured screen stops and the rest of the reply starts. */
const SCREEN_END = '__sedano_screen_end__'

/**
 * How many times a capture is retaken when the pane wrote something while it was
 * being taken (see `snapshot`).
 *
 * Three, because the window being closed is the gap between two commands in one
 * shell — microseconds — so a pane has to be printing continuously to lose twice
 * in a row, and a tab that is printing continuously is repainting itself anyway.
 */
const SNAPSHOT_TRIES = 3

type Proc = ReturnType<typeof Bun.spawn>

/** The writable end of a spawned process' stdin, as Bun hands it over. */
type WriteSink = { write(data: string): number | void; flush(): number | Promise<number> | void }

/**
 * Run a tmux command and collect its stdout.
 *
 * Asynchronous on purpose: a synchronous spawn here blocks the whole server —
 * and on a host it blocks it for a network round trip, which is exactly what
 * made the process crash under load. Everything the driver does is a wait, so
 * nothing is gained by holding the loop.
 */
async function run(args: string[], opts: { timeoutMs?: number } = {}): Promise<string> {
  try {
    const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'ignore' })
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        /* already gone */
      }
    }, opts.timeoutMs ?? 4000)
    const text = await new Response(proc.stdout).text()
    await proc.exited
    clearTimeout(timer)
    return text
  } catch {
    return ''
  }
}

/** The same, keeping the exit code and stderr — for the one call that reports. */
async function runFull(args: string[], timeoutMs = 8000): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        /* already gone */
      }
    }, timeoutMs)
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const code = await proc.exited
    clearTimeout(timer)
    return { code: code ?? 1, stdout, stderr }
  } catch {
    return { code: 1, stdout: '', stderr: '' }
  }
}

/**
 * Kill the tmux session behind a terminal tab, whether or not this process ever
 * attached to it. A restored session has no driver until you look at it, so
 * deleting it used to leave its shell running on the host with nothing pointing
 * at it — and those leftovers are what fill `tmux ls` over time.
 */
export async function killTerminalSession(sessionId: string, host: string | null): Promise<void> {
  if (host) assertSafeHost(host)
  // A host you have since un-ticked is a host we may not connect to, not even to
  // tidy up: deleting the session locally still succeeds, and re-enabling the
  // host makes the leftover reachable again.
  if (host && !isAuthorizedHost(host)) return
  const name = tmuxName(sessionId)
  const command = host
    ? ['ssh', ...SSH_OPTS, host, 'tmux', 'kill-session', '-t', name]
    : ['tmux', 'kill-session', '-t', name]
  try {
    const proc = Bun.spawn(command, { stdout: 'ignore', stderr: 'ignore' })
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        /* already gone */
      }
    }, 4000)
    await proc.exited
    clearTimeout(timer)
  } catch {
    /* nothing to kill */
  }
}

export class TerminalDriver implements Driver {
  alive = true

  private tail: Proc | null = null
  /** Bytes of the pane's output stream delivered so far (see `write`). */
  private logOffset = 0
  private decoder = new TextDecoder('utf-8')
  private cols = 100
  private rows = 30
  private stopped = false
  /** Keystrokes waiting for the fallback path to be free (see `write`). */
  private queue: string[] = []
  private coalesce: ReturnType<typeof setTimeout> | null = null
  /** True while a batch of the fallback path is in flight — at most one is. */
  private flushing = false
  /**
   * The long-lived ssh channel keystrokes of a remote tab go out on, or null
   * while there is none and the per-batch ssh path carries them (see
   * `startChannel`). Never used locally, where a spawn is already ~5ms.
   */
  private channel: Proc | null = null
  private check: ReturnType<typeof setInterval> | null = null
  /** Pending reconnects, and how many have been tried in a row (see below). */
  private tailRetry: ReturnType<typeof setTimeout> | null = null
  private channelRetry: ReturnType<typeof setTimeout> | null = null
  private tailAttempts = 0
  private channelAttempts = 0

  constructor(
    private readonly opts: CreateOptions,
    private readonly hooks: DriverHooks,
    private readonly presetId: string | null,
  ) {
    if (opts.host) assertSafeHost(opts.host)
  }

  get name(): string {
    return tmuxName(this.opts.sessionId)
  }

  /** Names the host knows this tab's long-lived processes by (see transport). */
  private get tailTag(): string {
    return `${this.name}-tail`
  }

  private get channelTag(): string {
    return `${this.name}-chan`
  }

  /** The pane log on *this* machine, for the work only a local file needs. */
  private get localLogPath(): string {
    return join(LOG_DIR, `${this.name}.log`)
  }

  /**
   * The pane log path as the machine that runs tmux sees it, ready to be dropped
   * into one of *its* shell commands.
   *
   * `pipe-pane` writes that log on the host and the `tail` that streams it runs
   * there too, so a path from this computer means a file that does not exist on
   * the host (`/Users/…` on a Linux box): `cat >>` exits immediately, tmux drops
   * the pipe (`pane_pipe` back to 0), and the tab shows nothing until you reattach
   * and the screen is captured — which is exactly what "it only appears when I
   * leave and come back" was. On a host the path is therefore `$HOME`, which that
   * machine's own shell expands; locally it is the real path, quoted for tmux.
   */
  private paneLog(): string {
    return this.opts.host ? `"$HOME/.sedano/panes/${this.name}.log"` : shq(this.localLogPath)
  }

  /**
   * The `pipe-pane` command, handed over as one argument (`remoteArgv` quotes
   * it).
   *
   * `tee -a`, not `cat >>`. Both look like they do the same thing and only one
   * of them does: on a host running uutils coreutils (Ubuntu 26.04, verified on
   * a remote VPS) a pane piped through `cat >> file` writes the first few bytes and
   * then *stops* — 2 bytes after 5000 keys, nothing until the pipe is closed.
   * `tee -a` streams every chunk as it arrives there, and on GNU coreutils and
   * BSD/macOS alike, which is why the tab looked dead on servers and fine
   * locally. It also keeps the redirect out of the command line entirely: a `>>`
   * in a pipe command set over ssh is re-parsed by the host's shell and lands on
   * tmux instead of on the file.
   *
   * `$HOME` stays in double quotes on purpose: tmux runs this command with the
   * *host's* shell, which is the machine whose home directory we want.
   */
  private pipeCommand(): string {
    return `tee -a ${this.paneLog()}`
  }

  /**
   * Make room for a tab's log on the host.
   *
   * The directory has to exist *before* `pipe-pane` starts — that is the whole
   * failure above — and the same retention as the local one keeps a shell that
   * prints all day from filling the server's disk.
   */
  private async prepareHostLogs(): Promise<void> {
    await run(this.remoteShell(privateMkdir('"$HOME/.sedano/panes"', '"$HOME/.sedano"')), { timeoutMs: 8000 })
    await run(
      this.remoteShell('ls -1t "$HOME/.sedano/panes"/* 2>/dev/null | tail -n +41 | xargs -r rm -f --'),
      { timeoutMs: 8000 },
    )
  }

  /**
   * A shell script for the target machine: one-liners, pipes and `$HOME` intact.
   *
   * ssh joins its arguments with spaces and the far shell parses the result,
   * which is exactly right for a snippet of shell and exactly wrong for a
   * program with arguments — see `remoteArgv`.
   */
  private remoteShell(script: string): string[] {
    return this.opts.host ? ['ssh', ...SSH_OPTS, this.opts.host, script] : ['sh', '-c', script]
  }

  /**
   * A command whose arguments must arrive exactly as they were given.
   *
   * Every argument is quoted, because of that same join-then-parse: `send-keys
   * -l "echo hi"` reaches the host as *two* arguments and tmux sends `echohi` —
   * a space typed over SSH was silently deleted — and a keystroke batch holding
   * `$`, `;` or a backtick was evaluated by the host's login shell before tmux
   * ever saw it. Quoting keeps the command as the command and its arguments as
   * data, on the machine that is running them.
   */
  private remoteArgv(args: string[]): string[] {
    return this.opts.host ? ['ssh', ...SSH_OPTS, this.opts.host, ...args.map(shq)] : args
  }

  private innerCommand(): string[] {
    const preset = getPreset(this.presetId)
    if (!preset.bin) return []
    const bin = findBinary(preset.bin)
    return bin ? [bin, ...preset.args] : []
  }

  /* ---------------- lifecycle ---------------- */

  async start(): Promise<void> {
    this.hooks.status('starting')
    if (!findBinary('tmux')) throw new Error('tmux not found: terminal tabs need tmux (brew install tmux)')

    if (this.opts.host) await this.prepareHostLogs()
    else {
      mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 })
      this.pruneLogs()
    }

    // A question that could not be put (`null`) is treated as "not there" here on
    // purpose: the attempt to create the session is what turns an unreachable host
    // into an error the user can read, instead of a tab that sits silent.
    const createdFresh = (await this.hasSession()) !== true
    if (createdFresh) {
      // `-d` never attaches, so tmux does not need a controlling terminal.
      const created = await runFull(
        this.remoteArgv(['tmux', 'new-session', '-d', '-s', this.name, '-c', this.opts.cwd, ...this.innerCommand()]),
      )
      if (created.code !== 0) {
        const detail = created.stderr.trim()
        throw new Error(`could not start tmux session: ${detail || created.code}`)
      }
      await run(this.remoteArgv(['tmux', 'set-option', '-t', this.name, 'history-limit', '20000']))
      // A brand new session has no size of its own, so it takes ours; the client
      // corrects it a moment later.
      await run(this.remoteArgv(['tmux', 'resize-window', '-t', this.name, '-x', String(this.cols), '-y', String(this.rows)]))
    } else {
      // An existing session keeps the size its terminal already had. Resizing it
      // to this driver's *defaults* on every attach is what shrank a pane that
      // was already correct: a taller terminal then replayed a screen measured
      // for 100×30 and the cursor came to rest in the middle of nothing.
      const current = (
        await run(this.remoteArgv(['tmux', 'display', '-t', this.name, '-p', '#{window_width}x#{window_height}']), {
          timeoutMs: 4000,
        })
      ).trim()
      const [cols, rows] = current.split('x').map((value) => Number.parseInt(value, 10))
      if (Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0) {
        this.cols = cols
        this.rows = rows
      }
    }

    // Every pane write is appended to a log we tail, with escapes intact.
    // The log is discarded only for a session we just created. Truncating it on
    // every reattach cuts the shell's output stream wherever it happens to be —
    // often in the middle of an escape sequence — and the client then applies a
    // fragment like "[?2004h" as text: the cursor lands somewhere else and every
    // line after it is drawn in the wrong column. The tail reads from the end of
    // the file (`-n 0`), so old bytes are never replayed and there is nothing to
    // gain by cutting them away.
    if (!this.opts.host && createdFresh) {
      try {
        rmSync(this.localLogPath, { force: true })
        await run(['sh', '-c', `: > ${shq(this.localLogPath)}`])
      } catch {
        /* ignore */
      }
    }
    // Own the pipe rather than asking tmux not to replace one. A stale pipe from
    // a previous run of the server still counts as "already piping", so `-o`
    // would leave it in place — writing into an inode we just truncated — and the
    // tab would sit blank with no output ever arriving. Clearing it first costs
    // one tmux call and removes that whole class of failure.
    await run(this.remoteArgv(['tmux', 'pipe-pane', '-t', this.name]))
    await run(this.remoteArgv(['tmux', 'pipe-pane', '-t', this.name, this.pipeCommand()]))

    this.startTail()
    this.startChannel()
    this.alive = true
    this.hooks.status('running')
    this.hooks.resumeHint(
      this.opts.host ? `ssh -t ${this.opts.host} tmux attach -t ${this.name}` : `tmux attach -t ${this.name}`,
    )
    this.hooks.event({
      k: 'system',
      subtype: 'terminal-attach',
      text: `tmux ${this.name} · ${this.opts.cwd}${this.opts.host ? ` · ${this.opts.host}` : ''}`,
    })

    // Cheap liveness: if the session is gone (user typed `exit`), say so once.
    this.check = setInterval(() => void this.checkAlive(), 4000)
  }

  /** Says the shell is gone, once, and stops watching. */
  private async checkAlive(): Promise<void> {
    if (this.stopped) return
    const present = await this.hasSession()
    // `null` is "could not ask", which is not an answer and must never be read as
    // one: a host that is unreachable for a moment — a laptop that changed
    // network, a link that blipped — would otherwise be announced as "the shell
    // exited", and this watcher would stop and take the output stream with it. The
    // pane is still there and the tab has to come back when the link does, so an
    // unanswered question is simply asked again on the next tick.
    if (present !== false) return
    this.alive = false
    if (this.check) clearInterval(this.check)
    this.check = null
    this.stopTail()
    this.hooks.status('stopped')
    this.hooks.event({
      k: 'system',
      subtype: 'terminal-exit',
      text: 'the shell exited — open a new terminal tab, or type in this one to start over',
    })
  }

  /**
   * Whether the pane is there — or `null` when the question could not be put.
   *
   * tmux answers 0 for "yes" and 1 for "no". An ssh that never reached the host
   * answers 255, and that is a third thing: it says nothing about the pane, which
   * is still running on a machine we cannot see right now. Folding it into "no"
   * is what turned a blip into "the shell exited — open a new terminal tab".
   */
  private async hasSession(): Promise<boolean | null> {
    const { code } = await runFull(this.remoteArgv(['tmux', 'has-session', '-t', this.name]), 4000)
    if (code === 0) return true
    // 255 is the ssh client's own "I could not connect", and it is the only code
    // it reserves for itself; tmux never exits with it.
    if (this.opts.host && code === 255) return null
    return false
  }

  /** Keep the pane log directory small; entries are per tab and per restart. */
  private pruneLogs(): void {
    try {
      const files = readdirSync(LOG_DIR)
        .map((name) => ({ name, at: statSync(join(LOG_DIR, name)).mtimeMs }))
        .sort((a, b) => b.at - a.at)
      for (const file of files.slice(40)) rmSync(join(LOG_DIR, file.name), { force: true })
    } catch {
      /* ignore */
    }
  }

  /**
   * The pane log, read as a stream of *bytes*: `tail -c +N -F`.
   *
   * It used to be `tail -n 0 -F`, and that was the whole "I can't type" bug: a
   * line-oriented `tail` emits complete **lines**, and a terminal produces none
   * of the interesting ones — a keystroke echo, a cursor move, a TUI screen all
   * arrive without a trailing newline. They sat in tail's buffer until the next
   * newline, so the pane looked dead while you typed and filled in the moment
   * you pressed Enter (or the app re-captured the screen when you left the tab
   * and came back). `-c +N` is the byte-oriented follow: whatever is appended is
   * passed on as it is appended.
   *
   * N is the file's size when we start, because `-n 0` has no byte equivalent and
   * we want none of what is already there: the log is a live channel, and the
   * screen you see when you open a tab comes from `capture-pane`, not from a
   * replay of old bytes. Measuring first also closes the gap between "the pipe is
   * attached" and "we are reading it": anything written in between is *before*
   * our offset, so it is neither lost nor duplicated — the snapshot has it.
   *
   * The script prints that number before it execs `tail`, so the driver knows
   * where the stream starts and can count from there: every chunk goes out tagged
   * with the offset it ends at, which is what lets a client tell whether a
   * replayed screen is behind what it has already drawn. Nothing about *when* the
   * measurement happens changes — the same `wc -c`, the same tail, microseconds
   * apart — because moving it out of this script is what once left terminals
   * blank (the shell's first prompt fell into the gap).
   */
  private startTail(): void {
    if (this.stopped) return
    // On a host the path belongs to that machine's shell (`$HOME` there is not
    // this user's), so the whole thing travels as one script; locally the same
    // script runs in a shell here. `paneLog()` is already quoted for whichever
    // machine it names.
    //
    // On a host the script writes its own pid down first: a `tail -F` does not
    // necessarily notice its ssh channel closing, and one left running per tab
    // per restart is what fills a server with orphan tails. `stopTail` kills it
    // by name (see `remotePidPrologue`).
    //
    // Locally the tail is not exec'd but watched. A `tail -F` only dies when it
    // writes into a closed pipe, so a server that exits without stopping it — a
    // crash, a SIGKILL, a test harness tearing down — left one per tab behind,
    // re-opening its file forever (`-F` retries even once the file is deleted).
    // The wrapper polls its parent, this server, and takes the tail down when it
    // is gone; the trap does the same for an ordinary stop, and `wait` is what
    // lets that trap run at once instead of after the sleep. (On a host the
    // parent is a shared ssh connection that outlives the channel, so there the
    // pid file and `cleanupRemoteProc` remain the mechanism.)
    const follow = this.opts.host
      ? 'exec tail -c +$((s+1)) -F "$f"'
      : watchedByServer('tail -c +$((s+1)) -F "$f"')
    const script =
      (this.opts.host ? remotePidPrologue(this.tailTag) : '') +
      `f=${this.paneLog()}; s=$(wc -c < "$f" 2>/dev/null || echo 0); ` +
      `printf '${TAIL_OFFSET} %s\\n' "$s"; ${follow}`
    const proc = Bun.spawn(this.remoteShell(script), { stdout: 'pipe', stderr: 'ignore' })
    this.tail = proc
    void this.pump(proc)
    void (async () => {
      try {
        await proc.exited
      } catch {
        /* gone either way */
      }
      // A tail that ends on its own is a dropped link, not a finished tab: the
      // pane is still alive on the host and the only thing lost is the live
      // stream. Reconnecting is the difference between "the tab went quiet" and
      // "the tab recovered when the network came back".
      if (this.tail === proc && !this.stopped) {
        this.tail = null
        this.scheduleTailRestart()
      }
    })()
  }

  /**
   * Bring the output stream back after a drop, with a widening delay so a host
   * that is simply down is not hammered once a second for as long as the tab is
   * open. The delay resets as soon as a stream lasts (see `pump`).
   */
  private scheduleTailRestart(): void {
    if (this.stopped || this.tailRetry) return
    const wait = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.tailAttempts)
    this.tailAttempts += 1
    this.tailRetry = setTimeout(() => {
      this.tailRetry = null
      if (!this.stopped && !this.tail) this.startTail()
    }, wait)
  }

  /**
   * The pane log as a stream, with the offset it starts from read off the front.
   *
   * The script's first line is where the tail began, so the driver can count from
   * there; everything else that comes down the pipe is pane output and goes out
   * with the offset it ends at (see `startTail`).
   */
  private async pump(proc: Proc): Promise<void> {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
    try {
      let head = new Uint8Array(0)
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        if (!value) continue
        head = Buffer.concat([head, value])
        const newline = head.indexOf(0x0a)
        if (newline < 0) {
          // Not a whole line yet, and a first line this long is not ours.
          if (head.length <= 128) continue
        } else {
          const line = new TextDecoder().decode(head.subarray(0, newline))
          const found = new RegExp(`^${TAIL_OFFSET} (\\d+)$`).exec(line)
          if (found) this.logOffset = Number(found[1])
          head = head.subarray(newline + 1)
        }
        break
      }
      if (head.length && !this.stopped) this.emitOutput(head)
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        // A tail that has been replaced or stopped can still be draining its
        // pipe; its bytes would be counted against the new stream's offsets.
        if (this.stopped || (this.tail && this.tail !== proc)) break
        this.emitOutput(value)
      }
    } catch {
      /* the stream closed: the tab keeps working, only live output stops */
    }
  }

  /** One chunk of pane output, counted in bytes against the log's offsets. */
  private emitOutput(bytes: Uint8Array): void {
    // Output arriving means the link is good again, so the next drop starts its
    // backoff from scratch instead of from where a long outage left it.
    this.tailAttempts = 0
    this.logOffset += bytes.byteLength
    const text = this.decoder.decode(bytes, { stream: true })
    if (text) this.hooks.terminal(text, this.logOffset)
  }

  private stopTail(): void {
    if (this.tailRetry) clearTimeout(this.tailRetry)
    this.tailRetry = null
    try {
      this.tail?.kill()
    } catch {
      /* ignore */
    }
    this.tail = null
    if (this.opts.host) this.cleanupRemoteProc(this.tailTag)
  }

  /**
   * Kill a tagged process on the host and forget its pid file.
   *
   * Killing the local `ssh` is not enough and never was: the far side keeps
   * running until it happens to write into a closed pipe, which a `tail -F`
   * waiting for output never does. This is the explicit half of that contract.
   */
  private cleanupRemoteProc(tag: string): void {
    if (!this.opts.host) return
    const file = remotePidPath(tag)
    void run(
      this.remoteShell(
        `p=$(cat ${file} 2>/dev/null); ` +
          `if [ -n "$p" ]; then kill -TERM -"$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null; fi; ` +
          `rm -f ${file}; exit 0`,
      ),
      { timeoutMs: 6000 },
    )
  }

  /* ---------------- io ---------------- */

  private keyName(data: string): string | null {
    switch (data) {
      case '\r':
      case '\n':
        return 'Enter'
      case '\x7f':
        return 'BSpace'
      case '\t':
        return 'Tab'
      case '\x03':
        return 'C-c'
      case '\x04':
        return 'C-d'
      case '\x1b':
        return 'Escape'
      case '\x1b[A':
        return 'Up'
      case '\x1b[B':
        return 'Down'
      case '\x1b[C':
        return 'Right'
      case '\x1b[D':
        return 'Left'
      case '\x1b[H':
        return 'Home'
      case '\x1b[F':
        return 'End'
      case '\x1b[3~':
        return 'DC'
      case '\x15':
        return 'C-u'
      case '\x0c':
        return 'C-l'
      default:
        return null
    }
  }

  /**
   * Keystrokes become tmux commands.
   *
   * A remote tab sends them down the long-lived channel, one write per tmux
   * call, the moment they are typed. When there is no channel — the local tabs,
   * which have nothing to save, and a remote one whose channel is not up yet or
   * has died — they are coalesced for a few milliseconds instead, because a
   * keystroke should not cost a process spawn (or an SSH round trip).
   */
  write(data: string): void {
    if (this.sendThroughChannel(data)) return
    this.queue.push(data)
    if (this.flushing || this.coalesce) return
    this.coalesce = setTimeout(() => {
      this.coalesce = null
      void this.flushQueue()
    }, COALESCE_MS)
  }

  /**
   * One batch at a time, and everything typed while that one is in flight waits
   * in the queue to be *joined* into the next — not to be sent as one more batch
   * behind it.
   *
   * That distinction is the whole difference between a laggy tab and a broken
   * one. Every batch here costs a full round trip (~170ms to a remote VPS, measured),
   * so a queue of them costs a round trip each: type ten characters faster than
   * the link answers and the tenth is a second and a half behind the cursor,
   * which grows for as long as you keep typing. With one batch in flight the
   * lag can never exceed the link plus a coalescing window, and typing faster
   * simply means bigger batches.
   */
  private async flushQueue(): Promise<void> {
    if (this.flushing) return
    this.flushing = true
    try {
      while (this.queue.length) {
        const batch = this.queue.join('')
        this.queue = []
        // In order: keystrokes must reach the shell in the order they were typed.
        for (const argv of this.keyCommands(batch)) await run(this.remoteArgv(argv))
      }
    } finally {
      this.flushing = false
    }
  }

  /**
   * One long-lived ssh channel carries every keystroke of a remote tab.
   *
   * A `tmux send-keys` of its own per batch costs a full round trip even over a
   * multiplexed connection: the client opens a channel and waits for the command
   * to finish, so what you type is serialized behind the link and the tab feels
   * like it is typing behind you (~150-250ms to a VPS, and worse in bursts). Here
   * ssh is opened once and left running, so a keystroke is a write on a socket
   * that already exists: it leaves immediately and nothing waits for a reply. One
   * stream is also one order, for free — no two `send-keys` ever race, which is
   * what used to arrive as your own sentence scrambled.
   *
   * The far side reads one base64 line per tmux invocation and runs it through a
   * shell, so the payload — a pasted block, an escape sequence, `$`, quotes —
   * never has to survive a second round of quoting on its way there.
   */
  private startChannel(): void {
    if (!this.opts.host || this.stopped) return
    const script =
      remotePidPrologue(this.channelTag) +
      'while IFS= read -r line; do printf %s "$line" | base64 -d | sh; done'
    try {
      const proc = Bun.spawn(['ssh', ...SSH_OPTS, '-T', this.opts.host, script], {
        stdin: 'pipe',
        stdout: 'ignore',
        stderr: 'ignore',
      })
      this.channel = proc
      void (async () => {
        try {
          await proc.exited
        } catch {
          /* killed, or gone: the same answer either way */
        }
        // A channel that dies (the host rebooted, the laptop changed network) is
        // not fatal: `write` falls back to one ssh per batch until it is back,
        // and typing keeps working throughout. It *is* worth bringing back, on a
        // widening delay — a tab left open all afternoon should be fast again
        // once the link is, not slow until it is reopened.
        if (this.channel === proc) {
          this.channel = null
          this.scheduleChannelRestart()
        }
      })()
    } catch {
      this.channel = null
      this.scheduleChannelRestart()
    }
  }

  private scheduleChannelRestart(): void {
    if (this.stopped || this.channelRetry) return
    const wait = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.channelAttempts)
    this.channelAttempts += 1
    this.channelRetry = setTimeout(() => {
      this.channelRetry = null
      if (!this.stopped && !this.channel) this.startChannel()
    }, wait)
  }

  private stopChannel(): void {
    if (this.channelRetry) clearTimeout(this.channelRetry)
    this.channelRetry = null
    const proc = this.channel
    this.channel = null
    if (this.opts.host) this.cleanupRemoteProc(this.channelTag)
    if (!proc) return
    // Closing stdin ends the remote loop, and killing the client takes the
    // channel with it. Nothing of the shell lives here: it is all in tmux.
    try {
      const stdin = proc.stdin as unknown as { end(): void } | number
      if (typeof stdin !== 'number') stdin.end()
    } catch {
      /* already gone */
    }
    try {
      proc.kill()
    } catch {
      /* already gone */
    }
  }

  private sink(): WriteSink | null {
    const stdin = this.channel?.stdin as unknown as WriteSink | number | undefined
    if (!stdin || typeof stdin === 'number') return null
    return typeof stdin.write === 'function' ? stdin : null
  }

  /** False when there is no channel to take it, and the fallback must. */
  private sendThroughChannel(data: string): boolean {
    const sink = this.sink()
    if (!sink) return false
    let written = 0
    try {
      for (const argv of this.keyCommands(data)) {
        sink.write(`${Buffer.from(argv.map(shq).join(' '), 'utf8').toString('base64')}\n`)
        written += 1
      }
      void sink.flush()
      return true
    } catch {
      // The channel went away mid-write. A line that was already handed to the
      // socket is gone with it, so re-sending the batch through the fallback
      // would type part of it twice; a batch that never got out is worth
      // re-sending whole.
      this.stopChannel()
      this.scheduleChannelRestart()
      return written > 0
    }
  }

  /**
   * The keystrokes as tmux argv, in the order they were typed: literal runs
   * (`-l`, so quotes and globs are safe), named keys, and hex for the control
   * characters tmux has no name for. One array per tmux invocation.
   */
  private keyCommands(data: string): string[][] {
    const commands: string[][] = []
    const literal: string[] = []
    const flushLiteral = () => {
      if (!literal.length) return
      const text = literal.join('')
      literal.length = 0
      commands.push(['tmux', 'send-keys', '-t', this.name, '-l', text])
    }

    for (let index = 0; index < data.length; index += 1) {
      const rest = data.slice(index)
      const escape = /^\x1b\[[0-9;]*[A-Za-z~]/.exec(rest)?.[0]
      const candidate = escape ?? data[index]!
      const key = this.keyName(candidate)
      if (key) {
        flushLiteral()
        commands.push(['tmux', 'send-keys', '-t', this.name, key])
        index += candidate.length - 1
        continue
      }
      if (candidate.length === 1 && candidate.charCodeAt(0) < 32) {
        flushLiteral()
        commands.push(['tmux', 'send-keys', '-t', this.name, '-H', candidate.charCodeAt(0).toString(16)])
        continue
      }
      literal.push(candidate)
    }
    flushLiteral()
    return commands
  }

  /**
   * Resize the pane — but only when the size really changes. A resize interrupts
   * the shell, which redraws its prompt line, so a stream of identical requests
   * (the client sends one on mount, the manager re-applies the remembered one on
   * attach, the snapshot applies it again) painted a column of prompts down the
   * pane. tmux would ignore the repeats anyway; not sending them is cheaper and
   * leaves the screen alone.
   */
  resize(cols: number, rows: number): void {
    const nextCols = Math.max(20, cols)
    const nextRows = Math.max(5, rows)
    if (nextCols === this.cols && nextRows === this.rows) return
    this.cols = nextCols
    this.rows = nextRows
    void run(this.remoteArgv(['tmux', 'resize-window', '-t', this.name, '-x', String(this.cols), '-y', String(this.rows)]))
  }

  /**
   * The screen as it is right now, escapes included, for a client that just
   * attached.
   *
   * Deliberately the *visible* pane and not `-S -3000`: replaying the scrollback
   * into a fresh terminal stacked every prompt the shell had ever printed into
   * one growing ladder, and each reattach made it taller. The scrollback belongs
   * to the terminal that produced it; a client that attaches late only needs the
   * screen it would see if it attached for real.
   *
   * And deliberately without `-J`, which rejoins wrapped lines: in a narrow pane
   * a prompt fills the width exactly, which tmux cannot tell apart from a wrapped
   * line, so `-J` glued the next prompt onto it — two prompts on one line and a
   * command that looked like it belonged to the wrong one. A screen is lines, not
   * paragraphs.
   *
   * The cursor comes along, from the tmux that owns it, and both travel in one
   * round trip: `capture-pane` pads every row to the width of the pane and then
   * drops that padding, so the capture alone ends left of the real cursor. A
   * client left to guess put its cursor a cell early and the shell's next echo
   * ate a cell of the prompt (see `TerminalScreen`).
   */
  async snapshot(history = false): Promise<TerminalScreen> {
    const name = shq(this.name)
    // `-S -N` reaches N lines into the scrollback, which is what an attach wants
    // — the lines that scrolled off are exactly what a client that just opened
    // the tab is missing — and what a resync does not: the screen is already
    // right, and the history would be the same lines again. The range is what the
    // pane actually kept, bounded, because a pane's `history-limit` is 20000 and
    // this travels over the wire.
    //
    // The pane's stream is measured on *both* sides of the capture, because one
    // measurement cannot answer the two questions the client asks of `offset`.
    // Taken before, it is a floor: the screen is at least this new, which is what
    // stops a stale capture from replacing output already drawn. Taken after, it
    // is a ceiling: the screen shows no more than this, which is what stops a
    // chunk the screen already contains from being drawn a second time. They
    // differ exactly when the shell printed while the capture was being taken,
    // and that is not a rare case — it is *the* case, because the first thing a
    // new pane does is print its prompt and the first thing a new tab does is ask
    // for its screen. Reporting the floor then said "the screen does not include
    // the prompt yet", so the prompt arrived again on the live stream and was
    // drawn underneath itself: two identical prompt lines and an empty pane below
    // them. Reporting the ceiling instead loses whatever the screen has not caught
    // up with. So neither is reported: when the two disagree the capture is simply
    // retaken, and the frame that goes out is one the pane did not move during.
    //
    // The screen is followed by a marker, and that marker is load-bearing. A pane
    // ends in blank rows — the part of it the shell has not reached — and a parser
    // that had to find the next number after the screen negotiated with those blank
    // rows for the newline between them, so the screen came back one or two rows
    // short. Nobody notices a row missing off the bottom of a screen replayed on
    // its own. Attached to the scrollback it is fatal: the whole replay slides up
    // by that much, the last line of the history comes to rest where the pane's
    // first row belongs, and a shell whose scrollback is a column of identical
    // prompts then shows its prompt twice with the rest of the pane empty. Which
    // is exactly the picture this was reported as. With an explicit end the screen
    // is whatever is in front of it, blank rows and all.
    const script = history
      ? `h=$(tmux display -p -t ${name} '#{history_size}'); ` +
        `[ "$h" -gt ${SCROLLBACK_LINES} ] && h=${SCROLLBACK_LINES}; ` +
        `wc -c < ${this.paneLog()} 2>/dev/null || echo 0; ` +
        `tmux capture-pane -p -e -S -$h -t ${name}; ` +
        `printf '${SCREEN_END}\\n'; ` +
        `wc -c < ${this.paneLog()} 2>/dev/null || echo 0; ` +
        `tmux display -p -t ${name} '#{cursor_x},#{cursor_y}'`
      : `wc -c < ${this.paneLog()} 2>/dev/null || echo 0; ` +
        `tmux capture-pane -p -e -t ${name}; ` +
        `printf '${SCREEN_END}\\n'; ` +
        `wc -c < ${this.paneLog()} 2>/dev/null || echo 0; ` +
        `tmux display -p -t ${name} '#{cursor_x},#{cursor_y}'`

    // The cursor is asked for last, after the second count, so the only thing
    // inside the window being closed is the capture itself.
    let unstable: TerminalScreen | null = null
    for (let attempt = 0; attempt < SNAPSHOT_TRIES; attempt += 1) {
      const out = await run(this.remoteShell(script), { timeoutMs: 6000 })
      // Offset, screen, the screen's end, offset again, cursor.
      //
      // The whitespace in front of those numbers is not decoration: `wc -c < file`
      // pads its count (macOS prints it in seven columns), and a parser that wanted
      // a bare number failed on it — the whole reply then went out as the screen,
      // with the offset and the cursor written into the terminal as text.
      const found = new RegExp(`^\\s*(\\d+)\\s*\\n([\\s\\S]*)\\n${SCREEN_END}\\n\\s*(\\d+)\\s*\\n(\\d+),(\\d+)\\s*$`).exec(out)
      // A reply that cannot be read is not a screen: send nothing rather than
      // something wrong, and the client keeps what it has until the next capture.
      if (!found) return { screen: '', cursor: null, offset: this.logOffset }
      const before = Number(found[1])
      const after = Number(found[3])
      const frame: TerminalScreen = {
        screen: found[2]!,
        cursor: { x: Number(found[4]), y: Number(found[5]) },
        offset: before,
      }
      if (before === after) return frame
      unstable = frame
    }
    // A pane that printed through every attempt is printing continuously, and
    // there is no honest offset for a screen that was already out of date when it
    // was taken. The floor is the one to report: a byte drawn twice is overwritten
    // by the next frame a moment later, a byte never drawn is gone for good.
    return unstable ?? { screen: '', cursor: null, offset: this.logOffset }
  }

  /* ---------------- Driver ---------------- */

  /** Used by the launchpad: a first command typed into the shell. */
  send(text: string): Promise<SendResult> {
    if (this.stopped) return Promise.resolve({ status: 'refused', reason: 'the terminal has stopped' })
    this.write(text.endsWith('\n') ? text : `${text}\n`)
    // The terminal's long-lived keystroke channel has no command-level ack.
    // It accepted the byte stream, but we cannot claim tmux executed it.
    return Promise.resolve({ status: 'accepted' })
  }

  interrupt(): void {
    this.write('\x03')
  }

  configure(_patch: Partial<Pick<CreateOptions, 'model' | 'effort' | 'permissionMode'>>): void {
    void _patch
  }

  /**
   * Detach. The shell keeps running inside tmux on the host, which is the whole
   * point: a closed tab is not a killed session.
   */
  stop(): void {
    this.stopped = true
    if (this.check) clearInterval(this.check)
    if (this.coalesce) clearTimeout(this.coalesce)
    this.check = null
    this.coalesce = null
    this.queue = []
    this.stopChannel()
    this.stopTail()
    this.alive = false
  }

  /**
   * Delete, which is the opposite of what `stop()` promises: the session is
   * leaving the workspace, so the shell it owns goes with it instead of being
   * left behind for nobody. Only ever our own name (`sedano-<id>`), never a
   * tmux session the user started.
   */
  destroy(): void {
    this.stop()
    void run(this.remoteArgv(['tmux', 'kill-session', '-t', this.name]), { timeoutMs: 4000 })
  }
}

export type { EffortLevel, PermissionMode, SessionStatus }
