/**
 * The demo's `/api/*`: the HTTP half of the fake server, answered in the page.
 *
 * Every route the UI calls has an answer here — a real one where the demo can
 * keep the promise (folders, hosts, imports, settings switches), and a plain
 * "not in the demo" where only a real machine could (opening a file in its
 * app, transcribing speech, remote pairing).
 */
import type { HarnessId, VoiceStatus } from '@shared'
import { documentSummary } from '@shared'
import { USAGE_READERS, homeFor, listDirectory } from './data.ts'
import type { DemoServer } from './server.ts'

const NOT_IN_DEMO = 'Not available in the browser demo — this needs Sedano running on your own machine.'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

async function bodyOf<T>(init?: RequestInit): Promise<Partial<T>> {
  if (typeof init?.body !== 'string') return {}
  try {
    return JSON.parse(init.body) as Partial<T>
  } catch {
    return {}
  }
}

function asDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

const syncStatus = { running: false, mode: 'check' as const, startedAt: null as number | null, finishedAt: Date.now() - 42 * 60_000, completed: 7, total: 7, queued: false, failures: [], automatic: true }

export async function handleApi(server: DemoServer, url: URL, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase()
  const path = url.pathname
  const host = url.searchParams.get('host') || null

  // Small, steady latency: instant answers make loading states flash.
  await new Promise((resolve) => setTimeout(resolve, 40 + Math.random() * 60))

  switch (path) {
    case '/api/health':
      return json({ ok: true, clients: 1, sessions: server.listSessions().length, instance: 'demo', version: 'demo', build: 'demo' })
    case '/api/remote/me':
      return json({ remote: false, device: null, login: null })
    case '/api/caps':
      return json(server.caps(host))
    case '/api/harnesses':
      return json({ harnesses: server.caps(host).harnesses })
    case '/api/unhandled':
      return json({ events: [] })
    case '/api/fs': {
      const listing = listDirectory(url.searchParams.get('path') ?? '', host)
      return listing ? json(listing) : json({ error: `no such folder: ${url.searchParams.get('path')}` }, 400)
    }
    case '/api/home':
      return json({ path: homeFor(host) })
    case '/api/commands': {
      const harness = url.searchParams.get('harness') as HarnessId | null
      const info = server.caps(host).harnesses.find((item) => item.id === harness)
      return json({ commands: info?.commands ?? [] })
    }
    case '/api/hosts': {
      if (method === 'POST') {
        const body = await bodyOf<{ host: string; enabled: boolean }>(init)
        if (!body.host) return json({ error: 'host is required' }, 400)
        server.setHost(body.host, body.enabled !== false)
      }
      const caps = server.caps(null)
      return json({ hosts: caps.hosts, available: caps.availableHosts, status: caps.hostStatus })
    }
    case '/api/host-check': {
      const body = await bodyOf<{ host: string }>(init)
      if (!body.host) return json({ error: 'host is required' }, 400)
      await new Promise((resolve) => setTimeout(resolve, 500))
      return json(server.checkHost(body.host))
    }
    case '/api/voice': {
      if (method === 'POST') {
        const body = await bodyOf<{ provider: VoiceStatus['configured'] }>(init)
        return json(server.setVoice(body.provider ?? 'auto'))
      }
      return json(server.caps(null).voice)
    }
    case '/api/voice/models':
      return json({ error: NOT_IN_DEMO }, 400)
    case '/api/transcribe':
      return json({ error: NOT_IN_DEMO }, 400)
    case '/api/open-file':
      return json({ error: `${NOT_IN_DEMO} (it would open the file in its default app)` }, 400)
    case '/api/export-file':
      return json({ error: NOT_IN_DEMO }, 400)
    case '/api/harness-check': {
      const body = await bodyOf<{ host: string | null; harness: HarnessId }>(init)
      await new Promise((resolve) => setTimeout(resolve, 300))
      const caps = server.caps(body.host ?? null)
      const info = caps.harnesses.find((item) => item.id === body.harness)
      return json({
        caps,
        update: {
          status: 'current',
          installedVersion: info?.version ?? null,
          latestVersion: info?.version ?? null,
          updateCommand: null,
          detail: `${info?.label ?? body.harness} is up to date`,
          checkedAt: Date.now(),
        },
      })
    }
    case '/api/harness-update':
      return json({ error: `${NOT_IN_DEMO} (updating a harness runs its installer)` }, 400)
    case '/api/harness-sync': {
      if (method === 'POST') {
        const body = await bodyOf<{ mode: string; automatic: boolean }>(init)
        if (typeof body.automatic === 'boolean') syncStatus.automatic = body.automatic
        else syncStatus.finishedAt = Date.now()
      }
      return json(syncStatus)
    }
    case '/api/usage-readers': {
      if (method === 'POST') {
        const body = await bodyOf<{ id: string; on: boolean }>(init)
        try {
          server.setUsageReader(String(body.id), body.on === true)
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 400)
        }
      }
      const on = server.usageReaders()
      return json({
        readers: (Object.keys(USAGE_READERS) as Array<keyof typeof USAGE_READERS>).map((id) => ({ id, on: on[id], ...USAGE_READERS[id] })),
      })
    }
    case '/api/import/scan': {
      const cwd = url.searchParams.get('cwd') ?? ''
      if (!cwd.startsWith('/')) return json({ error: 'cwd must be an absolute path' }, 400)
      return json(server.importScan(cwd))
    }
    case '/api/import': {
      const body = await bodyOf<{ harness: HarnessId; nativeId: string; cwd: string }>(init)
      if (!body.harness || !body.nativeId || !body.cwd) return json({ error: 'expected { harness, nativeId, cwd }' }, 400)
      return json({ session: await server.importNative(body.harness, body.nativeId, body.cwd) })
    }
    case '/api/session/archive': {
      const body = await bodyOf<{ sessionId: string; archived: boolean }>(init)
      if (!body.sessionId) return json({ error: 'expected { sessionId, archived }' }, 400)
      if (body.archived) return server.archive(body.sessionId) ? json({ ok: true }) : json({ error: 'that session no longer exists' }, 404)
      const session = server.unarchive(body.sessionId)
      return session ? json({ ok: true, session }) : json({ error: 'that session is not archived' }, 404)
    }
    case '/api/attachment': {
      // The bytes stay in the page: the id *is* a data URL, which the UI already
      // knows how to draw without asking a server (see `attachmentUrl`).
      const blob = init.body instanceof Blob ? init.body : new Blob([String(init.body ?? '')])
      const mediaType = (init.headers as Record<string, string> | undefined)?.['content-type'] ?? blob.type
      const name = (init.headers as Record<string, string> | undefined)?.['x-filename'] ?? 'attachment'
      const typed = blob.type === mediaType ? blob : new Blob([blob], { type: mediaType })
      const ref: Record<string, unknown> = { id: await asDataUrl(typed), name, mediaType }
      if (!mediaType.startsWith('image/')) Object.assign(ref, documentSummary(await typed.text()))
      return json(ref)
    }
  }
  if (path.startsWith('/api/attachment/')) return json({ ok: true })
  if (path.startsWith('/api/remote')) {
    return json({ error: 'Remote access pairs your phone with the Sedano app on your Mac — there is nothing to pair with in the browser demo.' }, 400)
  }
  return json({ error: `${path} is not part of the demo` }, 404)
}
