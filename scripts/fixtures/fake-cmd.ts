#!/usr/bin/env bun
/**
 * A stand-in for `cmd` in headless JSON mode.
 *
 * It prints the exact NDJSON frame shapes captured from a real
 * `cmd -p --output-format json` run (run_start, thinking deltas, text deltas,
 * tool_queued/completed, model_request_end, message_end, run_end, result), so the
 * Command Code driver can be exercised end to end without spending any quota.
 *
 * The first tool event carries this process' argv, which is how the test proves
 * that a resumed turn really passes `--resume <id>`.
 */
const args = process.argv.slice(2)
const flag = (name: string): string | null => {
  const index = args.indexOf(name)
  return index >= 0 ? (args[index + 1] ?? null) : null
}
const resumed = flag('--resume')
const sessionId = resumed ?? 'fake-session-0001'
const prompt = (await Bun.stdin.text()).trim()

const emit = (frame: unknown): void => {
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}
const usage = { inputTokens: 10, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 0 }

/**
 * The stuck turn, reproduced: a CLI that says it started, then says nothing,
 * refuses to die on SIGTERM and keeps stdout open. Every part of that was seen
 * in a real run, and together they are what left a session "running" with no way
 * to stop it — the driver's read never ended, so there was nothing to interrupt.
 * The test sends "hang" as the prompt to get this instead of a normal turn.
 */
if (prompt === 'hang') {
  // Set up the defence before announcing the turn: the test waits for the
  // `run_start` this emits, and reading it must guarantee the handler is already
  // in place. Emitting first let a fast interrupt land on a process that had not
  // armed itself yet — which is a kill, not the hang the test is here to prove.
  process.on('SIGTERM', () => undefined)
  process.on('SIGINT', () => undefined)
  setInterval(() => undefined, 1000)
  emit({ type: 'event', event: { type: 'run_start', sessionId } })
} else if (prompt === 'two turns') {
  /**
   * Two model rounds in one run, and no `message_end` on either: a round that
   * ends in tool calls closes with `turn_end`, so the prose of the first round
   * can only be committed by the native boundary. Inferring it merged both
   * rounds into one answer, in the wrong order around the tool call.
   */
  emit({ type: 'event', event: { type: 'run_start', sessionId } })
  emit({ type: 'event', event: { type: 'turn_start', turnNumber: 1 } })
  emit({ type: 'event', event: { type: 'model_request_start', model: 'fake/model' } })
  emit({ type: 'event', event: { type: 'text_delta', delta: 'First round.' } })
  emit({ type: 'event', event: { type: 'tool_queued', toolCallId: 'call_1', toolName: 'argv', input: { args } } })
  emit({
    type: 'event',
    event: { type: 'tool_completed', toolCallId: 'call_1', toolName: 'argv', result: [{ type: 'text', text: 'ok' }] },
  })
  emit({ type: 'event', event: { type: 'turn_end', turnNumber: 1, hadToolCalls: true, usage } })
  emit({ type: 'event', event: { type: 'turn_start', turnNumber: 2 } })
  emit({ type: 'event', event: { type: 'text_delta', delta: 'Second round.' } })
  emit({ type: 'event', event: { type: 'turn_end', turnNumber: 2, hadToolCalls: false, usage } })
  emit({
    type: 'event',
    event: { type: 'run_end', result: { finalText: 'Second round.', stopReason: 'max_tokens', turnCount: 2, usage } },
  })
  emit({ type: 'result', subtype: 'success', sessionId, stopReason: 'max_tokens', usage, durationMs: 5, finalText: 'Second round.' })
} else if (prompt === 'synthetic model') {
  /**
   * A harness naming a placeholder instead of a model.
   *
   * Claude Code is where `<synthetic>` really comes from, but the model hook is
   * one door every harness shares, and it is the manager's job — not one
   * driver's — to refuse a sentinel at it. Command Code is simply the cheapest
   * harness to drive a full manager session with, so this branch exists to push
   * a placeholder through that door and prove it does not reach the summary,
   * the stored row or the picker.
   */
  emit({ type: 'event', event: { type: 'run_start', sessionId } })
  emit({ type: 'event', event: { type: 'turn_start', turnNumber: 1 } })
  emit({ type: 'event', event: { type: 'model_request_start', model: '<synthetic>' } })
  emit({ type: 'event', event: { type: 'text_delta', delta: 'No response requested.' } })
  emit({ type: 'event', event: { type: 'message_end', content: [{ type: 'text', text: 'No response requested.' }] } })
  emit({ type: 'event', event: { type: 'turn_end', turnNumber: 1, hadToolCalls: false, usage } })
  emit({
    type: 'event',
    event: { type: 'run_end', result: { finalText: 'No response requested.', stopReason: 'end_turn', turnCount: 1, usage } },
  })
  emit({ type: 'result', subtype: 'success', sessionId, stopReason: 'end_turn', usage, durationMs: 1, finalText: 'No response requested.' })
} else if (prompt === 'boom') {
  /**
   * A run that fails, with the structured error the CLI really sends: its own
   * `toError` shape, not a string. Flattening it was how "[object Object]"
   * ended up in front of a person instead of the reason.
   */
  emit({ type: 'event', event: { type: 'run_start', sessionId } })
  emit({ type: 'event', event: { type: 'turn_start', turnNumber: 1 } })
  emit({
    type: 'event',
    event: { type: 'tool_queued', toolCallId: 'call_boom', toolName: 'Bash', input: { command: 'false' } },
  })
  emit({
    type: 'event',
    event: {
      type: 'tool_errored',
      toolCallId: 'call_boom',
      toolName: 'Bash',
      error: { message: 'command failed with exit 1', code: 'ETOOL' },
    },
  })
  emit({ type: 'event', event: { type: 'turn_end', turnNumber: 1, hadToolCalls: true, usage } })
  emit({ type: 'event', event: { type: 'run_error', error: { message: 'the run gave up', code: 'ERUN' } } })
  emit({
    type: 'result',
    subtype: 'error',
    sessionId,
    usage,
    durationMs: 3,
    finalText: '',
    error: { message: 'the run gave up', code: 'ERUN' },
  })
} else {
  emit({ type: 'event', event: { type: 'run_start', sessionId } })
  emit({ type: 'event', event: { type: 'turn_start', turnNumber: 1 } })
  emit({ type: 'event', event: { type: 'message_start' } })
  // The CLI names the model it is about to call here, before anything streams.
  emit({ type: 'event', event: { type: 'model_request_start', model: 'fake/model' } })
  emit({ type: 'event', event: { type: 'thinking_delta', delta: 'Thinking about it.' } })
  emit({ type: 'event', event: { type: 'thinking_end' } })
  emit({ type: 'event', event: { type: 'text_delta', delta: 'Hello ' } })
  emit({ type: 'event', event: { type: 'text_delta', delta: 'world' } })
  emit({ type: 'event', event: { type: 'message_end', content: [{ type: 'text', text: 'Hello world' }] } })
  emit({ type: 'event', event: { type: 'tool_queued', toolCallId: 'call_1', toolName: 'argv', input: { args } } })
  emit({ type: 'event', event: { type: 'tool_running', toolCallId: 'call_1', toolName: 'argv', description: null } })
  emit({
    type: 'event',
    event: { type: 'tool_completed', toolCallId: 'call_1', toolName: 'argv', result: [{ type: 'text', text: prompt }] },
  })
  emit({ type: 'event', event: { type: 'model_request_end', model: 'fake/model', usage, stopReason: 'end_turn', effort: 'high' } })
  emit({ type: 'event', event: { type: 'turn_end', turnNumber: 1, hadToolCalls: true, usage } })
  emit({ type: 'event', event: { type: 'run_end', result: { finalText: 'Hello world', stopReason: 'end_turn', turnCount: 1, usage } } })
  emit({ type: 'result', subtype: 'success', sessionId, stopReason: 'end_turn', usage, durationMs: 5, finalText: 'Hello world' })
}
