import { existsSync, statSync } from 'node:fs'
import { join, normalize } from 'node:path'
import type { Ack, AckError, ClientMsg, CommandId, HarnessCommand, HarnessId, ServerMsg } from '@shared'
import { asMachineColorId, asTabOp } from '@shared'
import { addClient, broadcast, clientCount, removeClient, type Client } from './bus.ts'
import { machineColors, setMachineColor } from './db.ts'
import * as db from './db.ts'
import { deleteAttachment, readAttachment, saveAttachment, sweepAttachments } from './attachments.ts'
import * as manager from './manager.ts'
import { applyTabs, openTabs, pruneTabs } from './tabs.ts'
import { listDirectoryForAsync, homeForAsync } from './fs.ts'
import { openFile } from './open-file.ts'
import { writeExportFile } from './export-file.ts'
import { SEDANO_HOME, SEDANO_INSTANCE } from './paths.ts'
import { SEDANO_BUILD, SEDANO_VERSION } from './version.ts'
import { listProjects, sshHosts } from './projects.ts'
import { allHosts, requireHost, setHostEnabled, sshConfigHosts } from './hosts.ts'
import { presetList } from './harnesses/terminal/presets.ts'
import { harnessCommands } from './harnesses/skills.ts'
import { commandCodeHistory, findNative, scanFolder } from './imports.ts'
import {
  cancelWhisperDownload,
  deleteWhisperModel,
  downloadWhisperModel,
  resolveVoice,
  setConfig,
  transcribe,
  type VoiceConfig,
} from './transcribe.ts'
import { ACCOUNT_READERS, accountReaders, currentLimits, refreshLimits, setAccountReader, startLimitPoller, type AccountReader } from './usage/index.ts'
import { unhandledEvents } from './harnesses/coverage.ts'
import * as remote from './remote.ts'
import { handleRemoteApi, unpaired } from './remote-http.ts'
import { stopLogin } from './tailscale.ts'

const PORT = Number(process.env.SEDANO_PORT ?? 7788)
const HOST = process.env.SEDANO_HOST ?? '127.0.0.1'
// A compiled sidecar has no source tree around it (`import.meta.dir` is inside the
// binary), so the desktop app points this at the copy it bundles in Resources.
const UI_DIST = process.env.SEDANO_UI_DIST ?? join(import.meta.dir, '../../ui/dist')

/** Slash commands per (harness, folder, machine), briefly. */
const commandCache = new Map<string, { at: number; commands: HarnessCommand[] }>()
const COMMAND_TTL = 60_000

// The last line of defence, not the error handling. Bun ends the process on an
// unhandled rejection, and one stray promise — a background drain, a driver
// callback, a malformed message — used to take every running session down with
// it. Logged loudly instead: a failed operation is a bug to fix, a dead server
// is an outage.
process.on('unhandledRejection', (reason) => {
  console.error('sedano: unhandled rejection (server kept running):', reason)
})

manager.restore()
// Before any client connects: a tab naming a session that is gone is dropped
// now, while no launch can be half-way through creating it.
pruneTabs((id) => Boolean(manager.getSession(id)))
manager.startMetricsTicker()
startLimitPoller()
// Images pasted into a composer the app never got to send. Swept at boot and not
// on a timer: an upload is only abandoned because the app went away with it, so
// a start is the one moment that becomes knowable (see `sweepAttachments`).
sweepAttachments()

function snapshot() {
  return {
    sessions: manager.listSessions(),
    limits: currentLimits(),
    projects: listProjects(),
    machineColors: machineColors(),
    tabs: openTabs(),
  }
}

interface WsData {
  client: Client | null
  /** The paired device a remote socket belongs to; null for a local one. */
  deviceId: string | null
}

function makeClient(ws: { send: (data: string) => void }): Client {
  const client: Client = {
    id: crypto.randomUUID(),
    subscribed: new Set<string>(),
    send(msg: ServerMsg) {
      ws.send(JSON.stringify(msg))
    },
    sendText(text: string) {
      ws.send(text)
    },
  }
  return client
}

/**
 * Only the app itself may talk to this API.
 *
 * The desktop shell serves its UI from `tauri://localhost` (`tauri.localhost`
 * on Windows and Linux), so every call is cross-origin; without an allowlist
 * any page open in any local browser could drive the API (and the API can
 * spawn processes). Any port on localhost was too wide: every dev server a
 * person runs is a page on localhost. So it is exactly the webview, the bundle
 * this server serves on its own port, and — for the dev copy only — the vite
 * dev server. Requests without an Origin header come from native clients and
 * are allowed.
 */
function allowedOrigins(): Set<string> {
  const origins = new Set(['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'])
  const ports = [String(PORT)]
  if (SEDANO_INSTANCE === 'dev') ports.push(process.env.SEDANO_UI_PORT ?? '5174')
  for (const port of ports) {
    for (const name of ['127.0.0.1', 'localhost', '[::1]']) origins.add(`http://${name}:${port}`)
  }
  return origins
}
const ALLOWED_ORIGINS = allowedOrigins()

function cors(origin: string | null): Record<string, string> {
  if (!origin) return { 'access-control-allow-origin': '*' }
  if (!ALLOWED_ORIGINS.has(origin)) return {}
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'content-type, x-filename',
    // DELETE is here for taking back an unsent attachment: without it the
    // browser's preflight refuses the call before it is ever made.
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    vary: 'origin',
  }
}

function originAllowed(req: Request): boolean {
  const origin = req.headers.get('origin')
  return !origin || ALLOWED_ORIGINS.has(origin)
}

/**
 * The names this server answers to.
 *
 * The Origin check alone does not stop DNS rebinding: a page on `evil.test`
 * that re-points its name at 127.0.0.1 makes its requests *same-origin*, and a
 * browser sends no Origin header on a same-origin GET — so `/api/fs`, `/api/state`
 * and the attachments were readable by any site. The Host header still carries
 * the attacker's name in that case, so only loopback names are served — plus,
 * with remote mode on, exactly this Mac's tailnet name and only for a paired
 * device (see `remote.ts#classify`).
 */

/**
 * Hashed bundles never change under their name; the index (and anything served
 * in its place) must be revalidated so a new build is picked up.
 */
function cacheControl(pathname: string): string {
  if (pathname.startsWith('/assets/')) return 'public, max-age=31536000, immutable'
  if (/\.(png|svg|ico)$/.test(pathname)) return 'public, max-age=86400'
  return 'no-cache'
}

function serveStatic(pathname: string): Response {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    // A malformed escape (e.g. `/%`) must not throw out of the fetch handler.
    return new Response('bad request', { status: 400 })
  }
  const safe = normalize(decoded).replace(/^(\.\.[/\\])+/, '')
  const candidate = join(UI_DIST, safe)
  if (candidate.startsWith(UI_DIST) && existsSync(candidate) && statSync(candidate).isFile()) {
    const headers: Record<string, string> = { 'cache-control': cacheControl(safe) }
    if (candidate.endsWith('.webmanifest')) headers['content-type'] = 'application/manifest+json'
    return new Response(Bun.file(candidate), { headers })
  }
  const index = join(UI_DIST, 'index.html')
  if (existsSync(index)) return new Response(Bun.file(index), { headers: { 'cache-control': 'no-cache' } })
  return new Response(
    'sedano: UI not built yet. Run `bun run dev` (vite on :5174) or `bun run build:ui`.',
    { status: 404 },
  )
}

const server = Bun.serve<WsData>({
  port: PORT,
  hostname: HOST,
  idleTimeout: 0,
  async fetch(req, srv) {
    const url = new URL(req.url)
    const access = remote.classify(req)
    if (access.kind === 'forbidden') return new Response(access.reason, { status: 403 })
    // A remote request that got this far already carried the one allowed Origin.
    if (access.kind === 'remote' && !access.device) return unpaired(req, url, access, serveStatic)
    const originOk = access.kind === 'remote' || originAllowed(req)

    const headers = cors(req.headers.get('origin'))

    if (url.pathname === '/api/ws') {
      if (!originOk) return new Response('forbidden origin', { status: 403 })
      const deviceId = access.kind === 'remote' ? access.device!.id : null
      const ok = srv.upgrade(req, { data: { client: null, deviceId } })
      return ok ? undefined : new Response('websocket upgrade failed', { status: 400 })
    }

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers })
    }

    if (url.pathname.startsWith('/api/') && !originOk) {
      return new Response('forbidden origin', { status: 403 })
    }

    const remoteResponse = await handleRemoteApi(req, url, access, PORT)
    if (remoteResponse) {
      // The desktop shell calls from its own origin: without these the answer
      // is thrown away by the webview and reads as a network error.
      for (const [name, value] of Object.entries(headers)) remoteResponse.headers.set(name, value)
      return remoteResponse
    }

    if (url.pathname === '/api/state') {
      return Response.json(snapshot(), { headers })
    }

    /**
     * The harness catalog of one machine. `host` decides *where* the binaries
     * are looked for — the pickers must offer what the machine that will run the
     * session actually has, not what this laptop happens to have installed.
     *
     * Every endpoint below runs its `host` through `requireHost` first: a name
     * that is not an alias you enabled is refused here, before it can become an
     * ssh argument, however well-formed it looks.
     */
    if (url.pathname === '/api/harnesses') {
      try {
        return Response.json(
          { harnesses: await manager.harnessCatalog(requireHost(url.searchParams.get('host'))) },
          { headers },
        )
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : String(err) },
          { status: 400, headers },
        )
      }
    }

    /** Protocol types a harness sent that sedano has no mapping for (Settings → Unhandled events). */
    if (url.pathname === '/api/unhandled' && req.method === 'GET') {
      return Response.json({ events: unhandledEvents() }, { headers })
    }

    if (url.pathname === '/api/health') {
      return Response.json(
        // `home` and `instance` let a desktop shell tell its own server from
        // another Sedano's before attaching to it, and `version` lets it refuse
        // a server left running by an older release (see `lib.rs`).
        {
          ok: true,
          clients: clientCount(),
          sessions: manager.listSessions().length,
          home: SEDANO_HOME,
          instance: SEDANO_INSTANCE,
          pid: process.pid,
          version: SEDANO_VERSION,
          build: SEDANO_BUILD,
        },
        { headers },
      )
    }

    if (url.pathname === '/api/caps') {
      try {
        return Response.json(await manager.capabilities(requireHost(url.searchParams.get('host'))), { headers })
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : String(err) },
          { status: 400, headers },
        )
      }
    }

    /**
     * A harness was actually selected: refresh its token-free catalog now and
     * check the external ACP executable for a newer stable release. This is
     * read-only; installation remains an explicit command the UI can show.
     */
    if (url.pathname === '/api/harness-check' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { host?: string | null; harness?: string }
      if (!body.harness) return Response.json({ error: 'harness is required' }, { status: 400, headers })
      try {
        return Response.json(
          await manager.inspectHarness(requireHost(body.host ?? null), body.harness as HarnessId),
          { headers },
        )
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 400, headers },
        )
      }
    }

    /** An explicit click updates the selected adapter, then refreshes its catalog. */
    if (url.pathname === '/api/harness-update' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { host?: string | null; harness?: string }
      if (!body.harness) return Response.json({ error: 'harness is required' }, { status: 400, headers })
      try {
        return Response.json(
          await manager.updateHarness(requireHost(body.host ?? null), body.harness as HarnessId),
          { headers },
        )
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 400, headers },
        )
      }
    }

    /** Read-only daily sweep, or an explicit sweep/updater across enabled machines. */
    if (url.pathname === '/api/harness-sync' && req.method === 'GET') {
      return Response.json({ ...manager.harnessSyncStatus(), automatic: backgroundSyncOn() }, { headers })
    }
    if (url.pathname === '/api/harness-sync' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { mode?: string; automatic?: unknown }
      if (typeof body.automatic === 'boolean') {
        db.kvSet(BACKGROUND_SYNC_KEY, body.automatic ? 'on' : 'off')
        return Response.json({ ...manager.harnessSyncStatus(), automatic: backgroundSyncOn() }, { headers })
      }
      if (body.mode !== 'check' && body.mode !== 'upgrade') {
        return Response.json({ error: 'mode must be check or upgrade' }, { status: 400, headers })
      }
      return Response.json({ ...manager.startHarnessSync(body.mode, true), automatic: backgroundSyncOn() }, { headers })
    }

    /**
     * Which SSH hosts sedano offers. The candidates are the `Host` aliases in
     * `~/.ssh/config`; which of them are enabled is your choice in Settings, and
     * only those reach a picker. Enabling one is what makes a server available
     * without putting every entry in your ssh config in front of you.
     */
    if (url.pathname === '/api/hosts') {
      // `status` carries what we know about each candidate, so the panel can
      // redraw from the answer instead of waiting for the broadcast that follows.
      const payload = () => ({ hosts: allHosts(), available: sshConfigHosts(), status: manager.hostStatusList() })
      if (req.method === 'GET') return Response.json(payload(), { headers })
      if (req.method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as { host?: string; enabled?: boolean }
        if (!body.host) return Response.json({ error: 'host is required' }, { status: 400, headers })
        try {
          setHostEnabled(body.host, body.enabled !== false)
          listProjects(true)
          // The enabled hosts are part of every machine's capabilities, so the
          // cached catalogs are dropped rather than refreshed one by one.
          manager.invalidateCapabilities()
          broadcast({ t: 'caps', caps: await manager.capabilities() })
          return Response.json(payload(), { headers })
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : String(err) },
            { status: 400, headers },
          )
        }
      }
    }

    /**
     * The colour each machine is recognised by (see `MachineColorId`).
     *
     * Kept on the server rather than in the browser's storage because it is a
     * fact about the machines this server talks to, not about the window you
     * are looking at them from: the desktop shell and a browser tab must not
     * disagree about which colour is `vps`, and the answer has to survive the
     * app being reinstalled. `host` is validated by the same gate as everywhere
     * else, so a colour cannot be stored for a machine nobody enabled.
     */
    if (url.pathname === '/api/machine-colors') {
      if (req.method === 'GET') return Response.json({ colors: machineColors() }, { headers })
      if (req.method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as { host?: string | null; color?: string | null }
        try {
          const host = requireHost(body.host)
          // `null` clears; anything that is not an offered id is a refusal, not
          // a colour to store and hand back for something to fail to draw.
          const color = body.color === null || body.color === undefined ? null : asMachineColorId(body.color)
          if (body.color && !color) {
            return Response.json({ error: `"${body.color}" is not a machine colour` }, { status: 400, headers })
          }
          const colors = setMachineColor(host, color)
          broadcast({ t: 'machine_colors', colors })
          return Response.json({ colors }, { headers })
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : String(err) },
            { status: 400, headers },
          )
        }
      }
    }

    /**
     * One level of a directory, for the folder picker and the file panel. This
     * grants nothing a terminal tab could not already do, and it never walks a
     * tree: the client asks for the level it is about to draw. With a `host` the
     * level is read on that machine over SSH, which is what lets a workspace be
     * a folder on a server rather than only here.
     */
    if (url.pathname === '/api/fs') {
      const target = url.searchParams.get('path') ?? ''
      try {
        return Response.json(await listDirectoryForAsync(requireHost(url.searchParams.get('host')), target), { headers })
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : String(err) },
          { status: 400, headers },
        )
      }
    }

    /**
     * One machine's home directory, for a shell that has no folder to start in.
     * A listing is the wrong shape for that question — a new terminal wants the
     * address, not the contents — and on a host it is one round trip either way.
     */
    if (url.pathname === '/api/home') {
      try {
        return Response.json({ path: await homeForAsync(requireHost(url.searchParams.get('host'))) }, { headers })
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : String(err) },
          { status: 400, headers },
        )
      }
    }

    /**
     * The slash commands and skills a harness offers in one workspace. Skills
     * live on disk next to the workspace (or on the host it runs on), so this
     * takes the folder and the machine, not just the harness.
     *
     * Cached: the composer asks once per session, and on a host the scan is a
     * handful of ssh calls that do not change between two messages.
     */
    if (url.pathname === '/api/commands') {
      const harness = url.searchParams.get('harness') as HarnessId | null
      const cwd = url.searchParams.get('cwd') ?? ''
      if (!harness) return Response.json({ error: 'harness is required' }, { status: 400, headers })
      let host: string | null
      try {
        host = requireHost(url.searchParams.get('host'))
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : String(err) },
          { status: 400, headers },
        )
      }
      const key = `${harness}|${cwd}|${host ?? ''}`
      const hit = commandCache.get(key)
      if (hit && Date.now() - hit.at < COMMAND_TTL) {
        return Response.json({ commands: hit.commands }, { headers })
      }
      try {
        const commands = harnessCommands(harness, cwd, host)
        commandCache.set(key, { at: Date.now(), commands })
        return Response.json({ commands }, { headers })
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : String(err) },
          { status: 400, headers },
        )
      }
    }

    /**
     * Every conversation one folder has that is not on screen: Sedano's own
     * archived sessions, and the ones each harness keeps in its own store that
     * Sedano does not hold. Read-only on every native store (see `imports.ts`).
     */
    if (url.pathname === '/api/import/scan') {
      try {
        const host = requireHost(url.searchParams.get('host'))
        const cwd = url.searchParams.get('cwd') ?? ''
        if (!cwd.startsWith('/')) throw new Error('cwd must be an absolute path')
        const held = manager.heldNativeIds()
        const archived = db.archivedSessions(cwd, host).map((row) => ({
          id: row.id,
          harness: row.harness,
          nativeId: row.native_id,
          title: row.title,
          updatedAt: row.updated_at,
        }))
        return Response.json(scanFolder({ cwd, host, archived, held }), { headers })
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400, headers })
      }
    }

    /**
     * Open a native conversation from the scan as a Sedano session that resumes
     * it. Only what the scan would list can be opened: the id is looked up in
     * the harness' store again rather than trusted.
     */
    if (url.pathname === '/api/import' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as {
        harness?: HarnessId
        nativeId?: string
        cwd?: string
        host?: string | null
      }
      try {
        const host = requireHost(body.host ?? null)
        if (host) throw new Error('native sessions can only be imported on this machine')
        const { harness, nativeId, cwd } = body
        if (!harness || !nativeId || !cwd) throw new Error('expected { harness, nativeId, cwd }')
        const native = findNative(harness, cwd, nativeId)
        if (!native) return Response.json({ error: 'that session is no longer in the harness store' }, { status: 404, headers })
        const session = await manager.importNativeSession({
          harness,
          nativeId,
          cwd,
          host,
          title: native.title,
          ...(harness === 'commandcode' ? { history: commandCodeHistory(cwd, nativeId) } : {}),
        })
        return Response.json({ session }, { headers })
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400, headers })
      }
    }

    /**
     * Archive or unarchive a session. Archiving hides it and stops it; nothing
     * is deleted, here or in the harness' store.
     */
    if (url.pathname === '/api/session/archive' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { sessionId?: string; archived?: boolean }
      if (!body.sessionId || typeof body.archived !== 'boolean') {
        return Response.json({ error: 'expected { sessionId, archived }' }, { status: 400, headers })
      }
      if (body.archived) {
        return manager.archiveSession(body.sessionId)
          ? Response.json({ ok: true }, { headers })
          : Response.json({ error: 'that session no longer exists' }, { status: 404, headers })
      }
      const session = manager.unarchiveSession(body.sessionId)
      return session
        ? Response.json({ ok: true, session }, { headers })
        : Response.json({ error: 'that session is not archived' }, { status: 404, headers })
    }

    /**
     * Speech to text for the composer microphone. The audio is handed to a local
     * model (whisper.cpp) or a local server; nothing is uploaded anywhere.
     */
    if (url.pathname === '/api/transcribe' && req.method === 'POST') {
      const mime = req.headers.get('content-type') ?? 'audio/webm'
      const body = new Uint8Array(await req.arrayBuffer())
      if (body.byteLength < 1024) {
        return Response.json({ error: 'recording too short' }, { status: 400, headers })
      }
      try {
        const started = Date.now()
        const text = await transcribe(body, mime)
        return Response.json({ text, ms: Date.now() - started }, { headers })
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : String(err) },
          { status: 500, headers },
        )
      }
    }

    /**
     * An image pasted into the composer. The bytes are the body and the
     * content-type is the media type, so there is no multipart parsing and no
     * base64 round trip; the id that comes back is what the message carries.
     */
    if (url.pathname === '/api/attachment' && req.method === 'POST') {
      const mediaType = req.headers.get('content-type') ?? ''
      const name = req.headers.get('x-filename') ?? ''
      try {
        const bytes = new Uint8Array(await req.arrayBuffer())
        const saved = saveAttachment(bytes, mediaType, name)
        return Response.json({ ...saved, url: `/api/attachment/${saved.id}` }, { headers })
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : String(err) },
          { status: 400, headers },
        )
      }
    }

    /**
     * Take back an image before it has been sent — the remove button on a
     * composer chip. Only an upload nobody has sent can go: once it is on a
     * message it belongs to that transcript, and the message would be left
     * pointing at bytes that no longer exist.
     */
    if (url.pathname.startsWith('/api/attachment/') && req.method === 'DELETE') {
      const refused = deleteAttachment(url.pathname.slice('/api/attachment/'.length))
      if (refused === 'gone') return Response.json({ error: 'not found' }, { status: 404, headers })
      if (refused === 'sent') {
        return Response.json(
          { error: 'that image is already on a message — delete the session to remove it' },
          { status: 409, headers },
        )
      }
      return Response.json({ ok: true }, { headers })
    }

    if (url.pathname.startsWith('/api/attachment/') && req.method === 'GET') {
      const found = readAttachment(url.pathname.slice('/api/attachment/'.length))
      if (!found) return new Response('not found', { status: 404, headers })
      return new Response(found.bytes.buffer as ArrayBuffer, {
        headers: {
          ...headers,
          'content-type': found.mediaType,
          // The bytes behind an id never change, so the browser may keep them.
          'cache-control': 'private, max-age=31536000, immutable',
        },
      })
    }

    /**
     * The dictation settings.
     *
     * GET exists so a panel can ask what is installed without changing anything;
     * it used to be POST-only, so "show me the engines" and "switch engine" were
     * the same request.
     */
    /**
     * Download, cancel or delete an official whisper.cpp model. A download runs
     * in the background: the reply is the status with its progress, the panel
     * polls GET /api/voice while one is running, and every client hears about
     * the finished (or failed) file through a caps broadcast.
     */
    if (url.pathname === '/api/voice/models' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { action?: string; file?: string; path?: string }
      const announce = async (): Promise<void> => {
        manager.invalidateCapabilities()
        broadcast({ t: 'caps', caps: await manager.capabilities() })
      }
      try {
        if (body.action === 'download' && body.file) downloadWhisperModel(body.file, () => void announce())
        else if (body.action === 'cancel' && body.file) cancelWhisperDownload(body.file)
        else if (body.action === 'delete' && body.path) deleteWhisperModel(body.path)
        else throw new Error('expected { action: download|cancel, file } or { action: delete, path }')
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400, headers })
      }
      if (body.action !== 'download') await announce()
      return Response.json(await resolveVoice(true), { headers })
    }

    if (url.pathname === '/api/voice') {
      if (req.method === 'GET') return Response.json(await resolveVoice(true), { headers })
      if (req.method === 'POST') {
        const patch = (await req.json().catch(() => ({}))) as Partial<VoiceConfig>
        try {
          setConfig(patch)
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400, headers })
        }
        const status = await resolveVoice(true)
        // The voice status is part of every machine's capabilities, and those are
        // cached for twenty seconds. Without this the panel re-read the catalog
        // from before the change and drew the old answer back over the new one —
        // which is exactly what "I click and nothing happens" looked like.
        manager.invalidateCapabilities()
        broadcast({ t: 'caps', caps: await manager.capabilities() })
        return Response.json(status, { headers })
      }
    }

    /**
     * Is this host actually there? Only for a host you enabled — the allowlist
     * is the single gate, and a reachability probe is still an `ssh` argument.
     */
    if (url.pathname === '/api/host-check' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { host?: string }
      if (!body.host) return Response.json({ error: 'host is required' }, { status: 400, headers })
      try {
        const status = await manager.checkHostAsync(body.host)
        broadcast({ t: 'caps', caps: await manager.capabilities() })
        return Response.json(status, { headers })
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400, headers })
      }
    }

    /**
     * Open a file of a session with this Mac's default app (see `open-file.ts`).
     * Only from the Mac itself: a phone asking would open a window nobody sees,
     * and a session on an ssh host names a file that is not on this machine.
     */
    if (url.pathname === '/api/open-file' && req.method === 'POST') {
      if (access.kind === 'remote') {
        return Response.json({ error: 'files open on the Mac, not from a remote device' }, { status: 403, headers })
      }
      const body = (await req.json().catch(() => ({}))) as { path?: string; sessionId?: string }
      if (!body.path) return Response.json({ error: 'path is required' }, { status: 400, headers })
      const session = body.sessionId ? manager.getSession(body.sessionId) : null
      if (session?.host) {
        return Response.json({ error: `that file is on ${session.host}, not on this machine` }, { status: 403, headers })
      }
      const opened = openFile(body.path, session?.cwd)
      return opened.ok
        ? Response.json({ path: opened.path }, { headers })
        : Response.json({ error: opened.error }, { status: opened.status, headers })
    }

    /**
     * The usage readers that send a stored credential to a vendor (see
     * `usage/index.ts#ACCOUNT_READERS`): what each would read and call, and
     * whether the person allowed it. Turning one on reads it straight away.
     */
    if (url.pathname === '/api/usage-readers') {
      if (req.method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as { id?: unknown; on?: unknown }
        try {
          if (typeof body.on !== 'boolean') throw new Error('expected { id, on: boolean }')
          setAccountReader(String(body.id), body.on)
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400, headers })
        }
        if (body.on) void refreshLimits(true)
        else broadcast({ t: 'limits', limits: currentLimits() })
      }
      const on = accountReaders()
      const readers = (Object.keys(ACCOUNT_READERS) as AccountReader[]).map((id) => ({ id, on: on[id], ...ACCOUNT_READERS[id] }))
      return Response.json({ readers }, { headers })
    }

    /** Write an exported conversation where the desktop's save dialog said (see export-file.ts). */
    if (url.pathname === '/api/export-file' && req.method === 'POST') {
      if (access.kind === 'remote') {
        return Response.json({ error: 'exports are saved by the device that asks, not on the Mac' }, { status: 403, headers })
      }
      const body = (await req.json().catch(() => ({}))) as { path?: unknown; name?: unknown; content?: unknown }
      const written = await writeExportFile(body)
      return written.ok
        ? Response.json({ path: written.path }, { headers })
        : Response.json({ error: written.error }, { status: written.status, headers })
    }

    return serveStatic(url.pathname)
  },

  websocket: {
    // By default a socket whose buffer passes 16 MB silently *drops* whatever is
    // sent next, so a client that fell behind (a janky renderer, a replayed
    // timeline) went on showing a transcript with holes in it. Closing instead
    // is recoverable: the client reconnects, resubscribes and gets the whole
    // state again. The limit is well above one full timeline message.
    backpressureLimit: 64 * 1024 * 1024,
    closeOnBackpressureLimit: true,

    open(ws) {
      const client = makeClient(ws as unknown as { send: (d: string) => void })
      const deviceId = ws.data?.deviceId ?? null
      ws.data = { client, deviceId }
      addClient(client)
      if (deviceId) remoteSockets.add(ws as unknown as RemoteSocket)
      const state = snapshot()
      client.send({ t: 'hello', ...state })
    },

    async message(ws, raw) {
      const client = ws.data?.client
      if (!client) return
      let msg: ClientMsg
      try {
        msg = JSON.parse(String(raw)) as ClientMsg
      } catch {
        return
      }
      await handle(client, msg)
    },

    close(ws) {
      const client = ws.data?.client
      if (client) removeClient(client)
      remoteSockets.delete(ws as unknown as RemoteSocket)
    },
  },
})

/**
 * Live remote sockets. A revoked device, or a change to who is let in, closes
 * them: the client reconnects and the upgrade is judged again.
 */
type RemoteSocket = { data: WsData; close: (code?: number, reason?: string) => void }
const remoteSockets = new Set<RemoteSocket>()
remote.onRemoteChange((event) => {
  for (const ws of remoteSockets) {
    if (event.kind === 'config' || ws.data.deviceId === event.deviceId) ws.close(4401, 'remote access changed')
  }
})
// The tailnet name can change under us (a rename, a re-login); asked again now
// and then, and only while remote mode is on — off, tailscale is never run.
if (remote.remoteConfig().enabled) void remote.refreshDetectedHostname()
setInterval(() => {
  if (remote.remoteConfig().enabled) void remote.refreshDetectedHostname()
}, 5 * 60_000).unref()

/**
 * The answers to commands that have already been carried out, by command id.
 *
 * A reconnecting client replays everything it never saw an answer to, and some
 * of those the server did carry out — the answer was simply lost with the
 * socket. Replaying a `new_session` or an `input` blind would open a second
 * session or send the prompt twice, so a command id we have seen is answered
 * with what it was answered the first time and nothing is done again. Bounded,
 * and oldest-first: a `Map` keeps insertion order, and a command old enough to
 * fall out of this window is older than any reconnect that could still replay it.
 */
const acked = new Map<CommandId, Ack>()
const ACK_MEMORY = 500
const inflight = new Map<CommandId, Promise<Ack | null>>()

type CommandLedger = {
  getCommand?: (cid: string) => unknown
  claimCommand?: (cid: string, kind: string, fingerprint: string, sessionId?: string | null, at?: number) => unknown
  completeCommand?: (cid: string, ack: Ack) => unknown
}
const commandLedger = db as unknown as CommandLedger

function durableAck(cid: string): Ack | null {
  try {
    const row = commandLedger.getCommand?.(cid)
    if (!row || typeof row !== 'object') return null
    const value = row as Record<string, unknown>
    const ack = value.ack ?? value.result ?? value
    return ack && typeof ack === 'object' && (ack as { t?: unknown }).t === 'ack' ? (ack as Ack) : null
  } catch {
    return null
  }
}

function commandFingerprint(msg: ClientMsg): string {
  // JSON is deliberately the wire payload: field order is stable in the UI and
  // retaining it lets the DB reject accidental cid reuse with a different act.
  return JSON.stringify(msg)
}

function commandKind(msg: ClientMsg): string {
  return msg.t
}

function recoverPendingPromptCommand(msg: ClientMsg, cid: string): Ack | null {
  if (msg.t !== 'input' && !(msg.t === 'new_session' && Boolean(msg.req.prompt || msg.req.attachments?.length))) {
    return null
  }
  const promptId = `prompt:${cid}`
  const prompt = db.getPrompt(promptId)
  if (!prompt) return null
  const sessionId = msg.t === 'input' ? msg.sessionId : deterministicUuid(`session:${cid}`)
  if (prompt.state === 'delivered' || prompt.state === 'queued') {
    return {
      t: 'ack',
      cid,
      ok: true,
      sessionId,
      promptId,
      ...(prompt.turnId ? { turnId: prompt.turnId } : {}),
    }
  }
  const detail =
    prompt.state === 'cancelled'
      ? 'the queued prompt was cancelled'
      : prompt.state === 'failed'
        ? prompt.reason ?? 'the prompt was not delivered'
        : 'the previous server stopped before prompt delivery could be confirmed; it was not replayed to avoid sending it twice'
  if (prompt.state === 'accepted' || prompt.state === 'starting') {
    manager.failRecoveredPrompt(sessionId, promptId, detail)
  }
  return {
    t: 'ack',
    cid,
    ok: false,
    error: 'failed',
    detail,
    sessionId,
    promptId,
    ...(prompt.turnId ? { turnId: prompt.turnId } : {}),
  }
}

function recoverPendingIdempotentCommand(msg: ClientMsg, cid: string): Ack | null {
  if (msg.t === 'new_session') {
    if (msg.req.prompt || msg.req.attachments?.length) return null
    const sessionId = deterministicUuid(`session:${cid}`)
    const session = manager.getSession(sessionId)
    if (!session) return null
    return { t: 'ack', cid, ok: true, sessionId }
  }
  if (msg.t === 'delete_session' && !manager.getSession(msg.sessionId)) {
    return { t: 'ack', cid, ok: true, sessionId: msg.sessionId }
  }
  if (msg.t === 'cancel_prompt') {
    const prompt = db.getPrompt(msg.promptId)
    if (prompt?.state === 'cancelled') {
      return { t: 'ack', cid, ok: true, sessionId: msg.sessionId, promptId: msg.promptId }
    }
  }
  return null
}

function deterministicUuid(seed: string): string {
  // A UUID-shaped stable id is enough for the existing session contract; the
  // cid remains the true idempotency key in the commands table.
  let state = 0x811c9dc5
  let hex = ''
  for (let round = 0; round < 4; round += 1) {
    for (const char of `${seed}:${round}`) {
      state ^= char.charCodeAt(0)
      state = Math.imul(state, 0x01000193)
    }
    hex += (state >>> 0).toString(16).padStart(8, '0')
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${((Number.parseInt(hex.slice(12, 16), 16) & 0x0fff) | 0x4000).toString(16).padStart(4, '0')}-${((Number.parseInt(hex.slice(16, 20), 16) & 0x3fff) | 0x8000).toString(16).padStart(4, '0')}-${hex.slice(20)}`
}

function remember(ack: Ack): Ack {
  acked.set(ack.cid, ack)
  try {
    commandLedger.completeCommand?.(ack.cid, ack)
  } catch {
    // Keep compatibility with a pre-ledger DB during rolling upgrades.
  }
  if (acked.size > ACK_MEMORY) {
    for (const key of acked.keys()) {
      acked.delete(key)
      if (acked.size <= ACK_MEMORY) break
    }
  }
  return ack
}

/** The shape every mutating case returns, before it is turned into an `Ack`. */
type Outcome =
  | { ok: true; sessionId?: string; promptId?: string; turnId?: string }
  | { ok: false; error: AckError; detail: string; promptId?: string; turnId?: string }

const failure = (error: AckError, detail: string): Outcome => ({ ok: false, error, detail })

async function handle(client: Client, msg: ClientMsg): Promise<void> {
  const cid = 'cid' in msg ? msg.cid : undefined
  if (cid) {
    const previous = acked.get(cid) ?? durableAck(cid)
    // The same command again: answered as it was answered, not done again.
    if (previous) {
      client.send(previous)
      return
    }
    const running = inflight.get(cid)
    if (running) {
      const ack = await running.catch((err: unknown): Ack => crashedAck(cid, err))
      if (ack) client.send(ack)
      return
    }
    try {
      const claim = commandLedger.claimCommand?.(cid, commandKind(msg), commandFingerprint(msg), 'sessionId' in msg ? msg.sessionId : null, Date.now()) as { state?: string; ack?: Ack } | string | undefined
      const state = typeof claim === 'string' ? claim : claim?.state
      if (state === 'completed' || state === 'failed') {
        const completed = (typeof claim === 'object' ? claim?.ack : undefined) ?? durableAck(cid)
        if (completed) client.send(completed)
        else client.send({ t: 'ack', cid, ok: false, error: 'failed', detail: 'command completed without a durable acknowledgement' })
        return
      }
      if (state === 'conflict') {
        client.send({ t: 'ack', cid, ok: false, error: 'rejected', detail: 'command id was already used for a different request' })
        return
      }
      if (state === 'pending') {
        const reconciled = recoverPendingPromptCommand(msg, cid) ?? recoverPendingIdempotentCommand(msg, cid)
        if (reconciled) {
          client.send(remember(reconciled))
          return
        }
        if (msg.t !== 'input' && msg.t !== 'new_session') {
          const failed: Ack = { t: 'ack', cid, ok: false, error: 'failed', detail: 'command was left pending by a previous server and cannot be safely replayed' }
          client.send(remember(failed))
          return
        }
      }
    } catch {
      // A pre-ledger DB has no claim operation; the in-memory/in-flight guards
      // remain the compatibility path.
    }
  }
  const process = (async (): Promise<Ack | null> => {
    const outcome = await run(client, msg)
    if (!outcome || !cid) {
      if (outcome && !outcome.ok && !cid) client.send({ t: 'toast', level: 'error', text: outcome.detail })
      return null
    }
    const ack: Ack = outcome.ok
      ? {
          t: 'ack',
          cid,
          ok: true,
          ...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}),
          ...(outcome.promptId ? { promptId: outcome.promptId } : {}),
          ...(outcome.turnId ? { turnId: outcome.turnId } : {}),
        }
      : {
          t: 'ack',
          cid,
          ok: false,
          error: outcome.error,
          detail: outcome.detail,
          ...(outcome.promptId ? { promptId: outcome.promptId } : {}),
          ...(outcome.turnId ? { turnId: outcome.turnId } : {}),
        }
    return remember(ack)
  })()
  if (cid) inflight.set(cid, process)
  let ack: Ack | null
  try {
    ack = await process
  } catch (err) {
    // One command that throws — a malformed field, a store error — used to
    // reject out of the socket handler, which ends the Bun process. It is
    // answered as a failure instead. Not remembered: the ledger row stays
    // pending, so a replay goes through the fail-closed recovery above rather
    // than being told something we do not actually know.
    console.error(`sedano: command ${msg.t} failed:`, err)
    ack = cid ? crashedAck(cid, err) : null
    if (!cid) client.send({ t: 'toast', level: 'error', text: errorText(err) })
  } finally {
    if (cid) inflight.delete(cid)
  }
  if (ack) client.send(ack)
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function crashedAck(cid: CommandId, err: unknown): Ack {
  return { t: 'ack', cid, ok: false, error: 'failed', detail: errorText(err) }
}

/**
 * Carry out one command. `undefined` means there is nothing to acknowledge —
 * a read, a subscription, a keystroke — and everything else is an outcome the
 * client is told about by id.
 */
async function run(client: Client, msg: ClientMsg): Promise<Outcome | undefined> {
  switch (msg.t) {
    case 'subscribe': {
      client.subscribed.add(msg.sessionId)
      const events = manager.loadSessionEvents(msg.sessionId)
      // How far this timeline reaches, so the client can tell a live event it
      // already holds from one that arrived after the replay was taken.
      client.send({
        t: 'timeline',
        sessionId: msg.sessionId,
        events,
        cursor: events[events.length - 1]?.seq ?? 0,
        // The ledger's word on every turn, so a client never derives a turn's
        // state from the rows it happens to hold (see `TurnRecord.phase`).
        turns: manager.turnViews(msg.sessionId),
      })
      const session = manager.getSession(msg.sessionId)
      if (session) client.send({ t: 'session', session })
      return undefined
    }

    case 'unsubscribe': {
      client.subscribed.delete(msg.sessionId)
      return undefined
    }

    case 'new_session': {
      try {
        const { prompt, attachments, ...rest } = msg.req
        const request = { ...rest, ...(msg.cid && !rest.id ? { id: deterministicUuid(`session:${msg.cid}`) } : {}) }
        // The machine a session runs on is chosen here and nowhere else. A
        // client asking for a host it invented — or one that dropped out of the
        // ssh config since the picker was drawn — is refused before anything is
        // spawned, rather than after a process is already running somewhere.
        const hasFirstPrompt = Boolean(prompt || attachments?.length)
        const session = await manager.createSession(
          { ...request, host: requireHost(request.host) },
          // Subscribe before the cold start. `sendMessage` persists and
          // broadcasts the prompt first, then starts the harness, so a slow
          // handshake is visible as "Starting" beneath the message the user
          // actually sent.
          { deferStart: hasFirstPrompt },
        )
        client.subscribed.add(session.id)
        const events = manager.loadSessionEvents(session.id)
        client.send({
          t: 'timeline',
          sessionId: session.id,
          events,
          cursor: events[events.length - 1]?.seq ?? 0,
          turns: manager.turnViews(session.id),
        })
        client.send({ t: 'session', session })
        if (prompt || attachments?.length) {
          const sent = await manager.sendMessage(session.id, prompt ?? '', attachments, {
            ...(msg.cid ? { promptId: `prompt:${msg.cid}`, commandId: msg.cid } : {}),
          })
          // The session exists either way, so the ack says so — and names the
          // reason the first prompt did not go, rather than reporting a session
          // that opened empty for no visible cause.
          if (!sent.ok) return failure(sent.code, sent.detail)
          return { ok: true, sessionId: session.id, promptId: sent.promptId, turnId: sent.turnId }
        }
        return { ok: true, sessionId: session.id }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        client.send({ t: 'toast', level: 'error', text: detail })
        return failure('rejected', detail)
      }
    }

    case 'input': {
      // Awaited: the result used to be a promise tested for truthiness, which is
      // always true, so a prompt the server refused was reported as sent.
      const sent = await manager.sendMessage(msg.sessionId, msg.text, msg.attachments, {
        ...(msg.cid ? { promptId: `prompt:${msg.cid}`, commandId: msg.cid } : {}),
      })
      return sent.ok
        ? { ok: true, sessionId: msg.sessionId, promptId: sent.promptId, turnId: sent.turnId }
        : { ok: false, error: sent.code, detail: sent.detail, promptId: sent.promptId, turnId: sent.turnId }
    }

    case 'interrupt': {
      return manager.interruptSession(msg.sessionId)
        ? { ok: true, sessionId: msg.sessionId }
        : failure('gone', 'that session no longer exists')
    }

    case 'stop': {
      return manager.stopSession(msg.sessionId)
        ? { ok: true, sessionId: msg.sessionId }
        : failure('gone', 'that session no longer exists')
    }

    case 'rename_session': {
      return manager.renameSession(msg.sessionId, msg.title)
        ? { ok: true, sessionId: msg.sessionId }
        : failure('gone', 'that session no longer exists')
    }

    case 'set_session_parent': {
      const adopted = manager.setSessionParent(msg.sessionId, msg.parentSessionId)
      return adopted.ok ? { ok: true, sessionId: msg.sessionId } : failure('rejected', adopted.detail)
    }

    case 'set_session_options': {
      const applied = manager.setSessionOptions(msg.sessionId, {
        model: msg.model,
        effort: msg.effort,
        permissionMode: msg.permissionMode,
      })
      if (!applied.ok) return failure(applied.code, applied.detail)
      const session = manager.getSession(msg.sessionId)
      if (session) client.send({ t: 'session', session })
      return { ok: true, sessionId: msg.sessionId }
    }

    case 'pin_session': {
      return manager.pinSession(msg.sessionId, msg.pinned)
        ? { ok: true, sessionId: msg.sessionId }
        : failure('gone', 'that session no longer exists')
    }

    case 'delete_session': {
      // A delete replayed after it succeeded finds nothing, and that is the
      // outcome it asked for: the session is gone.
      manager.removeSession(msg.sessionId)
      return { ok: true, sessionId: msg.sessionId }
    }

    case 'refresh_limits': {
      const before = new Map(currentLimits().map((snapshot) => [snapshot.harness, snapshot.updatedAt]))
      const snapshots = await refreshLimits(msg.force ?? false)
      const fresh = snapshots.filter((snapshot) => snapshot.updatedAt > (before.get(snapshot.harness) ?? 0))
      const failed = snapshots.filter((snapshot) => snapshot.error)
      client.send({
        t: 'toast',
        level: fresh.length ? (failed.length ? 'warning' : 'success') : failed.length ? 'error' : 'info',
        text: fresh.length
          ? `Limits refreshed: ${fresh.map((snapshot) => snapshot.harness).join(', ')}${failed.length ? ` · ${failed.length} unavailable` : ''}`
          : failed.length
            ? `No new limit reading · ${failed.map((snapshot) => `${snapshot.harness}: ${snapshot.error}`).join(' · ')}`
            : 'Limits checked — no newer reading available yet',
      })
      return
    }

    case 'list_projects': {
      client.send({ t: 'projects', projects: listProjects(true) })
      return
    }

    case 'list_caps': {
      // Which machine the client is looking at, because the harness list is a
      // fact about that machine. No host is this computer. `force` makes this a
      // fresh scan, which is what looking at a machine should be.
      try {
        client.send({
          t: 'caps',
          caps: await manager.capabilities(requireHost(msg.host), msg.force === true),
        })
      } catch (err) {
        client.send({ t: 'toast', level: 'error', text: err instanceof Error ? err.message : String(err) })
      }
      return
    }

    case 'set_harness_enabled': {
      try {
        // `requireHost` is the same gate a session goes through: a preference
        // about a machine nobody enabled is still a message naming that machine.
        const host = requireHost(msg.host)
        manager.setHarnessEnabled(host, msg.harness, msg.enabled)
        // Everyone sees the new catalog, and the switch in Settings moves
        // because of this message rather than because of the click.
        broadcast({ t: 'caps', caps: await manager.capabilities(host, true) })
        return { ok: true }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        return failure('rejected', detail)
      }
    }

    case 'set_machine_color': {
      try {
        // Same gate as a session: a preference naming a machine nobody enabled
        // is refused before it is written, not after.
        const host = requireHost(msg.host)
        const color = msg.color === null ? null : asMachineColorId(msg.color)
        if (msg.color && !color) return failure('rejected', `"${msg.color}" is not a machine colour`)
        broadcast({ t: 'machine_colors', colors: setMachineColor(host, color) })
        return { ok: true }
      } catch (err) {
        return failure('rejected', err instanceof Error ? err.message : String(err))
      }
    }

    case 'tabs': {
      const op = asTabOp(msg.op)
      if (!op) return failure('rejected', 'that is not a tab change')
      applyTabs(op, msg.cid)
      return { ok: true }
    }

    case 'term_input': {
      manager.writeTerminal(msg.sessionId, msg.data)
      return
    }

    case 'term_resize': {
      manager.resizeTerminal(msg.sessionId, msg.cols, msg.rows)
      return
    }

    case 'answer_question': {
      const answered = manager.answerQuestion(msg.sessionId, msg.toolId, msg.optionId)
      // The refusal is the point. This return value used to be thrown away, so a
      // click on a question nobody was waiting on looked exactly like an answer
      // that had been delivered.
      return answered.ok
        ? { ok: true, sessionId: msg.sessionId }
        : failure(answered.code, answered.detail)
    }

    case 'cancel_prompt': {
      const cancelled = manager.cancelPrompt(msg.sessionId, msg.promptId)
      return cancelled.ok
        ? { ok: true, sessionId: msg.sessionId, promptId: cancelled.promptId }
        : failure(cancelled.code, cancelled.detail)
    }

    case 'term_snapshot': {
      const screen = await manager.terminalSnapshot(msg.sessionId, msg.history === true)
      if (screen?.screen) {
        client.send({
          t: 'term',
          sessionId: msg.sessionId,
          data: screen.screen,
          snapshot: true,
          offset: screen.offset,
          ...(screen.cursor ? { cursor: screen.cursor } : {}),
        })
      }
      return
    }
  }
}

export { presetList, sshHosts }

// Refresh limits whenever a session changes status, so the bars stay honest.
setInterval(() => {
  broadcast({ t: 'limits', limits: currentLimits() })
}, 120_000)

// Once per day while the server stays open, and on every boot for model caches
// that live in memory. Registry results persist, so a restart does not repeat
// those network checks. Never hold the HTTP server's startup on an SSH host.
// It runs `npm view` and each CLI on every enabled host, so it is a switch in
// Settings (on by default); `SEDANO_BACKGROUND_SYNC=0` still turns it off for
// a test run, whatever the switch says.
const BACKGROUND_SYNC_KEY = 'sync.background'
function backgroundSyncOn(): boolean {
  return process.env.SEDANO_BACKGROUND_SYNC !== '0' && db.kvGet(BACKGROUND_SYNC_KEY) !== 'off'
}
setTimeout(() => backgroundSyncOn() && manager.startHarnessSync('check'), 2_000)
setInterval(() => backgroundSyncOn() && manager.startHarnessSync('check'), 60 * 60_000)

/**
 * Leave cleanly when asked to.
 *
 * With no handler a SIGTERM ended the process on the spot: every `tail -F`
 * this server was reading through was reparented to init and kept following
 * its file forever, and the WAL was left for the next boot to replay. The
 * desktop shell sends SIGTERM to the whole group and SIGKILL two seconds
 * later, so everything here is bounded well inside that.
 */
const SHUTDOWN_BUDGET_MS = 1500
let shuttingDown = false

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`sedano: ${reason}, shutting down`)
  // Whatever still hangs after the budget, the exit is not negotiable.
  setTimeout(() => process.exit(0), SHUTDOWN_BUDGET_MS).unref()
  stopLogin()
  try {
    server.stop(true)
  } catch {
    /* already closing */
  }
  try {
    await manager.shutdown(SHUTDOWN_BUDGET_MS - 500)
  } catch (err) {
    console.error('sedano: shutdown was not clean:', err)
  }
  try {
    db.closeDb()
  } catch {
    /* a write still in flight; the WAL keeps it */
  }
  process.exit(0)
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => void shutdown(signal))
}

/**
 * A supervised server has no reason to outlive its supervisor. If the desktop
 * shell dies without signalling (a crash, a SIGKILL of the app alone), the
 * sidecar used to keep the port and every session to itself, and the next
 * launch attached to an orphan. `process.ppid` is read once by Bun and never
 * refreshed, so the parent is asked directly: `kill(pid, 0)` fails with ESRCH
 * once it is gone.
 */
if (process.env.SEDANO_SUPERVISED === '1') {
  const parent = process.ppid
  setInterval(() => {
    try {
      process.kill(parent, 0)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') void shutdown('supervisor exited')
    }
  }, 2000).unref()
}

console.log(`sedano server listening on http://${HOST}:${PORT}`)
if (!existsSync(join(UI_DIST, 'index.html'))) {
  console.log('UI bundle not found: run the vite dev server (bun run dev:ui) on port 5174')
}

export { server }
