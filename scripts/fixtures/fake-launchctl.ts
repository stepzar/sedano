#!/usr/bin/env bun
/**
 * A fake `launchctl`: remembers whether the one agent is loaded, in
 * `$FAKE_TS_ROOT/launchd.json`, and logs every call to `launchctl.log`.
 * Nothing is ever started.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.env.FAKE_TS_ROOT!
const file = join(root, 'launchd.json')
const args = process.argv.slice(2)
appendFileSync(join(root, 'launchctl.log'), `${JSON.stringify(args)}\n`)
const state: { loaded: boolean } = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { loaded: false }

switch (args[0]) {
  case 'print':
    process.exit(state.loaded ? 0 : 113)
  case 'bootstrap':
    if (state.loaded) process.exit(37)
    if (!existsSync(args[2]!)) process.exit(5)
    writeFileSync(file, JSON.stringify({ loaded: true }))
    process.exit(0)
  case 'bootout':
    writeFileSync(file, JSON.stringify({ loaded: false }))
    process.exit(state.loaded ? 0 : 3)
  default:
    process.exit(64)
}
