#!/usr/bin/env bun
/**
 * A fake ACP agent, used to test the ACP driver without spending quota or
 * depending on any vendor CLI being installed and authenticated.
 *
 * It speaks the real protocol, including the parts that are easy to get wrong:
 * agent -> client *requests* (permissions, file reads and writes) that must be
 * answered or the agent hangs, streamed updates, turn usage, cancellation, and
 * a second prompt on the same session (a session is one conversation, not one
 * process per message).
 *
 * Prompts are interpreted by keyword so a test can ask for a behaviour:
 *   "ask"    → request permission before touching anything
 *   "elicit" → ask the client a question with choices (ACP elicitation/create)
 *   "read"   → ask the client for `fake-read.txt` and echo what came back
 *   "write"  → ask the client to write `fake-write.txt`
 *   "cancel" → stay busy until the client cancels the turn
 *   "fail"   → answer the prompt with a JSON-RPC error
 *   anything → stream prose, a tool call and a diff, then end the turn
 *
 * Env switches for the shapes a vendor CLI has that the protocol does not
 * require, so the driver can be tested against them:
 *   FAKE_ACP_SIGNIN=1 → refuses `session/new` until `authenticate` is answered
 *   FAKE_ACP_META=1   → reports its version and models in `_meta` (as grok
 *                       does) and gives `session/new` no model list at all
 *   FAKE_ACP_REFUSE_CONFIG=1 → refuses every `session/set_config_option`
 *   FAKE_ACP_NO_CONFIG=1     → answers it with JSON-RPC "method not found",
 *                              the way an agent older than session config
 *                              options does
 *   FAKE_ACP_LOAD_BARE=1     → answers `session/load` with `{}`, saying nothing
 *                              about the model it resumed on (also legal: the
 *                              state in that response is optional)
 *   FAKE_ACP_MODEL_EFFORTS=1 → model one offers low/medium/high while model two
 *                              has no effort option, like OpenCode's MiMo model
 *   FAKE_ACP_ENCODED_MODELS=1 → catalog ids include effort, but model config
 *                               accepts only the base id, as Codex ACP does
 *   FAKE_ACP_REPLAY_FIRST=1  → replays the conversation before answering
 *                              `session/load` (the spec's order) instead of after
 */
let buffer = ''
let currentSession = ''
let prompts = 0
let pending: { id: number | string; cancelled: boolean } | null = null
const SIGN_IN_FIRST = process.env.FAKE_ACP_SIGNIN === '1'
const META_ONLY = process.env.FAKE_ACP_META === '1'
/** Refuse every `session/set_config_option`, the way an agent refuses a value. */
const REFUSE_CONFIG = process.env.FAKE_ACP_REFUSE_CONFIG === '1'
/** Answer `session/set_config_option` with "method not found", as an old agent does. */
const NO_CONFIG_METHOD = process.env.FAKE_ACP_NO_CONFIG === '1'
/** Answer `session/load` with a bare `{}`: legal, and says nothing about the model. */
const LOAD_BARE = process.env.FAKE_ACP_LOAD_BARE === '1'
/** Replay the conversation *before* answering `session/load`, as the spec orders. */
const REPLAY_FIRST = process.env.FAKE_ACP_REPLAY_FIRST === '1'
/** Make the effort selector disappear when model two is selected. */
const MODEL_EFFORTS = process.env.FAKE_ACP_MODEL_EFFORTS === '1'
const ENCODED_MODELS = process.env.FAKE_ACP_ENCODED_MODELS === '1'

/**
 * The session's config options, in the shape the schema defines: an id, a
 * category the client is meant to recognise, and the values it may be set to.
 * `session/set_config_option` answers with this whole list, which is what the
 * client reads to learn what actually applied.
 */
const modelValues = [
  { value: 'fake-model-1', name: 'Fake Model One' },
  { value: 'fake-model-2', name: 'Fake Model Two' },
]
let currentModelId = 'fake-model-1'
let currentEffort = 'medium'
const configOptions = () => [
  {
    configId: 'model',
    name: 'Model',
    category: 'model',
    currentValue: currentModelId,
    options: modelValues,
  },
  ...(MODEL_EFFORTS && currentModelId === 'fake-model-2' ? [] : [{
    configId: 'thought',
    name: 'Reasoning',
    category: 'thought_level',
    currentValue: currentEffort,
    // Grouped values, which the schema allows just as much as a flat list.
    options: [
      {
        groupId: 'levels',
        name: 'Levels',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'medium', name: 'Medium' },
          { value: 'high', name: 'High' },
        ],
      },
    ],
  }]),
]
const AUTH_METHOD = 'fake-login'
let signedIn = !SIGN_IN_FIRST

const write = (message: unknown): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}
const notify = (method: string, params: unknown): void => write({ jsonrpc: '2.0', method, params })
const respond = (id: number | string, result: unknown): void => write({ jsonrpc: '2.0', id, result })
const respondError = (id: number | string, message: string): void =>
  write({ jsonrpc: '2.0', id, error: { code: -32000, message } })

let nextRequestId = 1000
const askClient = (method: string, params: unknown): Promise<unknown> =>
  new Promise((resolve) => {
    const id = nextRequestId++
    waiting.set(id, resolve)
    write({ jsonrpc: '2.0', id, method, params })
  })
const waiting = new Map<number, (value: unknown) => void>()

const update = (payload: Record<string, unknown>): void =>
  notify('session/update', { sessionId: currentSession, update: payload })

/** The turn body, streamed the way a real agent streams it. */
async function runTurn(text: string, permissionOutcome: unknown): Promise<void> {
  prompts += 1
  update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'considering…' } })
  // The spec's own usage report: what the conversation occupies and what it cost.
  update({ sessionUpdate: 'usage_update', used: 1234, size: 200_000, cost: 0.0123 })

  if (text.includes('echo-prompt')) {
    // What the agent was handed, verbatim: how a test sees the prompt text a
    // driver really sent (documents inlined, for one).
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `echo:${text}\n` } })
  }

  if (text.includes('elicit')) {
    // A form elicitation, exactly as the protocol describes it: one choice, with
    // titles and descriptions the client is expected to render.
    const answer = (await askClient('elicitation/create', {
      sessionId: currentSession,
      mode: 'form',
      message: 'How should I approach this refactoring?',
      requestedSchema: {
        type: 'object',
        properties: {
          strategy: {
            type: 'string',
            title: 'Refactoring Strategy',
            oneOf: [
              { const: 'conservative', title: 'Conservative', description: 'Minimal changes.' },
              { const: 'balanced', title: 'Balanced', description: 'Fix it and tidy nearby code.' },
              { const: 'aggressive', title: 'Aggressive', description: 'Refactor more broadly.' },
            ],
            default: 'balanced',
          },
        },
        required: ['strategy'],
      },
    })) as { action?: string; content?: { strategy?: string } }
    update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `elicited=${answer?.action}:${answer?.content?.strategy ?? 'none'}\n` },
    })
    return
  }

  if (text.includes('ask') || text.includes('write')) {
    const options = [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ]
    // `perm-kind=<kind>` and `perm-path=<path>` in the prompt shape the request,
    // so a test can ask about a delete, or a file outside the workspace.
    const kind = /perm-kind=(\S+)/.exec(text)?.[1] ?? 'edit'
    const paths = [...text.matchAll(/perm-path=(\S+)/g)].map((match) => match[1]!)
    const answer = (await askClient('session/request_permission', {
      sessionId: currentSession,
      toolCall: {
        toolCallId: 'call-permission',
        title: 'Fake Tool',
        kind,
        ...(paths.length ? { locations: paths.map((path) => ({ path })) } : {}),
      },
      options,
    })) as { outcome?: { outcome?: string; optionId?: string } }
    const chosen = answer?.outcome?.optionId ?? answer?.outcome?.outcome ?? 'none'
    update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `permission=${chosen}\n` },
    })
    if (permissionOutcome === 'reject' && chosen.startsWith('reject')) {
      // A refused tool call is a complete turn on its own.
      return
    }
  }

  if (text.includes('read')) {
    const answer = (await askClient('fs/read_text_file', {
      sessionId: currentSession,
      path: `${process.cwd()}/fake-read.txt`,
    })) as { content?: string }
    update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `read:${(answer?.content ?? '').trim()}\n` },
    })
    return
  }

  if (text.includes('write')) {
    await askClient('fs/write_text_file', {
      sessionId: currentSession,
      path: `${process.cwd()}/fake-write.txt`,
      content: 'written by the fake agent\n',
    })
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'wrote it\n' } })
    return
  }

  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `hello from fake (pid ${process.pid}, prompt ${prompts})\n` } })
  update({
    sessionUpdate: 'tool_call',
    toolCallId: 'call-1',
    title: 'Fake Tool',
    kind: 'edit',
    status: 'in_progress',
    rawInput: { path: 'src/thing.ts' },
  })
  update({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call-1',
    status: 'completed',
    content: [
      { type: 'content', content: { type: 'text', text: 'edited src/thing.ts' } },
      { type: 'diff', path: 'src/thing.ts', oldText: 'let a = 1\nlet b = 2\n', newText: 'let a = 1\nlet b = 3\nlet c = 4\n' },
    ],
  })
}

function handle(message: {
  id?: number | string
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: unknown
}): void {
  // A response to one of our own requests (fs/*, permissions).
  if (message.id !== undefined && !message.method) {
    const resolve = waiting.get(Number(message.id))
    if (resolve) {
      waiting.delete(Number(message.id))
      resolve(message.result)
    }
    return
  }

  const method = message.method ?? ''
  const params = (message.params ?? {}) as Record<string, unknown>

  if (method === 'initialize') {
    respond(message.id!, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, promptCapabilities: { image: false } },
      // A CLI that keeps its own facts in `_meta` sends no `agentInfo` at all.
      ...(META_ONLY ? {} : { agentInfo: { name: 'Fake ACP', version: '9.9.9' } }),
      ...(SIGN_IN_FIRST ? { authMethods: [{ id: AUTH_METHOD, name: 'Fake Login' }] } : {}),
      ...(META_ONLY
        ? {
            _meta: {
              agentVersion: '9.9.9',
              modelState: {
                currentModelId: 'fake-model-9',
                availableModels: [{ modelId: 'fake-model-9', name: 'Fake Model Nine' }],
              },
            },
          }
        : {}),
    })
    return
  }

  if (method === 'authenticate') {
    if (params.methodId !== AUTH_METHOD) {
      respondError(message.id!, `unknown auth method ${String(params.methodId)}`)
      return
    }
    signedIn = true
    respond(message.id!, {})
    return
  }

  if (method === 'session/new') {
    // A CLI with no stored credentials answers here, not with a prompt.
    if (!signedIn) {
      respondError(message.id!, 'Authentication required')
      return
    }
    currentSession = 'fake-session-1'
    respond(
      message.id!,
      META_ONLY
        ? { sessionId: currentSession }
        : {
            sessionId: currentSession,
            models: {
              currentModelId: ENCODED_MODELS ? `${currentModelId}[${currentEffort}]` : currentModelId,
              availableModels: ENCODED_MODELS
                ? modelValues.flatMap((model) => ['low', 'medium', 'high'].map((effort) => ({
                    modelId: `${model.value}[${effort}]`, name: `${model.name} ${effort}`,
                  })))
                : modelValues.map((model) => ({ modelId: model.value, name: model.name })),
            },
            configOptions: configOptions(),
          },
    )
    return
  }

  if (method === 'session/set_config_option') {
    if (NO_CONFIG_METHOD) {
      write({ jsonrpc: '2.0', id: message.id!, error: { code: -32601, message: 'Method not found' } })
      return
    }
    const configId = String(params.configId ?? '')
    const value = String(params.value ?? '')
    if (REFUSE_CONFIG) {
      respondError(message.id!, `this agent will not set ${configId} to ${value}`)
      return
    }
    if (configId === 'model') {
      if (!modelValues.some((model) => model.value === value)) {
        respondError(message.id!, `unknown model ${value}`)
        return
      }
      currentModelId = value
    } else if (configId === 'thought') {
      if (MODEL_EFFORTS && currentModelId === 'fake-model-2') {
        respondError(message.id!, `effort not found: ${value}`)
        return
      }
      currentEffort = value
    } else {
      respondError(message.id!, `unknown config option ${configId}`)
      return
    }
    // The spec's answer: the full set of options and their current values.
    respond(message.id!, { configOptions: configOptions() })
    return
  }

  if (method === 'session/load') {
    // Refused the same way as a new session: a CLI without credentials has no
    // way in at all.
    if (!signedIn) {
      respondError(message.id!, 'Authentication required')
      return
    }
    currentSession = String(params.sessionId ?? 'fake-session-1')
    /**
     * `LoadSessionResponse` carries the same optional state a new session does:
     * `configOptions` — "Initial session configuration options if supported by
     * the Agent" — and `modes`, field for field the same as
     * `NewSessionResponse` (schema `v1/agent.rs`). The narrative docs put it as
     * "the response MAY also include initial mode, model, or session
     * configuration state when those features are supported by the Agent", so an
     * agent that answers `session/set_config_option` reports its options here
     * too, and a reopened conversation knows what model it is on.
     *
     * `FAKE_ACP_LOAD_BARE=1` is the other legal agent: one that answers `{}` and
     * leaves the client with nothing to go on. Both exist, so both are fixtures.
     */
    // Real agents replay the conversation on a load. sedano already has the
    // transcript, so the driver must ignore the replay instead of duplicating it
    // — unless the session was just imported and has nothing yet.
    const replay = (): void => {
      if (REPLAY_FIRST) update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'REPLAYED QUESTION\n' } })
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAYED HISTORY\n' } })
      if (!REPLAY_FIRST) update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'REPLAYED QUESTION\n' } })
    }
    if (REPLAY_FIRST) replay()
    respond(message.id!, LOAD_BARE ? {} : { configOptions: configOptions() })
    if (!REPLAY_FIRST) replay()
    return
  }

  if (method === 'session/set_model') {
    // The private method that predates session config options. An agent with
    // neither (FAKE_ACP_NO_CONFIG) cannot change its model while it runs at all.
    if (NO_CONFIG_METHOD) {
      write({ jsonrpc: '2.0', id: message.id!, error: { code: -32601, message: 'Method not found' } })
      return
    }
    respond(message.id!, {})
    return
  }

  if (method === 'session/cancel') {
    if (pending) {
      pending.cancelled = true
      respond(pending.id, { stopReason: 'cancelled' })
      pending = null
    }
    return
  }

  if (method === 'session/prompt') {
    const blocks = (params.prompt as Array<{ text?: string }> | undefined) ?? []
    const text = blocks.map((block) => block.text ?? '').join(' ')
    if (text.includes('fail')) {
      respondError(message.id!, 'fake agent refused the prompt')
      return
    }
    if (text.includes('cancel')) {
      // Never answer: the client has to cancel the turn.
      pending = { id: message.id!, cancelled: false }
      return
    }
    void runTurn(text, 'allow').then(() => {
      respond(message.id!, { stopReason: 'end_turn', usage: { inputTokens: 11, outputTokens: 22, totalTokens: 33 } })
    })
    return
  }

  if (message.id !== undefined) respondError(message.id, `unknown method ${method}`)
}

process.stdin.on('data', (chunk: Buffer) => {
  buffer += chunk.toString('utf8')
  let index = buffer.indexOf('\n')
  while (index !== -1) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line) {
      try {
        handle(JSON.parse(line))
      } catch {
        /* ignore junk, like a real agent with a banner */
      }
    }
    index = buffer.indexOf('\n')
  }
})

process.stdin.on('end', () => process.exit(0))
