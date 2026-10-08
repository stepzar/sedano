/**
 * ACP client: JSON-RPC 2.0 over an agent process' stdio, one message per line.
 *
 * ACP (agentclientprotocol.com) is the protocol spoken by `opencode acp`,
 * `gemini --acp`, `codex-acp` and grok's streaming-json mode. Everything those
 * agents need is the same shape sedano already models: one long-lived process
 * that owns one conversation, streams its updates, and answers prompts turn by
 * turn. That is why they share this client instead of one bespoke parser each —
 * and why adding the next ACP agent is a table entry, not an adapter.
 *
 * Framing is newline-delimited JSON (no `Content-Length`, unlike LSP): a chunk
 * of stdout can hold half a message or three of them, so the reader keeps a
 * buffer and only parses complete lines.
 */
import type { Subprocess } from 'bun'
import { Transport } from '../../transport.ts'
import { LineSplitter } from '../lines.ts'

export interface AcpClientOptions {
  /** Full argv: the agent binary plus its ACP flag (`acp`, `--acp`, ...). */
  command: string[]
  cwd: string
  /** When set, the agent runs on this SSH host instead of this machine. */
  host?: string | null
  /** Environment override: some bridges need NODE_NO_WARNINGS etc. */
  env?: Record<string, string | undefined>
  /** Agent -> client notifications (`session/update`, ...). */
  onNotification(method: string, params: unknown): void
  /**
   * Agent -> client requests. Every one must be answered or the agent stalls
   * waiting: that is how permission prompts and file reads work.
   */
  /**
   * A request from the agent, with the id its reply must carry. The id matters
   * beyond the reply itself: a driver that turns the request into a question for
   * the user keys its "still waiting" state by it.
   */
  onRequest(method: string, params: unknown, id: number | string): Promise<unknown>
  onStderr?(text: string): void
  /** Called once, whatever the reason the process went away. */
  onExit?(code: number | null, signal: string | null): void
  /** Shown to the agent during `initialize`. */
  clientName?: string
  clientVersion?: string
}

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout> | null
  method: string
}

export class AcpClient {
  private proc: Subprocess<'pipe', 'pipe', 'pipe'> | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private closed = false
  private readonly stderrTail: string[] = []
  private exited: Promise<void> | null = null

  constructor(private readonly opts: AcpClientOptions) {}

  get alive(): boolean {
    return !this.closed && this.proc !== null && this.proc.exitCode === null
  }

  /** Last few stderr lines: the only diagnostic an agent gives when it dies. */
  get diagnostics(): string {
    return this.stderrTail.join('\n')
  }

  start(): void {
    if (this.proc) return
    const [bin, ...args] = this.opts.command
    if (!bin) throw new Error('acp: empty command')
    // Local or on a host: the transport chooses, so the JSON-RPC channel over
    // stdio is identical either way.
    const transport = new Transport(this.opts.host ?? null)
    this.proc = transport.spawn(bin, args, {
      cwd: this.opts.cwd,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ...this.opts.env },
    }) as Subprocess<'pipe', 'pipe', 'pipe'>
    void this.pumpStdout(this.proc)
    void this.pumpStderr(this.proc)
    void this.watchExit(this.proc)
  }

  /** `initialize`: the handshake every ACP agent expects first. */
  async initialize(timeoutMs = 60_000): Promise<Record<string, unknown>> {
    return this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        // We implement fs/read_text_file and fs/write_text_file ourselves, so the
        // agent never has to guess about paths, and we deliberately do not claim
        // terminal support: sedano's terminals are separate tabs, not tool calls.
        fs: { readTextFile: true, writeTextFile: true },
        // Questions, the protocol's own way: `elicitation/create` lets any agent
        // ask for a choice or a value mid-turn and wait. Declaring it is what
        // makes agents ask *us* instead of deciding on their own — the agent
        // must not request a mode the client has not advertised. Form mode only:
        // it is the in-band one, and it is what the card can render.
        elicitation: { form: {} },
        terminal: false,
      },
      clientInfo: {
        name: this.opts.clientName ?? 'sedano',
        version: this.opts.clientVersion ?? '0.1.0',
      },
    }, timeoutMs)
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = 0): Promise<T> {
    if (!this.proc) throw new Error('acp: client not started')
    if (this.closed) return Promise.reject(new Error('acp: client is closed'))
    const id = this.nextId++
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params })
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            const entry = this.pending.get(id)
            if (!entry) return
            this.pending.delete(id)
            entry.reject(new Error(`acp: ${method} timed out after ${timeoutMs}ms`))
          }, timeoutMs)
        : null
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer, method })
      try {
        this.write(payload)
      } catch (error) {
        this.pending.delete(id)
        if (timer) clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  notify(method: string, params: unknown): void {
    if (this.closed) return
    this.writeQuietly(JSON.stringify({ jsonrpc: '2.0', method, params }))
  }

  /** Answer an agent request. `error` turns it into a JSON-RPC error. */
  respond(id: number | string, result: unknown, error?: string, code = -32603): void {
    if (this.closed) return
    this.writeQuietly(
      JSON.stringify(
        error
          ? { jsonrpc: '2.0', id, error: { code, message: error } }
          : { jsonrpc: '2.0', id, result },
      ),
    )
  }

  /**
   * A write nobody is waiting on, to an agent that may already be gone.
   *
   * Replies and notifications go out from promise callbacks and from an
   * interrupt; a dead agent's stdin throws there, and a throw in a callback is
   * an unhandled rejection that takes the whole server down. The agent's exit is
   * reported by `watchExit`, so nothing is lost by not reporting it here too.
   */
  private writeQuietly(line: string): void {
    try {
      this.write(line)
    } catch {
      /* the agent is gone; watchExit says so */
    }
  }

  /** Stop the agent. Cancels whatever is in flight instead of leaving it hanging. */
  async close(graceMs = 1500): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const [id, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(new Error('acp: client closed'))
      this.pending.delete(id)
    }
    const proc = this.proc
    if (!proc) return
    try {
      proc.stdin.end()
    } catch {
      /* already gone */
    }
    // Give it a moment to exit on its own (agents flush state on stdin EOF),
    // then insist. A wedged agent must never keep a session alive.
    const exited = await Promise.race([
      (this.exited ?? Promise.resolve()).then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), graceMs)),
    ])
    if (!exited) {
      try {
        proc.kill()
      } catch {
        /* already gone */
      }
    }
  }

  private write(line: string): void {
    const stdin = this.proc?.stdin
    if (!stdin) throw new Error('acp: no stdin')
    stdin.write(`${line}\n`)
    stdin.flush()
  }

  private async pumpStdout(proc: Subprocess<'pipe', 'pipe', 'pipe'>): Promise<void> {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
    // Re-slicing the buffer after every line was quadratic in the lines per
    // chunk, and rescanning it per chunk was quadratic in a long message — a
    // `session/load` replay is exactly both.
    const lines = new LineSplitter()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        for (const line of lines.push(value)) this.handleLineSafely(line)
      }
      this.handleLineSafely(lines.flush())
    } catch {
      /* the stream ends when the agent dies; onExit reports it */
    }
  }

  /**
   * One message, contained: a throw from a handler would otherwise end this
   * read loop, and an agent whose stdout nobody reads blocks once the pipe fills.
   */
  private handleLineSafely(raw: string): void {
    const line = raw.trim()
    if (!line) return
    try {
      this.handleLine(line)
    } catch (error) {
      console.error('[acp] could not handle a message:', error)
    }
  }

  private handleLine(line: string): void {
    let message: {
      id?: number | string
      method?: string
      params?: unknown
      result?: unknown
      error?: { code?: number; message?: string; data?: unknown }
    }
    try {
      message = JSON.parse(line)
    } catch {
      // Agents do print banners and warnings on stdout. Dropping them keeps the
      // protocol readable; stderr is where diagnostics belong.
      return
    }

    // A notification or a request from the agent.
    if (message.method) {
      if (message.id === undefined) {
        this.opts.onNotification(message.method, message.params)
        return
      }
      const id = message.id
      void this.opts
        .onRequest(message.method, message.params, id)
        .then((result) => this.respond(id, result))
        .catch((error: unknown) => {
          // A handler that names its JSON-RPC code (`InvalidParams`) is answered
          // with it; everything else is the generic internal error.
          const code = (error as { code?: unknown } | null)?.code
          this.respond(
            id,
            null,
            error instanceof Error ? error.message : String(error),
            typeof code === 'number' ? code : undefined,
          )
        })
      return
    }

    // A response to something we asked for.
    if (message.id === undefined) return
    const entry = this.pending.get(Number(message.id))
    if (!entry) return
    this.pending.delete(Number(message.id))
    if (entry.timer) clearTimeout(entry.timer)
    if (message.error) {
      entry.reject(new Error(`acp: ${entry.method} failed: ${message.error.message ?? 'unknown error'}`))
      return
    }
    entry.resolve(message.result)
  }

  private async pumpStderr(proc: Subprocess<'pipe', 'pipe', 'pipe'>): Promise<void> {
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        const text = decoder.decode(value, { stream: true })
        if (!text.trim()) continue
        for (const line of text.split('\n')) {
          if (!line.trim()) continue
          this.stderrTail.push(line.trim())
          if (this.stderrTail.length > 40) this.stderrTail.shift()
        }
        this.opts.onStderr?.(text)
      }
    } catch {
      /* same as stdout */
    }
  }

  private async watchExit(proc: Subprocess<'pipe', 'pipe', 'pipe'>): Promise<void> {
    this.exited = proc.exited.then(() => undefined)
    const code = await proc.exited
    if (this.closed) return
    const error = new Error(
      `acp: agent exited (${code ?? 'signal'})${this.stderrTail.length ? `\n${this.diagnostics}` : ''}`,
    )
    for (const [id, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(error)
      this.pending.delete(id)
    }
    this.opts.onExit?.(code, null)
  }
}
