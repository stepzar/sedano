import { strict as assert } from 'node:assert'
import type { SessionEvent, SessionSummary } from '../packages/shared/src/events.ts'
import { buildTransferPrompt, transferContext } from '../apps/ui/src/transfer.ts'

const session: SessionSummary = {
  id: 'sedano-123',
  nativeId: 'claude-456',
  harness: 'claude',
  kind: 'agent',
  title: 'Transfer work',
  preset: null,
  cwd: '/repo/app',
  host: null,
  model: 'opus',
  status: 'idle',
  createdAt: 1,
  updatedAt: 2,
  transcriptPath: null,
  resumeHint: null,
  permissionMode: 'acceptEdits',
  effort: 'high',
  gitBranch: null,
  pinned: false,
  started: true,
  metrics: {
    tps: 0,
    tpsAvg: 0,
    lastTtftMs: null,
    outputTokens: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    contextTokens: 0,
    contextWindow: 0,
    costUsd: 0,
    turnActive: false,
  },
}

const events: SessionEvent[] = [
  { id: 'u1', sessionId: session.id, seq: 1, at: 1, ev: { k: 'user', text: 'Implement the transfer flow.' } },
  { id: 'f1', sessionId: session.id, seq: 2, at: 2, ev: { k: 'file_change', toolId: 't1', path: 'src/transfer.ts', change: 'create', added: 20, removed: 0, preview: '' } },
  { id: 'a1', sessionId: session.id, seq: 3, at: 3, ev: { k: 'assistant', text: 'The dialog is implemented; visual verification remains.' } },
]

const prompt = buildTransferPrompt(session, events)
assert.match(prompt, /Claude Code/)
assert.match(prompt, /claude-456 \(Sedano sedano-123\)/)
assert.match(prompt, /Implement the transfer flow/)
assert.match(prompt, /src\/transfer\.ts/)
assert.match(prompt, /visual verification remains/)
assert.match(prompt, /Cosa stavamo facendo:/)
assert.doesNotMatch(prompt, /Workspace:/)

const custom = buildTransferPrompt(session, events, '{sourceHarness}|{sourceSession}|{workspace}|{summary}|{remaining}')
assert.match(custom, /^Claude Code\|claude-456/)
assert.doesNotMatch(custom, /\{sourceHarness\}/)
assert.doesNotMatch(custom, /\{workspace\}/)

const legacy = buildTransferPrompt(session, events, 'Harness: {sourceHarness}\nWorkspace: {workspace}\n{remaining}')
assert.doesNotMatch(legacy, /Workspace:/)

const running = transferContext({ ...session, status: 'running' }, events)
assert.match(running.remaining, /stava ancora lavorando/)

const failed = transferContext(session, [
  ...events,
  { id: 'e1', sessionId: session.id, seq: 4, at: 4, ev: { k: 'error', text: 'Harness disconnected' } },
])
assert.match(failed.remaining, /Harness disconnected/)

console.log('transfer-test: PASSED (10 checks)')
