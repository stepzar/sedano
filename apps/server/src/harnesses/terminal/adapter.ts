import type { Adapter, CreateOptions, Driver, DriverHooks } from '../types.ts'
import { TerminalDriver } from './driver.ts'
import { findBinary, PRESETS, presetList } from './presets.ts'

/**
 * Terminal tabs.
 *
 * There is nothing to detect here: tmux is the only hard requirement, and each
 * preset checks its own binary. `readonlyTerminalDriver` lets the manager reach
 * the terminal-specific methods (resize, snapshot, reattach) without leaking
 * casts through the rest of the server.
 */
export const terminalAdapter: Adapter = {
  id: 'shell',
  label: 'Terminal',
  images: false,

  async detect() {
    const tmux = findBinary('tmux')
    return {
      available: tmux !== null,
      bin: tmux,
      version: tmux ? 'tmux' : null,
    }
  },

  models: (_host) => [],

  async create(opts: CreateOptions, hooks: DriverHooks): Promise<Driver> {
    if (!findBinary('tmux')) throw new Error('tmux not found: terminal tabs need tmux (brew install tmux)')
    const presetId = opts.preset ?? PRESETS[0]!.id
    const driver = new TerminalDriver(opts, hooks, presetId)
    await driver.start()
    return driver
  },
}

export { presetList }
