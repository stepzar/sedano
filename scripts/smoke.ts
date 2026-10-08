#!/usr/bin/env bun
/**
 * End-to-end smoke test: starts a server of its own, creates a real Claude
 * session through its websocket, asks it to spawn a subagent and checks that the
 * whole pipeline (deltas, transcript, subagent tree, metrics, limits) reports.
 *
 * Not a hermetic gate: it needs the `claude` CLI installed, logged in, and it
 * spends quota. It is deliberately outside `check:all` — run it with
 * `bun run check:smoke` before a release.
 *
 * The store is temporary so the sessions it creates never land in yours, but the
 * vendor config is the real one: that is where the login is.
 *
 * Usage: bun scripts/smoke.ts [cwd] [timeout-seconds]
 */
import type { ClientMsg, ServerMsg } from '@shared'
import { installExitHandlers, ROOT, runCleanups, startApi, tempHome } from './lib/harness.ts'

installExitHandlers()

const cwd = process.argv[2] ?? ROOT
const timeoutSeconds = Number(process.argv[3] ?? 180)

if (!Bun.which('claude')) {
  console.error('smoke: the `claude` CLI is not on PATH — this test drives the real harness')
  process.exit(1)
}

const { env } = tempHome('smoke-home', { isolateVendorConfig: false })
const api = await startApi(env)
console.log(`smoke: server on ${api.url} against a temporary store`)

const markers = {
  user: false,
  tool: false,
  subagentStart: false,
  subagentEvent: false,
  subagentEnd: false,
  result: false,
  metrics: false,
  limits: false,
  delta: false,
  /** A second turn proves the long-lived stdin process keeps accepting input. */
  secondTurn: false,
}

let sessionId: string | null = null
let results = 0

let deltaChars = 0
let tps = 0
const seen = new Map<string, number>()
let finished = false

const ws = new WebSocket(`${api.url.replace(/^http/, 'ws')}/api/ws`)

function send(msg: ClientMsg): void {
  ws.send(JSON.stringify(msg))
}

function stamp(): string {
  return new Date().toISOString().slice(11, 19)
}

function describe(ev: any): string {
  switch (ev.k) {
    case 'user':
      return `USER ${JSON.stringify(ev.text.slice(0, 60))}`
    case 'assistant':
      return `ASSISTANT ${JSON.stringify(ev.text.slice(0, 90))}`
    case 'thinking':
      return `THINKING ${ev.text.length} chars`
    case 'tool':
      return `TOOL ${ev.name} ${JSON.stringify(ev.summary ? ev.summary.slice(0, 70) : '')}`
    case 'tool_result':
      return `RESULT ${ev.toolId.slice(0, 14)} ${ev.isError ? 'ERROR ' : ''}${ev.text.length} chars`
    case 'subagent_start':
      return `SUBAGENT_START ${ev.agentType} ${ev.agentId || '(id pending)'} :: ${ev.description}`
    case 'subagent_end':
      return `SUBAGENT_END ${ev.agentId} status=${ev.status} tools=${ev.toolUses} out=${ev.usage?.output ?? 0} ${(ev.durationMs / 1000).toFixed(1)}s`
    case 'system':
      return `SYSTEM ${ev.subtype}`
    case 'result':
      return `TURN_END ${ev.subtype} ${(ev.durationMs / 1000).toFixed(1)}s cost=$${ev.costUsd.toFixed(4)} out=${ev.usage?.output ?? 0}`
    case 'error':
      return `ERROR ${ev.text.slice(0, 200)}`
    default:
      return JSON.stringify(ev).slice(0, 100)
  }
}

ws.addEventListener('open', () => {
  console.log(`${stamp()} ws open`)
})

ws.addEventListener('close', () => {
  console.log(`${stamp()} ws closed`)
})

ws.addEventListener('message', (raw) => {
  const msg = JSON.parse(String((raw as MessageEvent).data)) as ServerMsg

  switch (msg.t) {
    case 'hello': {
      console.log(`${stamp()} hello: ${msg.sessions.length} sessions, ${msg.projects.length} projects`)
      for (const limit of msg.limits) {
        markers.limits = true
        console.log(
          `  limits ${limit.harness}: ${limit.windows.map((w) => `${w.label} ${w.usedPercent.toFixed(0)}%`).join(', ') || '—'}${
            limit.error ? ` (${limit.error})` : ''
          }`,
        )
      }
      console.log(`${stamp()} creating session in ${cwd}`)
      send({
        t: 'new_session',
        req: {
          harness: 'claude',
          cwd,
          model: 'haiku',
          permissionMode: 'acceptEdits',
          prompt:
            'Do this in two steps. First spawn exactly ONE subagent (Task tool, subagent_type general-purpose) telling it to run `echo sedano-subagent-ok` in bash and report the output. Wait for it. Then reply with the single word DONE. Do not do anything else.',
        },
      })
      return
    }

    case 'session': {
      console.log(
        `${stamp()} session ${msg.session.status.padEnd(8)} ${msg.session.id.slice(0, 8)} ${msg.session.model ?? ''} ${
          msg.session.nativeId ? `native=${msg.session.nativeId.slice(0, 8)}` : ''
        }`,
      )
      return
    }

    case 'timeline': {
      console.log(`${stamp()} timeline ${msg.sessionId.slice(0, 8)}: ${msg.events.length} events replayed`)
      sessionId = msg.sessionId
      return
    }

    case 'event': {
      const ev = msg.event.ev
      markers.user ||= ev.k === 'user'
      markers.tool ||= ev.k === 'tool'
      markers.subagentStart ||= ev.k === 'subagent_start'
      markers.subagentEnd ||= ev.k === 'subagent_end'
      markers.result ||= ev.k === 'result'
      if (ev.k === 'result') {
        results += 1
        if (results === 1 && sessionId) {
          console.log(`${stamp()} sending a second message to prove the process stays alive`)
          send({ t: 'input', sessionId, text: 'Reply with exactly: still-alive' })
        }
        if (results >= 2) markers.secondTurn = true
      }
      if (ev.k !== 'subagent_start' && ev.k !== 'subagent_end' && msg.event.agentId) markers.subagentEvent = true
      const key = `${ev.k}:${msg.event.agentId ?? 'main'}`
      seen.set(key, (seen.get(key) ?? 0) + 1)
      console.log(`${stamp()} [${String(msg.event.seq).padStart(3)}] ${msg.event.agentId ? '└─ ' : ''}${describe(ev)}`)
      return
    }

    case 'delta': {
      deltaChars += msg.text.length
      markers.delta = true
      return
    }

    case 'metrics': {
      markers.metrics = true
      tps = msg.metrics.tps
      return
    }

    case 'limits': {
      markers.limits = true
      const claude = msg.limits.find((l) => l.harness === 'claude')
      if (claude?.windows.length) {
        console.log(
          `${stamp()} limits(claude): ${claude.windows.map((w) => `${w.label}=${w.usedPercent.toFixed(0)}%`).join(' ')}`,
        )
      }
      return
    }

    case 'toast': {
      console.log(`${stamp()} TOAST(${msg.level}) ${msg.text}`)
      return
    }
  }
})

const heartbeat = setInterval(() => {
  console.log(`${stamp()} … streamed ${deltaChars} chars, tps≈${tps}`)
}, 15_000)

const deadline = setTimeout(() => {
  console.log(`${stamp()} timeout reached`)
  void report()
}, timeoutSeconds * 1000)

async function report(): Promise<void> {
  if (finished) return
  finished = true
  clearInterval(heartbeat)
  clearTimeout(deadline)
  // The server this run started is stopped here, pass or fail, along with the
  // temporary store — the sessions above were real, so the cleanup has to be.
  try {
    ws.close()
  } catch {
    /* already gone */
  }
  await runCleanups()
  console.log('\n--- smoke report ---')
  console.log(`streamed delta chars: ${deltaChars}`)
  for (const [key, count] of [...seen.entries()].sort()) console.log(`  ${key}: ${count}`)
  console.log('\nmarkers:')
  let failed = false
  for (const [name, ok] of Object.entries(markers)) {
    console.log(`  ${ok ? 'ok  ' : 'MISS'} ${name}`)
    if (!ok) failed = true
  }
  console.log(failed ? '\nRESULT: FAILED' : '\nRESULT: PASSED')
  process.exit(failed ? 1 : 0)
}

// Exit as soon as the turns are over and every marker landed.
setInterval(() => {
  if (markers.result && markers.subagentEnd && markers.metrics && markers.secondTurn) void report()
}, 2000)
