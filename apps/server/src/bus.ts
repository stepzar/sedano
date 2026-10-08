import type { ServerMsg } from '@shared'

export interface Client {
  id: string
  send(msg: ServerMsg): void
  /**
   * The same message already serialized. Optional, so a client that only knows
   * `send` (the test doubles) keeps working; a socket client implements it so a
   * broadcast is stringified once rather than once per window — a delta goes out
   * per token, and a large timeline frame is megabytes.
   */
  sendText?(text: string): void
  subscribed: Set<string>
}

const clients = new Set<Client>()

export function addClient(client: Client): void {
  clients.add(client)
}

export function removeClient(client: Client): void {
  clients.delete(client)
}

export function broadcast(msg: ServerMsg, filter?: (c: Client) => boolean): void {
  let text: string | null = null
  for (const client of clients) {
    if (filter && !filter(client)) continue
    try {
      if (client.sendText) client.sendText((text ??= JSON.stringify(msg)))
      else client.send(msg)
    } catch {
      clients.delete(client)
    }
  }
}

/** Broadcast only to clients subscribed to a given session. */
export function broadcastSession(sessionId: string, msg: ServerMsg): void {
  broadcast(msg, (c) => c.subscribed.has(sessionId))
}

export function clientCount(): number {
  return clients.size
}
