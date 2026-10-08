import type { SessionEvent, SessionSummary } from '@shared'
import { HARNESS_LABEL } from '@shared'
import { DEFAULT_TRANSFER_PROMPT_TEMPLATE } from './store.ts'

const MAX_ITEM = 900

function compact(text: string, limit = MAX_ITEM): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= limit) return clean
  return `${clean.slice(0, limit - 1).trimEnd()}…`
}

function latest<T>(items: T[], count: number): T[] {
  return items.slice(Math.max(0, items.length - count))
}

/** Build the facts inserted into the editable transfer template. */
export function transferContext(session: SessionSummary, events: SessionEvent[]): {
  summary: string
  remaining: string
} {
  const main = events.filter((event) => !event.agentId)
  const users = latest(main.filter((event) => event.ev.k === 'user'), 2)
  const assistants = latest(main.filter((event) => event.ev.k === 'assistant'), 1)
  const files = [...new Set(events.flatMap((event) => event.ev.k === 'file_change' ? [event.ev.path] : []))].slice(-8)
  const errors = latest(events.filter((event) => event.ev.k === 'error' || (event.ev.k === 'tool_result' && event.ev.isError)), 1)
  const subagents = events.filter((event) => event.ev.k === 'subagent_end' && !event.ev.provisional)

  const lines: string[] = []
  if (users.length) {
    lines.push(`Ultima richiesta: ${compact(users.map((event) => event.ev.k === 'user' ? event.ev.text : '').join(' / '))}`)
  }
  if (assistants[0]?.ev.k === 'assistant' && assistants[0].ev.text.trim()) {
    lines.push(`Ultimo aggiornamento dell'agente: ${compact(assistants[0].ev.text, 700)}`)
  }
  if (files.length) lines.push(`File modificati di recente: ${files.join(', ')}`)
  if (subagents.length) {
    const done = subagents.filter((event) => event.ev.k === 'subagent_end' && event.ev.status === 'done').length
    lines.push(`Sub-agent: ${done}/${subagents.length} completati con successo.`)
  }
  if (!lines.length) lines.push(`Continua la sessione intitolata “${session.title}”. Controlla il repository e la trascrizione prima di agire.`)

  let remaining: string
  if (session.status === 'running' || session.status === 'starting') {
    remaining = 'L’harness precedente stava ancora lavorando. Controlla lo stato attuale del repository e la trascrizione, poi continua l’ultima richiesta dal punto raggiunto.'
  } else if (errors[0] && (session.status === 'error' || !assistants[0] || errors[0].seq > assistants[0].seq)) {
    const ev = errors[0].ev
    const detail = ev.k === 'error' ? ev.text : ev.k === 'tool_result' ? ev.text : ''
    remaining = `Risolvi l’ultimo errore, poi completa e verifica la richiesta originale: ${compact(detail, 600)}`
  } else {
    const lastUser = [...main].reverse().find((event) => event.ev.k === 'user')
    const lastReply = [...main].reverse().find((event) => event.ev.k === 'assistant')
    remaining = lastUser && (!lastReply || lastUser.seq > lastReply.seq)
      ? 'L’ultima richiesta dell’utente non ha ancora ricevuto una risposta completa. Continua il lavoro, conserva quanto già presente e verifica il risultato.'
      : 'Confronta lo stato attuale del repository con l’ultima richiesta, completa ciò che resta e avvia i test pertinenti. Se è già tutto completo, verificalo prima di comunicarlo.'
  }

  return { summary: lines.map((line) => `- ${line}`).join('\n'), remaining }
}

/** Expand a user-editable template without evaluating arbitrary expressions. */
export function buildTransferPrompt(
  session: SessionSummary,
  events: SessionEvent[],
  template?: string | null,
): string {
  const context = transferContext(session, events)
  const native = session.nativeId?.trim()
  const sourceSession = native && native !== session.id
    ? `${native} (Sedano ${session.id})`
    : session.id
  const values: Record<string, string> = {
    sourceHarness: HARNESS_LABEL[session.harness],
    sourceSession,
    summary: context.summary,
    remaining: context.remaining,
  }
  return (template?.trim() || DEFAULT_TRANSFER_PROMPT_TEMPLATE)
    // Old custom templates can still contain the removed token. Removing its
    // entire line avoids leaving an empty `Workspace:` label in the handoff.
    .replace(/^[^{}\r\n]*\{workspace\}[^{}\r\n]*(?:\r?\n|$)/gim, '')
    .replace(
      /\{(sourceHarness|sourceSession|workspace|summary|remaining)\}/g,
      (_, key: string) => values[key] ?? '',
    )
}
