/**
 * Remote mode: who may reach this server from outside the Mac, and how.
 *
 * Off by default. The server keeps listening on 127.0.0.1 only; a phone reaches
 * it through `tailscale serve`, which terminates HTTPS on this machine's tailnet
 * name and proxies to the loopback port. So the request that arrives here
 * carries that name as its Host (and forwarding headers), and that is what tells
 * a remote request from a local one:
 *
 *   - local: a loopback Host and no proxy headers. Unchanged: no token needed.
 *   - remote: exactly the configured tailnet name, remote mode on, and a device
 *     token in an HttpOnly cookie that only a pairing code can issue.
 *   - anything else: refused, as before (DNS rebinding).
 *
 * State lives in `~/.sedano/remote.json` (0600). Tokens are stored hashed.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SEDANO_HOME } from './paths.ts'
import { nodeStatus, type TailscaleInstance } from './tailscale.ts'

const FILE = join(SEDANO_HOME, 'remote.json')

export const COOKIE = '__Host-sedano_device'
/** Browsers cap cookie lifetime at 400 days; asking for more is ignored. */
const COOKIE_MAX_AGE = 400 * 24 * 3600
const PAIRING_TTL_MS = 5 * 60_000
const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const PAIRING_LENGTH = 8
/** Wrong codes one pairing code survives before it is thrown away. */
const WRONG_PER_CODE = 5
/** Pairing attempts per minute, for everyone: every remote request comes from the same proxy. */
const ATTEMPTS_PER_MINUTE = 10

export interface RemoteConfig {
  enabled: boolean
  /** Manual override of the tailnet name; null means ask tailscale. */
  hostname: string | null
  /** When set, only this Tailscale login (Tailscale-User-Login) is served. */
  allowedLogin: string | null
  tailscale: {
    instance: TailscaleInstance
    /** Machine name the dedicated instance registers as. */
    nodeName: string
  }
}

interface Device {
  id: string
  name: string
  tokenHash: string
  createdAt: number
  lastSeenAt: number
  login: string | null
  userAgent: string | null
}

export type PublicDevice = Omit<Device, 'tokenHash'>

interface State extends RemoteConfig {
  devices: Device[]
}

const DEFAULTS: State = {
  enabled: false,
  hostname: null,
  allowedLogin: null,
  tailscale: { instance: 'app', nodeName: 'sedano' },
  devices: [],
}

function load(): State {
  if (!existsSync(FILE)) return structuredClone(DEFAULTS)
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8')) as Partial<State>
    return {
      enabled: raw.enabled === true,
      hostname: typeof raw.hostname === 'string' ? raw.hostname : null,
      allowedLogin: typeof raw.allowedLogin === 'string' ? raw.allowedLogin : null,
      tailscale: {
        instance: raw.tailscale?.instance === 'dedicated' ? 'dedicated' : 'app',
        nodeName: typeof raw.tailscale?.nodeName === 'string' ? raw.tailscale.nodeName : DEFAULTS.tailscale.nodeName,
      },
      devices: Array.isArray(raw.devices) ? raw.devices : [],
    }
  } catch (err) {
    // A corrupt file must fail closed: remote stays off rather than guessing.
    console.error('sedano: remote.json unreadable, remote mode off:', err)
    return structuredClone(DEFAULTS)
  }
}

let state = load()

function save(): void {
  mkdirSync(SEDANO_HOME, { recursive: true, mode: 0o700 })
  const tmp = `${FILE}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, FILE)
}

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

const DNS_NAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/
const NODE_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const LOGIN = /^[^\s@]+@[^\s@]+$/

let detectedHostname: string | null = null
let detectedAt = 0

export function remoteConfig(): RemoteConfig {
  const { devices: _devices, ...config } = state
  return structuredClone(config)
}

/** The one name remote requests may carry, or null when there is none yet. */
export function effectiveHostname(): string | null {
  return state.hostname ?? detectedHostname
}

export function detected(): { hostname: string | null; at: number } {
  return { hostname: detectedHostname, at: detectedAt }
}

/** Asks the configured tailscale instance for its own name. Never throws. */
export async function refreshDetectedHostname(): Promise<string | null> {
  const status = await nodeStatus(state.tailscale.instance)
  detectedHostname = status.dnsName
  detectedAt = Date.now()
  return detectedHostname
}

type Listener = (event: { kind: 'config' } | { kind: 'revoke'; deviceId: string }) => void
const listeners: Listener[] = []

/** Told when a live remote connection may have lost its right to exist. */
export function onRemoteChange(listener: Listener): void {
  listeners.push(listener)
}

function emit(event: Parameters<Listener>[0]): void {
  for (const listener of listeners) listener(event)
}

export type ConfigPatch = Partial<Omit<RemoteConfig, 'tailscale'>> & {
  tailscale?: Partial<RemoteConfig['tailscale']>
}

/** Validated at the boundary; a bad value throws and nothing is written. */
export function updateRemoteConfig(patch: ConfigPatch): RemoteConfig {
  const next = structuredClone(state)
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') throw new Error('enabled must be a boolean')
    next.enabled = patch.enabled
  }
  if (patch.hostname !== undefined) {
    const value = patch.hostname === null || patch.hostname === '' ? null : String(patch.hostname).toLowerCase().replace(/\.$/, '')
    if (value !== null && !DNS_NAME.test(value)) throw new Error(`not a DNS name: ${patch.hostname}`)
    next.hostname = value
  }
  if (patch.allowedLogin !== undefined) {
    const value = patch.allowedLogin === null || patch.allowedLogin === '' ? null : String(patch.allowedLogin).toLowerCase()
    if (value !== null && !LOGIN.test(value)) throw new Error(`not a Tailscale login: ${patch.allowedLogin}`)
    next.allowedLogin = value
  }
  if (patch.tailscale?.instance !== undefined) {
    if (patch.tailscale.instance !== 'app' && patch.tailscale.instance !== 'dedicated') {
      throw new Error('tailscale.instance must be app or dedicated')
    }
    next.tailscale.instance = patch.tailscale.instance
  }
  if (patch.tailscale?.nodeName !== undefined) {
    const value = String(patch.tailscale.nodeName).toLowerCase()
    if (!NODE_NAME.test(value)) throw new Error(`not a machine name: ${patch.tailscale.nodeName}`)
    next.tailscale.nodeName = value
  }
  const instanceChanged = next.tailscale.instance !== state.tailscale.instance
  state = next
  if (instanceChanged) detectedHostname = null
  if (!state.enabled) pairing = null
  save()
  emit({ kind: 'config' })
  return remoteConfig()
}

/* ------------------------------------------------------------------ */
/* Classifying a request                                               */
/* ------------------------------------------------------------------ */

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'forwarded', 'tailscale-user-login', 'tailscale-funnel-request']

export type Access =
  | { kind: 'local' }
  | { kind: 'remote'; hostname: string; login: string | null; loginName: string | null; device: PublicDevice | null }
  | { kind: 'forbidden'; reason: string }

function bareHost(value: string | null): string | null {
  if (!value) return null
  return value.trim().toLowerCase().replace(/:443$/, '').replace(/\.$/, '')
}

function hash(text: string): Buffer {
  return createHash('sha256').update(text).digest()
}

function cookieValue(req: Request, name: string): string | null {
  const header = req.headers.get('cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim()
  }
  return null
}

/** Every device is compared, match or not: the time taken says nothing about which. */
function deviceForToken(token: string | null): Device | null {
  if (!token) return null
  const presented = hash(token)
  let found: Device | null = null
  for (const device of state.devices) {
    const stored = Buffer.from(device.tokenHash, 'hex')
    if (stored.length === presented.length && timingSafeEqual(stored, presented)) found = device
  }
  return found
}

function publicDevice(device: Device): PublicDevice {
  const { tokenHash: _hash, ...rest } = device
  return rest
}

const SEEN_WRITE_INTERVAL = 5 * 60_000

export function classify(req: Request): Access {
  const host = req.headers.get('host')
  const proxied = PROXY_HEADERS.some((name) => req.headers.has(name))
  if (!proxied && (!host || LOOPBACK_HOST.test(host))) return { kind: 'local' }

  if (!state.enabled) return { kind: 'forbidden', reason: 'forbidden host' }
  if (req.headers.has('tailscale-funnel-request')) return { kind: 'forbidden', reason: 'funnel requests are refused' }
  const name = effectiveHostname()
  if (!name) return { kind: 'forbidden', reason: 'forbidden host' }

  // tailscale serve keeps the Host and adds X-Forwarded-Host; either may be all
  // a proxy passes on, but whatever is there must be exactly this name.
  const forwarded = bareHost(req.headers.get('x-forwarded-host'))
  const direct = host && !LOOPBACK_HOST.test(host) ? bareHost(host) : null
  if (!forwarded && !direct) return { kind: 'forbidden', reason: 'forbidden host' }
  if ((forwarded && forwarded !== name) || (direct && direct !== name)) return { kind: 'forbidden', reason: 'forbidden host' }

  const origin = req.headers.get('origin')
  if (origin && origin.toLowerCase() !== `https://${name}`) return { kind: 'forbidden', reason: 'forbidden origin' }

  const login = req.headers.get('tailscale-user-login')?.trim().toLowerCase() || null
  if (state.allowedLogin && login !== state.allowedLogin) return { kind: 'forbidden', reason: 'this Tailscale account is not allowed' }

  const device = deviceForToken(cookieValue(req, COOKIE))
  if (device) {
    const now = Date.now()
    const stale = now - device.lastSeenAt > SEEN_WRITE_INTERVAL
    device.lastSeenAt = now
    if (login) device.login = login
    if (stale) save()
  }
  return {
    kind: 'remote',
    hostname: name,
    login,
    loginName: req.headers.get('tailscale-user-name'),
    device: device ? publicDevice(device) : null,
  }
}

/* ------------------------------------------------------------------ */
/* Pairing                                                             */
/* ------------------------------------------------------------------ */

let pairing: { hash: Buffer; expiresAt: number; wrong: number } | null = null
let attempts: number[] = []

function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

export function pairingUrl(code: string): string | null {
  const name = effectiveHostname()
  return name ? `https://${name}/pair?code=${code}` : null
}

/** A fresh one-time code; any earlier one stops working. */
export function createPairingCode(): { code: string; display: string; url: string | null; expiresAt: number } {
  if (!state.enabled) throw new Error('remote mode is off')
  const bytes = randomBytes(PAIRING_LENGTH)
  let code = ''
  for (const byte of bytes) code += PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length]
  const expiresAt = Date.now() + PAIRING_TTL_MS
  pairing = { hash: hash(code), expiresAt, wrong: 0 }
  return { code, display: `${code.slice(0, 4)}-${code.slice(4)}`, url: pairingUrl(code), expiresAt }
}

export function cancelPairing(): void {
  pairing = null
}

export function pairingStatus(): { active: boolean; expiresAt: number | null } {
  const active = pairing !== null && pairing.expiresAt > Date.now()
  return { active, expiresAt: active ? pairing!.expiresAt : null }
}

export type PairResult =
  | { ok: true; token: string; device: PublicDevice }
  | { ok: false; status: 401 | 429; error: string }

export function pair(code: string, meta: { name?: string | null; login: string | null; userAgent: string | null }): PairResult {
  const now = Date.now()
  attempts = attempts.filter((at) => now - at < 60_000)
  if (attempts.length >= ATTEMPTS_PER_MINUTE) return { ok: false, status: 429, error: 'too many pairing attempts; wait a minute' }
  attempts.push(now)

  if (!pairing || pairing.expiresAt <= now) {
    pairing = null
    return { ok: false, status: 401, error: 'no pairing code is active; create one on the Mac' }
  }
  const presented = hash(normalizeCode(code))
  if (!timingSafeEqual(presented, pairing.hash)) {
    pairing.wrong += 1
    if (pairing.wrong >= WRONG_PER_CODE) pairing = null
    return { ok: false, status: 401, error: 'wrong pairing code' }
  }
  pairing = null

  const token = randomBytes(32).toString('base64url')
  const device: Device = {
    id: crypto.randomUUID(),
    name: (meta.name?.trim() || guessDeviceName(meta.userAgent)).slice(0, 64),
    tokenHash: hash(token).toString('hex'),
    createdAt: now,
    lastSeenAt: now,
    login: meta.login,
    userAgent: meta.userAgent?.slice(0, 256) ?? null,
  }
  state.devices.push(device)
  save()
  return { ok: true, token, device: publicDevice(device) }
}

function guessDeviceName(userAgent: string | null): string {
  if (!userAgent) return 'Device'
  if (/iPhone/.test(userAgent)) return 'iPhone'
  if (/iPad/.test(userAgent)) return 'iPad'
  if (/Android/.test(userAgent)) return 'Android'
  if (/Macintosh/.test(userAgent)) return 'Mac'
  return 'Device'
}

export function sessionCookie(token: string): string {
  return `${COOKIE}=${token}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Strict`
}

export function clearedCookie(): string {
  return `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`
}

/* ------------------------------------------------------------------ */
/* Devices                                                             */
/* ------------------------------------------------------------------ */

export function listDevices(): PublicDevice[] {
  return state.devices.map(publicDevice)
}

export function revokeDevice(id: string): boolean {
  const before = state.devices.length
  state.devices = state.devices.filter((device) => device.id !== id)
  if (state.devices.length === before) return false
  save()
  emit({ kind: 'revoke', deviceId: id })
  return true
}
