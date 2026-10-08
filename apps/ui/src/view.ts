import { resultOutcomeOf } from '@shared'
import type { SessionEvent, TimelineEvent, TurnRecord } from '@shared'

export type SubagentStart = Extract<TimelineEvent, { k: 'subagent_start' }>
export type SubagentEnd = Extract<TimelineEvent, { k: 'subagent_end' }>

export interface SubagentGroup {
  kind: 'subagent'
  toolId: string
  agentId: string
  /** The actor that launched this one, when the adapter reported it. */
  parentAgentId?: string
  /**
   * The turn the card belongs to, taken from the first event that formed it. A
   * subagent's work is the turn's work, and a sidechain that outlives the turn's
   * own `result` must still be rendered under the prompt that spawned it.
   */
  turnId?: string
  start: SubagentStart
  end: SubagentEnd | null
  /** Sequence of the completion row, used to spot premature completions. */
  endSeq: number
  firstAt: number
  events: SessionEvent[]
  /** Provider-native children; their events stay in their own card. */
  children: SubagentGroup[]
}

export type Row = SessionEvent | SubagentGroup

export function isGroup(row: Row): row is SubagentGroup {
  return (row as SubagentGroup).kind === 'subagent'
}

/**
 * A call the turn made: something the agent *did*, rather than something it said.
 *
 * This is the line between the work and the reply. Prose that follows the last
 * of these is what the turn concluded; prose that comes before one is narration
 * on the way to doing something, and narration is part of the work. Reading it as
 * the answer is what put "I'll read the middleware first" on the same level as
 * the conclusion it was only a step towards.
 */
export function isAction(row: Row): boolean {
  return (
    isGroup(row) || row.ev.k === 'tool' || row.ev.k === 'tool_result' || row.ev.k === 'file_change'
  )
}

/**
 * A completion row with no metrics at all is the harness' first, empty write:
 * treat it as provisional so a working subagent never looks finished. This also
 * repairs events persisted by older versions of the server.
 */
function normalizeEnd(end: SubagentEnd): SubagentEnd {
  const empty = end.toolUses === 0 && end.durationMs === 0 && !end.usage && !end.result
  return empty && !end.provisional ? { ...end, provisional: true } : end
}

/**
 * The stand-in a source writes when it does not know what kind of agent this is.
 *
 * The server publishes a card the moment it learns a subagent exists, and the
 * source that gets there first is often the one that knows the least — the
 * sidecar meta file, or a completion row with no launch behind it. Both fall
 * back to this word, so it has to be readable as "not answered yet" rather than
 * as an answer: a later source that names a real type must win over it, however
 * late it lands.
 */
const UNTYPED_AGENT = 'agent'

/**
 * Assemble one subagent's launch record from every source that describes it.
 *
 * Captured traces (`scripts/fixtures/traces/claude/subagent.jsonl`) show three
 * of them, arriving in no fixed order and none complete on its own: the `Agent`
 * tool call carries `subagent_type`, `description` and the prompt but no agent
 * id; `system/task_started` carries all of it including the id; the sidecar
 * `agent-<id>.meta.json` carries the id and the type but never the prompt.
 *
 * So a field is only ever filled in, never blanked: a source that says nothing
 * about a field is silent, not authoritative. That is what a card starting up
 * needs — it used to render the placeholder type with no description at all
 * until the slowest source arrived, which is the "agent · agent" row.
 */
function mergeStart(previous: SubagentStart | undefined, next: SubagentStart): SubagentStart {
  if (!previous) return next
  // A named type beats the placeholder whichever order the two arrive in.
  const named = [next.agentType, previous.agentType].find((type) => type && type !== UNTYPED_AGENT)
  const merged: SubagentStart = {
    ...previous,
    ...next,
    agentId: next.agentId || previous.agentId || '',
    agentType: named || next.agentType || previous.agentType || UNTYPED_AGENT,
    description: next.description || previous.description || '',
    prompt: next.prompt || previous.prompt || '',
    depth: next.depth || previous.depth || 1,
  }
  const model = next.model || previous.model
  if (model) merged.model = model
  else delete merged.model
  return merged
}

/** The launch record an `Agent`/`Task` tool call is, read from its own input. */
function startFromSpawnCall(ev: Extract<TimelineEvent, { k: 'tool' }>): SubagentStart {
  const input = ev.input && typeof ev.input === 'object' && !Array.isArray(ev.input)
    ? (ev.input as Record<string, unknown>)
    : {}
  const text = (key: string): string => {
    const value = input[key]
    return typeof value === 'string' ? value.trim() : ''
  }
  const prompt = text('prompt')
  const promptLines = prompt.split('\n').map((line) => line.trim()).filter(Boolean)
  const brief = promptLines.indexOf('[BRIEF]')
  const inferredDescription = (brief >= 0 ? promptLines[brief + 1] : promptLines[0]) ?? ''
  return {
    k: 'subagent_start',
    toolId: ev.toolId,
    agentId: '',
    agentType: text('subagent_type') || text('agent_type') || UNTYPED_AGENT,
    description: text('description') || inferredDescription.slice(0, 140),
    prompt,
    depth: 1,
  }
}

/** A generic `agent` tool name is not enough to invent a subagent card. */
function describesAgentCall(ev: Extract<TimelineEvent, { k: 'tool' }>): boolean {
  if (!isAgentCall(ev.name) || !ev.input || typeof ev.input !== 'object' || Array.isArray(ev.input)) return false
  const input = ev.input as Record<string, unknown>
  return ['subagent_type', 'agent_type', 'description', 'prompt'].some(
    (key) => typeof input[key] === 'string' && Boolean((input[key] as string).trim()),
  )
}

/**
 * Nest subagent sidechains under their spawn card.
 *
 * Two passes: first resolve `toolId <-> agentId` (meta.json can land a few ms
 * after the tool call, so the same tool id may show up twice), then route every
 * event to its group. Completion rows are routed by tool id because they are
 * written by the parent transcript, not by the sidechain.
 */
export function buildRows(events: SessionEvent[]): Row[] {
  const startByTool = new Map<string, SubagentStart>()
  const toolByAgent = new Map<string, string>()
  // Every run of an agent, by when it started: a resumed agent has one card per
  // run, and each of its lines belongs to the run that was going at the time.
  const runsByAgent = new Map<string, Array<{ at: number; toolId: string }>>()
  const parentByAgent = new Map<string, string>()
  // The Claude task lifecycle also reports background Bash. A real tool call
  // tells us which is which, including for rows persisted by older Sedano
  // versions that mistakenly stored those task notices as subagent events.
  const ordinaryTools = new Set(events.flatMap((event) =>
    event.ev.k === 'tool' && !isAgentCall(event.ev.name) ? [event.ev.toolId] : [],
  ))

  for (const event of events) {
    const ev = event.ev
    if (ev.k === 'subagent_start' && !ordinaryTools.has(ev.toolId)) {
      startByTool.set(ev.toolId, mergeStart(startByTool.get(ev.toolId), ev))
      if (ev.agentId) toolByAgent.set(ev.agentId, ev.toolId)
      if (ev.agentId) {
        const runs = runsByAgent.get(ev.agentId) ?? []
        if (!runs.some((run) => run.toolId === ev.toolId)) runs.push({ at: event.at, toolId: ev.toolId })
        runsByAgent.set(ev.agentId, runs)
      }
      if (ev.agentId && event.parentAgentId) parentByAgent.set(ev.agentId, event.parentAgentId)
    } else if (ev.k === 'tool' && describesAgentCall(ev)) {
      // The spawn call describes the agent it is spawning, and it is always the
      // first thing on the wire: reading it is what lets a card say what it is
      // while it is starting, instead of waiting for the harness' own frame.
      startByTool.set(ev.toolId, mergeStart(startByTool.get(ev.toolId), startFromSpawnCall(ev)))
    } else if (ev.k === 'subagent_end' && !ordinaryTools.has(ev.toolId) && !ev.background && ev.toolId && ev.agentId) {
      toolByAgent.set(ev.agentId, ev.toolId)
    }
  }

  for (const runs of runsByAgent.values()) runs.sort((a, b) => a.at - b.at)
  /** The run an agent's line belongs to: the latest one started by then, or its first. */
  const runOf = (agentId: string, at: number): string | undefined => {
    const runs = runsByAgent.get(agentId)
    if (!runs?.length) return toolByAgent.get(agentId)
    let found = runs[0]!.toolId
    for (const run of runs) if (run.at <= at) found = run.toolId
    return found
  }

  const groups = new Map<string, SubagentGroup>()
  const rows: Row[] = []
  // The spawning call is where a card belongs among its siblings. The harness'
  // own launch frame (Claude's `task_started`) is streamed *before* the
  // transcript line that holds the call — and before the text written just
  // ahead of it — so placing the card at its first frame put it above that
  // text, and the text, now after the last action, was read as the reply.
  const spawnCalls = new Set(events.flatMap((event) =>
    event.ev.k === 'tool' && isAgentCall(event.ev.name) && startByTool.has(event.ev.toolId) ? [event.ev.toolId] : [],
  ))

  // The card belongs to the turn of the first event that formed it; a later
  // event never moves it, so a sidechain that keeps working past its turn's
  // `result` cannot drift into the next prompt.
  const adoptTurn = (group: SubagentGroup | null, event: SessionEvent): void => {
    if (group && !group.turnId && event.turnId) group.turnId = event.turnId
  }

  const placed = new Set<SubagentGroup>()
  const groupFor = (toolId: string, agentId?: string, atCall = false): SubagentGroup | null => {
    const existing = groups.get(toolId)
    if (existing) {
      if (atCall && !placed.has(existing)) {
        placed.add(existing)
        rows.push(existing)
      }
      return existing
    }
    const start = startByTool.get(toolId)
    if (!start) return null
    const group: SubagentGroup = {
      kind: 'subagent',
      toolId,
      agentId: start.agentId || agentId || '',
      parentAgentId: parentByAgent.get(start.agentId || agentId || ''),
      start,
      end: null,
      endSeq: 0,
      firstAt: 0,
      events: [],
      children: [],
    }
    groups.set(toolId, group)
    // Without a spawn call on record, the first frame is the only place there is.
    if (atCall || !spawnCalls.has(toolId)) {
      placed.add(group)
      rows.push(group)
    }
    return group
  }

  for (const event of events) {
    const ev = event.ev

    if (ev.k === 'subagent_start') {
      if (ordinaryTools.has(ev.toolId)) continue
      const group = groupFor(ev.toolId, ev.agentId)
      if (group && !group.firstAt) group.firstAt = event.at
      adoptTurn(group, event)
      continue
    }

    if (ev.k === 'tool' && spawnCalls.has(ev.toolId)) {
      // The spawn call itself becomes the card header, and puts it here.
      adoptTurn(groupFor(ev.toolId, undefined, true), event)
      continue
    }

    // A turn ending does not decide anything here: whether an empty completion
    // row was the harness' premature write or a real "finished" only becomes
    // clear once every event has been routed. Deciding it inline got the order
    // wrong whenever a sidechain event arrived after the parent's `result`.
    if (ev.k === 'result') {
      rows.push(event)
      continue
    }

    if (ev.k === 'subagent_end') {
      // A background command finishing is drawn on its call (see `toolFacts`).
      if (ordinaryTools.has(ev.toolId) || ev.background) continue
      const toolId = ev.toolId || (ev.agentId ? (toolByAgent.get(ev.agentId) ?? '') : '')
      const group = toolId ? (groups.get(toolId) ?? groupFor(toolId, ev.agentId)) : null
      if (group) {
        group.end = normalizeEnd(ev)
        group.endSeq = event.seq
        group.events.push(event)
        adoptTurn(group, event)
        continue
      }
      // A bare progress frame is not proof that this was an agent at all.
      // Background Bash uses the same frame and has no prompt or sidechain.
      if (ev.provisional) continue
      // Completion without a spawn card (older transcript): keep the evidence.
      rows.push({
        kind: 'subagent',
        toolId: ev.toolId || ev.agentId,
        agentId: ev.agentId,
        parentAgentId: event.parentAgentId,
        turnId: event.turnId,
        start: {
          k: 'subagent_start',
          toolId: ev.toolId,
          agentId: ev.agentId,
          agentType: UNTYPED_AGENT,
          description: ev.status === 'error' || ev.status === 'stopped'
            ? 'Task failed; details unavailable'
            : 'Task details unavailable',
          prompt: '',
          depth: 1,
        },
        end: normalizeEnd(ev),
        endSeq: event.seq,
        firstAt: event.at,
        events: [event],
        children: [],
      })
      continue
    }

    if (event.agentId) {
      const toolId = runOf(event.agentId, event.at)
      const group = toolId ? groupFor(toolId, event.agentId) : null
      if (group) {
        group.events.push(event)
        adoptTurn(group, event)
        continue
      }
    }

    rows.push(event)
  }

  // An empty completion row followed by work of its own is the harness' premature
  // write, so it stays provisional and the card keeps saying "running"; one with
  // nothing after it really did finish. Decided here, once every event is routed,
  // because a sidechain event can arrive after the parent turn's `result`.
  for (const group of groups.values()) {
    if (!group.end?.provisional) continue
    const hadLaterWork = group.events.some((event) => event.seq > group.endSeq)
    if (!hadLaterWork) group.end = { ...group.end, provisional: undefined }
  }

  /**
   * A discovery frame can contain nothing but two correlation ids. Older
   * adapters also wrote an empty completion for that frame. Neither describes
   * an agent a person can recognise and neither contains work to inspect, so it
   * is plumbing rather than a transcript card. Waiting for a later, richer
   * frame is important here: drawing the placeholder immediately is what made
   * the blank, duplicated `Subagent · Subagent` card in the transcript.
   */
  const meaningfulGroup = (group: SubagentGroup): boolean => {
    const namedType = group.start.agentType.trim().toLowerCase()
    if (namedType && namedType !== UNTYPED_AGENT) return true
    if (group.start.description.trim() || group.start.prompt.trim()) return true
    if (
      group.events.some((event) =>
        ['assistant', 'thinking', 'tool', 'tool_result', 'file_change', 'error'].includes(event.ev.k),
      )
    ) return true
    if (group.children.some(meaningfulGroup)) return true
    const end = group.end
    return Boolean(
      end &&
        (end.status !== 'done' || end.result.trim() || end.toolUses > 0 || end.durationMs > 0 || end.usage),
    )
  }

  // `depth` is useful metadata, but not identity. Nest only when the stream
  // names the actual parent actor; legacy events without that link remain
  // top-level rather than being attached to whichever card happened to precede
  // them.
  const groupByAgent = new Map(
    [...groups.values()].filter((group) => group.agentId).map((group) => [group.agentId, group]),
  )
  const nested = new Set<SubagentGroup>()
  for (const group of groups.values()) {
    const parent = group.parentAgentId ? groupByAgent.get(group.parentAgentId) : undefined
    if (!parent || parent === group) continue
    // Two actors naming each other as parent is a broken report, not a family:
    // nesting it would make every walk of the tree recurse forever.
    if (descendsFrom(parent, group, groupByAgent)) continue
    parent.children.push(group)
    nested.add(group)
  }
  for (const group of groups.values()) {
    group.children = group.children.filter(meaningfulGroup)
  }

  return rows.filter((row) => !isGroup(row) || (!nested.has(row) && meaningfulGroup(row)))
}

/** Whether `ancestor` is somewhere up `group`'s reported parent chain. */
function descendsFrom(group: SubagentGroup, ancestor: SubagentGroup, byAgent: Map<string, SubagentGroup>): boolean {
  const seen = new Set<SubagentGroup>()
  let current: SubagentGroup | undefined = group
  while (current && !seen.has(current)) {
    if (current === ancestor) return true
    seen.add(current)
    current = current.parentAgentId ? byAgent.get(current.parentAgentId) : undefined
  }
  return false
}

/* ------------------------------------------------------------------ */
/* Subagents                                                           */
/* ------------------------------------------------------------------ */

export interface SubagentInfo {
  toolId: string
  agentType: string
  model: string | null
  description: string
  prompt: string
  running: boolean
  toolUses: number
  durationMs: number | null
  usage?: SubagentEnd['usage']
  result: string
}

/**
 * One derivation of a session's subagents, shared by the transcript card and the
 * status bar.
 *
 * The status bar used to read the raw events, so a completion row the harness
 * writes empty (or provisional) kept counting as "running" forever, while the
 * card — which goes through `buildRows` — said otherwise. Same data, one answer.
 * Counts fall back to what actually happened in the sidechain, because a
 * provisional row reports zero tools and zero seconds.
 */
export function subagentInfos(events: SessionEvent[]): SubagentInfo[] {
  const rows = buildRows(events)
  const groups: SubagentGroup[] = []
  const collect = (group: SubagentGroup): void => {
    groups.push(group)
    for (const child of group.children) collect(child)
  }
  for (const row of rows) if (isGroup(row)) collect(row)
  return groups
    .map((group) => {
      const end = group.end
      const tools = group.events.filter((event) => event.ev.k === 'tool').length
      const last = group.events[group.events.length - 1]
      // The caller gates this on the session being live; here the question is
      // only whether a completion with real metrics has landed.
      const running = groupRunning(group, true)
      return {
        toolId: group.toolId || group.agentId,
        agentType:
          group.start.agentType && group.start.agentType.toLowerCase() !== UNTYPED_AGENT
            ? group.start.agentType
            : 'Subagent',
        model: group.start.model ?? null,
        description:
          group.start.description ||
          group.start.prompt.slice(0, 64) ||
          (end && end.status !== 'done' && end.status !== 'running' ? 'Task failed; details unavailable' : 'subagent'),
        prompt: group.start.prompt,
        running,
        toolUses: (end?.toolUses ?? 0) || tools,
        durationMs: agentSpanMs(group),
        usage: end?.usage,
        result: end?.result ?? '',
      }
    })
}

/* ------------------------------------------------------------------ */
/* Turns                                                               */
/* ------------------------------------------------------------------ */

export type UserEvent = Extract<TimelineEvent, { k: 'user' }>
export type FileChange = Extract<TimelineEvent, { k: 'file_change' }>
export type ResultEvent = Extract<TimelineEvent, { k: 'result' }>

export interface TurnStats {
  /** Files the main loop changed; a subagent's own stay in its card. */
  files: FileChange[]
  /** Totals, the main loop and its agents together. */
  commands: number
  reads: number
  searches: number
  agents: number
  linesAdded: number
  linesRemoved: number
  /**
   * The part of each count that happened inside subagents. "403 Commands" for
   * a turn whose main loop ran eleven read as the main loop's own work.
   */
  inAgents: { commands: number; reads: number; searches: number; files: number }
  /** Files the turn's subagents changed (counted with the turn's own). */
  agentFiles: FileChange[]
  /** Calls that deleted something (ACP `kind: delete`), by what they named. */
  deleted: string[]
}

/** Token traffic, in the four counters a harness reports. */
export interface TokenTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

function emptyTokens(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

function addTokens(into: TokenTotals, usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | undefined): void {
  if (!usage) return
  into.input += usage.input ?? 0
  into.output += usage.output ?? 0
  into.cacheRead += usage.cacheRead ?? 0
  into.cacheWrite += usage.cacheWrite ?? 0
}

export interface Turn {
  id: string
  /** The recorded turn, when the events carried one. Absent for legacy events. */
  turnId?: string
  /** A legacy server could start a second id after falsely ending a cold start. */
  continuationTurnId?: string
  user: UserEvent | null
  /** The id of the prompt's event, for acting on it (see `editCancelledPrompt`). */
  userId?: string
  userAt: number
  rows: Row[]
  stats: TurnStats
  durationMs: number | null
  /** The last moment anything of this turn happened, sidechains included. */
  endedAt: number
  /** What the turn spent: its own results, and its agents' completions. */
  tokens: { main: TokenTotals; agents: TokenTotals }
  outputTokens: number
  costUsd: number
  running: boolean
}

/**
 * What kind of work a tool call is, from its name or the protocol's own `kind`.
 *
 * Names are compared lower-cased: Claude says `Bash` and `Read`, ACP agents say
 * `bash` and `read`, and a count that only knew one spelling reported "0
 * Commands" for a turn that ran six hundred. When the protocol names the
 * category itself (ACP `kind`), that wins over guessing from the name.
 */
export type ToolClass = 'command' | 'read' | 'search' | 'edit'
const TOOL_CLASS: Record<string, ToolClass> = {
  bash: 'command', shell: 'command', run_terminal_command: 'command', execute_command: 'command',
  read: 'read', notebookread: 'read', read_file: 'read',
  glob: 'search', grep: 'search', websearch: 'search', webfetch: 'search', search: 'search', fetch: 'search',
  write: 'edit', edit: 'edit', multiedit: 'edit', notebookedit: 'edit', write_file: 'edit', edit_file: 'edit',
}
const KIND_CLASS: Record<string, ToolClass> = {
  execute: 'command', read: 'read', search: 'search', fetch: 'search', edit: 'edit', delete: 'edit', move: 'edit',
}

export function toolClass(name: string | undefined, kind?: string): ToolClass | null {
  const byKind = kind ? KIND_CLASS[kind.toLowerCase()] : undefined
  if (byKind) return byKind
  return name ? (TOOL_CLASS[name.toLowerCase()] ?? null) : null
}

/**
 * What a running turn is doing, read from its own events.
 *
 * Deliberately derived, never timed: a label that cycles on a clock ("Thinking…
 * Reading… Writing…") is decoration pretending to be a status, and the one thing
 * a status must not do is describe work that is not happening. The orb and the
 * word follow the last thing that actually occurred, and fall back to the
 * generic verb when there is nothing to read yet.
 */
export type Activity =
  | 'thinking'
  | 'reading'
  | 'searching'
  | 'running'
  | 'editing'
  | 'writing'
  | 'delegating'
  | 'working'

/** The word shown for each state; "…" is the caller's to add. */
export const ACTIVITY_WORD: Record<Activity, string> = {
  thinking: 'Thinking',
  reading: 'Reading',
  searching: 'Searching',
  running: 'Running',
  editing: 'Editing',
  writing: 'Writing',
  delegating: 'Waiting On Agents',
  working: 'Working',
}

const CLASS_ACTIVITY: Record<ToolClass, Activity> = {
  command: 'running', read: 'reading', search: 'searching', edit: 'editing',
}

function toolActivity(name: string | undefined, kind?: string): Activity | null {
  const found = toolClass(name, kind)
  return found ? CLASS_ACTIVITY[found] : null
}

/**
 * True for the calls that start an agent's run, whose work lives in their own
 * card. `SendMessage` is one when it resumes a stopped agent: the harness then
 * reports a new run under that call (a message to an agent still running has no
 * card, and stays an ordinary call).
 */
function isAgentCall(name: string | undefined): boolean {
  return /^(task|agent|spawnagent|sendmessage)$/i.test(name ?? '')
}

/**
 * Whether a spawn card is still waiting on its agent: only while the session
 * runs, and only until a completion with real metrics has landed.
 *
 * A provisional row is the harness reporting the spawn, not the finish; a turn
 * that is over must not keep a spinner and a verb on screen, which is exactly
 * what "it never stops updating" looked like.
 */
export function groupRunning(group: SubagentGroup, sessionLive: boolean): boolean {
  if (!sessionLive) return false
  return (
    !group.end ||
    Boolean(group.end.provisional) ||
    group.children.some((child) => groupRunning(child, sessionLive))
  )
}

/** Any card in this turn still waiting on its agent. */
export function anyAgentRunning(rows: Row[], sessionLive: boolean): boolean {
  if (!sessionLive) return false
  return rows.some((row) => isGroup(row) && groupRunning(row, sessionLive))
}

/**
 * The turn's current activity: the call it is waiting on, and nothing else.
 *
 * Only a call that has been made and not yet answered is something the turn can
 * truthfully be said to be doing. A call that has come back is finished, so
 * reading its name off the back of its own result — "Reading…" while the model
 * is already deciding what to do with the file — claimed work that was not
 * happening, and the word swapping every couple of seconds while the model went
 * about one step made a status out of decoration. With nothing outstanding, the
 * honest word is the generic one.
 */
export function activityOf(
  rows: Row[],
  options: { text?: string; thinking?: string; running?: boolean } = {},
): Activity {
  // Live buffers are the most recent evidence there is: they are cleared the
  // moment their message is committed as an event.
  if (options.thinking?.trim()) return 'thinking'
  if (options.text?.trim()) return 'writing'

  const answered = new Set<string>()
  const calls: Array<{ toolId: string; name: string; kind?: string }> = []
  for (const row of rows) {
    if (isGroup(row)) continue
    if (row.ev.k === 'tool') calls.push({ toolId: row.ev.toolId, name: row.ev.name, kind: row.ev.kind })
    else if (row.ev.k === 'tool_result') answered.add(row.ev.toolId)
  }

  // The most recent call that has not come back is what the turn is doing. Two
  // in flight at once (a harness that runs them in parallel) still reads
  // "Running" until the last one answers, which is true, and it stays put while
  // the model waits on it.
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index]!
    if (answered.has(call.toolId)) continue
    if (isAgentCall(call.name)) return 'delegating'
    return toolActivity(call.name, call.kind) ?? 'working'
  }

  // Nothing outstanding: this turn's own agents are the only thing left to wait
  // on; otherwise the model is deciding what to do next, which "Working" says
  // without claiming to know what it decided.
  return anyAgentRunning(rows, options.running !== false) ? 'delegating' : 'working'
}

function emptyStats(): TurnStats {
  return {
    files: [], commands: 0, reads: 0, searches: 0, agents: 0, linesAdded: 0, linesRemoved: 0,
    inAgents: { commands: 0, reads: 0, searches: 0, files: 0 },
    agentFiles: [],
    deleted: [],
  }
}

function tallyTool(stats: TurnStats, name: string, kind: string | undefined, inAgent: boolean): void {
  const found = toolClass(name, kind)
  const key = found === 'command' ? 'commands' : found === 'read' ? 'reads' : found === 'search' ? 'searches' : null
  if (!key) return
  stats[key] += 1
  if (inAgent) stats.inAgents[key] += 1
}

/**
 * Group the render tree into turns (one user message plus everything it
 * caused), counting what happened so a finished turn can collapse into a
 * single line. Sidechain work is counted too: it belongs to the same turn.
 *
 * The turn an event belongs to is data when the server recorded it (`turnId`),
 * and only a guess otherwise. The guess — "everything after a user message
 * belongs to it until the next one" — is what let a transcript line or a
 * sidechain event that arrived after the next prompt be rendered under a prompt
 * that did not cause it. So an event that carries a turn goes to that turn,
 * however late it shows up, and the sequential reading is left to the events
 * persisted before turns existed.
 */
export function buildTurns(rows: Row[], options: { live?: boolean } = {}): Turn[] {
  const turns: Turn[] = []
  const byTurnId = new Map<string, Turn>()
  let current: Turn | null = null

  const open = (
    user: UserEvent | null,
    at: number,
    turnId?: string,
    options: { activate?: boolean } = {},
  ): Turn => {
    const activate = options.activate !== false
    // A new prompt closes whatever came before it: only the last turn can be
    // working, so a turn whose `result` never arrived (an error, a queued
    // message, a harness that died) cannot leave a second spinner on screen
    // next to the one that is actually running.
    if (activate) for (const previous of turns) previous.running = false
    const turn: Turn = {
      // The recorded id is the stable one: it does not move when the prompt is
      // edited or the timestamp is refined, which is what a React key wants.
      id: turnId ? `turn:${turnId}` : user ? `turn:${user.text.slice(0, 24)}:${at}` : `turn:start:${at}`,
      turnId,
      user,
      userAt: at,
      rows: [],
      stats: emptyStats(),
      durationMs: null,
      endedAt: at,
      tokens: { main: emptyTokens(), agents: emptyTokens() },
      outputTokens: 0,
      costUsd: 0,
      running: activate,
    }
    turns.push(turn)
    if (turnId) byTurnId.set(turnId, turn)
    if (activate) current = turn
    return turn
  }

  /**
   * The turn a row goes in. A known turn is found by id — that is the whole
   * point, a late event rejoins the turn it came from instead of the one on
   * screen — and an unknown one opens the next turn, in the order the rows are
   * read.
   */
  const turnFor = (row: Row, at: number): Turn => {
    const turnId = row.turnId
    if (turnId) {
      const known = byTurnId.get(turnId)
      if (known) return known
      // Older servers treated the adapter's startup "idle" as the end of the
      // accepted prompt. The real output then acquired a new id without any
      // second user message. Repair only that recognizable synthetic boundary;
      // a genuine autonomous turn must still get its own card.
      const premature = current?.rows.find((item) =>
        !isGroup(item) && item.ev.k === 'result' && item.id.startsWith('local:result:'),
      )
      const hasWork = current?.rows.some((item) =>
        isGroup(item) || (!['system', 'result'].includes(item.ev.k)),
      )
      if (current?.user && premature && !hasWork) {
        current.rows = current.rows.filter((item) => item !== premature)
        current.durationMs = null
        current.running = true
        current.continuationTurnId = turnId
        byTurnId.set(turnId, current)
        return current
      }
      return open(null, at, turnId)
    }
    return current ?? open(null, at)
  }

  const absorb = (turn: Turn, event: SessionEvent, inAgent = false): void => {
    const ev = event.ev
    turn.endedAt = Math.max(turn.endedAt, event.at)
    if (ev.k === 'tool') {
      tallyTool(turn.stats, ev.name, ev.kind, inAgent || Boolean(event.agentId))
      if (ev.kind?.toLowerCase() === 'delete') turn.stats.deleted.push(toolSummary(ev) || ev.name)
    }
    else if (ev.k === 'file_change') {
      // Files written inside a subagent stay inside its card (the turn's file
      // list would otherwise show them twice), but they are counted.
      if (event.agentId || inAgent) {
        turn.stats.inAgents.files += 1
        turn.stats.agentFiles.push(ev)
        return
      }
      turn.stats.files.push(ev)
      turn.stats.linesAdded += ev.added
      turn.stats.linesRemoved += ev.removed
    } else if (ev.k === 'result') {
      // A turn can hold several results: the model keeps talking after an agent
      // comes back, and the harness reports each of those turns on its own. The
      // turn's span is their sum — taking the last one made a turn that ran
      // thirteen seconds say "Worked for 2s".
      if (!event.agentId) turn.durationMs = (turn.durationMs ?? 0) + ev.durationMs
      // Agents' tokens are taken from their completion (see `absorbGroup`), so a
      // sidechain's own result is not counted twice.
      if (!event.agentId && !inAgent) addTokens(turn.tokens.main, ev.usage)
      turn.outputTokens += ev.usage?.output ?? 0
      turn.costUsd += ev.costUsd
      turn.running = false
    }
  }

  const absorbGroup = (turn: Turn, group: SubagentGroup): void => {
    turn.stats.agents += 1
    turn.endedAt = Math.max(turn.endedAt, group.firstAt)
    addTokens(turn.tokens.agents, group.end?.usage)
    for (const event of group.events) {
      if (event.ev.k === 'subagent_end' || event.ev.k === 'subagent_start') {
        // A stop written for an agent cut off by a restart carries the moment
        // it was noticed — possibly days later — not a moment the turn worked.
        if (!(event.ev.k === 'subagent_end' && event.ev.status === 'stopped')) turn.endedAt = Math.max(turn.endedAt, event.at)
        continue
      }
      absorb(turn, event, true)
    }
    for (const child of group.children) absorbGroup(turn, child)
  }

  for (const row of rows) {
    if (!isGroup(row) && row.ev.k === 'user' && !row.agentId) {
      // A prompt the user cancelled before it was delivered never happened as
      // far as the conversation is concerned: it is not drawn at all, and the
      // one just cancelled goes back into the composer (see `onAcked`). One the
      // *server* cancelled (a failed turn ahead of it) stays, marked "Not sent",
      // because nobody chose to lose it. History without the field stays hidden.
      if (row.ev.delivery === 'cancelled' && cancelledBy(row.ev) !== 'server') continue
      // The turn header renders the prompt. Putting the same row in `rows` too
      // would print it a second time inside the work block.
      const existing = row.turnId ? byTurnId.get(row.turnId) : null
      if (existing) {
        // The turn was opened by one of its own events before its prompt was
        // read (a replay that reordered them): give it its header rather than a
        // second turn with the same id.
        if (!existing.user) {
          existing.user = row.ev
          existing.userId = row.id
          existing.userAt = row.at
        }
        current = existing
      } else {
        const deferred =
          row.ev.delivery === 'queued' || row.ev.delivery === 'cancelled' || row.ev.delivery === 'failed'
        // A prompt accepted behind the active turn is already part of the
        // transcript, but it has not started a turn yet. Keep the current turn
        // live and give the future prompt its own stable slot; when the same
        // event is upserted to `starting`/`delivered`, it becomes active without
        // moving or duplicating its bubble.
        open(row.ev, row.at, row.turnId, { activate: !deferred }).userId = row.id
      }
      continue
    }
    const turn = turnFor(row, isGroup(row) ? row.firstAt : row.at)
    turn.rows.push(row)
    if (isGroup(row)) {
      absorbGroup(turn, row)
    } else {
      absorb(turn, row)
    }
  }

  // A turn is only live while the session is: when the harness dies, the app is
  // closed mid-turn or the turn is interrupted, no `result` event ever arrives
  // and every turn would keep its spinner forever. Liveness belongs to the
  // session, not to the transcript's guess about the stream.
  if (options.live === false) for (const turn of turns) turn.running = false

  return turns
}

/**
 * Hand back the previous object for every turn whose content did not change.
 *
 * `buildTurns` rebuilds every turn from scratch whenever one event arrives, so
 * a memoised turn view saw a new object each time and repainted the whole
 * transcript — in a long session that is hundreds of turns re-rendered for one
 * tool call in the last of them. Identity is what the memo compares, so the
 * finished turns keep theirs and only the turn that actually moved is new.
 */
export function reuseTurns(
  previous: Turn[],
  next: Turn[],
  // A tool's result is drawn inside the tool's card, and it can be committed to
  // a different turn than the call (legacy rows without a turn id). A turn whose
  // calls got a new answer has changed even if its own rows did not.
  results?: { before: Map<string, unknown>; after: Map<string, unknown> },
): Turn[] {
  if (!previous.length) return next
  const byId = new Map(previous.map((turn) => [turn.id, turn]))
  const answered = (rows: Row[]): boolean =>
    rows.every((row) =>
      isGroup(row)
        ? answered(row.events) && answered(row.children)
        : row.ev.k !== 'tool' || results!.before.get(row.ev.toolId) === results!.after.get(row.ev.toolId),
    )
  return next.map((turn) => {
    const old = byId.get(turn.id)
    if (!old || !sameTurn(old, turn)) return turn
    if (results && results.before !== results.after && !answered(old.rows)) return turn
    return old
  })
}

function sameTurn(a: Turn, b: Turn): boolean {
  return (
    a.turnId === b.turnId &&
    a.continuationTurnId === b.continuationTurnId &&
    a.user === b.user &&
    a.userAt === b.userAt &&
    a.running === b.running &&
    a.durationMs === b.durationMs &&
    a.outputTokens === b.outputTokens &&
    a.costUsd === b.costUsd &&
    // Everything else on a turn (stats, files) is derived from its rows.
    sameList(a.rows, b.rows, sameRow)
  )
}

function sameRow(a: Row, b: Row): boolean {
  if (a === b) return true
  if (!isGroup(a) || !isGroup(b)) return false
  return (
    a.toolId === b.toolId &&
    a.agentId === b.agentId &&
    a.parentAgentId === b.parentAgentId &&
    a.turnId === b.turnId &&
    a.endSeq === b.endSeq &&
    a.firstAt === b.firstAt &&
    // Group headers are merged into fresh objects on every build.
    sameFields(a.start, b.start) &&
    (a.end === b.end || (a.end !== null && b.end !== null && sameFields(a.end, b.end))) &&
    sameList(a.events, b.events, (x, y) => x === y) &&
    sameList(a.children, b.children, sameRow)
  )
}

function sameList<T>(a: T[], b: T[], same: (x: T, y: T) => boolean): boolean {
  return a.length === b.length && a.every((item, index) => same(item, b[index]!))
}

function sameFields(a: object, b: object): boolean {
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key])
}

/* ------------------------------------------------------------------ */
/* Reading a turn: state, order, and what a tool call was about        */
/* ------------------------------------------------------------------ */

/**
 * The three readings a turn can have, and the only ones.
 *
 * "Still going" and "this is the answer" were indistinguishable while scrolling,
 * because the only difference was a word in the header. Deriving the state once,
 * here, lets the transcript mark it on the turn element itself, so the spine, the
 * header and the reply all say the same thing without each re-deciding it.
 */
export type TurnState = 'working' | 'failed' | 'interrupted' | 'done'

export function turnState(turn: Turn, sessionLive: boolean): TurnState {
  // A parent `result` can land while the turn's agents are still out, so the
  // turn is only finished once nothing is still working.
  // Liveness belongs to the session: a harness that died mid-turn leaves a turn
  // whose `result` never arrived, and that must not read as work in progress.
  if (sessionLive && (turn.running || anyAgentRunning(turn.rows, sessionLive))) return 'working'
  // Failed means the turn failed: an error it ended on, or a result that says
  // so. A tool call that came back with an error, or an agent that did, is part
  // of the work — the model reads it and carries on — and painting the whole
  // turn red for one failed grep was a claim about the turn it did not make.
  let interrupted = false
  for (const row of turn.rows) {
    if (isGroup(row) || row.agentId) continue
    const ev = row.ev
    if (ev.k === 'error') return 'failed'
    if (ev.k === 'result') {
      const outcome = resultOutcomeOf(ev)
      if (outcome === 'failed') return 'failed'
      if (outcome === 'interrupted') interrupted = true
    }
  }
  // Agents still out when the session stopped were cut off, not failed.
  if (!sessionLive && cutOffAgents(turn) > 0) return 'interrupted'
  return interrupted ? 'interrupted' : 'done'
}

/**
 * Agents of this turn that never finished: no completion, only the harness'
 * provisional one, or one that says it was still running or was stopped. Only
 * meaningful once the session has stopped — while it runs they are working.
 */
export function cutOffAgents(turn: Turn): number {
  let count = 0
  const visit = (group: SubagentGroup): void => {
    const end = group.end
    if (!end || end.provisional || end.status === 'running' || end.status === 'stopped') count += 1
    for (const child of group.children) visit(child)
  }
  for (const row of turn.rows) if (isGroup(row)) visit(row)
  return count
}

/** How long the turn took on the clock: from the prompt to the last thing it did. */
/**
 * How long an agent worked, honestly: what it reported, and otherwise from its
 * launch to the last thing it did itself.
 *
 * An agent cut off by a stop or a restart is capped at its last activity: its
 * `stopped` row is written when the stop is noticed, and older builds stamped
 * "now - launch" into it — a restart a week later read as a week of work.
 * Missing or zero timestamps are ignored; with nothing to measure, null.
 */
export function agentSpanMs(group: SubagentGroup): number | null {
  const end = group.end
  let lastActivity = 0
  for (const event of group.events) {
    if (event.ev.k === 'subagent_end' || event.ev.k === 'subagent_start') continue
    if (event.at > lastActivity) lastActivity = event.at
  }
  const lived = lastActivity && group.firstAt > 0 ? Math.max(0, lastActivity - group.firstAt) : null
  if (end?.status === 'stopped') {
    if (lived === null) return null
    return end.durationMs > 0 ? Math.min(end.durationMs, lived) : lived
  }
  if (end && end.durationMs > 0) return end.durationMs
  return lived
}

/**
 * The span a turn's header states: from its prompt to the last thing it did.
 *
 * The server's ledger end wins when it is earlier (it is the turn's own
 * result), but never when it is later than every event the turn has: a turn
 * closed by a restart or a stop is closed at the moment that was noticed, and
 * that moment is not work.
 */
export function turnSpanMs(turn: Turn, record: TurnRecord | null | undefined): number {
  const start = turnStartedAt(turn, record)
  const wall = turnWallMs(turn, start)
  const ledger = record?.endedAt && record.endedAt > start ? record.endedAt - start : 0
  if (!ledger) return wall
  return turn.endedAt > start ? Math.min(ledger, wall) : ledger
}

/**
 * When a turn began running, which is not always when its prompt was sent.
 *
 * A prompt queued behind a running turn is written the moment it is typed, but
 * its turn starts only when the queue releases it, and the server's ledger
 * records that moment (`TurnRecord.startedAt`). Counting from the prompt made a
 * queued turn open with the minutes it spent waiting already on its clock. The
 * later of the two wins: a turn cannot start before its own prompt.
 */
export function turnStartedAt(turn: Turn, record: TurnRecord | null | undefined): number {
  const started = record?.startedAt ?? 0
  return started > turn.userAt ? started : turn.userAt
}

/**
 * A duration, the same way everywhere: "0.2s" and "4.1s" under ten seconds
 * (a command's time is worth its tenth), then "26s", "4m 12s", "1h 3m".
 */
export function formatDuration(ms: number): string {
  const value = Math.max(0, ms)
  return value < 10_000 ? `${(value / 1000).toFixed(1)}s` : formatSpan(value)
}

export function turnWallMs(turn: Turn, start = turn.userAt): number {
  const wall = turn.endedAt - start
  // A turn whose events carry no usable clock falls back to what the harness said.
  return wall > 0 ? wall : (turn.durationMs ?? 0)
}

/** "26s", "4m 12s", "1h 3m" — a span, readable at a glance. */
export function formatSpan(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/**
 * The harness' own bookkeeping, told apart from what the turn did.
 *
 * Every configured hook writes one of these at the end of every turn, and a
 * successful `result` repeats figures the turn header already carries. Stacked
 * between the work and the reply they were five lines of noise in the one place
 * the eye is looking for the answer. They are not deleted — a hook that stopped
 * the turn or reported an error is not routine and stays in plain sight, and the
 * routine ones move one click away.
 */
const ROUTINE_HOOK = /^\d+ hooks? ran(?: in \d+ms)?$/

/** Harness bookkeeping that is worth keeping but not worth a line of its own. */
const ROUTINE_SYSTEM = new Set(['compact_boundary', 'api_retry', 'api-retry'])

export function isRoutineNotice(event: SessionEvent): boolean {
  const ev = event.ev
  if (ev.k === 'result') return resultOutcomeOf(ev) === 'completed'
  if (ev.k !== 'system') return false
  if (ev.subtype === 'stop_hook_summary') return ROUTINE_HOOK.test(ev.text.trim())
  if (ROUTINE_SYSTEM.has(ev.subtype)) return true
  // An API error the harness is retrying is a retry, not the failure.
  return ev.subtype === 'api_error' && ev.detail?.attempt !== undefined
}

function shortTokens(value: number): string {
  return value >= 1000 ? `${Math.round(value / 1000)}k` : String(value)
}

/**
 * The one line a harness notice reads as, from its structured details when the
 * harness gave any ("Compacted · 180k→40k", "API retry 2/10 · overloaded");
 * otherwise the line the server wrote.
 */
export function noticeLine(ev: Extract<TimelineEvent, { k: 'system' }>): string {
  const detail = ev.detail ?? {}
  const number = (key: string): number | null => (typeof detail[key] === 'number' ? (detail[key] as number) : null)
  if (ev.subtype === 'compact_boundary') {
    const before = number('preTokens')
    const after = number('postTokens')
    return before !== null && after !== null ? `Compacted · ${shortTokens(before)}→${shortTokens(after)}` : ev.text
  }
  if (ev.subtype === 'api_retry' || ev.subtype === 'api-retry' || (ev.subtype === 'api_error' && number('attempt') !== null)) {
    const attempt = number('attempt')
    const max = number('maxRetries')
    const why = String(detail.message ?? detail.status ?? '').trim()
    if (attempt === null) return ev.text
    return `API retry ${attempt}${max !== null ? `/${max}` : ''}${why ? ` · ${why.slice(0, 80)}` : ''}`
  }
  return ev.text
}

export interface WorkSplit {
  /** The session's own configuration, shown once as a header rather than inline. */
  context: SessionEvent[]
  /** What the turn actually did, in the order it happened. */
  activity: Row[]
  /** Routine bookkeeping, kept behind a disclosure. */
  notices: SessionEvent[]
}

/**
 * Give the expanded turn a fixed internal order: configuration first, then the
 * work in the order it happened, then the bookkeeping. Before this everything
 * landed in one flat list at the same weight, which is what "a pile" meant.
 */
export function splitWork(rows: Row[]): WorkSplit {
  const split: WorkSplit = { context: [], activity: [], notices: [] }
  for (const row of rows) {
    if (isGroup(row)) {
      split.activity.push(row)
      continue
    }
    if (row.ev.k === 'system' && row.ev.subtype === 'init') {
      split.context.push(row)
      continue
    }
    if (isRoutineNotice(row)) {
      split.notices.push(row)
      continue
    }
    split.activity.push(row)
  }
  return split
}

/**
 * Keys worth showing as a tool call's one-line summary, best first.
 *
 * The server writes the summary and knows the tools it knows; a tool it has no
 * case for arrives with an empty one. That is how the Skill card came to render
 * as the bare word "Skill" and a clock — the skill's own name sat unread in
 * `input.skill`. This is the generic repair, not a case per tool: the value of
 * the most identifying key the input happens to carry.
 */
const SUMMARY_KEYS = [
  'skill',
  'command',
  'file_path',
  'notebook_path',
  'path',
  'pattern',
  'query',
  'url',
  'description',
  'subagent_type',
  'title',
  'name',
  'prompt',
]

export function toolSummary(ev: { name: string; summary?: string; input?: unknown }): string {
  const given = ev.summary?.trim()
  if (given) return given
  const input = ev.input
  if (!input || typeof input !== 'object' || Array.isArray(input)) return ''
  const record = input as Record<string, unknown>
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
  for (const key of SUMMARY_KEYS) {
    const value = text(record[key])
    if (value) return value.split('\n')[0]!.slice(0, 200)
  }
  // Still nothing named: the first string the input carries is better than the
  // silence, and printing the object would be the plumbing the user saw before.
  for (const value of Object.values(record)) {
    const found = text(value)
    if (found) return found.split('\n')[0]!.slice(0, 200)
  }
  return ''
}

/**
 * The turn read as prose: the reply, and the updates it gave on the way.
 *
 * A turn can run several model cycles — each `result` of the main loop closes
 * one, and the model carries on when an agent comes back. The reply is the
 * closing prose of the *last* cycle only: text after that cycle's last action.
 * An earlier cycle's closing words were an update at the time, not the answer,
 * and putting them in the reply is what made one turn read as three answers.
 * Text before a tool call is a note on the way and stays in the work.
 *
 * `fallback` is the final reply the harness itself reported on the last
 * result, for a cycle whose closing prose never arrived as its own message.
 */
export interface TurnReading {
  reply: SessionEvent[]
  updates: SessionEvent[]
  fallback: string
}

export function readTurn(rows: Row[]): TurnReading {
  // File changes are drawn with the turn's files, not in its rows (as in the view).
  const visible = rows.filter((row) => isGroup(row) || row.ev.k !== 'file_change')
  const cycles: Row[][] = [[]]
  let lastResult: ResultEvent | null = null
  for (const row of visible) {
    if (!isGroup(row) && row.ev.k === 'result' && !row.agentId) {
      lastResult = row.ev
      cycles.push([])
      continue
    }
    cycles[cycles.length - 1]!.push(row)
  }
  const said = (cycle: Row[]): boolean => cycle.some((row) => isGroup(row) || row.ev.k !== 'system')
  const closing = (cycle: Row[]): SessionEvent[] => {
    const lastAction = cycle.reduce((last, row, index) => (isAction(row) ? index : last), -1)
    return cycle.filter(
      (row, index): row is SessionEvent =>
        index > lastAction && !isGroup(row) && row.ev.k === 'assistant' && row.ev.text.trim().length > 0,
    )
  }
  const spoken = cycles.filter(said)
  const last = spoken[spoken.length - 1] ?? []
  return {
    reply: closing(last),
    updates: spoken.slice(0, -1).flatMap(closing),
    fallback: lastResult?.reply?.trim() ?? '',
  }
}

/** Whether the turn ended on something to read, so its work can fold away. */
export function turnHasReply(turn: Turn): boolean {
  const reading = readTurn(turn.rows)
  return reading.reply.length > 0 || reading.fallback.length > 0
}

/** "2 files changed · 5 commands · 1 subagent" — only what actually happened. */
export function turnSummary(turn: Turn): string[] {
  const parts: string[] = []
  const { files, commands, reads, searches, agents, inAgents } = turn.stats
  // A count with some of it inside agents says how much: "403 Commands (392 in
  // agents)" — the main loop's share is the difference, and the scope is clear.
  const count = (total: number, inside: number, one: string, many: string): void => {
    if (!total) return
    const scope = inside ? ` (${inside === total ? 'all' : inside} in agents)` : ''
    parts.push(`${total} ${total > 1 ? many : one}${scope}`)
  }
  count(files.length + inAgents.files, inAgents.files, 'File Changed', 'Files Changed')
  count(commands, inAgents.commands, 'Command', 'Commands')
  if (agents) parts.push(`${agents} Subagent${agents > 1 ? 's' : ''}`)
  count(reads, inAgents.reads, 'Read', 'Reads')
  count(searches, inAgents.searches, 'Search', 'Searches')
  return parts
}

/** Split a message into prose and fenced code blocks. */
export function splitCode(text: string): Array<{ type: 'text' | 'code'; content: string; lang?: string }> {
  const parts: Array<{ type: 'text' | 'code'; content: string; lang?: string }> = []
  const fence = /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)(?:```|$)/
  let rest = text
  for (;;) {
    const match = fence.exec(rest)
    if (!match || match.index === undefined) break
    if (match.index > 0) parts.push({ type: 'text', content: rest.slice(0, match.index) })
    parts.push({ type: 'code', content: match[2] ?? '', lang: match[1] || undefined })
    rest = rest.slice(match.index + match[0].length)
  }
  if (rest) parts.push({ type: 'text', content: rest })
  return parts
}

/* ------------------------------------------------------------------ */
/* Tool calls: what each one's line says                               */
/* ------------------------------------------------------------------ */

export type ToolResultEvent = Extract<TimelineEvent, { k: 'tool_result' }>

/** Everything the timeline learnt about one call after it was made. */
export interface ToolFacts {
  result?: ToolResultEvent
  /** The file it wrote, with its line counts. */
  change?: FileChange
  /** How a command that moved to the background ended. */
  background?: SubagentEnd
}

/**
 * The facts for every call, keyed by tool id.
 *
 * An entry that did not change keeps its object from `previous`: turn views are
 * memoised on identity (see `reuseTurns`), and a fresh object per call on every
 * event would repaint every turn that ever ran a tool.
 */
export function toolFacts(events: SessionEvent[], previous?: Map<string, ToolFacts>): Map<string, ToolFacts> {
  const ordinaryTools = new Set(events.flatMap((event) =>
    event.ev.k === 'tool' && !isAgentCall(event.ev.name) ? [event.ev.toolId] : [],
  ))
  const draft = new Map<string, ToolFacts>()
  const entry = (toolId: string): ToolFacts => {
    let found = draft.get(toolId)
    if (!found) draft.set(toolId, (found = {}))
    return found
  }
  for (const event of events) {
    const ev = event.ev
    if (ev.k === 'tool_result') entry(ev.toolId).result = ev
    else if (ev.k === 'file_change' && ev.toolId) entry(ev.toolId).change = ev
    else if (ev.k === 'subagent_end' && ev.toolId && (ev.background === 'bash' || ordinaryTools.has(ev.toolId))) {
      entry(ev.toolId).background = ev
    }
  }
  if (!previous) return draft
  const next = new Map<string, ToolFacts>()
  for (const [toolId, facts] of draft) {
    const old = previous.get(toolId)
    const same = old && old.result === facts.result && old.change === facts.change && old.background === facts.background
    next.set(toolId, same ? old : facts)
  }
  return next
}

function inputRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
}

function baseName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

/**
 * The name an MCP tool is shown under: `mcp__github__create_issue` is
 * "Github · create_issue", the server first, the way it is organised.
 */
export function toolTitle(name: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  if (!mcp) return name
  const server = mcp[1]!.replace(/[-_]+/g, ' ')
  return `${server.charAt(0).toUpperCase()}${server.slice(1)} · ${mcp[2]}`
}

/**
 * One line that says what the call did, with the facts that make it useful:
 * a command's time and exit status, the lines a read covered, a write's line
 * counts, a search's hits. Each fact only when the harness reported it.
 */
/**
 * The word a call is known by on its card, and what a run of them counts.
 *
 * Claude names its tools (`Bash`, `Read`), and the name is the word. ACP agents
 * title each call ("Run `ls -la`", "Read src/view.ts") and name its *kind*, so
 * a run of five reads would count five different titles; the kind is the word
 * there. Command Code and older ACP data use lower-case tool names, kept as is.
 */
const KIND_LABEL: Record<string, string> = {
  execute: 'Run', read: 'Read', edit: 'Edit', delete: 'Delete', move: 'Move',
  search: 'Search', fetch: 'Fetch', think: 'Think',
}

export function toolLabel(ev: Extract<TimelineEvent, { k: 'tool' }>): string {
  const byKind = ev.kind ? KIND_LABEL[ev.kind.toLowerCase()] : undefined
  return byKind ?? toolTitle(ev.name)
}

/**
 * A summary without the words its card already says: Command Code writes
 * "read_file src/a.ts" under a card titled "read_file", an ACP title repeats
 * its kind ("Read src/a.ts" under "Read"), and an input-less call's summary is
 * just its own name — which was the card reading "bash bash".
 */
function withoutTitle(summary: string, ev: Extract<TimelineEvent, { k: 'tool' }>): string {
  // The word the card is titled with: the kind for an ACP call (its name is
  // the informative title), the tool's own name otherwise.
  const word = (ev.kind ? toolLabel(ev) : ev.name).toLowerCase()
  const text = summary.trim()
  if (text.toLowerCase() === word) return ''
  return text.toLowerCase().startsWith(`${word} `) ? text.slice(word.length + 1).trim() : text
}

/** How many hits a search reported: its own count when it states one, else its lines. */
function searchHits(text: string): number {
  const stated = /^found (\d+) (?:match|file|result)/i.exec(text.trim())
  if (stated) return Number(stated[1])
  if (/^no (?:files|matches|results) found/i.test(text.trim())) return 0
  return text.split('\n').filter((line) => line.trim()).length
}

export function toolLine(ev: Extract<TimelineEvent, { k: 'tool' }>, facts?: ToolFacts): string {
  const summary = withoutTitle(toolSummary(ev), ev)
  const input = inputRecord(ev.input)
  const result = facts?.result
  const kind = toolClass(ev.name, ev.kind)
  if (kind === 'command') {
    const background = facts?.background
    if (background || result?.backgroundTaskId) {
      const status = !background
        ? 'running'
        : background.status === 'done' && (background.exitCode ?? 0) === 0 ? 'done' : 'failed'
      return `${summary} · ⧗ bg → ${status}`
    }
    const bits: string[] = []
    if (typeof result?.durationMs === 'number') bits.push(formatDuration(result.durationMs))
    if (typeof result?.exitCode === 'number') bits.push(`exit ${result.exitCode}`)
    return bits.length ? `${summary} (${bits.join(', ')})` : summary
  }
  if (kind === 'read') {
    const path = typeof input.file_path === 'string' ? input.file_path : typeof input.path === 'string' ? input.path : ''
    const offset = typeof input.offset === 'number' ? input.offset : null
    const limit = typeof input.limit === 'number' ? input.limit : null
    if (!path || offset === null) return summary
    return `${baseName(path)}:${offset}-${limit !== null ? offset + limit - 1 : ''}`
  }
  if (kind === 'edit' && facts?.change) {
    const change = facts.change
    return `${baseName(change.path)} +${change.added} −${change.removed}`
  }
  if (kind === 'search') {
    const pattern = typeof input.pattern === 'string' ? input.pattern : typeof input.query === 'string' ? input.query : ''
    if (!pattern) return summary
    const hits = result && !result.isError && !result.truncated ? searchHits(result.text) : null
    return `'${pattern}'${hits !== null ? ` (${hits} hit${hits === 1 ? '' : 's'})` : ''}`
  }
  return summary
}

/**
 * Result texts that say nothing the row does not: the placeholders harnesses
 * write for a call with no output ("done", "(Bash completed with no output)").
 */
const EMPTY_OUTPUT = /^(|done|ok|failed|completed|\(empty\)|\(.*\bno output\))$/i

/** Input fields that are plumbing: opening a call to show only these shows nothing. */
const QUIET_INPUT = new Set(['cwd', 'directory', 'description', 'timeout', 'timeout_ms', 'run_in_background', 'dangerouslyDisableSandbox'])

/**
 * Whether opening a call shows anything its row does not already say.
 *
 * Open, a call shows its input and its output. A `Run ls` that printed nothing
 * would open onto `{"command":"ls"}` — the row again — so it has nothing to
 * open. It does when there is real output, or an input field the row does not
 * show whole (a multi-line command, a file's content, a command's arguments).
 * A row whose line is cut by the column's width is decided by the view, which
 * can measure it.
 */
export function toolHasMore(ev: Extract<TimelineEvent, { k: 'tool' }>, facts?: ToolFacts): boolean {
  const result = facts?.result
  if (result && (result.truncated || !EMPTY_OUTPUT.test(result.text.trim()))) return true
  const shown = toolLine(ev, facts)
  const covered = (value: unknown): boolean => {
    if (value === null || value === undefined || value === '' || value === false) return true
    if (typeof value !== 'string') return false
    const text = value.trim()
    return !text.includes('\n') && shown.includes(text)
  }
  if (ev.input === null || ev.input === undefined) return false
  if (typeof ev.input !== 'object' || Array.isArray(ev.input)) return !covered(ev.input)
  return Object.entries(ev.input as Record<string, unknown>).some(([key, value]) => !QUIET_INPUT.has(key) && !covered(value))
}

/** Input fields that name the one file a call reads or writes, across harnesses. */
const PATH_INPUT = ['file_path', 'filePath', 'notebook_path', 'absolute_path', 'path', 'target_file']

/**
 * The file a call is about, when it is about one: what a click on its row opens.
 * The protocol's own locations first (ACP), then the input field every harness
 * spells its own way. Only reads and writes — a search's `path` is a folder, and
 * a deleted file is not there to open.
 */
export function toolFilePath(ev: Extract<TimelineEvent, { k: 'tool' }>): string | null {
  const kind = toolClass(ev.name, ev.kind)
  if ((kind !== 'read' && kind !== 'edit') || ev.kind?.toLowerCase() === 'delete') return null
  if (ev.paths?.length === 1) return ev.paths[0]!
  const input = inputRecord(ev.input)
  for (const key of PATH_INPUT) {
    const value = input[key]
    if (typeof value === 'string' && value.trim() && !value.includes('\n')) return value.trim()
  }
  return null
}

/* ------------------------------------------------------------------ */
/* Plans                                                               */
/* ------------------------------------------------------------------ */

export interface PlanItem {
  text: string
  status: 'done' | 'active' | 'pending'
}

/**
 * A checklist, from either spelling of one: Claude's `TodoWrite` call (its
 * `todos` input) or an ACP `plan` update (one "✓ / ▸ / ·" line per entry).
 * Null when the event is neither, or carries no entries.
 */
export function planItems(ev: TimelineEvent): PlanItem[] | null {
  if (ev.k === 'tool' && /^todowrite$/i.test(ev.name)) {
    const todos = inputRecord(ev.input).todos
    if (!Array.isArray(todos)) return null
    const items = todos.flatMap((todo): PlanItem[] => {
      const record = inputRecord(todo)
      const text = String(record.content ?? record.activeForm ?? '').trim()
      if (!text) return []
      const status = record.status === 'completed' ? 'done' : record.status === 'in_progress' ? 'active' : 'pending'
      return [{ text, status }]
    })
    return items.length ? items : null
  }
  if (ev.k === 'system' && ev.subtype === 'plan') {
    const items = ev.text.split('\n').flatMap((line): PlanItem[] => {
      const match = /^\s*([✓▸·])\s*(.*)$/.exec(line)
      if (!match || !match[2]!.trim()) return []
      return [{ text: match[2]!.trim(), status: match[1] === '✓' ? 'done' : match[1] === '▸' ? 'active' : 'pending' }]
    })
    return items.length ? items : null
  }
  return null
}

/** The plan an `ExitPlanMode` call proposes, as the Markdown it was written in. */
export function proposedPlan(ev: Extract<TimelineEvent, { k: 'tool' }>): string | null {
  if (!/^exitplanmode$/i.test(ev.name)) return null
  const plan = inputRecord(ev.input).plan
  return typeof plan === 'string' && plan.trim() ? plan : null
}

/**
 * At most one "reasoning hidden" marker per list, and none beside reasoning
 * that is shown. Claude writes a withheld-thinking marker on nearly every
 * message; one chip per message was a column of identical chips saying the
 * same thing.
 */
export function oneHiddenReasoning<T extends Row>(rows: T[]): T[] {
  const hidden = (row: Row): boolean =>
    !isGroup(row) && row.ev.k === 'thinking' && (Boolean(row.ev.hidden) || !row.ev.text.trim())
  const shown = rows.some((row) => !isGroup(row) && row.ev.k === 'thinking' && !hidden(row))
  let kept = shown
  return rows.filter((row) => {
    if (!hidden(row)) return true
    if (kept) return false
    kept = true
    return true
  })
}

/**
 * The files a turn touched, agents included, as the header's three counts:
 * changed, added, deleted — each a list of distinct paths for its tooltip.
 */
export function turnFiles(turn: Turn): { edited: string[]; added: string[]; deleted: string[] } {
  const created = new Set<string>()
  const edited = new Set<string>()
  for (const file of [...turn.stats.files, ...turn.stats.agentFiles]) {
    if (file.change === 'create') created.add(file.path)
    else edited.add(file.path)
  }
  // A file the turn created and then edited is one new file.
  for (const path of created) edited.delete(path)
  return { edited: [...edited], added: [...created], deleted: [...new Set(turn.stats.deleted)] }
}

/** "25.3k", "1.2M" — a count at a glance. */
export function compactCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}

/**
 * Who cancelled a prompt before delivery, when the server says: the user, or
 * the server itself (a failed turn ahead of it). Absent on older events.
 */
export function cancelledBy(ev: UserEvent): 'user' | 'server' | undefined {
  return ev.cancelledBy
}

/** Why the server cancelled a prompt, when it said. */
export function cancelReason(ev: UserEvent): string | undefined {
  return ev.cancelReason?.trim() || undefined
}

/* ------------------------------------------------------------------ */
/* The server's turn ledger                                            */
/* ------------------------------------------------------------------ */

/**
 * What a turn is, as the server's turn ledger says — for every harness, decided
 * once, where the events are. The transcript used to infer it from the events
 * (a result, agents without an end), and each inference was a guess the next
 * harness broke. When a ledger record is there it is the answer; the reading
 * of the events is kept only for servers older than the ledger.
 *
 * A turn the user moved on from mid-flight (`continued`: a new prompt opened
 * its own turn) is simply finished — it was not stopped and did not fail.
 */
export function ledgerState(record: TurnRecord | undefined): TurnState | null {
  switch (record?.phase) {
    case 'running':
    case 'waiting_agents':
      return 'working'
    case 'completed':
      return 'done'
    case 'stopped':
      return record.subtype === 'continued' ? 'done' : 'interrupted'
    case 'failed':
      return record.subtype === 'continued' ? 'done' : 'failed'
    default:
      return null
  }
}

/**
 * The turn's state: the ledger's when there is one, the events' reading
 * otherwise. `null` means the server keeps a ledger but has no record of this
 * turn (events that never got a turn id): nothing vouches that it is live, so
 * it is read as settled rather than left spinning.
 */
export function stateOf(turn: Turn, record: TurnRecord | null | undefined, sessionLive: boolean): TurnState {
  if (record === null) return turnState(turn, false)
  return ledgerState(record) ?? turnState(turn, sessionLive)
}

/** A turn's ledger record: `null` when the session has a ledger without it. */
export function recordOf(records: Record<string, TurnRecord> | undefined, turn: Turn): TurnRecord | null | undefined {
  if (!records) return undefined
  return (turn.turnId ? records[turn.turnId] : undefined) ?? (turn.continuationTurnId ? records[turn.continuationTurnId] : undefined) ?? null
}

/** Agents the stop cut off: the ledger's count, or the events' reading. */
export function cutOffOf(turn: Turn, record: TurnRecord | null | undefined): number {
  return record?.phase ? (record.cutOffAgents ?? 0) : cutOffAgents(turn)
}

/**
 * The reply, as the ledger names it (`replyEventId`) when it does. The closing
 * prose of the last cycle is kept together when the named event is part of it;
 * otherwise the named event is the reply and what the events' reading picked
 * moves to the updates. With no ledger reply the events' reading stands.
 */
export function readTurnWith(rows: Row[], record: TurnRecord | null | undefined): TurnReading {
  const reading = readTurn(rows)
  const replyId = record?.replyEventId
  if (!replyId || reading.reply.some((row) => row.id === replyId)) return reading
  const named = rows.find((row): row is SessionEvent => !isGroup(row) && row.id === replyId && row.ev.k === 'assistant')
  if (!named) return reading
  return {
    reply: [named],
    updates: [...reading.updates, ...reading.reply].filter((row) => row !== named).sort((a, b) => a.seq - b.seq),
    fallback: reading.fallback,
  }
}

/** Child agents still working across a session's turns, from the ledger; null without one. */
export function activeAgentsOf(records: Record<string, TurnRecord> | undefined): number | null {
  const list = Object.values(records ?? {})
  if (!list.some((record) => record.phase)) return null
  return list.reduce(
    (sum, record) => sum + (record.phase === 'running' || record.phase === 'waiting_agents' ? (record.activeAgents ?? 0) : 0),
    0,
  )
}

/** The session's live turn, from the ledger: running, or waiting on agents. */
export function livePhaseOf(records: Record<string, TurnRecord> | undefined): 'running' | 'waiting_agents' | null {
  let phase: 'running' | 'waiting_agents' | null = null
  for (const record of Object.values(records ?? {})) {
    if (record.phase === 'running') return 'running'
    if (record.phase === 'waiting_agents') phase = 'waiting_agents'
  }
  return phase
}

/* ------------------------------------------------------------------ */
/* Runs of tool calls                                                  */
/* ------------------------------------------------------------------ */

/** Consecutive tool calls, shown as one row that opens to the list. */
export interface ToolRun {
  kind: 'tools'
  /** The first call's event id: stable while the run only grows. */
  key: string
  events: SessionEvent[]
}

export function isToolRun(item: unknown): item is ToolRun {
  return typeof item === 'object' && item !== null && (item as ToolRun).kind === 'tools'
}

/** A call that is just a call — not a question, a plan or a proposed plan. */
function plainCall(row: Row): boolean {
  if (isGroup(row) || row.ev.k !== 'tool') return false
  return row.ev.name !== 'AskUserQuestion' && planItems(row.ev) === null && proposedPlan(row.ev) === null
}

/**
 * Fold runs of two or more consecutive tool calls into one `ToolRun`.
 *
 * Eight Bash calls in a row were eight cards of the same shape, and the note
 * or agent card that actually said something was lost among them. A run
 * breaks at anything that is not a call — a note, reasoning, a subagent card,
 * a question, an error, a harness line. A call's result is not drawn in the
 * list (it lives on the call's card), so it never breaks one.
 */
export function groupToolRuns<T extends Row>(rows: T[]): Array<T | ToolRun> {
  const out: Array<T | ToolRun> = []
  let run: SessionEvent[] = []
  const flush = () => {
    if (run.length >= 2) out.push({ kind: 'tools', key: run[0]!.id, events: run })
    else out.push(...(run as unknown as T[]))
    run = []
  }
  for (const row of rows) {
    if (plainCall(row)) {
      run.push(row as SessionEvent)
      continue
    }
    if (!isGroup(row) && row.ev.k === 'tool_result') {
      // Invisible in the list; keeps its place so nothing else moves.
      if (!run.length) out.push(row)
      continue
    }
    flush()
    out.push(row)
  }
  flush()
  return out
}

/**
 * The one line a run reads as when folded: "Bash ×8 · 42s", or for a mix
 * "6 tools · Bash ×4, Read ×2". The time is the calls' own when the harness
 * timed them, otherwise the span from the first call to the last answer.
 */
export function toolRunLine(run: ToolRun, facts: Map<string, ToolFacts>): string {
  const { label, time } = toolRunParts(run, facts)
  return time ? `${label} · ${time}` : label
}

/**
 * The same line in its two halves, for a row that sets them apart: what ran
 * ("Bash ×8", "6 tools · Bash ×4, Read ×2") and how long it took ("42s", or ""
 * under a second).
 */
export function toolRunParts(run: ToolRun, facts: Map<string, ToolFacts>): { label: string; time: string } {
  const counts = new Map<string, number>()
  for (const event of run.events) {
    if (event.ev.k !== 'tool') continue
    const name = toolLabel(event.ev)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const parts = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name} ×${count}`)
  let timed = 0
  let untimed = false
  for (const event of run.events) {
    if (event.ev.k !== 'tool') continue
    const result = facts.get(event.ev.toolId)?.result
    if (typeof result?.durationMs === 'number') timed += result.durationMs
    else untimed = true
  }
  const first = run.events[0]!.at
  const last = run.events[run.events.length - 1]!.at
  const span = untimed ? Math.max(0, last - first) : timed
  return {
    label: counts.size === 1 ? parts[0]! : `${run.events.length} tools · ${parts.join(', ')}`,
    time: span >= 1000 ? formatSpan(span) : '',
  }
}

/**
 * The one class every call of a run shares, or null for a mix — which is what
 * picks the run's icon: a terminal for eight commands, a stack for a mix.
 */
export function toolRunClass(run: ToolRun): ToolClass | null {
  let shared: ToolClass | null | undefined
  for (const event of run.events) {
    if (event.ev.k !== 'tool') continue
    const kind = toolClass(event.ev.name, event.ev.kind)
    if (shared === undefined) shared = kind
    else if (shared !== kind) return null
  }
  return shared ?? null
}

/**
 * The first line of some prose, without its Markdown marks: what a folded row
 * previews ("Reasoning · The user wants…", a subagent's result).
 */
export function firstLine(text: string): string {
  const line = text.trim().split('\n').find((item) => item.trim()) ?? ''
  return line.replace(/^\s*(?:[#>]+|[-*+]\s|\d+\.\s|\|)\s*/, '').replace(/[*_`#>|]/g, '').replace(/\s+/g, ' ').trim()
}

/**
 * Consecutive identical harness lines, said once.
 *
 * A reattach, a retry or a warning can arrive twice in a row with the very
 * same words (a resumed process announcing itself to both of its readers), and
 * two identical rows read as two events. The first one stays, in its place; the
 * returned map says how many it stands for, so the row can say "×2". Only
 * `system` lines fold — a repeated tool call or note is real work done twice.
 */
export function foldRepeats<T extends Row>(rows: T[]): { rows: T[]; repeats: Map<string, number> } {
  const out: T[] = []
  const repeats = new Map<string, number>()
  let last: SessionEvent | null = null
  for (const row of rows) {
    const same = last && !isGroup(row) && row.ev.k === 'system' && last.ev.k === 'system'
      && row.ev.subtype === last.ev.subtype && row.ev.text === last.ev.text && planItems(row.ev) === null
    if (same && last) {
      repeats.set(last.id, (repeats.get(last.id) ?? 1) + 1)
      continue
    }
    out.push(row)
    last = !isGroup(row) && row.ev.k === 'system' ? row : null
  }
  return { rows: out, repeats }
}

/** "42s", "12m", "2h 5m": how long, without the seconds once it is minutes. */
export function coarseSpan(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/**
 * What in-chat search looks through: every piece of text the transcript can
 * show, folded away or not, with the element that shows it.
 *
 * Searching the page itself only ever found what happened to be mounted, and a
 * finished turn unmounts its work (see `useFoldContents`): a word in a folded
 * reasoning block or a collapsed tool call could not be found at all. So search
 * reads the turns, and each target names the element that draws it
 * (`data-search-id`) and the subagent cards around it, outermost first — which
 * is exactly what has to open for it to be on screen.
 */
export interface SearchTarget {
  turnIndex: number
  key: string
  agents: string[]
  text: string
}

export const promptSearchKey = (turn: Turn): string => `prompt:${turn.id}`
export const toolSearchKey = (toolId: string): string => `tool:${toolId}`
export const agentSearchKey = (group: SubagentGroup): string => `agent:${group.toolId || group.agentId}`
export const fileSearchKey = (file: FileChange): string => `file:${file.toolId}:${file.path}`

/** The text an event puts on screen, folded or not; empty for what draws no text. */
function eventSearchText(event: SessionEvent, results: Map<string, ToolFacts>, showThinking: boolean): string {
  const ev = event.ev
  switch (ev.k) {
    case 'assistant':
    case 'error':
      return ev.text
    case 'thinking':
      return showThinking && !ev.hidden ? ev.text : ''
    case 'tool': {
      const plan = planItems(ev)
      if (plan) return plan.map((item) => item.text).join('\n')
      const proposed = proposedPlan(ev)
      if (proposed) return proposed
      const facts = results.get(ev.toolId)
      const input = ev.input && typeof ev.input === 'object' ? JSON.stringify(ev.input, null, 1) : String(ev.input ?? '')
      return [toolLabel(ev), toolLine(ev, facts), input, facts?.result?.text ?? ''].join('\n')
    }
    case 'file_change':
      return ev.path
    case 'system': {
      const plan = planItems(ev)
      return plan ? plan.map((item) => item.text).join('\n') : noticeLine(ev)
    }
    case 'request':
      return [ev.title, ev.detail ?? '', ...ev.options.map((option) => option.label)].join('\n')
    default:
      return ''
  }
}

export function searchTargets(turns: Turn[], results: Map<string, ToolFacts>, showThinking: boolean): SearchTarget[] {
  const out: SearchTarget[] = []
  const push = (turnIndex: number, key: string, agents: string[], text: string) => {
    if (text.trim()) out.push({ turnIndex, key, agents, text })
  }
  const walk = (rows: Row[], turnIndex: number, agents: string[]) => {
    // Only the latest version of a plan is drawn (see `TurnView`).
    const plans = rows.filter((row) => !isGroup(row) && row.ev.k === 'tool' && planItems(row.ev) !== null)
    for (const row of foldRepeats(rows).rows) {
      if (isGroup(row)) {
        const key = agentSearchKey(row)
        const inside = [...agents, key]
        const answered = row.events.some((event) => event.ev.k === 'assistant' && event.ev.text.trim())
        push(turnIndex, key, inside, [row.start.description, row.start.prompt, answered ? '' : (row.end?.result ?? '')].join('\n'))
        walk(row.events.filter((event) => event.ev.k !== 'subagent_start' && event.ev.k !== 'subagent_end'), turnIndex, inside)
        walk(row.children, turnIndex, inside)
        continue
      }
      if (plans.length > 1 && plans.includes(row) && row !== plans[plans.length - 1]) continue
      const key = row.ev.k === 'tool' ? toolSearchKey(row.ev.toolId) : row.ev.k === 'file_change' ? fileSearchKey(row.ev) : row.id
      push(turnIndex, key, agents, eventSearchText(row, results, showThinking))
    }
  }
  turns.forEach((turn, turnIndex) => {
    if (turn.user) push(turnIndex, promptSearchKey(turn), [], turn.user.text)
    walk(turn.rows, turnIndex, [])
  })
  return out
}
