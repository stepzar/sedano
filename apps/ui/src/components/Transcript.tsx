import { createContext, memo, useContext, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { TurnRecord, SessionEvent, SessionSummary, TimelineEvent } from '@shared'
import { isDocument, splitDocuments, usageValue } from '@shared'
import {
  ACTIVITY_WORD,
  activityOf,
  anyAgentRunning,
  groupRunning,
  buildRows,
  buildTurns,
  isAction,
  compactCount,
  cancelReason,
  groupToolRuns,
  isGroup,
  isToolRun,
  toolRunParts,
  toolRunClass,
  toolClass,
  firstLine,
  foldRepeats,
  type ToolClass,
  type ToolRun,
  noticeLine,
  cutOffOf,
  recordOf,
  readTurnWith,
  stateOf,
  turnFiles,
  type TokenTotals,
  oneHiddenReasoning,
  planItems,
  proposedPlan,
  readTurn,
  reuseTurns,
  toolFacts,
  toolLine,
  toolLabel,
  toolTitle,
  cutOffAgents,
  formatSpan,
  formatDuration,
  agentSpanMs,
  turnSpanMs,
  turnStartedAt,
  toolFilePath,
  toolHasMore,
  coarseSpan,
  turnWallMs,
  turnHasReply,
  splitCode,
  splitWork,
  searchTargets,
  promptSearchKey,
  toolSearchKey,
  agentSearchKey,
  fileSearchKey,
  toolSummary,
  turnState,
  turnSummary,
  type TurnState,
  type Activity,
  type FileChange,
  type Row,
  type PlanItem,
  type SubagentGroup,
  type ToolFacts,
  type Turn,
  type UserEvent,
} from '../view.ts'
import type { LiveBuffer, UiSettings } from '../store.ts'
import { answerQuestion, answerStateFor, attachmentUrl, cancelQueuedPrompt, editCancelledPrompt, openSessionFile, requestStateFor, useStore } from '../store.ts'
import { touchedFiles } from '../fileLinks.ts'
import { isLocalPage } from '../remoteClient.ts'
import { Markdown } from '../markdown.tsx'
import { imageTokenSpans } from '../attachments.ts'
import { useWindowFocused } from '../windowFocus.ts'
import {
  IconAgent, IconCaret, IconCheck, IconChevronUp, IconClose, IconCopy, IconFile, IconFileAdd, IconFileEdit, IconFileRemove, IconGlobe,
  IconInfo, IconPlan, IconSearch, IconStack, IconTerminal, IconThought, IconTool,
} from './Icons.tsx'
import { Lightbox } from './Overlays.tsx'
import { SentDocuments } from './Documents.tsx'
import { Boundary } from './Boundary.tsx'
import { FileLink, FileLinksContext, type FileLinks } from './FileLink.tsx'
import { PromptMinimap, type MinimapPrompt } from './PromptMinimap.tsx'
import { ThinkingOrb, type OrbState } from 'thinking-orbs'
import '../work.css'

type ToolEvent = Extract<TimelineEvent, { k: 'tool' }>
type ToolResult = Extract<TimelineEvent, { k: 'tool_result' }>
type ResultEvent = Extract<TimelineEvent, { k: 'result' }>

/* ------------------------------------------------------------------ */
/* Small pieces                                                        */
/* ------------------------------------------------------------------ */

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * Seconds since `since`, while `active`.
 *
 * A number that visibly ticks is the cheapest proof a turn is alive: "Working…"
 * on its own looks identical whether the harness is thinking or has hung, which
 * is the state the user could not read. It stops the moment the turn settles, so
 * a finished turn never keeps counting.
 */
function useElapsed(active: boolean, since: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active, since])
  return active ? Math.max(0, Math.round((now - since) / 1000)) : 0
}

/**
 * The ticking seconds of a live turn, as its own component on purpose: the
 * state that changes every second lives here, so the tick re-renders one span
 * instead of the whole turn. With the clock in TurnView, every tool row,
 * subagent card and markdown block of a long working turn was rebuilt once a
 * second while nothing else changed.
 */
function ElapsedClock({ since }: { since: number }) {
  const elapsed = useElapsed(true, since)
  return <span className="turn-elapsed mono">{formatElapsed(elapsed)}</span>
}

/**
 * "Working for 12m": the header's words while a turn runs. Coarse on purpose —
 * the ticking seconds are the live indicator's, at the bottom of the turn; the
 * header only has to say how long, in the words it will keep once it settles.
 */
function WorkingFor({ since }: { since: number }) {
  const elapsed = useElapsed(true, since)
  return <>{coarseSpan(elapsed * 1000)}</>
}

/**
 * Whether a collapsible's contents should still be in the tree.
 *
 * The fold animates by going from `0fr` to `1fr`, which needs the content to
 * exist — but a thread of two hundred collapsed turns keeping every tool call
 * and diff mounted is exactly the kind of weight this app exists not to carry.
 * So the content mounts on open and is dropped once the closing animation is
 * over: the movement is real, and a folded turn costs nothing.
 */
function useFoldContents(open: boolean, ms = 240): boolean {
  const [mounted, setMounted] = useState(open)
  useEffect(() => {
    if (open) {
      setMounted(true)
      return
    }
    const timer = setTimeout(() => setMounted(false), ms)
    return () => clearTimeout(timer)
  }, [open, ms])
  return open || mounted
}

/**
 * The one disclosure control in the transcript.
 *
 * It used to be a 0.9em text triangle inside a 1em box: roughly eleven pixels of
 * glyph, and an eleven-pixel target, for the primary way to open a card. One
 * real icon now, in a box big enough to hit, rotating rather than swapping
 * characters — so a caret always reads as a control rather than as punctuation.
 * `open` is on the element as a class, which is also how a test (or the next
 * person) reads the state without parsing a glyph.
 */
function Chevron({ open }: { open: boolean }) {
  return (
    <span className={`chevron${open ? ' open' : ''}`} aria-hidden="true">
      <IconCaret size={16} />
    </span>
  )
}

/**
 * Holds a row where it is on screen while the section under it opens or closes.
 *
 * A header pinned to the top of a long section is exactly where you are when
 * you collapse it; without this the section's height left the thread and the
 * row — and what follows it — jumped to wherever the section had begun. The
 * transcript owns the scroll, so it provides the function (see `holdRow`).
 */
const HoldContext = createContext<(row: HTMLElement) => void>(() => {})

/**
 * The search match on screen, for the one turn that holds it: the key of the
 * element that draws it (`data-search-id`), the subagent cards around it, and
 * the words searched for.
 */
interface Reveal {
  key: string
  agents: string[]
  needle: string
}
const RevealContext = createContext<Reveal | null>(null)

/**
 * A disclosure search can hold open without touching the reader's own choice.
 *
 * The reveal is laid over the state rather than written into it, so when the
 * match moves on the row goes back to exactly what it was — open if the reader
 * had opened it, closed otherwise. A click while search holds it open is the
 * reader taking over: the hold lets go and the click is kept as their choice.
 */
function useRevealed(reveal: boolean): [boolean, () => void] {
  const [released, setReleased] = useState(false)
  useEffect(() => {
    if (!reveal) setReleased(false)
  }, [reveal])
  return [reveal && !released, () => { if (reveal) setReleased(true) }]
}

function useDisclosure(reveal: boolean, initial = false): [boolean, () => void] {
  const [open, setOpen] = useState(initial)
  const [held, release] = useRevealed(reveal)
  const shown = held || open
  return [shown, () => {
    release()
    setOpen(!shown)
  }]
}

/** Whether search is showing a match inside the element drawn for `key`. */
function useRevealKey(key: string | undefined): boolean {
  const reveal = useContext(RevealContext)
  return Boolean(reveal && key && reveal.key === key)
}

/**
 * The one row of the work area: [caret][icon] Label · detail — preview ··· meta.
 *
 * Every kind of work — a tool, a run of them, a subagent, reasoning, a plan,
 * the harness' bookkeeping — is this row, told apart by its icon and the weight
 * of its label rather than by a box around it. A row with nothing to open keeps
 * the caret's slot, so the icons of a column always line up.
 */
function WorkRow({
  icon, label, detail, preview, meta, status, statusText, open = false, onToggle,
  className = '', labelClass = '', detailClass = '', previewClass = '', mono = false, title,
  toggleOnlyWhenCut = false, detailFile,
}: {
  icon?: React.ReactNode
  label: React.ReactNode
  detail?: string
  /** Faint, after the detail, and the first thing to give way when space runs out. */
  preview?: string
  meta?: React.ReactNode
  status?: 'running' | 'failed'
  statusText?: string
  open?: boolean
  onToggle?: () => void
  className?: string
  labelClass?: string
  detailClass?: string
  previewClass?: string
  mono?: boolean
  title?: string
  /**
   * The row only opens when its detail is cut by the column's width: opening
   * would otherwise show nothing the row does not (see `toolHasMore`).
   */
  toggleOnlyWhenCut?: boolean
  /** The file the detail names: a click on the detail opens it. */
  detailFile?: string | null
}) {
  const hold = useContext(HoldContext)
  const [detailNode, setDetailNode] = useState<HTMLSpanElement | null>(null)
  const [cut, setCut] = useState(false)
  useLayoutEffect(() => {
    if (!toggleOnlyWhenCut || !detailNode) return
    const measure = () => setCut(detailNode.scrollWidth > detailNode.clientWidth + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(detailNode)
    return () => observer.disconnect()
  }, [toggleOnlyWhenCut, detailNode, detail])
  // An open row stays a toggle, so it can always be closed again.
  if (toggleOnlyWhenCut && !cut && !open) onToggle = undefined
  const detailText = detail && detailFile ? <FileLink path={detailFile}>{detail}</FileLink> : detail
  const content = <>
    {onToggle ? <Chevron open={open} /> : <span className="wr-slot" aria-hidden="true" />}
    {icon ? <span className="wr-icon" aria-hidden="true">{icon}</span> : null}
    <span className={`wr-label ${labelClass}`}>{label}</span>
    {detail ? <span ref={setDetailNode} className={`wr-detail${mono ? ' mono' : ''} ${detailClass}`} title={detail}>{detailText}</span> : null}
    {preview ? <span className={`wr-preview ${previewClass}`} title={preview}>{preview}</span> : <span className="wr-fill" />}
    {status === 'running'
      ? <span className="wr-status live"><span className="subagent-running-icon" aria-hidden="true" />{statusText ?? 'Working'}</span>
      : status === 'failed' ? <span className="wr-status failed">{statusText ?? 'Failed'}</span> : null}
    {meta ? <span className="wr-meta">{meta}</span> : null}
  </>
  return onToggle
    ? (
      <button type="button" className={`wr ${className}`} aria-expanded={open} title={title}
        onClick={(event) => { hold(event.currentTarget); onToggle() }}>
        {content}
      </button>
    )
    : <div className={`wr static ${className}`} title={title}>{content}</div>
}

const CLASS_ICON: Record<ToolClass, (props: { size?: number }) => React.ReactElement> = {
  command: IconTerminal,
  read: IconFile,
  search: IconSearch,
  edit: IconFileEdit,
}

/** The glyph a call is recognised by: a terminal, a file, a lens, a pencil. */
function toolIcon(kind: ToolClass | null, name = '', protocolKind?: string): React.ReactElement {
  if (kind) {
    const Icon = CLASS_ICON[kind]
    return <Icon size={15} />
  }
  if (/fetch|web/i.test(protocolKind ?? name)) return <IconGlobe size={15} />
  if (/^(agent|task)$/i.test(name)) return <IconAgent size={15} />
  return <IconTool size={15} />
}

/**
 * Long text in the work area, the way a long prompt is: a few lines with a fade,
 * and "Show more" / "Show less" underneath — never a small box with a scrollbar
 * of its own. The control only appears when the text really is cut.
 */
function ClampedText({ text, lines, className, searchKey }: { text: string; lines: number; className: string; searchKey?: string }) {
  const reveal = useContext(RevealContext)
  // Opened by search only when the match is in this very text, not in its sibling.
  const [open, toggle] = useDisclosure(Boolean(
    reveal && searchKey && reveal.key === searchKey && text.toLocaleLowerCase().includes(reveal.needle),
  ))
  const [cut, setCut] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const node = box.current
    if (!node || open) return
    const measure = () => setCut(node.scrollHeight > node.clientHeight + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [text, open])
  return (
    <div className={`clamp-wrap${cut && !open ? ' is-cut' : ''}`}>
      <div ref={box} className={`${className} clamp${open ? '' : ' clamped'}`} style={{ '--clamp-lines': lines } as React.CSSProperties}>
        {text}
      </div>
      {cut || open ? (
        <button type="button" className="msg-expand clamp-toggle" aria-expanded={open} onClick={toggle}>
          <Chevron open={open} />{open ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </div>
  )
}

/** The seconds a subagent has been out, ticking on its own row only. */
function AgentClock({ since }: { since: number }) {
  const elapsed = useElapsed(true, since)
  return <span className="mono">{formatElapsed(elapsed)}</span>
}

function relativePath(path: string, cwd: string): string {
  // A trailing slash is not a directory level: kept, it would empty the name.
  const clean = path.replace(/\/+$/, '')
  if (cwd && clean.startsWith(`${cwd}/`)) return clean.slice(cwd.length + 1)
  const parts = clean.split('/')
  // Shortened from the left: the file name is the part worth keeping whole.
  return parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : clean
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className={`copy-btn${done ? ' done' : ''}`}
      title={done ? 'Copied' : label}
      aria-label={done ? 'Copied' : label}
      onClick={() => {
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setDone(true)
            setTimeout(() => setDone(false), 1200)
          })
          .catch(() => setDone(false))
      }}
    >
      {done ? <IconCheck size={16} /> : <IconCopy size={16} />}
    </button>
  )
}

/**
 * A prompt's text with each `[image:N]` token drawn as the same "Image N" chip
 * the composer showed; a chip whose picture is there opens it.
 */
function PromptText({ text, images, onOpen }: { text: string; images: number; onOpen: (index: number) => void }) {
  const spans = imageTokenSpans(text)
  if (!spans.length) return <>{text}</>
  const parts: React.ReactNode[] = []
  let cursor = 0
  for (const span of spans) {
    if (span.start > cursor) parts.push(text.slice(cursor, span.start))
    const label = `Image ${span.n}`
    parts.push(
      span.n <= images ? (
        <button key={span.start} type="button" className="image-chip" title={`Open ${label}`} onClick={() => onOpen(span.n - 1)}>
          {label}
        </button>
      ) : (
        <span key={span.start} className="image-chip">{label}</span>
      ),
    )
    cursor = span.end
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return <>{parts}</>
}

/**
 * What the user said, with whatever they pasted into it. The `[image:N]` tokens
 * stay in the text — they are how the message points at each thumbnail — and
 * are drawn as chips (see `PromptText`).
 */
function UserMessage({ ev, at, sessionId, eventId, searchKey }: { ev: UserEvent; at: number; sessionId: string; eventId?: string; searchKey?: string }) {
  const [zoom, setZoom] = useState<number | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [expanded, toggleExpanded] = useDisclosure(useRevealKey(searchKey))
  const cardRef = useRef<HTMLDivElement>(null)
  // Documents are tiles, not text: stored ones are attachments, and a history
  // read back from the harness carries them inline, split off here.
  const { text, documents: inlineDocuments } = useMemo(() => splitDocuments(ev.text), [ev.text])
  const long = text.length > 420 || text.split('\n').length > 6
  const veryLong = text.length > 1000 || text.split('\n').length > 12
  const images = (ev.attachments ?? []).filter((ref) => !isDocument(ref))
  const documents = (ev.attachments ?? []).filter(isDocument)
  const deliveryLabel =
    ev.delivery === 'queued'
      ? 'Queued — waiting for the current turn'
      : ev.delivery === 'cancelled'
        ? `Not sent · ${cancelReason(ev) ?? 'cancelled by the server'}`
        : ev.delivery === 'failed'
          ? 'Not delivered'
          : null
  return (
    <div className="msg-user" data-delivery={ev.delivery} data-search-id={searchKey}>
      {/* The pictures come first, above the words that point at them. */}
      {images.length || documents.length || inlineDocuments.length ? (
        <div className="attach-strip sent">
          {images.map((attachment, index) => (
            <div className="attach" key={attachment.id}>
              <img
                src={attachmentUrl(attachment)}
                alt={attachment.name}
                title={attachment.name}
                onClick={() => setZoom(index)}
              />
              <span className="attach-tag mono">{index + 1}</span>
            </div>
          ))}
          <SentDocuments refs={documents} inline={inlineDocuments} />
        </div>
      ) : null}
      {/* A message that is only a document has no words to put in a bubble. */}
      {text || !(documents.length || inlineDocuments.length) ? (
      <div className="msg-user-line">
        {/* A very long prompt, opened, is taller than the window: this rides down
            beside it (sticky, in the empty space to its left) and takes you back
            up to where it starts. */}
        {veryLong && expanded ? (
          <div className="msg-jump-slot">
            <button
              type="button"
              className="msg-jump"
              title="Back to the start of this prompt"
              aria-label="Back to the start of this prompt"
              onClick={() => {
                const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
                cardRef.current?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' })
              }}
            >
              <IconChevronUp size={16} />
            </button>
          </div>
        ) : null}
        <div className="msg-user-card" ref={cardRef}>
          <div className={`msg-body${long && !expanded ? ' collapsed' : ''}`}>
            <PromptText text={text} images={images.length} onOpen={setZoom} />
          </div>
          {long ? (
            <button type="button" className="msg-expand" aria-expanded={expanded} onClick={toggleExpanded}>
              <Chevron open={expanded} />{expanded ? 'Show less' : 'Show more'}
            </button>
          ) : null}
        </div>
      </div>
      ) : null}
      {deliveryLabel ? (
        <div className="prompt-delivery" role="status">
          <span className="dot" />
          <span>{deliveryLabel}</span>
          {ev.delivery === 'queued' && ev.promptId ? (
            <button
              className="prompt-cancel"
              type="button"
              disabled={cancelling}
              onClick={() => {
                setCancelling(true)
                cancelQueuedPrompt(sessionId, ev.promptId!)
              }}
            >
              {cancelling ? 'Cancelling…' : 'Cancel'}
            </button>
          ) : null}
          {ev.delivery === 'cancelled' && eventId ? (
            // Nobody chose to lose this one: one click puts it back where it was
            // written, to send again or change first.
            <button className="prompt-cancel" type="button" onClick={() => editCancelledPrompt(sessionId, eventId)}>
              Edit
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="msg-actions">
        <span className="mono">{clock(at)}</span>
        <CopyButton text={ev.text} />
      </div>
      {zoom === null ? null : <Lightbox images={images} index={zoom} onClose={() => setZoom(null)} />}
    </div>
  )
}

/**
 * The live-turn indicator: the orb from `thinking-orbs` (theme auto-resolves
 * from the app's `data-theme`, so it is tuned for both) beside the verb for what
 * the turn is actually doing.
 *
 * The verb is a reading of the turn's own events (see `activityOf`), not a
 * rotation: a word that changes every couple of seconds while nothing changes —
 * "Reading…" while the model is thinking — is worse than no word at all.
 */
const ACTIVITY_ORB: Record<Activity, OrbState> = {
  thinking: 'solving',
  reading: 'breathing',
  searching: 'searching',
  running: 'working',
  editing: 'shaping',
  writing: 'composing',
  delegating: 'connecting',
  working: 'working',
}

function ThinkingIndicator({ activity, label }: { activity: Activity; label?: string }) {
  // The orb draws a canvas frame on every display refresh; it rests with the
  // window in the background, like the CSS loops (see windowFocus.ts).
  const focused = useWindowFocused()
  return (
    <span className="thinking-indicator">
      <ThinkingOrb state={ACTIVITY_ORB[activity]} size={20} paused={!focused} />
      <span className="think-word" key={activity}>
        {label ?? ACTIVITY_WORD[activity]}…
      </span>
    </span>
  )
}

function CodeBody({ text }: { text: string }) {
  const parts = useMemo(() => splitCode(text), [text])
  return (
    <>
      {parts.map((part, index) =>
        part.type === 'code' ? (
          <pre className="code" key={index}>
            {part.content.replace(/\n$/, '')}
          </pre>
        ) : (
          <span key={index}>{part.content}</span>
        ),
      )}
    </>
  )
}

function Diff({ preview }: { preview: string }) {
  const lines = useMemo(() => preview.split('\n').slice(0, 400), [preview])
  return (
    <pre className="diff">
      {lines.map((line, index) => {
        const cls = line.startsWith('@@')
          ? 'diff-hunk'
          : line.startsWith('+')
            ? 'diff-add'
            : line.startsWith('-')
              ? 'diff-del'
              : 'diff-ctx'
        return (
          <div key={index} className={cls}>
            {line || ' '}
          </div>
        )
      })}
    </pre>
  )
}

function FileCard({ file, cwd }: { file: FileChange; cwd: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`file-card wi${open ? ' open' : ''}`} data-search-id={fileSearchKey(file)}>
      <div className="file-head" onClick={() => setOpen((v) => !v)}>
        <Chevron open={open} />
        <span className={`file-badge ${file.change}`}>{file.change === 'create' ? 'New' : 'Edit'}</span>
        <span className="file-path mono" title={file.path}>
          {/* The box is right-to-left so a long path is cut from its left and
              the file name stays whole; the path itself must still read left to
              right, or the bidi algorithm moves a leading "…/" to the end and
              the name comes out as "file.md/…". */}
          <FileLink path={file.path}><bdi dir="ltr">{relativePath(file.path, cwd)}</bdi></FileLink>
        </span>
        <span className="spacer" />
        {file.added ? <span className="diff-count add">+{file.added}</span> : null}
        {file.removed ? <span className="diff-count del">−{file.removed}</span> : null}
      </div>
      {open && file.preview ? (
        <div className="file-body">
          <Diff preview={file.preview} />
        </div>
      ) : null}
    </div>
  )
}

/**
 * What the turn (or an agent) wrote, as one folded row — "2 files changed ·
 * +27 −3" — that opens to one row per file, and each file to its diff. Folded
 * by default: the header already counts the files, and the list is for when
 * you want to check them.
 */
function FileGroup({ files, cwd }: { files: FileChange[]; cwd: string }) {
  const reveal = useContext(RevealContext)
  const [open, toggle] = useDisclosure(Boolean(reveal && files.some((file) => fileSearchKey(file) === reveal.key)))
  if (!files.length) return null
  const added = files.reduce((sum, file) => sum + file.added, 0)
  const removed = files.reduce((sum, file) => sum + file.removed, 0)
  const created = files.filter((file) => file.change === 'create').length
  return (
    <div className={`file-group wi${open ? ' open' : ''}`}>
      <WorkRow
        className="file-group-head"
        icon={created === files.length ? <IconFileAdd size={15} /> : <IconFileEdit size={15} />}
        label={
          created === files.length
            ? `${files.length} new ${files.length === 1 ? 'file' : 'files'}`
            : `${files.length} ${files.length === 1 ? 'file' : 'files'} ${created ? `changed, ${created} new` : 'changed'}`
        }
        meta={<>
          {added ? <span className="diff-count add">+{added}</span> : null}
          {removed ? <span className="diff-count del">−{removed}</span> : null}
        </>}
        open={open}
        onToggle={toggle}
      />
      {open ? (
        <div className="file-group-body wr-nest">
          {files.map((file, index) => (
            <FileCard key={`${file.toolId}:${index}`} file={file} cwd={cwd} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

/**
 * Reasoning, told apart from notes at a glance: a "Reasoning" row with a bulb
 * that opens on a click, where a note is quiet italic prose with no row at all.
 * Reasoning the harness withheld (a redacted or signed block) is still a fact
 * worth a row, not a gap. Streaming reasoning stays open — it is what the turn
 * is doing right now.
 */
function Thinking({ text, show, live = false, hidden = false, searchKey }: { text: string; show: boolean; live?: boolean; hidden?: boolean; searchKey?: string }) {
  const [open, toggle] = useDisclosure(useRevealKey(searchKey))
  if (!show) return null
  if (hidden || !text.trim()) {
    return live ? null : (
      <div className="think reasoning wi" data-block="thinking" role="note" aria-label="Reasoning hidden by the harness">
        <WorkRow className="reasoning-chip" icon={<IconThought size={15} />} label="Reasoning" preview="hidden by the harness" />
      </div>
    )
  }
  if (live) {
    return (
      <div className="think reasoning activity-note live wi open" data-block="thinking" role="note" aria-label="Reasoning">
        <WorkRow className="reasoning-chip" icon={<IconThought size={15} />} label="Reasoning" />
        <div className="wr-body"><div className="msg-thinking"><Markdown text={text} /></div></div>
      </div>
    )
  }
  return (
    <div className={`think reasoning wi${open ? ' open' : ''}`} data-block="thinking" data-search-id={searchKey} role="note" aria-label="Reasoning">
      <WorkRow className="reasoning-chip" icon={<IconThought size={15} />} label="Reasoning"
        preview={open ? undefined : firstLine(text)} previewClass="reasoning-first"
        open={open} onToggle={toggle} />
      {open ? <div className="wr-body"><div className="msg-thinking"><Markdown text={text} /></div></div> : null}
    </div>
  )
}

/**
 * A checklist the agent keeps (TodoWrite, an ACP plan), as one row that says
 * how far along it is and what is being done now: "Plan · 2/4 done · Run the
 * suite". The list itself is a click away.
 */
function PlanBlock({ items, searchKey }: { items: PlanItem[]; searchKey?: string }) {
  const [open, toggle] = useDisclosure(useRevealKey(searchKey))
  const done = items.filter((item) => item.status === 'done').length
  const active = items.find((item) => item.status === 'active')
  return (
    <div className={`plan-block wi${open ? ' open' : ''}`} data-block="plan" data-search-id={searchKey} role="group" aria-label={`Plan, ${done} of ${items.length} done`}>
      <WorkRow className="plan-head" icon={<IconPlan size={15} />} label="Plan" detail={`${done}/${items.length} done`}
        preview={active?.text} open={open} onToggle={toggle} />
      {open ? (
        <ul className="plan-list wr-body">
          {items.map((item, index) => (
            <li key={index} className={`plan-item ${item.status}`}>
              <span className="plan-mark" aria-hidden="true">{item.status === 'done' ? '✓' : item.status === 'active' ? '▸' : '○'}</span>
              <span>{item.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/**
 * A question the agent is waiting on.
 *
 * The harness asks through `AskUserQuestion`, and its input is a list of
 * questions, each with options and their consequences. Shown as JSON — which is
 * what every other tool gets — the one moment the agent is actually blocked on
 * you was the least readable thing in the transcript. The options are drawn as
 * options, with what each one means underneath.
 */
interface QuestionOption {
  label?: string
  description?: string
  /** The id the protocol wants back; when absent the label is the answer. */
  id?: string
}
interface QuestionSpec {
  question?: string
  header?: string
  multiSelect?: boolean
  options?: QuestionOption[]
}

function QuestionBlock({
  ev,
  at,
  result,
  sessionId,
}: {
  ev: ToolEvent
  at: number
  result?: ToolResult
  sessionId?: string
}) {
  // Both come from the store rather than from this card's own memory. The click
  // used to set "sent" before the message left the browser, so an answer the
  // server refused — a question already answered elsewhere, a session restarted
  // since — was indistinguishable from one that arrived.
  const key = sessionId ?? ''
  const answer = useStore((s) => answerStateFor(s, key, ev.toolId))
  const request = useStore((s) => requestStateFor(s, key, ev.toolId))
  const status = useStore((s) => (sessionId ? s.sessions[sessionId]?.status : undefined))
  const questions = ((ev.input as { questions?: QuestionSpec[] } | undefined)?.questions ?? []).filter(
    (item) => item && (item.question || item.options?.length),
  )
  const answered = result?.text?.trim()
  // Answerable only while the request itself is open and something is there to
  // answer into: a stopped session has no process left to hear it.
  const waiting = request === 'pending' && Boolean(sessionId) && status !== 'stopped'
  // The request died without an answer. The card stays as the record it now is:
  // readable, greyed, and out of reach.
  const closed = request === 'expired' || request === 'cancelled'
  return (
    <div className={`question${closed ? ' closed' : ''}`}>
      <div className="question-head">
        <span className="name">Question</span>
        <span className="summary">{ev.summary}</span>
        <span className="spacer" />
        {questions.length > 1 ? <span className="chip mono">{questions.length}</span> : null}
        <span className="mono tool-time">{clock(at)}</span>
      </div>
      {questions.map((question, index) => (
        <div className="question-body" key={`${question.header ?? 'q'}-${index}`}>
          <div className="question-ask">
            {question.header ? <span className="question-tag mono">{question.header}</span> : null}
            <span>{question.question}</span>
            {question.multiSelect ? <span className="chip mono">multi</span> : null}
          </div>
          <div className="question-options">
            {(question.options ?? []).map((option) => {
              const value = option.id ?? option.label ?? ''
              // Which one was picked is read from the answer the harness wrote
              // back, not from what this browser clicked: the answer may well
              // have come from another client.
              const chosen = Boolean(answered) && (answered === value || answered === option.label)
              return (
                <button
                  type="button"
                  className={`question-option${waiting ? ' ask' : ''}${chosen ? ' chosen' : ''}`}
                  key={value}
                  disabled={!waiting || answer === 'sending' || answer === 'answered'}
                  title={waiting ? 'Answer this' : undefined}
                  onClick={() => {
                    if (!sessionId) return
                    // Nothing optimistic here: the store goes to `sending`, and
                    // only the server's ack turns that into an answer.
                    answerQuestion(sessionId, ev.toolId, value)
                  }}
                >
                  <span className="question-mark" />
                  <span className="question-label">{option.label}</span>
                  {option.description ? <span className="question-note">{option.description}</span> : null}
                </button>
              )
            })}
          </div>
        </div>
      ))}
      <div className="question-foot">
        {answered ? (
          // The server wrote the closing result: an answer, or why there will
          // never be one. Either way it already says what happened, so the card
          // repeats it rather than inventing a second version of the story.
          <span className="question-answered">{answered}</span>
        ) : (
          <span className={waiting ? 'question-waiting live' : 'question-waiting'}>
            {answer === 'sending'
              ? 'sending…'
              : answer === 'answered'
                ? 'answer sent'
                : waiting
                  ? 'waiting for your answer — pick one above'
                  : 'this question is no longer waiting for an answer'}
          </span>
        )}
      </div>
    </div>
  )
}

function ToolBlock({
  ev,
  facts,
  at,
  sessionId,
}: {
  ev: ToolEvent
  facts?: ToolFacts
  at: number
  sessionId: string
}) {
  const searchKey = toolSearchKey(ev.toolId)
  const [open, toggle] = useDisclosure(useRevealKey(searchKey))
  const result = facts?.result
  const input = ev.input && typeof ev.input === 'object' ? JSON.stringify(ev.input, null, 1) : String(ev.input ?? '')
  // One tool is a conversation rather than a command, and gets its own card.
  if (ev.name === 'AskUserQuestion') {
    return <QuestionBlock ev={ev} at={at} result={result} sessionId={sessionId} />
  }
  // The summary the server wrote, or the most identifying thing the input
  // carries. A tool the server has no case for used to render as its bare name
  // and a clock — which is how the Skill card lost the skill's own name.
  const untypedAgent = /^(agent|task)$/i.test(ev.name) && !input.trim().replace(/[{}]/g, '')
  const summary = untypedAgent ? 'Type not reported by harness' : toolLine(ev, facts)
  // A proposed plan is a document, and reads as one rather than as JSON.
  const plan = proposedPlan(ev)
  if (plan) return <ProposedPlan plan={plan} name={ev.name} searchKey={searchKey} />
  return (
    <div className={`tool wi${open ? ' open' : ''}`} data-tool={ev.name} data-search-id={searchKey}>
      <WorkRow className="tool-head"
        icon={untypedAgent ? <IconAgent size={15} /> : toolIcon(toolClass(ev.name, ev.kind), ev.name, ev.kind)}
        label={untypedAgent ? 'Subagent' : toolLabel(ev)} labelClass="name"
        detail={summary} detailClass="summary" mono={!untypedAgent}
        status={result?.isError ? 'failed' : undefined}
        meta={clock(at)} open={open} onToggle={toggle}
        toggleOnlyWhenCut={!untypedAgent && !toolHasMore(ev, facts)}
        detailFile={toolFilePath(ev)} />
      {open ? (
        <div className="tool-io">
          <ClampedText className="tool-body" lines={8} text={input} searchKey={searchKey} />
          {result ? (
            <ClampedText className={`tool-body${result.isError ? ' error' : ''}`} lines={8} searchKey={searchKey}
              text={`${result.text || '(empty)'}${result.truncated ? '\n… truncated' : ''}`} />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** The plan an agent proposes before it starts: a document, open by default. */
function ProposedPlan({ plan, name, searchKey }: { plan: string; name: string; searchKey?: string }) {
  const [open, toggle] = useDisclosure(useRevealKey(searchKey), true)
  return (
    <div className={`plan-block proposed wi${open ? ' open' : ''}`} data-block="plan" data-tool={name} data-search-id={searchKey}>
      <WorkRow className="plan-head" icon={<IconPlan size={15} />} label="Proposed plan"
        preview={open ? undefined : firstLine(plan)} open={open} onToggle={toggle} />
      {open ? <div className="msg-body wr-body"><Markdown text={plan} /></div> : null}
    </div>
  )
}

function SubagentCard({
  group,
  sessionId,
  running,
  sessionLive,
  live,
  showThinking,
  showCost,
  results,
  cwd,
}: {
  group: SubagentGroup
  sessionId: string
  /**
   * Whether the agent behind this card is still out (see `groupRunning`).
   * Decided by the turn, which has every row: only there can the card tell a
   * provisional completion row from a real one.
   */
  running: boolean
  /** Child liveness is independent from whether this parent already ended. */
  sessionLive: boolean
  live: Record<string, LiveBuffer>
  showThinking: boolean
  showCost?: boolean
  results: Map<string, ToolFacts>
  cwd: string
}) {
  const end = group.end
  const failed = Boolean(end && end.status !== 'done' && end.status !== 'running')
  const state: 'running' | 'failed' | 'done' = running ? 'running' : failed ? 'failed' : 'done'
  // One line until it is asked for, whatever state it is in: the line itself
  // says running (live status), failed (in red, with the reason as its
  // preview) or done (with the first line of what it found). A card that
  // reproduced its prompt, its work and its whole result outside the fold is
  // what made two agents fill the screen.
  const searchKey = agentSearchKey(group)
  const reveal = useContext(RevealContext)
  const [open, toggle] = useDisclosure(Boolean(reveal?.agents.includes(searchKey)))
  const showDetail = useFoldContents(open)
  const buffer = group.agentId ? live[`${sessionId}:${group.agentId}`] : undefined
  const files = group.events.filter((event): event is SessionEvent & { ev: FileChange } => event.ev.k === 'file_change')
  // A provisional completion row reports zero tools and zero seconds, which is
  // worse than nothing: fall back to what the sidechain actually did.
  const tools = (end?.toolUses ?? 0) || group.events.filter((event) => event.ev.k === 'tool').length
  const spanMs = agentSpanMs(group)
  // The sidechain's own prose is what it *concluded*, so the last thing it said
  // belongs under Result, not under Work with the tool calls. Everything else it
  // said stays where it happened, as running commentary.
  const answerRow = [...group.events]
    .reverse()
    .find((event) => event.ev.k === 'assistant' && event.ev.text.trim().length > 0)
  const answerText = answerRow?.ev.k === 'assistant' ? answerRow.ev.text : (end?.result ?? '')
  const workRows = oneHiddenReasoning(group.events).filter(
    (event) =>
      event !== answerRow &&
      event.ev.k !== 'subagent_start' &&
      event.ev.k !== 'file_change' &&
      event.ev.k !== 'subagent_end',
  )
  const foldedWork = foldRepeats(workRows)
  const streaming = !answerText && buffer?.text ? buffer.text : ''
  const hasDetail = Boolean(
    group.start.prompt ||
      files.length ||
      workRows.length ||
      group.children.length ||
      answerText ||
      streaming ||
      (buffer?.thinking && showThinking) ||
      (!group.start.prompt && end),
  )
  // What the folded line previews: while it works, what it is doing right now;
  // once it is back, the first line of what it came back with.
  const lastCall = [...group.events].reverse().find((event) => event.ev.k === 'tool')
  const doing = lastCall?.ev.k === 'tool'
    ? `${toolLabel(lastCall.ev)} ${toolLine(lastCall.ev, results.get(lastCall.ev.toolId))}`.trim()
    : ''
  const preview = running ? firstLine(streaming) || doing : firstLine(answerText)
  const type = group.start.agentType && group.start.agentType.toLowerCase() !== 'agent' ? group.start.agentType : 'Subagent'
  const usage = end?.usage
  const toolCount = tools ? `${tools} ${tools === 1 ? 'tool' : 'tools'}` : null
  const facts = [
    group.start.model,
    usage?.output ? `${usage.output.toLocaleString()} tokens out` : null,
    usage?.input ? `${usage.input.toLocaleString()} in` : null,
    usage?.cacheRead ? `${usage.cacheRead.toLocaleString()} cache` : null,
    toolCount,
    spanMs !== null && !running ? formatDuration(spanMs) : null,
  ].filter(Boolean).join(' · ')

  return (
    <div className={`subagent wi${open && hasDetail ? ' open' : ''}`} data-state={state} data-search-id={searchKey}>
      <WorkRow className="subagent-head" icon={<IconAgent size={15} />}
        label={type} labelClass="subagent-type"
        detail={group.start.description || group.start.prompt.slice(0, 70) || (failed ? 'Task failed; details unavailable' : 'Task details unavailable')}
        detailClass="subagent-desc"
        preview={preview} previewClass="subagent-preview"
        status={state === 'done' ? undefined : state}
        meta={running
          ? <AgentClock since={group.firstAt || Date.now()} />
          : [toolCount, spanMs !== null ? formatDuration(spanMs) : null].filter(Boolean).join(' · ')}
        title={group.start.model ? `${type} · ${group.start.model}` : undefined}
        open={open} onToggle={hasDetail ? toggle : undefined} />
      {/* The detail is a grid row that goes to zero rather than an element that
          vanishes, so opening and closing a card is a movement you can follow. */}
      <div className={`subagent-detail${hasDetail && open ? ' open' : ''}`}>
        <div className="subagent-detail-inner">
          {hasDetail && showDetail ? (
          <div className="subagent-body wr-nest">
            {group.start.prompt ? (
              <div className="subagent-section">
                <div className="subagent-label">Prompt</div>
                <ClampedText className="subagent-prompt" lines={4} text={group.start.prompt} searchKey={searchKey} />
              </div>
            ) : end ? (
              <div className="subagent-section">
                <div className="subagent-label">Details</div>
                <div className="subagent-prompt">The harness did not provide task metadata for this event.</div>
                {group.toolId ? <div className="subagent-prompt mono">Task ID: {group.toolId}</div> : null}
              </div>
            ) : null}
            {files.length ? <FileGroup files={files.map((event) => event.ev)} cwd={cwd} /> : null}
            {workRows.length ? (
              <div className="subagent-section work">
                <div className="subagent-label">Work</div>
                {groupToolRuns(foldedWork.rows).map((event) =>
                  isToolRun(event) ? (
                    <ToolRunRow key={`run:${event.key}`} run={event} results={results} sessionId={sessionId} live={running} />
                  ) : (
                    <RowView
                      key={event.id}
                      event={event}
                      sessionId={sessionId}
                      showThinking={showThinking}
                      showCost={showCost}
                      results={results}
                      cwd={cwd}
                      nested
                      repeat={foldedWork.repeats.get(event.id)}
                    />
                  ),
                )}
              </div>
            ) : null}
            {group.children.length ? (
              <div className="subagent-section subagent-children">
                <div className="subagent-label">Subagents</div>
                {group.children.map((child) => (
                  <SubagentCard
                    key={`subagent:${child.toolId || child.agentId}`}
                    group={child}
                    sessionId={sessionId}
                    running={groupRunning(child, sessionLive)}
                    sessionLive={sessionLive}
                    live={live}
                    showThinking={showThinking}
                    showCost={showCost}
                    results={results}
                    cwd={cwd}
                  />
                ))}
              </div>
            ) : null}
            {buffer?.thinking && showThinking ? <Thinking text={buffer.thinking} show live /> : null}
            {answerText || streaming ? (
              <div className="subagent-section result">
                <div className="subagent-label">{answerText ? 'Result' : 'Writing…'}</div>
                <div className={`subagent-answer${answerText ? '' : ' dim'}`} data-search-id={answerRow?.id ?? searchKey}>
                  <Markdown text={answerText || streaming} />
                </div>
                {facts ? <div className="subagent-meta mono">{facts}</div> : null}
              </div>
            ) : null}
          </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function RowView({
  event,
  sessionId,
  showThinking,
  showCost,
  results,
  cwd,
  nested,
  repeat,
}: {
  event: SessionEvent
  sessionId: string
  showThinking: boolean
  showCost?: boolean
  results: Map<string, ToolFacts>
  cwd: string
  nested?: boolean
  /** How many identical harness lines in a row this one stands for (see `foldRepeats`). */
  repeat?: number
}) {
  const ev = event.ev
  switch (ev.k) {
    case 'user':
      return <UserMessage ev={ev} at={event.at} sessionId={sessionId} />
    case 'assistant':
      return (
        <div className={nested ? 'work-update activity-note' : 'msg-assistant'} data-block={nested ? 'progress' : undefined} data-reading-id={event.id} data-search-id={event.id} role={nested ? 'note' : undefined} aria-label={nested ? 'Note' : undefined}>
          {/* A note is prose on the way — quiet italic, with no row of its
              own, so it never reads as reasoning (a row) or as the reply. */}
          <div className="msg-body">
            <Markdown text={ev.text} />
          </div>
          {nested ? null : (
            <div className="msg-actions">
              <span className="mono">{clock(event.at)}</span>
              {ev.usage?.output ? <span className="mono">{ev.usage.output} tok</span> : null}
              <CopyButton text={ev.text} />
            </div>
          )}
        </div>
      )
    case 'thinking':
      return <Thinking text={ev.text} show={showThinking} hidden={ev.hidden} searchKey={event.id} />
    case 'tool': {
      const plan = planItems(ev)
      if (plan) return <PlanBlock items={plan} searchKey={toolSearchKey(ev.toolId)} />
      return <ToolBlock ev={ev} facts={results.get(ev.toolId)} at={event.at} sessionId={sessionId} />
    }
    case 'tool_result':
      return null
    case 'file_change':
      return <FileCard file={ev} cwd={cwd} />
    case 'subagent_end':
      return nested && ev.result ? (
        <div className="line-result nested-result">
          <Markdown text={ev.result} />
        </div>
      ) : null
    case 'system': {
      const plan = planItems(ev)
      if (plan) return <PlanBlock items={plan} searchKey={event.id} />
      return (
        <div className="line-system" data-search-id={event.id}>
          <span className="wr-slot" aria-hidden="true" />
          <span className="wr-icon" aria-hidden="true"><IconInfo size={15} /></span>
          <span className="line-system-text">
            {SYSTEM_LABEL[ev.subtype] ? <span className="system-tag mono">{SYSTEM_LABEL[ev.subtype]}</span> : null}
            {noticeLine(ev)}
          </span>
          {repeat && repeat > 1 ? <span className="wr-meta" title={`${repeat} identical lines in a row`}>×{repeat}</span> : null}
        </div>
      )
    }
    case 'request':
      return <RequestBlock ev={ev} at={event.at} sessionId={sessionId} searchKey={event.id} />
    case 'result':
      return <TurnFooter ev={ev} showCost={showCost} />
    case 'error':
      return <ErrorCard ev={ev} searchKey={event.id} />
    default:
      return null
  }
}

/**
 * Something went wrong, said in words, with the raw report kept underneath.
 *
 * The server writes a normalized failure as one paragraph of plain language, a
 * blank line, and then everything it was handed, unedited (see `formatFailure`
 * in the harness types). That is the whole contract this component reads: the
 * first paragraph is what a person needs, the rest is what an engineer needs,
 * and neither is thrown away. A failure that was never normalized has no blank
 * line in it, so it renders as one block exactly the way it always did.
 *
 * The detail stays mounted and is closed by folding its row to zero height
 * rather than by being removed. A stack trace is small, and keeping it in the
 * tree is what lets the copy button hand over the whole report — headline and
 * trace together — from a card nobody has opened.
 *
 * This component knows nothing about which harness produced the failure. The
 * attribution is in the sentence the server wrote, because deciding who a
 * failure belongs to needs the process, the host and the stack frames, and none
 * of those exist in the browser.
 */
/**
 * The one piece of markup a headline may carry: a path or a command in
 * backticks, drawn as code.
 *
 * Not the markdown renderer. The headline is one sentence and the renderer is
 * built for documents — its block margins are exactly the airiness this app has
 * been asked to remove — and a stack trace that happened to contain a `*` would
 * come out italicised. A backtick pair is the whole grammar, because a path you
 * are meant to read and a command you are meant to retype are the only things
 * the server ever marks up.
 */
function headlineParts(text: string): Array<string | React.ReactElement> {
  return text.split(/`([^`\n]+)`/).map((part, index) =>
    index % 2 ? <code key={index}>{part}</code> : part,
  )
}

export function ErrorCard({ ev, searchKey }: { ev: Extract<TimelineEvent, { k: 'error' }>; searchKey?: string }) {
  const reveal = useContext(RevealContext)
  const text = ev.text ?? ''
  const split = text.indexOf('\n\n')
  // Search opens the details only for a match in them; the headline is always shown.
  const [open, toggle] = useDisclosure(Boolean(
    reveal && searchKey && reveal.key === searchKey && split !== -1
      && text.slice(split + 2).toLocaleLowerCase().includes(reveal.needle),
  ))
  const headline = (split === -1 ? text : text.slice(0, split)).trim()
  const detail = split === -1 ? '' : text.slice(split + 2).trim()
  return (
    <div className="line-error" role="alert" data-search-id={searchKey}>
      <div className="error-head">
        <span className="error-headline">{headlineParts(headline)}</span>
        <CopyButton text={text} label="Copy This Report" />
      </div>
      {detail ? (
        <>
          <button
            className={`error-more${open ? ' open' : ''}`}
            onClick={toggle}
            aria-expanded={open}
          >
            <IconCaret size={16} />
            <span>{open ? 'Hide Details' : 'Details'}</span>
          </button>
          <div className={`error-fold${open ? ' open' : ''}`}>
            <div className="error-fold-inner">
              <pre className="error-detail">{detail}</pre>
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}

/** Internal subtypes the harness emits: name them so they are not mysterious. */
const SYSTEM_LABEL: Record<string, string> = {
  stop_hook_summary: 'Hook · Stop',
  'agent-exit': 'Harness Stopped',
  'session-fresh': 'New Session',
  auth: 'Sign In',
  plan: 'Plan',
  compact_boundary: 'Compaction',
  api_retry: 'Retry',
  'api-retry': 'Retry',
  api_error: 'API Error',
}

/** A first-class agent request: one event is both the live card and its history. */
function RequestBlock({
  ev,
  at,
  sessionId,
  searchKey,
}: {
  ev: Extract<TimelineEvent, { k: 'request' }>
  at: number
  sessionId: string
  searchKey?: string
}) {
  const answer = useStore((s) => answerStateFor(s, sessionId, ev.requestId))
  const status = useStore((s) => s.sessions[sessionId]?.status)
  const waiting = ev.state === 'pending' && status !== 'stopped' && status !== 'error'
  const closed = ev.state === 'expired' || ev.state === 'cancelled'
  const answered = ev.options.find((option) => option.id === ev.answeredOptionId)
  const outcome =
    ev.state === 'answered'
      ? (answered?.label ?? 'answered')
      : ev.state === 'pending'
        ? null
        : (ev.closedReason ?? (ev.state === 'expired' ? 'expired' : 'cancelled'))
  return (
    <div className={`question request${closed ? ' closed' : ''}`} data-request-state={ev.state} data-search-id={searchKey}>
      <div className="question-head">
        <span className="name">{ev.kind === 'permission' ? 'Permission' : 'Question'}</span>
        <span className="summary">{ev.title}</span>
        <span className="spacer" />
        <span className="mono tool-time">{clock(at)}</span>
      </div>
      <div className="question-body">
        <div className="question-ask">
          <span>{ev.title}</span>
        </div>
        {ev.detail ? <div className="question-note request-detail">{ev.detail}</div> : null}
        <div className="question-options">
          {ev.options.map((option) => {
            const chosen = ev.state === 'answered' && ev.answeredOptionId === option.id
            return (
              <button
                type="button"
                className={`question-option${waiting ? ' ask' : ''}${chosen ? ' chosen' : ''}`}
                data-intent={option.intent ?? 'neutral'}
                key={option.id}
                disabled={!waiting || answer === 'sending' || answer === 'answered'}
                title={waiting ? 'Answer this' : undefined}
                onClick={() => answerQuestion(sessionId, ev.requestId, option.id)}
              >
                <span className="question-mark" />
                <span className="question-label">{option.label}</span>
                {option.hint ? <span className="question-note">{option.hint}</span> : null}
              </button>
            )
          })}
        </div>
      </div>
      <div className="question-foot">
        {outcome ? (
          <span className="question-answered">{outcome}</span>
        ) : (
          <span className={waiting ? 'question-waiting live' : 'question-waiting'}>
            {answer === 'sending'
              ? 'sending…'
              : waiting
                ? 'waiting for your answer — pick one above'
                : 'this request is no longer waiting for an answer'}
          </span>
        )}
      </div>
    </div>
  )
}

function TurnFooter({ ev, showCost }: { ev: ResultEvent; showCost?: boolean }) {
  // The header already shows the elapsed time. A raw internal stop reason such
  // as `server_restart · 401.0s` reads like a harness failure, while in fact
  // the Sedano backend disappeared before this turn could return.
  if (ev.subtype === 'server_restart') {
    return <div className="line-result" role="status">Sedano restarted before this turn finished.</div>
  }
  const bits: string[] = []
  if (ev.durationMs) bits.push(formatDuration(ev.durationMs))
  // A counter the harness never reported is not a zero: `usageValue` answers
  // null for those and the footer simply does not mention them.
  const usage = ev.usage
  const input = usageValue(usage, 'input')
  const cacheRead = usageValue(usage, 'cacheRead')
  const output = usageValue(usage, 'output')
  if (input) bits.push(`${formatTokens(input)} in`)
  if (cacheRead) bits.push(`${formatTokens(cacheRead)} cache`)
  if (output) bits.push(`${formatTokens(output)} out`)
  // Same for the price: several harnesses bill a subscription and publish
  // nothing, and "$0.0000" would be a claim about the price rather than silence.
  // A harness that did quote zero has still answered, though, so the figure is
  // printed — testing `costUsd` alone dropped it, because zero is falsy, and the
  // footer then disagreed with the status bar about the very same turn.
  if (showCost && (ev.costUsd || ev.costReported)) bits.push(`$${ev.costUsd.toFixed(4)}`)
  if (ev.subtype !== 'success') bits.unshift(ev.subtype)
  return <div className="line-result">{bits.join(' · ')}</div>
}

/* ------------------------------------------------------------------ */
/* Turns                                                               */
/* ------------------------------------------------------------------ */

/**
 * The session's configuration, as the turn header's tooltip.
 *
 * The harness reports it as an ordinary `system` line ("model · folder ·
 * approval mode"); drawn at the top of every expanded turn it was a mono line
 * of things the user set themselves, read once and then only in the way. It is
 * kept where it answers a question — hovering the header — with the workspace
 * shortened to the folder's name.
 */
function contextLine(events: SessionEvent[], cwd: string): string {
  const event = events[0]
  if (!event || event.ev.k !== 'system') return ''
  const folder = cwd.split('/').filter(Boolean).pop() ?? cwd
  return event.ev.text.split(' · ').map((part) => (part === cwd ? folder : part)).join(' · ')
}

/**
 * The harness' routine bookkeeping, one click away.
 *
 * Every turn ends with a per-`result` timing line and one line per hook run, and
 * stacked together they were the ugliest region on screen — five grey rows
 * between the work and the answer, none of which anyone asked for. The figures
 * are already in the turn header; nothing is deleted, it is folded. Only the
 * routine ones come here: a hook that stopped the turn, or a result that was not
 * a success, is not routine and stays in plain sight (see `isRoutineNotice`).
 */
function TurnNotices({
  events,
  showCost,
  cwd,
  sessionId,
  results,
}: {
  events: SessionEvent[]
  showCost?: boolean
  cwd: string
  sessionId: string
  results: Map<string, ToolFacts>
}) {
  const reveal = useContext(RevealContext)
  const [open, toggle] = useDisclosure(Boolean(reveal && events.some((event) => event.id === reveal.key)))
  if (!events.length) return null
  const { rows, repeats } = foldRepeats(events)
  return (
    <div className={`turn-notes wi${open ? ' open' : ''}`}>
      <WorkRow className="turn-notes-head" icon={<IconInfo size={15} />}
        label={`${events.length} Harness ${events.length === 1 ? 'Notice' : 'Notices'}`}
        open={open} onToggle={toggle} />
      {open ? (
        <div className="turn-notes-body wr-nest">
          {rows.map((event) => (
            <RowView
              key={event.id}
              event={event}
              repeat={repeats.get(event.id)}
              sessionId={sessionId}
              showThinking={false}
              showCost={showCost}
              results={results}
              cwd={cwd}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

/**
 * A run of consecutive tool calls, folded into one row: what ran and how long
 * it took, and — while one of them is still out — which one, live. Opened, a
 * long run shows its first and last few calls with the rest one click away,
 * rather than a wall of identical cards.
 */
const RUN_EDGE = 3

const ToolRunRow = memo(function ToolRunRow({
  run,
  results,
  sessionId,
  live,
}: {
  run: ToolRun
  results: Map<string, ToolFacts>
  sessionId: string
  /** Whether the turn is still working, so an unanswered call is running now. */
  live: boolean
}) {
  const reveal = useContext(RevealContext)
  const revealAt = reveal
    ? run.events.findIndex((event) => event.ev.k === 'tool' && toolSearchKey(event.ev.toolId) === reveal.key)
    : -1
  const [open, toggle] = useDisclosure(revealAt >= 0)
  // A match among the calls a long run keeps behind "Show all" shows them all,
  // until search moves on.
  const [allHeld] = useRevealed(revealAt >= RUN_EDGE && revealAt < run.events.length - RUN_EDGE)
  const [allChosen, setAll] = useState(false)
  const all = allChosen || allHeld
  const pending = live
    ? [...run.events].reverse().find((event) => event.ev.k === 'tool' && !results.get(event.ev.toolId)?.result)
    : undefined
  const failed = run.events.some((event) => event.ev.k === 'tool' && results.get(event.ev.toolId)?.result?.isError)
  const shown = all || run.events.length <= RUN_EDGE * 2 + 1
    ? run.events
    : [...run.events.slice(0, RUN_EDGE), ...run.events.slice(-RUN_EDGE)]
  const hidden = run.events.length - shown.length
  const card = (event: SessionEvent) =>
    event.ev.k === 'tool' ? (
      <ToolBlock key={event.id} ev={event.ev} facts={results.get(event.ev.toolId)} at={event.at} sessionId={sessionId} />
    ) : null
  const { label, time } = toolRunParts(run, results)
  const calls = run.events.filter((event): event is SessionEvent & { ev: ToolEvent } => event.ev.k === 'tool')
  // Folded, the line says what the calls were about — the commands, the paths —
  // so eight Bash calls are not eight clicks to tell apart. While one is out,
  // it says that one.
  const detail = pending?.ev.k === 'tool'
    ? `${toolLabel(pending.ev)} ${toolLine(pending.ev, results.get(pending.ev.toolId))}`.trim()
    : calls.slice(0, 4).map((event) => toolLine(event.ev, results.get(event.ev.toolId))).filter(Boolean).join(' · ')
  const shared = toolRunClass(run)
  const first = calls[0]?.ev
  return (
    <div className={`tool tool-run wi${open ? ' open' : ''}`} data-tool-run={run.events.length}>
      <WorkRow
        className="tool-head"
        icon={shared ? toolIcon(shared) : first && calls.every((event) => event.ev.name === first.name) ? toolIcon(null, first.name, first.kind) : <IconStack size={15} />}
        label={label}
        labelClass="name"
        detail={detail}
        detailClass="summary"
        mono
        status={pending ? 'running' : failed ? 'failed' : undefined}
        statusText={pending ? 'Running' : undefined}
        meta={time}
        open={open}
        onToggle={toggle}
      />
      {open ? (
        <div className="tool-run-list wr-nest">
          {shown.slice(0, all || !hidden ? shown.length : RUN_EDGE).map(card)}
          {hidden ? (
            <button type="button" className="tool-run-more" onClick={() => setAll(true)}>
              Show all {run.events.length}
            </button>
          ) : null}
          {!all && hidden ? shown.slice(RUN_EDGE).map(card) : null}
        </div>
      ) : null}
    </div>
  )
}, (previous, next) =>
  previous.run.events.length === next.run.events.length &&
  previous.run.events.every((event, index) => event === next.run.events[index]) &&
  previous.live === next.live &&
  previous.sessionId === next.sessionId &&
  previous.run.events.every((event) => event.ev.k !== 'tool' || previous.results.get(event.ev.toolId) === next.results.get(event.ev.toolId)),
)

/**
 * The header's facts, and only these: what happened to files, as icons with
 * counts, and what the turn spent in tokens, as one number. Every other count
 * (commands, reads, agents…) read as noise on a line meant to be glanced at;
 * the work itself is one click away. Each fact explains itself on hover.
 */
function TurnFacts({ turn }: { turn: Turn }) {
  const files = turnFiles(turn)
  const { main, agents } = turn.tokens
  const total = (tokens: TokenTotals) => tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite
  const spent = main.output + agents.output
  const line = (label: string, tokens: TokenTotals) =>
    `${label}: ${compactCount(tokens.input)} in · ${compactCount(tokens.output)} out · ${compactCount(tokens.cacheRead)} cache read · ${compactCount(tokens.cacheWrite)} cache write`
  // No cost line: Claude reports a result's cost as the running total of the
  // process, so summing a turn's results multiplies it, and one result alone
  // is not the turn's share either. The session's cost lives in the status bar.
  const tokenTip = [
    `${compactCount(spent)} output tokens`,
    total(main) ? line('This turn', main) : null,
    total(agents) ? line('Its agents', agents) : null,
  ].filter(Boolean).join('\n')
  const list = (title: string, paths: string[]) => `${title}\n${paths.map((path) => `  ${path}`).join('\n')}`
  return (
    <>
      {files.edited.length ? (
        <span className="turn-file edited" title={list(`${files.edited.length} changed`, files.edited)} aria-label={`${files.edited.length} files changed`}>
          <IconFileEdit size={14} />{files.edited.length}
        </span>
      ) : null}
      {files.added.length ? (
        <span className="turn-file added" title={list(`${files.added.length} added`, files.added)} aria-label={`${files.added.length} files added`}>
          <IconFileAdd size={14} />{files.added.length}
        </span>
      ) : null}
      {files.deleted.length ? (
        <span className="turn-file deleted" title={list(`${files.deleted.length} deleted`, files.deleted)} aria-label={`${files.deleted.length} files deleted`}>
          <IconFileRemove size={14} />{files.deleted.length}
        </span>
      ) : null}
      {spent ? <span className="chip mono turn-tokens" title={tokenTip}>{compactCount(spent)}</span> : null}
    </>
  )
}

function TurnView({
  turn,
  isLast,
  index,
  session,
  live,
  settings,
  results,
  expanded,
  onToggle,
  searchTarget,
  reveal = null,
  record,
}: {
  turn: Turn
  isLast: boolean
  index: number
  session: SessionSummary
  live: Record<string, LiveBuffer>
  settings: UiSettings
  results: Map<string, ToolFacts>
  expanded: boolean
  /** Called with whether the work is open on screen right now. */
  onToggle: (shown: boolean) => void
  searchTarget?: boolean
  /** The search match, when it is in this turn (see `Reveal`). */
  reveal?: Reveal | null
  /** The server's ledger record of this turn; `null` when it keeps a ledger without one. */
  record?: TurnRecord | null
}) {
  const hold = useContext(HoldContext)
  const buffer = live[`${session.id}:main`]
  const starting = session.status === 'starting'
  const sessionLive = session.status === 'running' || starting
  // One reading of the turn, shared by its header and reply.
  // The server's ledger decides the state when it has a record of this turn.
  const state: TurnState = stateOf(turn, record, sessionLive)
  const working = state === 'working'
  // The clocks count from when the turn ran, not from when its prompt was typed.
  const startedAt = turnStartedAt(turn, record)
  const cutOff = sessionLive && !record?.phase ? 0 : cutOffOf(turn, record)
  const files = turn.stats.files
  // Subagent groups paint their own files and tools; the turn-level file group
  // only shows what the main loop changed, so nothing is listed twice.
  const rows = turn.rows.filter((row) => isGroup(row) || row.ev.k !== 'file_change')
  // The reply is what the turn ends on: the closing prose of its last model
  // cycle (see `readTurn`). It lives outside the collapsible on purpose — the
  // reply is what you come back to read, while the work behind it is what you
  // expand when you want to check it. Prose written before a tool call is a
  // note and stays in the work; an earlier cycle's closing words were said to
  // the user at the time, and read above the reply in the order they came —
  // already while the turn is still going, since those cycles are over.
  const reading = readTurnWith(rows, record)
  const replies = working ? [] : reading.reply
  const updates = reading.updates
  const answers = replies.map((row) => ({
    key: row.id,
    at: row.at as number | null,
    text: row.ev.k === 'assistant' ? row.ev.text : '',
  }))
  // The harness' own record of the final reply, for a cycle whose closing prose
  // never arrived as a message of its own.
  if (!working && !answers.length && reading.fallback) {
    answers.push({ key: `fallback:${turn.id}`, at: turn.endedAt, text: reading.fallback })
  }
  // Only the buffer that belongs to *this* turn. A socket that drops mid-stream
  // leaves text behind that the replayed timeline already contains; deciding
  // whether to draw it by string-matching it against the last reply guessed
  // wrong often enough that one answer appeared twice and never went away.
  // Turn identity answers the same question without guessing. Two unknowns
  // still match, so a server that reports no turn at all streams as before.
  const bufferIsOurs = isLast && (buffer?.turnId === turn.turnId || buffer?.turnId === turn.continuationTurnId)
  const streamed = bufferIsOurs ? (buffer?.text ?? '').trim() : ''
  if (streamed && !working) {
    // The message in flight, or a longer copy of the last one still being
    // written: either way it must not appear twice.
    const last = answers[answers.length - 1]
    if (!last) answers.push({ key: 'live', at: null, text: streamed })
    else if (streamed.length > last.text.length) last.text = streamed
  }
  // Live deltas stay in the same chronological activity column as their
  // committed event. Moving the latest thought to the top made it jump back
  // into the history when the next event arrived.
  const streamedThinking = bufferIsOurs ? (buffer?.thinking ?? '').trim() : ''
  // Everything that is not the reply: the tools, the thinking, the cards — and the
  // narration, which is prose but is still work.
  const replyIds = new Set([...replies, ...updates].map((row) => row.id))
  // A plan is rewritten as the work goes; only its latest version is the plan.
  const plans = rows.filter((row): row is SessionEvent => !isGroup(row) && row.ev.k === 'tool' && planItems(row.ev) !== null)
  const latestPlan = plans[plans.length - 1]
  const workRows = rows.filter((row) =>
    !(!isGroup(row) && replyIds.has(row.id)) && !(!isGroup(row) && plans.includes(row) && row !== latestPlan))
  // Configuration on top, the work in the order it happened, the bookkeeping at
  // the bottom behind a disclosure. The flat list at one weight is what read as
  // a pile.
  const work = splitWork(oneHiddenReasoning(workRows))
  // A failure is not part of the work, it is the outcome of it, so it lives
  // beside the reply rather than inside the collapsible.
  //
  // This is not presentation. A finished turn folds itself up, and an error was
  // an ordinary row inside that fold: a turn that failed collapsed to a grey
  // header reading "Stopped after 4s" with the reason hidden behind a click
  // nobody knew to make. Lifting it out is what makes "never silenced" true of
  // the screen and not only of the database.
  const failures = work.activity.filter(
    (row): row is SessionEvent => !isGroup(row) && row.ev.k === 'error',
  )
  const activity = work.activity.filter((row) => !failures.includes(row as SessionEvent))
  const folded = foldRepeats(activity)
  const context = contextLine(work.context, session.cwd)
  // The clock of the whole reply is the last message's: several messages of one
  // turn are one answer, so one timestamp closes it rather than three.
  const answerAt = answers.reduce<number | null>((last, answer) => answer.at ?? last, null)
  // Everything said to the user, in order: the earlier cycles' closing words,
  // then the reply.
  const outputs = [
    ...updates.map((row) => ({ key: row.id, at: row.at as number | null, text: row.ev.k === 'assistant' ? row.ev.text : '' })),
    ...answers,
  ]
  const outputText = outputs.map((part) => part.text).join('\n\n')
  // A match anywhere but the prompt, the failures and what was said to the user
  // is inside the work, and the work opens for it.
  const [revealHeld, releaseReveal] = useRevealed(Boolean(
    reveal
      && reveal.key !== promptSearchKey(turn)
      && !outputs.some((part) => part.key === reveal.key)
      && !failures.some((row) => row.id === reveal.key),
  ))
  const shown = expanded || revealHeld
  const showWork = useFoldContents(shown)
  const promptOnly =
    turn.user?.delivery === 'queued'
    || turn.user?.delivery === 'cancelled'
    || turn.user?.delivery === 'failed'

  // A future/cancelled prompt is a real timeline item, but it has no actor yet.
  // Omitting the actor subtree entirely avoids inert zero-size disclosures and
  // status dots remaining in the accessibility tree behind `display:none`.
  if (promptOnly && turn.user) {
    return (
      <RevealContext.Provider value={reveal}>
      <section className={`turn${searchTarget ? ' search-target' : ''}`} data-index={index} data-turn-key={turn.id} data-state={state} data-prompt-state={turn.user.delivery}>
        <UserMessage ev={turn.user} at={turn.userAt} sessionId={session.id} eventId={turn.userId} searchKey={promptSearchKey(turn)} />
      </section>
      </RevealContext.Provider>
    )
  }

  return (
    <RevealContext.Provider value={reveal}>
    <section
      className={`turn${searchTarget ? ' search-target' : ''}`}
      data-index={index}
      data-turn-key={turn.id}
      data-state={state}
      data-prompt-state={turn.user?.delivery}
    >
      {turn.user ? <UserMessage ev={turn.user} at={turn.userAt} sessionId={session.id} eventId={turn.userId} searchKey={promptSearchKey(turn)} /> : null}

      {/* One activity group per turn; the centered disclosure stays reachable
          while the work grows, without drawing a second timeline rule. */}
      <div className="turn-agent">
        {/* The header and the work it folds, together: the header stays pinned
            while you scroll through the work, and lets go at the reply. */}
        <div className={`turn-work${shown ? ' open' : ''}`}>
        <div className="turn-head">
          <button
            className="turn-toggle"
            onClick={(event) => {
              hold(event.currentTarget.parentElement ?? event.currentTarget)
              releaseReveal()
              onToggle(shown)
            }}
            title={`${shown ? 'Collapse this turn' : 'Expand this turn'}${context ? `\n${context}` : ''}`}
          >
            <Chevron open={shown} />
            {/* "Worked for Ns" only when the work is actually over: the parent's
                result can arrive while its subagents are still running, and a
                finished-looking turn with four agents live behind it is a lie.
                While it runs the header says so in plain words; the moving
                part — the orb and the ticking seconds — sits at the bottom of
                the turn, after the latest thing it said (see below). */}
            {working ? (
              <span className="turn-title">Working for <WorkingFor since={startedAt} /></span>
            ) : (
              <span className="turn-title">
                {state === 'failed'
                  ? 'Failed after'
                  : state === 'interrupted'
                    ? 'Stopped after'
                    : 'Worked for'}{' '}
                {/* The clock from the prompt to the last thing the turn did —
                    summing each cycle's reported time left out the waits on
                    agents, so a turn of an hour read as a few minutes. */}
                {formatSpan(turnSpanMs(turn, record))}
                {state === 'interrupted' && cutOff ? ` · ${cutOff} agent${cutOff > 1 ? 's' : ''} cut off` : ''}
              </span>
            )}
            <TurnFacts turn={turn} />
          </button>
        </div>

        {/* A row that collapses to zero height rather than an element that blinks
            out: expanding a turn is a movement you can follow, which is what the
            work appearing and disappearing was missing. */}
        <div className={`turn-fold${shown ? ' open' : ''}`}>
          <div className="turn-fold-inner">
            {showWork ? (
            <div className="turn-body" data-block="work">
              {files.length ? <FileGroup files={files} cwd={session.cwd} /> : null}
              {groupToolRuns(folded.rows).map((row) =>
                isToolRun(row) ? (
                  <ToolRunRow key={`run:${row.key}`} run={row} results={results} sessionId={session.id} live={working} />
                ) : isGroup(row) ? (
                  <SubagentCard
                    key={`subagent:${row.toolId || row.agentId}`}
                    group={row}
                    sessionId={session.id}
                    running={groupRunning(row, sessionLive)}
                    sessionLive={sessionLive}
                    live={live}
                    showThinking={settings.showThinking}
                    showCost={settings.showCost}
                    results={results}
                    cwd={session.cwd}
                  />
                ) : (
                  <RowView
                    key={row.id}
                    event={row}
                    sessionId={session.id}
                    showThinking={settings.showThinking}
                    showCost={settings.showCost}
                    results={results}
                    cwd={session.cwd}
                    // Narration inside the work group is work: no clock and no copy
                    // affordance, the way a reply gets them.
                    nested={row.ev.k === 'assistant'}
                    repeat={folded.repeats.get(row.id)}
                  />
                ),
              )}
              {working && streamedThinking && settings.showThinking ? <Thinking text={streamedThinking} show live /> : null}
              {working && streamed ? (
                <div className="work-update activity-note live" data-block="progress" role="note" aria-label="Current progress">
                  <div className="msg-body"><Markdown text={streamed} /></div>
                </div>
              ) : null}
              <TurnNotices
                events={work.notices}
                showCost={settings.showCost}
                cwd={session.cwd}
                sessionId={session.id}
                results={results}
              />
            </div>
            ) : null}
          </div>
        </div>
        </div>

        {/* Whatever went wrong, outside the fold and above the reply: it is the
            answer to the turn as much as any prose would have been. */}
        {failures.map((row) => (
          <ErrorCard key={row.id} ev={row.ev as Extract<TimelineEvent, { k: 'error' }>} searchKey={row.id} />
        ))}

        {/* Collapsed or expanded, running or long finished: what the agent said
            to the user is always here, under the work, without a click — every
            message of the turn in the order it came, the earlier cycles' first
            and the reply last, each one marked with when it arrived.

            One block, however many messages: three consecutive replies each
            drawn as their own slab is what made one turn read as three
            unrelated events. Output in flight is not the answer, and the two
            must never look alike: while the turn works, its prose streams
            inside the work as progress, and only a settled turn's block is the
            answer. */}
        {outputs.length ? (
          <div
            className={`msg-assistant turn-output${working ? '' : ' answer final'}`}
            data-block={working ? 'output' : 'reply'}
            aria-label={working ? 'Messages so far' : 'Reply'}
            data-reading-id={outputs[0]!.key}
          >
            {outputs.map((part, position) => (
              <div className="output-part" key={part.key} data-reading-id={position ? part.key : undefined} data-search-id={part.key}>
                {position ? (
                  <div className="output-sep" aria-hidden="true">
                    {part.at === null ? null : <span className="mono">{clock(part.at)}</span>}
                  </div>
                ) : null}
                <div className="msg-body">
                  <Markdown text={part.text} />
                </div>
              </div>
            ))}
            {/* Same clock as the prompt above it, so the two sides of a turn line
                up. */}
            {working || answerAt === null ? null : (
              <div className="msg-actions">
                <span className="mono">{clock(answerAt)}</span>
                <CopyButton text={outputText} />
              </div>
            )}
          </div>
        ) : null}

        {/* The one moving thing, at the bottom: what the turn is doing now and
            for how long, after the latest thing it said. Gone the moment it
            settles. */}
        {working ? (
          <div className="turn-live" role="status">
            <ThinkingIndicator
              activity={
                starting
                  ? 'working'
                  : record?.phase === 'waiting_agents'
                    ? 'delegating'
                    : activityOf(turn.rows, { ...buffer, running: sessionLive })
              }
              label={starting ? 'Starting the harness' : undefined}
            />
            <ElapsedClock since={startedAt} />
          </div>
        ) : null}
      </div>
    </section>
    </RevealContext.Provider>
  )
}

// Metrics arrive several times per second. They change the composer meter, not
// a finished transcript turn; repainting a long session for every tick makes
// the browser work harder than the harness. Live sidechains still repaint.
const MemoTurnView = memo(TurnView, (previous, next) =>
  previous.turn === next.turn &&
  previous.index === next.index &&
  previous.isLast === next.isLast &&
  previous.expanded === next.expanded &&
  previous.searchTarget === next.searchTarget &&
  previous.reveal === next.reveal &&
  previous.settings === next.settings &&
  previous.session.id === next.session.id &&
  previous.session.cwd === next.session.cwd &&
  previous.session.status === next.session.status &&
  previous.record === next.record &&
  (!previous.isLast && !anyAgentRunning(previous.turn.rows, true) || previous.live === next.live),
)

/** "9s", "1:24", "2:07:31" — a clock, so a long turn stays one glance wide. */
function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const pad = (value: number) => String(value).padStart(2, '0')
  const minutes = Math.floor(seconds / 60) % 60
  const hours = Math.floor(seconds / 3600)
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}` : `${minutes}:${pad(seconds % 60)}`
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`
}

/* ------------------------------------------------------------------ */
/* Transcript                                                          */
/* ------------------------------------------------------------------ */

/**
 * The blocks a reading position is held by (see `takeAnchor`).
 *
 * Never a header that can be pinned: a sticky row is always "in view" while
 * its section is, so it would anchor nothing. Those are an open turn's header,
 * an open row directly in a turn's work and open Updates; a folded row, and
 * any row nested deeper, never sticks.
 */
/** A search match: which element holds it and which of its matches it is. */
interface SearchMatch {
  turnIndex: number
  reveal: Reveal
  occurrence: number
  text: string
  at: number
}

type HighlightRegistry = { set: (name: string, value: unknown) => void; delete: (name: string) => void }
function highlightRegistry(): HighlightRegistry | undefined {
  return (CSS as typeof CSS & { highlights?: HighlightRegistry }).highlights
}

/** Each session's hand-opened and hand-closed turns, across remounts (see `Transcript`). */
const collapsedBySession = new Map<string, Record<string, boolean>>()

const READING_MARKS = [
  '.turn > .msg-user',
  '.turn-work:not(.open) > .turn-head',
  '[data-reading-id]',
  '.turn-body > .wi:not(.open) > .wr',
  '.wi .wi > .wr',
].join(', ')

export function Transcript({
  session,
  events,
  live: givenLive,
  foldFinished = true,
  settings,
  connected,
  onFileStats,
}: {
  session: SessionSummary
  events: SessionEvent[]
  /** Only for the gallery, which renders fixtures instead of the store. */
  live?: Record<string, LiveBuffer>
  /**
   * Off only in the gallery, which exists to show every surface of a finished
   * turn at once; the app always folds a settled turn's work away.
   */
  foldFinished?: boolean
  settings: UiSettings
  connected: boolean
  onFileStats?: (count: number) => void
}) {
  // Streaming buffers are read here rather than passed down: the app shell does
  // not re-render for a token (see `shellState`), the transcript does.
  const storeLive = useStore((s) => s.live)
  // The server's turn ledger for this session: the state of every turn it knows.
  const ledger = useStore((s) => s.turns[session.id])
  const live = givenLive ?? storeLive
  const scroller = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(true)
  // The transcript remounts for each session (App keys it), so the turns a
  // reader opened or closed by hand are kept here, not in the component.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => collapsedBySession.get(session.id) ?? {})
  useEffect(() => {
    collapsedBySession.set(session.id, collapsed)
  }, [session.id, collapsed])
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchIndex, setSearchIndex] = useState(0)
  const searchInput = useRef<HTMLInputElement>(null)

  // What each call came back with, the file it wrote, how a background command
  // ended. Unchanged entries keep their objects (see `toolFacts`).
  const lastFacts = useRef<Map<string, ToolFacts> | undefined>(undefined)
  const results = useMemo(() => {
    const next = toolFacts(events, lastFacts.current)
    lastFacts.current = next
    return next
  }, [events])

  // Paths in the transcript open with the Mac's default app — only on the Mac
  // itself, and only for a session whose files are on this machine.
  const local = isLocalPage()
  const touchedKey = useMemo(() => touchedFiles(events, session.cwd).join('\n'), [events, session.cwd])
  const fileLinks = useMemo<FileLinks>(() => ({
    cwd: session.cwd,
    touched: touchedKey ? touchedKey.split('\n') : [],
    open: local && !session.host ? (path) => void openSessionFile(session.id, path) : null,
  }), [session.cwd, session.id, session.host, touchedKey, local])

  // `live` comes from the session, not from the events: a stopped session can
  // still hold a turn that never got its `result`, and that turn must not look
  // like it is still working.
  const sessionLive = session.status === 'running' || session.status === 'starting'
  // A "Not sent" prompt the user took back into the composer is not drawn again.
  const editedPrompts = useStore((s) => s.editedPrompts)
  const visibleEvents = useMemo(
    () => (events.some((event) => editedPrompts[event.id]) ? events.filter((event) => !editedPrompts[event.id]) : events),
    [events, editedPrompts],
  )
  // Finished turns keep their object identity across rebuilds (see `reuseTurns`),
  // so one new event repaints the turn it landed in rather than the whole thread.
  const previousTurns = useRef<{ turns: Turn[]; results: Map<string, ToolFacts> }>({ turns: [], results })
  const turns = useMemo<Turn[]>(() => {
    const before = previousTurns.current
    const next = reuseTurns(before.turns, buildTurns(buildRows(visibleEvents), { live: sessionLive }), {
      before: before.results,
      after: results,
    })
    previousTurns.current = { turns: next, results }
    return next
  }, [visibleEvents, sessionLive, results])
  // Search reads the turns rather than the page (see `searchTargets`), so a
  // match inside folded work is found and counted like any other.
  const needle = useDeferredValue(searchQuery).trim().toLocaleLowerCase()
  const targets = useMemo(
    () => (searchOpen ? searchTargets(turns, results, settings.showThinking) : []),
    [searchOpen, turns, results, settings.showThinking],
  )
  const matches = useMemo<SearchMatch[]>(() => {
    if (!needle) return []
    const found: SearchMatch[] = []
    for (const target of targets) {
      const lower = target.text.toLocaleLowerCase()
      // One reveal per element, shared by its matches: moving between two
      // matches in the same block re-renders nothing.
      let reveal: Reveal | null = null
      for (let at = lower.indexOf(needle), occurrence = 0; at >= 0; at = lower.indexOf(needle, at + needle.length), occurrence += 1) {
        reveal ??= { key: target.key, agents: target.agents, needle }
        found.push({ turnIndex: target.turnIndex, reveal, occurrence, text: target.text, at })
      }
    }
    return found
  }, [targets, needle])
  const currentMatch = searchOpen && matches.length ? matches[Math.min(searchIndex, matches.length - 1)] : undefined

  useEffect(() => {
    if (searchOpen) searchInput.current?.focus()
  }, [searchOpen])

  useEffect(() => {
    const onFind = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        setSearchOpen(true)
        searchInput.current?.select()
      }
    }
    window.addEventListener('keydown', onFind)
    return () => window.removeEventListener('keydown', onFind)
  }, [])

  // New words start from where the reader is, the way a browser's find does:
  // the first match in the first turn on screen or below it.
  useEffect(() => {
    if (!needle) return
    const node = scroller.current
    let first = 0
    if (node) {
      const top = node.getBoundingClientRect().top
      const section = Array.from(node.querySelectorAll<HTMLElement>('.turn[data-index]'))
        .find((item) => item.getBoundingClientRect().bottom > top)
      first = Number(section?.dataset.index ?? 0)
    }
    const index = matches.findIndex((match) => match.turnIndex >= first)
    setSearchIndex(index < 0 ? 0 : index)
    // Only a new word picks a new start; the thread growing keeps the current one.
  }, [needle])

  const goToMatch = (index: number) => {
    if (!matches.length) return
    setSearchIndex((index + matches.length) % matches.length)
  }

  /**
   * Every match on screen painted, the current one painted stronger and brought
   * to the middle of the view.
   *
   * Painting is the CSS Custom Highlight API: ranges over the text as it is,
   * with no element added, so the markdown and the reading anchors are left
   * alone. It runs again as the folds it opened finish moving (they animate
   * for 200ms) and whenever the thread changes, but it only scrolls when the
   * current match itself changed — new output streaming in must not keep
   * pulling the view back to it.
   */
  const scrolledTo = useRef('')
  useEffect(() => {
    const registry = highlightRegistry()
    const clear = () => {
      registry?.delete('sedano-search')
      registry?.delete('sedano-search-current')
    }
    const node = scroller.current
    if (!searchOpen || !needle || !node) {
      clear()
      scrolledTo.current = ''
      return clear
    }
    const target = currentMatch ? `${currentMatch.reveal.key}#${currentMatch.occurrence}` : ''
    const moved = target !== scrolledTo.current
    scrolledTo.current = target
    if (moved && currentMatch) {
      // Going to a match is leaving the bottom: nothing may pull the view back.
      settling.current = false
      pinnedNow.current = false
      setPinned(false)
    }
    const paint = (scroll: boolean) => {
      const all: Range[] = []
      const mine: Range[] = []
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
      let textNode: Node | null
      while ((textNode = walker.nextNode())) {
        const parent = textNode.parentElement
        const lower = (textNode.textContent ?? '').toLocaleLowerCase()
        if (!parent || !lower.includes(needle) || parent.closest('.turn-fold:not(.open)')) continue
        const owner = parent.closest<HTMLElement>('[data-search-id]')?.dataset.searchId
        for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + needle.length)) {
          const range = document.createRange()
          range.setStart(textNode, at)
          range.setEnd(textNode, at + needle.length)
          all.push(range)
          if (currentMatch && owner === currentMatch.reveal.key) mine.push(range)
        }
      }
      // The page draws a block's text a little differently from its source
      // (markdown, a preview line), so the nth match is taken as near as it goes.
      const current = currentMatch ? mine[Math.min(currentMatch.occurrence, mine.length - 1)] : undefined
      const Highlight = (window as Window & { Highlight?: new (...ranges: Range[]) => { priority: number } }).Highlight
      if (registry && Highlight) {
        registry.set('sedano-search', new Highlight(...all.filter((range) => range !== current)))
        const strong = new Highlight(...(current ? [current] : []))
        strong.priority = 1
        registry.set('sedano-search-current', strong)
      }
      if (!scroll || !current) return
      const rect = current.getBoundingClientRect()
      const box = node.getBoundingClientRect()
      const drift = rect.top - box.top - (node.clientHeight - rect.height) / 2
      if (Math.abs(drift) < 1) return
      node.scrollTop += drift
      // Our own scroll: not a reading position to hold (see `takeAnchor`).
      anchor.current = null
      ownScroll.current = node.scrollTop
    }
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => paint(moved))
    })
    const timers = [120, 260, 450].map((ms) => setTimeout(() => paint(moved), ms))
    return () => {
      cancelAnimationFrame(frame)
      timers.forEach(clearTimeout)
    }
  }, [searchOpen, needle, currentMatch?.reveal, currentMatch?.occurrence, turns, collapsed])
  useEffect(() => () => {
    highlightRegistry()?.delete('sedano-search')
    highlightRegistry()?.delete('sedano-search-current')
  }, [])
  const closeSearch = () => {
    setSearchOpen(false)
    setSearchQuery('')
  }
  const fileCount = useMemo(
    () => turns.reduce((sum, turn) => sum + turn.stats.files.length, 0),
    [turns],
  )
  // Rebuilt with the turns, never per streamed token, so the strip stays still.
  const prompts = useMemo<MinimapPrompt[]>(
    () => turns.flatMap((turn) => (turn.user ? [{ key: turn.id, text: turn.user.text }] : [])),
    [turns],
  )
  const liveText = live[`${session.id}:main`]?.text ?? ''
  const liveThinking = live[`${session.id}:main`]?.thinking ?? ''

  /**
   * Which turns fold their work away by default.
   *
   * A turn is open while it works and folds the moment it settles — and one
   * loaded already finished starts folded — so what is left is the prompt and
   * the answer: the work is what you watch, the reply is what you read. A
   * failure folds too, because its error sits outside the fold. A turn that
   * ended with nothing to read stays open rather than folding into an empty
   * header. Manual toggles (`collapsed`) always win, so a turn you opened by
   * hand stays open.
   */
  const folds = useMemo(() => {
    const map = new Map<string, boolean>()
    turns.forEach((turn, index) => {
      const state = stateOf(turn, recordOf(ledger, turn), sessionLive)
      if (state === 'working') return
      const compact = settings.compactTurns && index < turns.length - 1
      if (compact || (foldFinished && (state === 'failed' || turnHasReply(turn)))) map.set(turn.id, true)
    })
    return map
  }, [turns, sessionLive, settings.compactTurns, foldFinished, ledger])

  useEffect(() => {
    onFileStats?.(fileCount)
  }, [fileCount, onFileStats])

  useEffect(() => {
    if (pinned) followBottom()
  }, [events.length, turns.length, liveText, liveThinking, pinned])

  // Sending a prompt is asking to watch the answer: the view goes to the
  // bottom and follows it, wherever it was scrolled to before.
  const lastPrompt = useMemo(() => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]!
      if (event.ev.k === 'user' && !event.agentId) return event.id
    }
    return null
  }, [events])
  const seenPrompt = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    const before = seenPrompt.current
    seenPrompt.current = lastPrompt
    // Not on the first render of a session: opening one is not sending.
    if (before === undefined || before === lastPrompt || lastPrompt === null) return
    pinnedNow.current = true
    setPinned(true)
    followBottom()
  }, [lastPrompt])
  // A different session is a fresh start for that question.
  useEffect(() => {
    seenPrompt.current = undefined
  }, [session.id])

  /**
   * Whether the view is at the bottom of the thread — which is also the only
   * reason the jump control exists.
   *
   * It is a reading of the geometry, so it has to be taken whenever the geometry
   * moves, not only when the user scrolls. Expanding a "Worked for Ns" block adds
   * height and summons the control, and collapsing it takes that height straight
   * back out — but no scroll event follows a fold closing, so the control stayed
   * on screen offering to jump down to nothing.
   */
  const measure = () => {
    const node = scroller.current
    if (!node) return
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 60
    pinnedNow.current = atBottom
    setPinned(atBottom)
  }

  /**
   * What you are reading, held still while the thread changes height.
   *
   * A turn folding its work away when it settles takes height out of the
   * thread, and when that fold is above the part you are reading, everything
   * under it slid up. Chrome anchors scrolling on its own; WebKit does not, so
   * the first landmark in view (a prompt, a turn header, a reply) is remembered
   * on scroll and put back where it was after a resize. Pinned to the bottom
   * needs none of this: the bottom is the anchor, and it holds by itself.
   */
  const pinnedNow = useRef(true)
  const followBottom = () => {
    const node = scroller.current
    if (node) node.scrollTop = node.scrollHeight
  }
  /**
   * Opening a session lands on its latest message, and stays there until the
   * reader does something.
   *
   * The thread lays itself out after it mounts — markdown, code blocks, images
   * arriving — and a scroll event read in the middle of that could look like
   * the reader leaving the bottom, which unpinned the view and left an old
   * session opened at its top. Until the first wheel, touch, click or key
   * inside the transcript, the thread growing takes the view back to the
   * bottom whatever a scroll event made of it (see the observer below).
   */
  const settling = useRef(true)
  const wrap = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const node = wrap.current
    if (!node) return
    const release = () => { settling.current = false }
    const kinds = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const
    for (const kind of kinds) node.addEventListener(kind, release, { passive: true })
    return () => {
      for (const kind of kinds) node.removeEventListener(kind, release)
    }
  }, [])
  /**
   * A scroll event read while the view follows the bottom can be stale: the
   * browser clamps after a fold shrinks the thread, or our own follow lands a
   * frame after more content arrived, and either reads as "no longer at the
   * bottom". Measured on the spot, that unpinned a view nobody touched and left
   * it parked at the top of the new turn. So a pinned view is only let go once
   * it is *still* away from the bottom two frames later — after the observer
   * below has had its chance to follow. A reader scrolling up is still away.
   */
  const pendingCheck = useRef(0)
  const onScroll = () => {
    const node = scroller.current
    if (!node) return
    const away = node.scrollHeight - node.scrollTop - node.clientHeight >= 60
    if (!pinnedNow.current || !away) {
      measure()
      takeAnchor()
      return
    }
    if (pendingCheck.current) return
    pendingCheck.current = requestAnimationFrame(() => {
      pendingCheck.current = requestAnimationFrame(() => {
        pendingCheck.current = 0
        measure()
        takeAnchor()
      })
    })
  }
  const anchor = useRef<{ node: HTMLElement; top: number; id?: string } | null>(null)
  /**
   * A row about to open or close is where the reader is: hold it there.
   *
   * Opening or closing something is taking the view in hand, so the view stops
   * following the bottom (it picks the bottom up again by itself if that is
   * still where it is, see `measure`). Then the row is the anchor: collapsing a
   * section whose pinned header sits at the top of the view leaves that header
   * where it is, with what came after the section right under it, instead of
   * jumping to wherever the section began.
   */
  const holdRow = useMemo(() => (row: HTMLElement) => {
    const node = scroller.current
    if (!node || !node.contains(row)) return
    settling.current = false
    pinnedNow.current = false
    ownScroll.current = null
    anchor.current = { node: row, top: row.getBoundingClientRect().top - node.getBoundingClientRect().top }
  }, [])
  // The scroll this component made itself, whose event must not re-anchor: it
  // lands a frame later, mid-fold, and would record where the text was sliding.
  const ownScroll = useRef<number | null>(null)
  const takeAnchor = () => {
    const node = scroller.current
    if (node && ownScroll.current !== null && Math.abs(node.scrollTop - ownScroll.current) < 1) return
    ownScroll.current = null
    if (!node || pinnedNow.current) {
      anchor.current = null
      return
    }
    const viewTop = node.getBoundingClientRect().top
    const marks = Array.from(node.querySelectorAll<HTMLElement>(READING_MARKS))
    // Document order is top-to-bottom order, so the first one in view is a search.
    let low = 0
    let high = marks.length - 1
    let found: HTMLElement | null = null
    while (low <= high) {
      const middle = (low + high) >> 1
      if (marks[middle]!.getBoundingClientRect().top - viewTop >= 0) {
        found = marks[middle]!
        high = middle - 1
      } else {
        low = middle + 1
      }
    }
    anchor.current = found
      ? { node: found, top: found.getBoundingClientRect().top - viewTop, id: found.dataset.readingId }
      : null
  }
  const holdAnchor = () => {
    const node = scroller.current
    const held = anchor.current
    if (!node || !held || pinnedNow.current) return
    // A message that was work while the turn ran becomes its reply when it
    // settles: same id, a new block outside the fold that is closing. Follow it
    // there, or the text you were reading slides up with the fold.
    const moved = held.id
      ? Array.from(node.querySelectorAll<HTMLElement>(`[data-reading-id="${CSS.escape(held.id)}"]`))
        .find((item) => !item.closest('.turn-fold:not(.open)'))
      : undefined
    const target = moved ?? held.node
    // Something that is itself folding away has no place left to be held at.
    if (!target.isConnected || target.closest('.turn-fold:not(.open)')) return
    const drift = target.getBoundingClientRect().top - node.getBoundingClientRect().top - held.top
    if (Math.abs(drift) < 1) return
    node.scrollTop += drift
    ownScroll.current = node.scrollTop
  }

  // Anything that changes the height of the thread — a fold opening or closing,
  // a card expanding, a diff rendering, the window resizing — resizes the
  // content box, and that is exactly the question being asked. One observer on
  // the thread and one on the scroller catch all of it without any component
  // having to remember to report.
  const thread = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const content = thread.current
    const node = scroller.current
    if (!content || !node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      // Only the thread growing: the scroller itself resizes when the jump row
      // comes and goes, which is a consequence of leaving the bottom, not layout.
      if (settling.current && entries.some((entry) => entry.target === content)) {
        pinnedNow.current = true
        setPinned(true)
        followBottom()
        return
      }
      // Following the bottom is a decision only the reader unmakes (by
      // scrolling up). Content growing under a pinned view — a prompt just
      // sent, a tool run, a reply — used to be *measured* as "no longer at the
      // bottom" before the pin could follow it, which unpinned the view and
      // left it parked at the top of the new turn while the answer streamed
      // below. So a pinned view is simply taken to the new bottom.
      if (pinnedNow.current) {
        followBottom()
        return
      }
      holdAnchor()
      measure()
    })
    observer.observe(content)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return (
    <div className="transcript-wrap" data-search-open={searchOpen} ref={wrap}>
      <div className="transcript-search">
        {searchOpen ? (
          <div className="transcript-search-box" role="search">
            <IconSearch size={15} />
            <input
              ref={searchInput}
              type="search"
              aria-label="Search this conversation"
              placeholder="Search conversation"
              value={searchQuery}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') closeSearch()
                if (event.key === 'Enter') {
                  event.preventDefault()
                  goToMatch(searchIndex + (event.shiftKey ? -1 : 1))
                }
              }}
            />
            <span className="transcript-search-count">{needle ? `${matches.length ? Math.min(searchIndex, matches.length - 1) + 1 : 0}/${matches.length}` : ''}</span>
            <button type="button" aria-label="Previous match" disabled={!matches.length} onClick={() => goToMatch(searchIndex - 1)}><IconChevronUp size={15} /></button>
            <button type="button" aria-label="Next match" disabled={!matches.length} onClick={() => goToMatch(searchIndex + 1)}><IconCaret size={15} /></button>
            <button type="button" className="search-close" aria-label="Close search" onClick={closeSearch}><IconClose size={13} /></button>
          </div>
        ) : (
          <button type="button" className="transcript-search-toggle" title="Search this conversation (⌘F)" aria-label="Search this conversation" onClick={() => setSearchOpen(true)}><IconSearch size={16} /></button>
        )}
      </div>
      {currentMatch ? (
        <div className="transcript-search-preview" role="status">
          Turn {currentMatch.turnIndex + 1} · {currentMatch.text.slice(Math.max(0, currentMatch.at - 48), currentMatch.at + needle.length + 72).replace(/\s+/g, ' ').trim()}
        </div>
      ) : null}
      <div className="transcript" ref={scroller} onScroll={onScroll}>
        <HoldContext.Provider value={holdRow}><FileLinksContext.Provider value={fileLinks}>
        <div className="thread" ref={thread}>
          {turns.length === 0 ? (
            <div className="session-start">
              {!connected ? (
                <>
                  <span className="dot idle" />
                  <span>Not Connected — The Server Is Not Running</span>
                </>
              ) : session.status === 'starting' ? (
                <ThinkingIndicator activity="working" label="Starting the harness" />
              ) : (
                <>
                  <span className={`dot ${session.status === 'running' ? 'running' : 'idle'}`} />
                  <span>Session Ready — Send A Message To Begin</span>
                </>
              )}
            </div>
          ) : null}
          {turns.map((turn, index) => {
            const isLast = index === turns.length - 1
            const defaultExpanded = !folds.get(turn.id)
            const expanded = collapsed[turn.id] === undefined ? defaultExpanded : !collapsed[turn.id]
            return (
              <Boundary key={turn.id} label={`Turn ${index + 1}`} scope="turn" resetKey={turn}>
              <MemoTurnView
                turn={turn}
                index={index}
                isLast={isLast}
                session={session}
                live={live}
                settings={settings}
                results={results}
                expanded={expanded}
                searchTarget={currentMatch?.turnIndex === index}
                reveal={currentMatch?.turnIndex === index ? currentMatch.reveal : null}
                record={recordOf(ledger, turn)}
                onToggle={(shown) => setCollapsed((prev) => ({ ...prev, [turn.id]: shown }))}
              />
              </Boundary>
            )
          })}
        </div>
        </FileLinksContext.Provider></HoldContext.Provider>
      </div>
      <PromptMinimap prompts={prompts} scroller={scroller} thread={thread} />
      {/* The jump control is a row of its own under the scroller, not a pill
          floating over it: parked on top of the transcript it sat squarely on
          whatever line happened to be at the bottom of the view. A strip that
          takes its own space cannot overlap anything by construction. */}
      {!pinned ? (
        <div className="jump">
          <button
            className="ghost"
            onClick={() => {
              pinnedNow.current = true
              setPinned(true)
              followBottom()
            }}
          >
            ↓ latest
          </button>
        </div>
      ) : null}
    </div>
  )
}

export type { Row }
