/**
 * A pretend shell for the demo's terminal tabs: a line editor and a handful of
 * canned commands, written as the bytes a real pane would send. Nothing runs.
 */
import { HOME, REMOTE_HOME, listDirectory } from './data.ts'

const RESET = '\u001b[0m'
const DIM = '\u001b[2m'
const BOLD = '\u001b[1m'
const GREEN = '\u001b[32m'
const RED = '\u001b[31m'
const BLUE = '\u001b[34m'
const CYAN = '\u001b[36m'
const YELLOW = '\u001b[33m'
const MAGENTA = '\u001b[35m'

type Emit = (data: string, offset: number) => void

export class DemoShell {
  private history = ''
  private line = ''
  offset = 0

  constructor(
    private cwd: string,
    private host: string | null,
    preset: string,
  ) {
    const banner = preset && preset !== 'shell'
      ? `${YELLOW}${preset} would start here — the demo has no CLIs to run, so this is a plain pretend shell.${RESET}\n`
      : ''
    this.history = `${DIM}Last login: ${new Date(Date.now() - 3_600_000).toString().slice(0, 24)} on ttys004${RESET}\n${banner}${this.prompt()}`
    this.offset = this.history.length
  }

  resize(_cols: number, _rows: number): void {
    /* the pretend screen has no geometry to keep */
  }

  /** The whole screen so far, for an attach. */
  screen(): string {
    return this.history
  }

  private home(): string {
    return this.host ? REMOTE_HOME : HOME
  }

  private prompt(): string {
    const where = this.cwd === this.home() ? '~' : this.cwd.replace(this.home(), '~')
    const branch = this.cwd.endsWith('acme-api') ? ` ${MAGENTA}(main)${RESET}` : ''
    const who = this.host ? `deploy@${this.host}` : 'you@macbook'
    return `${GREEN}${who}${RESET} ${BLUE}${where}${RESET}${branch} ${BOLD}$${RESET} `
  }

  private write(data: string, emit: Emit): void {
    this.history += data.replace(/\r\n/g, '\n')
    // Keep the replay bounded, like a pane's scrollback.
    if (this.history.length > 40_000) this.history = this.history.slice(-30_000)
    this.offset += data.length
    emit(data, this.offset)
  }

  input(data: string, emit: Emit): void {
    // Escape sequences (arrows, function keys) are swallowed whole.
    const clean = data.replace(/\u001b\[[0-9;]*[A-Za-z~]|\u001bO[A-Za-z]/g, '')
    for (const char of clean) {
      if (char === '\r' || char === '\n') {
        const command = this.line.trim()
        this.line = ''
        this.write('\r\n', emit)
        const output = command ? this.run(command) : ''
        if (output === '\u000c') {
          this.history = ''
          this.write(`\u001b[2J\u001b[H${this.prompt()}`, emit)
          continue
        }
        this.write(`${output}${this.prompt()}`, emit)
      } else if (char === '\u007f' || char === '\b') {
        if (!this.line) continue
        this.line = this.line.slice(0, -1)
        this.write('\b \b', emit)
      } else if (char === '\u0003') {
        this.line = ''
        this.write(`^C\r\n${this.prompt()}`, emit)
      } else if (char === '\t') {
        continue
      } else if (char >= ' ') {
        this.line += char
        this.write(char, emit)
      }
    }
  }

  private run(command: string): string {
    const [name = '', ...args] = command.split(/\s+/)
    const out = (lines: string[]) => lines.map((line) => `${line}\r\n`).join('')
    switch (name) {
      case 'help':
        return out([
          `${BOLD}This is a pretend shell.${RESET} Nothing runs — the demo has no machine behind it.`,
          `Try: ${CYAN}ls${RESET}, ${CYAN}pwd${RESET}, ${CYAN}cd src${RESET}, ${CYAN}git status${RESET}, ${CYAN}git log${RESET}, ${CYAN}bun test${RESET}, ${CYAN}cat README.md${RESET}, ${CYAN}clear${RESET}`,
        ])
      case 'pwd':
        return out([this.cwd])
      case 'whoami':
        return out([this.host ? 'deploy' : 'you'])
      case 'date':
        return out([new Date().toString().slice(0, 33)])
      case 'echo':
        return out([args.join(' ')])
      case 'clear':
        return '\u000c'
      case 'ls': {
        const listing = listDirectory(this.cwd, this.host)
        if (!listing) return out([])
        const showHidden = args.some((arg) => arg.startsWith('-') && arg.includes('a'))
        const names = listing.entries
          .filter((entry) => showHidden || !entry.hidden)
          .map((entry) => (entry.kind === 'dir' ? `${BLUE}${BOLD}${entry.name}${RESET}` : entry.name))
        return out([names.join('  ')])
      }
      case 'cd': {
        const target = args[0] ?? '~'
        const next = target === '~' ? this.home()
          : target === '..' ? this.cwd.slice(0, this.cwd.lastIndexOf('/')) || '/'
          : target.startsWith('/') ? target
          : target.startsWith('~/') ? `${this.home()}/${target.slice(2)}`
          : `${this.cwd}/${target}`
        const normalized = next.replace(/\/+$/, '') || '/'
        if (!listDirectory(normalized, this.host)) return out([`cd: no such file or directory: ${target}`])
        this.cwd = normalized
        return ''
      }
      case 'cat':
        if (args[0] === 'README.md') {
          return out(['# acme-api', '', 'Orders, users and billing for the Acme storefront.', 'Bun + SQLite, deployed to k8s.', '', '    bun install', '    bun run dev'])
        }
        return out([`cat: ${args[0] ?? ''}: not in the demo's pretend disk`])
      case 'git':
        if (args[0] === 'status') {
          return out([
            'On branch main',
            "Your branch is up to date with 'origin/main'.",
            '',
            'Changes not staged for commit:',
            `\t${RED}modified:   src/middleware/rate-limit.ts${RESET}`,
            `\t${RED}modified:   tests/rate-limit.test.ts${RESET}`,
          ])
        }
        if (args[0] === 'log') {
          return out([
            `${YELLOW}4c1e9d2${RESET} Rate-limit POST /api/orders per API key`,
            `${YELLOW}a07b3f1${RESET} Stream the CSV importer instead of buffering it`,
            `${YELLOW}91d2c48${RESET} Pin the clock in expireOrders so its test stops flaking`,
            `${YELLOW}5e8a0b7${RESET} Add the deploy runbook`,
          ])
        }
        return out([`${DIM}(git ${args.join(' ')} — not simulated in the demo)${RESET}`])
      case 'bun':
      case 'npm':
        if (args[0] === 'test') {
          return out([
            `${BOLD}bun test${RESET} v1.2.23`,
            '',
            `${GREEN}✓${RESET} rate limit > allows the first 120 requests ${DIM}[0.41ms]${RESET}`,
            `${GREEN}✓${RESET} rate limit > blocks the 121st inside the window ${DIM}[0.22ms]${RESET}`,
            `${GREEN}✓${RESET} orders > creates an order ${DIM}[3.10ms]${RESET}`,
            '',
            ` ${GREEN}41 pass${RESET}`,
            ' 0 fail',
            `Ran 41 tests across 4 files. ${DIM}[612.00ms]${RESET}`,
          ])
        }
        return out([`${DIM}(${command} — not simulated in the demo)${RESET}`])
      case 'claude':
      case 'codex':
      case 'gemini':
      case 'opencode':
      case 'cmd':
        return out([`${YELLOW}${name}${RESET} is not installed here — this is the browser demo. Open an agent tab instead (⌘D).`])
      case 'exit':
        return out([`${DIM}(this pretend shell stays open)${RESET}`])
      default:
        return out([`zsh: command not found: ${name}`])
    }
  }
}
