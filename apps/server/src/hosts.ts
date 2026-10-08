/**
 * Which SSH hosts sedano may talk to, and who says so.
 *
 * The candidates are the literal `Host` aliases in `~/.ssh/config` — the only
 * place a destination is actually defined. Which of them sedano offers is
 * **your** choice: nothing is imported until you tick it in Settings, because a
 * machine with a dozen config entries should not put a dozen servers in every
 * workspace picker. The selection lives in `~/.sedano/config.json`.
 *
 * That list is not decoration: it is the allowlist. Every host that reaches an
 * API endpoint, a session or a transport is checked against it, so a destination
 * nobody ticked — `user@10.0.0.1`, a typo, a name a client made up — never
 * becomes an `ssh` argument, no matter how well-formed it looks.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { SSH_CONFIG, SEDANO_HOME } from './paths.ts'

const CONFIG_FILE = join(SEDANO_HOME, 'config.json')

/**
 * The ssh config to read. Overridable so the tests can parse fixtures without
 * going anywhere near the real one; nothing else sets it.
 */
function sshConfigPath(): string {
  return process.env.SEDANO_SSH_CONFIG || SSH_CONFIG
}

/**
 * A host is handed straight to `ssh`, so it must be a host name and not an
 * argument: a value beginning with `-` would be read as an ssh option
 * (e.g. `-oProxyCommand=…`) and turn into local command execution.
 */
const SAFE_HOST = /^[A-Za-z0-9._@][A-Za-z0-9._@-]*$/

export function assertSafeHost(host: string): void {
  if (!SAFE_HOST.test(host)) throw new Error(`refusing unsafe ssh host: ${host}`)
}

/** True when the string is *shaped* like a destination. Not permission to use it. */
export function isSafeHost(host: string): boolean {
  return SAFE_HOST.test(host)
}

interface Config {
  /** The hosts you enabled, in the order you enabled them. */
  hosts: string[]
}

/**
 * Files this module reads on every authorization check, remembered with the
 * mtime they had. `isAuthorizedHost` runs for every transport, every endpoint
 * and every ssh call, and each run used to re-read and re-parse the ssh config
 * and all of its includes. A handful of `stat`s answers "has anything changed"
 * instead; any edit, new include or deleted file changes a stamp and the next
 * call reads everything again.
 */
function stamp(paths: string[]): string {
  return paths
    .map((path) => {
      try {
        const info = statSync(path)
        return `${path}:${info.mtimeMs}:${info.size}`
      } catch {
        return `${path}:-`
      }
    })
    .join('|')
}

let configCache: { stamp: string; config: Config } | null = null

function readConfig(): Config {
  const current = stamp([CONFIG_FILE])
  if (configCache?.stamp === current) return { hosts: [...configCache.config.hosts] }
  const config = readConfigFile()
  configCache = { stamp: current, config }
  return { hosts: [...config.hosts] }
}

function readConfigFile(): Config {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Partial<Config>
    return { hosts: Array.isArray(parsed.hosts) ? parsed.hosts.filter((h) => typeof h === 'string') : [] }
  } catch {
    return { hosts: [] }
  }
}

function writeConfig(config: Config): void {
  if (!existsSync(SEDANO_HOME)) mkdirSync(SEDANO_HOME, { recursive: true, mode: 0o700 })
  writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`)
  // Two writes inside one mtime tick must not read back the first.
  configCache = null
}

/**
 * Everything after an unquoted `#` is a comment, and ssh treats it as one
 * wherever it appears. Reading it as part of the line is how `Host vps # prod`
 * turned into three destinations, one of them named `#`.
 */
function stripComment(line: string): string {
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '"') quoted = !quoted
    else if (char === '#' && !quoted) return line.slice(0, index)
  }
  return line
}

/**
 * A `Host` token names a destination only when it is a literal name.
 *
 * `Host *`, `Host *.example.com` and `Host !staging` are *patterns*: they attach
 * options to other destinations and there is nothing to connect to. Offering
 * them puts a machine called `*` in the picker and an `ssh '*'` behind it.
 */
function isLiteralAlias(token: string): boolean {
  if (!token || token.startsWith('!')) return false
  if (token.includes('*') || token.includes('?')) return false
  return SAFE_HOST.test(token)
}

/**
 * `Include` is followed by one or more paths, relative ones rooted at `~/.ssh`,
 * and real configs use it (`Include ~/.ssh/config.d/*`). Claiming to support it
 * and then not reading the files is how an enabled host silently stops being
 * enabled, so the includes are expanded here — with a depth bound, because an
 * include cycle is a config someone can write by accident.
 */
const MAX_INCLUDE_DEPTH = 8

function expandIncludePattern(pattern: string, base: string, watched: Set<string>): string[] {
  const unquoted = pattern.replace(/^"(.*)"$/, '$1')
  const expanded = unquoted.startsWith('~/')
    ? join(process.env.HOME ?? '', unquoted.slice(2))
    : isAbsolute(unquoted)
      ? unquoted
      : join(base, unquoted)
  if (!expanded.includes('*') && !expanded.includes('?')) {
    // Watched even when missing: creating it later is a change.
    watched.add(expanded)
    return existsSync(expanded) ? [expanded] : []
  }
  // A glob is resolved against the deepest fixed directory, the way ssh does it.
  const star = expanded.search(/[*?]/)
  const root = dirname(expanded.slice(0, star + 1))
  const relative = expanded.slice(root.length + 1)
  // A file added to or removed from the directory changes its mtime.
  watched.add(root)
  try {
    return [...new Bun.Glob(relative).scanSync({ cwd: root, dot: true, onlyFiles: true })]
      .map((name) => join(root, name))
      .sort()
  } catch {
    return []
  }
}

function collectHosts(
  path: string,
  depth: number,
  seen: Set<string>,
  hosts: string[],
  watched: Set<string>,
): void {
  if (depth > MAX_INCLUDE_DEPTH || seen.has(path)) return
  seen.add(path)
  watched.add(path)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return
  }
  for (const raw of text.split('\n')) {
    const line = stripComment(raw).trim()
    if (!line) continue
    const include = /^Include\s+(.+)$/i.exec(line)
    if (include) {
      for (const pattern of include[1]!.trim().split(/\s+/)) {
        for (const file of expandIncludePattern(pattern, dirname(path), watched)) {
          collectHosts(file, depth + 1, seen, hosts, watched)
        }
      }
      continue
    }
    // `Host a b c` is three aliases for one block, and only the first used to be
    // picked up — the others were simply unreachable from the UI.
    const match = /^Host(?:\s*=\s*|\s+)(.+)$/i.exec(line)
    if (!match) continue
    for (const token of match[1]!.trim().split(/\s+/)) {
      const alias = token.replace(/^"(.*)"$/, '$1')
      if (!isLiteralAlias(alias)) continue
      if (!hosts.includes(alias)) hosts.push(alias)
    }
  }
}

/** Every destination `~/.ssh/config` defines; patterns are not destinations. */
let hostsCache: { stamp: string; watched: string[]; hosts: string[] } | null = null

export function sshConfigHosts(): string[] {
  const root = sshConfigPath()
  if (hostsCache && hostsCache.watched[0] === root && stamp(hostsCache.watched) === hostsCache.stamp) {
    return [...hostsCache.hosts]
  }
  const hosts: string[] = []
  // Every file read, every glob directory and every literal include (present or
  // not) — the set whose stamps decide whether this answer is still true.
  const watched = new Set<string>([root])
  collectHosts(root, 0, new Set<string>(), hosts, watched)
  const list = [...watched]
  hostsCache = { stamp: stamp(list), watched: list, hosts }
  return [...hosts]
}

/** The hosts you enabled. One dropped from the ssh config is dropped here too. */
export function enabledHosts(): string[] {
  const available = new Set(sshConfigHosts())
  return readConfig().hosts.filter((host) => available.has(host))
}

/** Every host we may hand to `ssh`: only the ones you chose. */
export function allHosts(): string[] {
  return enabledHosts()
}

/** True only for an alias that is in the ssh config *and* ticked in Settings. */
export function isAuthorizedHost(host: string): boolean {
  return enabledHosts().includes(host)
}

/**
 * The one gate. Every endpoint, every session and every transport goes through
 * it, because "looks like a host name" was never a reason to connect anywhere:
 * an exact match against the hosts you enabled is.
 *
 * The message names the alternative on purpose — a host that dropped out of the
 * ssh config, or one that was never ticked, looks identical from the client.
 */
export function assertAuthorizedHost(host: string): void {
  assertSafeHost(host)
  if (isAuthorizedHost(host)) return
  const enabled = enabledHosts()
  const detail = enabled.length ? `enabled hosts: ${enabled.join(', ')}` : 'no hosts are enabled'
  throw new Error(`host "${host}" is not enabled in settings — ${detail}`)
}

/**
 * Normalise a host coming off the wire: `null`/`''` is this machine, anything
 * else must be an enabled alias. Endpoints call this instead of trusting the
 * query string.
 */
export function requireHost(host: string | null | undefined): string | null {
  if (host === null || host === undefined || host === '') return null
  assertAuthorizedHost(host)
  return host
}

export function setHostEnabled(host: string, enabled: boolean): void {
  assertSafeHost(host)
  const config = readConfig()
  const hosts = new Set(config.hosts)
  if (enabled) {
    // Only an alias the ssh config defines *right now*. Enabling anything else
    // would write a destination into our own config that ssh cannot resolve —
    // and would make the allowlist a list of whatever was asked for.
    if (!sshConfigHosts().includes(host)) {
      throw new Error(`"${host}" is not a Host alias in ${sshConfigPath()}`)
    }
    hosts.add(host)
  } else hosts.delete(host)
  writeConfig({ hosts: [...hosts] })
}
