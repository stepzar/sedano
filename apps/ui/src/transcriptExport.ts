import { HARNESS_LABEL, type SessionEvent, type SessionSummary } from '@shared'
import { apiHttp, isDesktop, notify } from './store.ts'

/**
 * A conversation as a file you can keep or share: the prompts and the replies,
 * in order, with each tool call reduced to one line. Reasoning is left out —
 * it is the model thinking aloud, not what was said — and so are subagent
 * sidechains, which are their own conversations.
 */
export type ExportFormat = 'markdown' | 'text'

type Entry =
  | { role: 'user' | 'assistant'; text: string }
  | { role: 'tool'; text: string }
  | { role: 'error'; text: string }

function entriesOf(events: SessionEvent[]): Entry[] {
  const entries: Entry[] = []
  for (const { ev, agentId } of events) {
    if (agentId) continue
    if (ev.k === 'user' && ev.text.trim()) entries.push({ role: 'user', text: ev.text.trim() })
    else if (ev.k === 'assistant' && ev.text.trim()) entries.push({ role: 'assistant', text: ev.text.trim() })
    else if (ev.k === 'tool') entries.push({ role: 'tool', text: (ev.summary || ev.name).replace(/\s+/g, ' ').trim() })
    else if (ev.k === 'error' && ev.text.trim()) entries.push({ role: 'error', text: ev.text.trim() })
  }
  return entries
}

function exportDate(at: number): string {
  return new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function formatTranscript(session: SessionSummary, events: SessionEvent[], format: ExportFormat): string {
  const title = session.title || HARNESS_LABEL[session.harness]
  const agent = HARNESS_LABEL[session.harness]
  const about = `${agent} · ${session.cwd} · ${exportDate(session.createdAt)}`
  const entries = entriesOf(events)
  const out: string[] = []
  let speaker: Entry['role'] | null = null

  if (format === 'markdown') {
    out.push(`# ${title}`, '', `_${about}_`, '')
    for (const entry of entries) {
      // A heading only where the speaker changes: a reply split around tool
      // calls is still one reply.
      const role = entry.role === 'user' ? 'user' : 'assistant'
      if (role !== speaker) {
        out.push(role === 'user' ? '## You' : `## ${agent}`, '')
        speaker = role
      }
      if (entry.role === 'tool') out.push(`> Tool: ${entry.text}`, '')
      else if (entry.role === 'error') out.push(`> Error: ${entry.text}`, '')
      else out.push(entry.text, '')
    }
  } else {
    out.push(title, '='.repeat(Math.min(title.length, 72)), about, '')
    for (const entry of entries) {
      const role = entry.role === 'user' ? 'user' : 'assistant'
      if (role !== speaker) {
        out.push('', role === 'user' ? 'You:' : `${agent}:`)
        speaker = role
      }
      if (entry.role === 'tool') out.push(`  [tool] ${entry.text}`)
      else if (entry.role === 'error') out.push(`  [error] ${entry.text}`)
      else out.push(entry.text)
    }
  }
  return `${out.join('\n').trim()}\n`
}

/** A file name from the title: readable, and safe on every file system. */
export function exportFileName(session: SessionSummary, format: ExportFormat): string {
  const base = (session.title || HARNESS_LABEL[session.harness])
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'conversation'
  return `${base}.${format === 'markdown' ? 'md' : 'txt'}`
}

/**
 * Save the text as a file.
 *
 * A browser downloads a blob by itself. The desktop webview has no downloads,
 * so the shell shows its native save dialog and writes the file itself; the
 * local server only takes a file name, for a shell that cannot, and puts it in
 * ~/Downloads without replacing anything.
 */
async function saveFile(name: string, content: string, format: ExportFormat): Promise<void> {
  if (!isDesktop()) {
    const url = URL.createObjectURL(new Blob([content], { type: format === 'markdown' ? 'text/markdown' : 'text/plain' }))
    const link = document.createElement('a')
    link.href = url
    link.download = name
    document.body.append(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    return
  }
  let saved: string | null
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    saved = await invoke<string | null>('export_conversation', { name, content, markdown: format === 'markdown' })
  } catch (error) {
    // A shell without the command: fall back to ~/Downloads. Any other failure
    // (the write itself) is the person's to see.
    if (!/export_conversation|not found|unknown command/i.test(String(error))) throw error
    saved = await saveToDownloads(name, content)
  }
  if (!saved) return // cancelled
  notify('success', `Saved to ${saved}`)
}

async function saveToDownloads(name: string, content: string): Promise<string> {
  const response = await fetch(apiHttp('/api/export-file'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, content }),
  })
  const body = (await response.json().catch(() => ({}))) as { path?: string; error?: string }
  if (!response.ok || !body.path) throw new Error(body.error ?? 'the server did not save the file')
  return body.path
}

export async function exportConversation(session: SessionSummary, events: SessionEvent[], format: ExportFormat): Promise<void> {
  try {
    await saveFile(exportFileName(session, format), formatTranscript(session, events, format), format)
  } catch (error) {
    notify('error', `Could not export: ${error instanceof Error ? error.message : String(error)}`)
  }
}
