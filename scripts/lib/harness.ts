/**
 * Test harness: temporary homes, free ports and servers this process owns.
 *
 * The browser checks used to talk to whatever was already listening on 7788 and
 * 5174, which meant they read (and could delete from) the store of whoever ran
 * them, and failed outright on a machine where nothing was running. Everything
 * here is the opposite: a home that is created and removed, a port nobody else
 * is on, and a child process that is stopped on the way out — success or
 * failure.
 *
 * Nothing in here ever kills a process it did not spawn.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const ROOT = join(import.meta.dir, '..', '..')

/* ------------------------------------------------------------------ */
/* Cleanup                                                             */
/* ------------------------------------------------------------------ */

type Cleanup = () => void | Promise<void>
const cleanups: Cleanup[] = []
let cleaning = false

/** Registers work that must happen whether the run passes, fails or is killed. */
export function onCleanup(fn: Cleanup): void {
  cleanups.push(fn)
}

/** Runs every registered cleanup, newest first, swallowing their errors. */
export async function runCleanups(): Promise<void> {
  if (cleaning) return
  cleaning = true
  for (const fn of cleanups.reverse()) {
    try {
      await fn()
    } catch (error) {
      console.error(`cleanup failed: ${String(error)}`)
    }
  }
  cleanups.length = 0
  cleaning = false
}

/**
 * Makes a script exit through the cleanups no matter how it ends: a ⌃C or an
 * unhandled rejection must not leave a server on a port and a directory in tmp.
 */
export function installExitHandlers(): void {
  const bail = (code: number) => {
    void runCleanups().then(() => process.exit(code))
  }
  process.on('SIGINT', () => bail(130))
  process.on('SIGTERM', () => bail(143))
  process.on('uncaughtException', (error) => {
    console.error(error)
    bail(1)
  })
  process.on('unhandledRejection', (error) => {
    console.error(error)
    bail(1)
  })
}

/* ------------------------------------------------------------------ */
/* Temp state                                                          */
/* ------------------------------------------------------------------ */

/**
 * A throwaway `SEDANO_HOME`, removed on the way out.
 *
 * Note the vendor config roots are pointed at it too: project discovery walks
 * `~/.claude`, `~/.codex` and `~/.grok`, and a check whose result depends on the
 * transcripts the operator happens to have is not a check.
 */
export function tempHome(
  label: string,
  options: { isolateVendorConfig?: boolean } = {},
): { home: string; env: Record<string, string> } {
  const home = mkdtempSync(join(tmpdir(), `sedano-${label}-`))
  onCleanup(() => rmSync(home, { recursive: true, force: true }))
  // A smoke test against a real CLI has to keep the vendor config: that is where
  // the login lives. Everything hermetic wants it moved out of the way.
  const vendors = options.isolateVendorConfig !== false
  return {
    home,
    env: {
      SEDANO_HOME: home,
      ...(vendors
        ? {
            CLAUDE_CONFIG_DIR: join(home, 'claude'),
            CODEX_HOME: join(home, 'codex'),
            GROK_HOME: join(home, 'grok'),
            GEMINI_DIR: join(home, 'gemini'),
            // Where the import scan looks for Opencode's database and Command
            // Code's projects; read by Sedano only, never by the CLIs.
            SEDANO_IMPORT_OPENCODE_DIR: join(home, 'opencode'),
            SEDANO_IMPORT_COMMANDCODE_DIR: join(home, 'commandcode'),
            // Where the Command Code usage reader looks for its key: never the real one.
            COMMANDCODE_AUTH_FILE: join(home, 'commandcode', 'auth.json'),
          }
        : {}),
    },
  }
}

/** A port nothing is listening on, taken by binding and releasing it. */
export function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response('') })
  const port = server.port
  server.stop(true)
  if (!port) throw new Error('could not reserve a free port')
  return port
}

/* ------------------------------------------------------------------ */
/* Child servers                                                       */
/* ------------------------------------------------------------------ */

export interface Server {
  url: string
  port: number
  /** Everything the child printed, for a failure message worth reading. */
  output: () => string
  stop: () => Promise<void>
}

interface StartOptions {
  label: string
  command: string[]
  env: Record<string, string>
  /** Host the child listens on; vite binds `localhost`, which is not 127.0.0.1 everywhere. */
  host: string
  /** Path polled until it answers; the server is considered up when it does. */
  health: string
  port: number
  timeoutMs?: number
}

async function start(options: StartOptions): Promise<Server> {
  const chunks: string[] = []
  const proc = Bun.spawn(options.command, {
    cwd: ROOT,
    env: { ...process.env, ...options.env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const drain = async (stream: ReadableStream<Uint8Array> | null): Promise<void> => {
    if (!stream) return
    const decoder = new TextDecoder()
    const reader = stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      if (value) chunks.push(decoder.decode(value))
    }
  }
  void drain(proc.stdout as ReadableStream<Uint8Array>)
  void drain(proc.stderr as ReadableStream<Uint8Array>)

  const output = () => chunks.join('')
  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    // Only ever the child this function spawned, and only by handle: a port
    // sweep would take down the server the operator is using.
    proc.kill('SIGTERM')
    const died = await Promise.race([
      proc.exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
    ])
    if (!died) proc.kill('SIGKILL')
    await proc.exited
  }
  onCleanup(stop)

  const url = `http://${options.host}:${options.port}`
  const deadline = Date.now() + (options.timeoutMs ?? 30_000)
  while (Date.now() < deadline) {
    if (proc.killed || proc.exitCode !== null) {
      throw new Error(`${options.label} exited before it was ready (code ${proc.exitCode}):\n${output()}`)
    }
    try {
      const response = await fetch(`${url}${options.health}`)
      if (response.ok) return { url, port: options.port, output, stop }
    } catch {
      /* not listening yet */
    }
    await Bun.sleep(150)
  }
  await stop()
  throw new Error(`${options.label} did not become healthy within the deadline:\n${output()}`)
}

/** The API server, on its own port and against its own store. */
export function startApi(env: Record<string, string>, port = freePort()): Promise<Server> {
  return start({
    label: 'api server',
    command: ['bun', 'apps/server/src/index.ts'],
    env: { SEDANO_BACKGROUND_SYNC: '0', ...env, SEDANO_PORT: String(port), SEDANO_HOST: '127.0.0.1' },
    host: '127.0.0.1',
    health: '/api/health',
    port,
  })
}

/**
 * The vite dev server, needed only for the component gallery: `preview.html`
 * renders from fixtures and is not part of the production bundle, so there is no
 * built file to serve it from.
 */
export function startVite(port = freePort()): Promise<Server> {
  return start({
    label: 'vite',
    command: [
      join(ROOT, 'node_modules', '.bin', 'vite'),
      '--config',
      'apps/ui/vite.config.ts',
      '--port',
      String(port),
      '--strictPort',
    ],
    env: {},
    host: 'localhost',
    health: '/preview.html',
    port,
  })
}

/** Seeds a temporary store with the fixture sessions, in its own process. */
export async function seedStore(env: Record<string, string>, cwd: string): Promise<void> {
  const proc = Bun.spawn(['bun', join(ROOT, 'scripts', 'fixtures', 'seed-db.ts'), cwd], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  if (proc.exitCode !== 0) throw new Error(`seeding the fixture store failed:\n${out}\n${err}`)
}
