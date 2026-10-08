#!/usr/bin/env bun
/**
 * Probe an ACP agent: handshake, then open a session and report what it says.
 *
 * Used to verify the ACP client against the real agents on this machine
 * (`opencode acp`, `codex-acp`, `gemini --acp`) without spending a single token
 * of quota: initialize and session/new are pure protocol.
 *
 *   bun scripts/acp-probe.ts opencode acp
 *   bun scripts/acp-probe.ts codex-acp
 *   bun scripts/acp-probe.ts gemini --acp
 */
import { AcpClient } from '../apps/server/src/harnesses/acp/client.ts'

const command = Bun.argv.slice(2)
if (command.length === 0) {
  console.error('usage: bun scripts/acp-probe.ts <agent> [acp-flag]')
  process.exit(2)
}

const cwd = process.env.SEDANO_PROBE_CWD ?? process.cwd()
const client = new AcpClient({
  command,
  cwd,
  onNotification: (method, params) =>
    console.log(`   ← notification ${method} ${JSON.stringify(params).slice(0, 160)}`),
  onRequest: async (method, params) => {
    console.log(`   ← request ${method} ${JSON.stringify(params).slice(0, 160)}`)
    // Answer the ones that block a handshake: a permission prompt with no answer
    // stalls the agent, which is exactly the kind of thing worth discovering here.
    if (method === 'session/request_permission') return { outcome: { outcome: 'cancelled' } }
    if (method === 'fs/read_text_file') return { content: '' }
    if (method === 'fs/write_text_file') return null
    return {}
  },
  onStderr: () => undefined,
})

const started = Date.now()
client.start()
try {
  const initTimeout = Number(process.env.SEDANO_PROBE_TIMEOUT ?? 60_000)
  const init = await client.initialize(initTimeout)
  console.log(`initialize ok in ${Date.now() - started}ms`)
  console.log(JSON.stringify(init, null, 2).slice(0, 1200))

  const session = await client.request<Record<string, unknown>>(
    'session/new',
    { cwd, mcpServers: [] },
    90_000,
  )
  console.log('session/new ok')
  console.log(JSON.stringify(session, null, 2).slice(0, 20_000))
  const model = process.env.SEDANO_PROBE_MODEL
  if (model) {
    const changed = await client.request<Record<string, unknown>>(
      'session/set_config_option',
      { sessionId: session.sessionId, configId: 'model', type: 'id', value: model },
      30_000,
    )
    console.log(`session/set_config_option model=${model} ok`)
    console.log(JSON.stringify(changed, null, 2).slice(0, 100_000))
  }
  const effort = process.env.SEDANO_PROBE_EFFORT
  if (effort) {
    const changed = await client.request<Record<string, unknown>>(
      'session/set_config_option',
      { sessionId: session.sessionId, configId: 'reasoning_effort', type: 'id', value: effort },
      30_000,
    )
    console.log(`session/set_config_option reasoning_effort=${effort} ok`)
    console.log(JSON.stringify(changed, null, 2).slice(0, 100_000))
  }
  console.log(`\nacp-probe: ${command.join(' ')} speaks ACP`)
} catch (error) {
  console.error(`\nacp-probe: FAILED — ${error instanceof Error ? error.message : String(error)}`)
  await client.close()
  process.exit(1)
}

await client.close()
