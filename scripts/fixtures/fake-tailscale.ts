#!/usr/bin/env bun
/**
 * A fake `tailscale` CLI, so remote mode is tested without touching a tailnet.
 *
 * State is one JSON file, `$FAKE_TS_ROOT/state.json`, read and written per
 * invocation so a test can change the node while the server runs:
 *
 *   { "backendState": "Running", "dnsName": "sedano.tail-test.ts.net",
 *     "login": "user@example.com",
 *     "serve": { "Web": {...}, "AllowFunnel": {...} } }
 *
 * Every invocation is appended to `$FAKE_TS_ROOT/tailscale.log` as a JSON argv.
 * Supported: `[--socket S] status --json`, `serve status --json`,
 * `serve --bg --https=443 <url>`, `serve --https=443 off`, `up ...`.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.env.FAKE_TS_ROOT
if (!root) {
  console.error('fake-tailscale: FAKE_TS_ROOT is not set')
  process.exit(2)
}
const stateFile = join(root, 'state.json')
appendFileSync(join(root, 'tailscale.log'), `${JSON.stringify(process.argv.slice(2))}\n`)

interface State {
  backendState: string
  dnsName: string
  login: string
  serve: { Web?: Record<string, { Handlers: Record<string, { Proxy: string }> }>; AllowFunnel?: Record<string, boolean> }
}
const state: State = existsSync(stateFile)
  ? JSON.parse(readFileSync(stateFile, 'utf8'))
  : { backendState: 'Running', dnsName: 'sedano.tail-test.ts.net', login: 'user@example.com', serve: {} }
const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2))

let args = process.argv.slice(2)
if (args[0] === '--socket') args = args.slice(2)
const key = `${state.dnsName}:443`

if (args[0] === 'status' && args[1] === '--json') {
  console.log(
    JSON.stringify({
      BackendState: state.backendState,
      AuthURL: state.backendState === 'NeedsLogin' ? 'https://login.tailscale.com/a/fake' : '',
      Self: { DNSName: `${state.dnsName}.`, UserID: 7 },
      User: { '7': { LoginName: state.login } },
      CurrentTailnet: { Name: 'fake-tailnet' },
    }),
  )
  process.exit(0)
}

if (args[0] === 'serve' && args[1] === 'status' && args[2] === '--json') {
  console.log(JSON.stringify(state.serve))
  process.exit(0)
}

if (args[0] === 'serve' && args.includes('off')) {
  if (!state.serve.Web?.[key]) {
    console.error('error: handler does not exist')
    process.exit(1)
  }
  delete state.serve.Web[key]
  save()
  process.exit(0)
}

if (args[0] === 'serve' && args.includes('--bg') && args.includes('--https=443')) {
  const target = args[args.length - 1]!
  state.serve.Web ??= {}
  state.serve.Web[key] = { Handlers: { '/': { Proxy: target } } }
  save()
  console.log(`Available within your tailnet:\n\nhttps://${state.dnsName}/\n|-- proxy ${target}`)
  process.exit(0)
}

if (args[0] === 'up') {
  if (state.backendState === 'Running') process.exit(0)
  console.error('\nTo authenticate, visit:\n\n\thttps://login.tailscale.com/a/fake-login\n')
  // Like the real CLI: waits for the browser. Bounded, so a missed kill cannot leak it.
  setTimeout(() => process.exit(0), 30_000)
} else {
  console.error(`fake-tailscale: unsupported ${JSON.stringify(args)}`)
  process.exit(2)
}
