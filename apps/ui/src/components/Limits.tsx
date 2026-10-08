import { useLayoutEffect, useRef, type ReactNode } from 'react'
import type { HarnessId, LimitSnapshot } from '@shared'
import { HARNESS_LABEL } from '@shared'
import { refreshLimits } from '../store.ts'
import { MenuTrigger } from './Menu.tsx'
import type { IconProps } from './Icons.tsx'
import {
  IconAgent,
  IconCaret,
  IconClaude,
  IconCodex,
  IconCommand,
  IconFreebuff,
  IconGemini,
  IconGrok,
  IconOpencode,
  IconTerminal,
} from './Icons.tsx'
import '../limits.css'

/**
 * The subscription limits readout.
 *
 * The bar used to print every harness it knew about as one unbroken run of
 * words — `63% Codex No Credits Opencode — Cmd 5h` — so there was no telling
 * where one harness ended and the next began, and the three that had nothing to
 * say took up as much room as the one that was out of credits. This file answers
 * one question at a glance: **is anything about to run out?** Everything else —
 * the second window, the reset time, the spend of a pay-per-use harness, the
 * reason a harness reports nothing — lives in the panel one click away.
 *
 * Nothing here branches on a harness by name. Every decision is read off the
 * shared domain (`LimitSnapshot.windows`, `.error`, `.note`, `.credits`), so a
 * harness added tomorrow is classified by what it reports, not by an entry in a
 * table nobody remembers to update.
 */

/**
 * What a snapshot actually says, as one word.
 *
 * The three that matter are the three that must never look alike: a quota that
 * is spent, a reading we are still waiting for, and a harness that has nothing
 * to report at all. The last one is an absence, and an absence is drawn by
 * drawing nothing.
 */
export type LimitState =
  | 'exhausted' // a reported quota is spent — the one thing worth interrupting a glance for
  | 'tight' // reported, and close enough to the ceiling to plan around
  | 'healthy' // reported, with room left
  | 'unreadable' // we tried to read and could not: unknown, which is not zero
  | 'waiting' // the harness is known, the reading has not arrived yet
  | 'metered' // no quota exists: it bills your own keys, so nothing can run out
  | 'silent' // nothing to read and nothing to report
  | 'off' // reading it is switched off in Settings: unknown, which is not zero

export interface LimitReading {
  harness: HarnessId
  state: LimitState
  /** The window closest to its ceiling — the one that decides the state. */
  worst: LimitSnapshot['windows'][number] | null
  /** Three words for the bar. Empty when the number speaks for itself. */
  tag: string
  /** The full sentence, for the tooltip — never for the bar. */
  detail: string
  /** Whether this reading belongs in the always-visible bar. */
  inBar: boolean
  snapshot: LimitSnapshot
}

/** At what point a window stops being comfortable. */
const TIGHT_PERCENT = 80
/**
 * Vendors report 99.7% for a window that is spent, so an exact 100 would leave
 * an exhausted quota reading as merely "tight".
 */
const FULL_PERCENT = 99

/** Whether an error text says the quota itself is gone, rather than our reading of it. */
function saysExhausted(error: string): boolean {
  const text = error.toLowerCase()
  return (
    text.includes('credits exhausted') ||
    text.includes('credits_depleted') ||
    text.includes('credits depleted') ||
    text.includes('rate limit reached') ||
    text.includes('rate limit exceeded') ||
    text.includes('limit_reached')
  )
}

/** Whether an error text is about credit balance specifically. */
function saysCredits(error: string): boolean {
  const text = error.toLowerCase()
  return text.includes('credit')
}

/**
 * Why there is no number, in as few words as the number it replaces.
 *
 * The panel used to explain each absence in a sentence, which is the wrong
 * shape for a readout you glance at. Each case is a tag; the sentence it came
 * from stays in `detail` for the tooltip, where it costs nothing to keep.
 */
function readFailure(error: string): { tag: string; detail: string } {
  const text = error.toLowerCase()
  if (text.includes('429') || text.includes('rate limited') || text.includes('throttl'))
    return {
      tag: 'Read Throttled',
      detail: `The usage endpoint throttled our reading, so the numbers below may be stale. The subscription itself is not blocked. (${error})`,
    }
  if (text.includes('no oauth token') || text.includes('unauthor') || text.includes('sign in'))
    return {
      tag: 'Sign In To Read',
      detail: `No credentials on this machine for reading usage, so there is no number to show — not a number of zero. (${error})`,
    }
  return { tag: 'Cannot Read', detail: `The usage reading failed: ${error}` }
}

/**
 * Classify one snapshot.
 *
 * Order matters: a reported window is the strongest evidence there is, so it
 * decides even when an error is also attached (a throttled *reading* does not
 * erase the numbers we already hold).
 */
export function readLimit(snapshot: LimitSnapshot): LimitReading {
  const worst = snapshot.windows.reduce<LimitSnapshot['windows'][number] | null>(
    (found, window) => (!found || window.usedPercent > found.usedPercent ? window : found),
    null,
  )
  const base = { harness: snapshot.harness, worst, snapshot }

  if (worst) {
    const spent = worst.usedPercent >= FULL_PERCENT || (snapshot.error ? saysExhausted(snapshot.error) : false)
    if (spent)
      return {
        ...base,
        state: 'exhausted',
        tag: snapshot.error && saysCredits(snapshot.error) ? 'Out Of Credits' : 'Limit Reached',
        detail: snapshot.error
          ? `${HARNESS_LABEL[snapshot.harness]} reports: ${snapshot.error}. It will refuse work until the balance is topped up or the window resets.`
          : `The ${worst.label} window is used up. It frees again ${resetPhrase(worst.resetsAt)}.`,
        inBar: true,
      }
    const tight = worst.usedPercent >= TIGHT_PERCENT
    return {
      ...base,
      state: tight ? 'tight' : 'healthy',
      tag: '',
      detail: `${worst.usedPercent.toFixed(0)}% of the ${worst.label} window used, ${(100 - worst.usedPercent).toFixed(0)}% left. Resets ${resetPhrase(worst.resetsAt)}.`,
      inBar: true,
    }
  }

  // Switched off by the person: there is no number because nobody asked for
  // one, and the bar says so rather than leaving a gap that reads as "fine".
  if (snapshot.off)
    return {
      ...base,
      state: 'off',
      tag: 'Off',
      detail: `Reading ${HARNESS_LABEL[snapshot.harness]}'s usage is off, so there is no number — not a number of zero. Turn it on in Settings › Advanced.`,
      inBar: true,
    }

  if (snapshot.error) {
    if (saysExhausted(snapshot.error))
      return {
        ...base,
        state: 'exhausted',
        tag: saysCredits(snapshot.error) ? 'Out Of Credits' : 'Limit Reached',
        detail: `${HARNESS_LABEL[snapshot.harness]} reports: ${snapshot.error}. This is a quota that has been spent, not a subscription that is missing — it will refuse work until the balance is topped up or the window resets.`,
        inBar: true,
      }
    const failure = readFailure(snapshot.error)
    return { ...base, state: 'unreadable', tag: failure.tag, detail: failure.detail, inBar: true }
  }

  // A note is the harness explaining, in its own words, that there is nothing to
  // read. That is an absence, and an absence earns no room in the bar.
  if (snapshot.note) return { ...base, state: 'silent', tag: '', detail: snapshot.note, inBar: false }

  // No window, no failure, but a plan and a balance: this harness bills your own
  // keys, so there is a reading (what you have spent) and no quota to run out.
  const spend = snapshot.credits
  if (snapshot.plan || (spend && (spend.hasCredits || spend.unlimited)))
    return {
      ...base,
      state: 'metered',
      tag: '',
      detail: 'This harness bills your own provider keys, so there is no subscription window to run out of — only what you have spent.',
      inBar: false,
    }

  return {
    ...base,
    state: 'waiting',
    tag: 'Reading…',
    detail: 'The usage reading has not come back yet. This is an unknown, not a zero.',
    inBar: true,
  }
}

/** The worst first, so the left edge of the bar is always the thing to worry about. */
const SEVERITY: Record<LimitState, number> = {
  exhausted: 0,
  tight: 1,
  healthy: 2,
  unreadable: 3,
  waiting: 4,
  metered: 5,
  off: 6,
  silent: 7,
}

export function readLimits(limits: LimitSnapshot[]): LimitReading[] {
  return limits
    .map(readLimit)
    .map((reading, index) => ({ reading, index }))
    .sort((a, b) =>
      SEVERITY[a.reading.state] - SEVERITY[b.reading.state] || a.index - b.index,
    )
    .map((entry) => entry.reading)
}

/**
 * The order the panel's sections keep — fixed, and deliberately not the bar's.
 *
 * Severity is the right order for a row you glance at: the worst thing is at
 * the left edge where the eye lands. It is the wrong order for a list you read,
 * because severity *changes*. A harness whose reading lands while the panel is
 * open goes from "waiting" to "healthy", and under a severity sort that means
 * the row jumps two places and drags every row after it along — the panel
 * rearranging itself under the pointer. Sections therefore sit in the domain's
 * own harness order, which nothing that arrives can change.
 *
 * The server's array order is no help here: `currentLimits` moves a harness to
 * the front when it reports live and appends the ones with nothing to say, so
 * the incoming order is different from one poll to the next.
 */
const PANEL_ORDER = Object.keys(HARNESS_LABEL) as HarnessId[]

/** Rank in the fixed order; anything unheard-of sorts last rather than first. */
function panelRank(harness: HarnessId): number {
  const at = PANEL_ORDER.indexOf(harness)
  return at < 0 ? PANEL_ORDER.length : at
}

/** Every reading, in the order the panel keeps. */
export function panelReadings(limits: LimitSnapshot[]): LimitReading[] {
  return readLimits(limits).sort((a, b) => panelRank(a.harness) - panelRank(b.harness))
}

/** How long until a window frees up, in a word. */
export function resetHint(resetsAt: number | null): string {
  if (!resetsAt) return ''
  const diff = resetsAt - Date.now()
  if (diff <= 0) return 'Resetting'
  const minutes = Math.round(diff / 60_000)
  if (minutes < 60) return `${minutes}m`
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`
  return `${Math.round(minutes / 1440)}d`
}

/** The same value as a phrase, for the sentences that only tooltips carry. */
function resetPhrase(resetsAt: number | null): string {
  const hint = resetHint(resetsAt)
  if (!hint) return 'at a time this harness did not report'
  return hint === 'Resetting' ? 'now' : `in ${hint}`
}

/** Short names, because the bar is a row and not a column. */
const SHORT_HARNESS: Record<HarnessId, string> = {
  claude: 'Claude',
  commandcode: 'Cmd',
  codex: 'Codex',
  gemini: 'Gemini',
  grok: 'Grok',
  opencode: 'Opencode',
  freebuff: 'Freebuff',
  shell: 'Shell',
}

/** How long ago the freshest of these readings was taken, in a word. */
export function readingAge(limits: LimitSnapshot[]): string {
  const newest = Math.max(...limits.map((snapshot) => snapshot.updatedAt))
  if (!Number.isFinite(newest) || newest <= 0) return 'just now'
  const minutes = Math.round((Date.now() - newest) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.round(minutes / 60)}h ago`
}

/**
 * The mark that goes with a harness. The rail has its own copy for session
 * cards; this one is coloured by the limit's state, which is what turns three
 * chips in a row into three obviously separate things.
 */
const MARKS: Record<HarnessId, (p: IconProps) => ReactNode> = {
  claude: IconClaude,
  codex: IconCodex,
  commandcode: IconCommand,
  gemini: IconGemini,
  grok: IconGrok,
  opencode: IconOpencode,
  freebuff: IconFreebuff,
  shell: IconTerminal,
}

/** One harness in the bar: its mark, its name, and the one number that matters. */
function LimitChip({ reading }: { reading: LimitReading }) {
  const { snapshot, worst, state } = reading
  const stale = Date.now() - snapshot.updatedAt > 5 * 60_000
  const Mark = MARKS[snapshot.harness] ?? IconAgent
  return (
    <span className={`limit-chip ${state}`} title={`${HARNESS_LABEL[snapshot.harness]} · ${reading.detail}`}>
      <Mark size={12} className="limit-mark" />
      <span className="limit-name">{SHORT_HARNESS[snapshot.harness]}</span>
      {/* A percentage or a tag, never both: the number is the reading when
          there is one, and the tag is what stands in for it when there is not. */}
      {reading.tag ? (
        <span className="limit-tag">{reading.tag}</span>
      ) : worst ? (
        <>
          <span className="limit-value">{worst.usedPercent.toFixed(0)}%</span>
          {/* Which window the number is of. A bare percentage is not a reading. */}
          <span className="limit-window">{worst.label}</span>
        </>
      ) : null}
      {/* An old reading is still a reading; it just is not this minute's. */}
      {stale && worst ? <span className="limit-stale">~</span> : null}
    </span>
  )
}

/**
 * How many window rows a harness still waiting for its reading holds open.
 *
 * Every harness in sedano that reports windows at all reports one or two of
 * them, so two is the room a reading needs. This reserves *space*, never a
 * value: the held-open row carries no label, no percentage and no reset time,
 * because inventing any of those is exactly what this readout must not do.
 */
const RESERVED_WINDOW_ROWS = 2

/**
 * The rows a harness gets in the panel, one per slot.
 *
 * `slots` is at least as many rows as the harness has windows, and while the
 * reading is still on its way it is `RESERVED_WINDOW_ROWS` — so the numbers
 * land in space that was already theirs instead of pushing the harnesses below
 * them down the panel.
 */
function WindowRows({ snapshot, slots }: { snapshot: LimitSnapshot; slots: number }) {
  return (
    <>
      {Array.from({ length: slots }, (_unused, index) => {
        const window = snapshot.windows[index]
        if (!window)
          return (
            <div className="menu-meter pending" key={`slot-${index}`} title="This reading has not arrived yet">
              <span className="label" />
              <span className="track" />
              <span className="value" />
            </div>
          )
        return (
          <div className="menu-meter" key={window.label}>
            <span className="label">{window.label}</span>
            <span className="track">
              <span
                className={`fill ${window.usedPercent >= FULL_PERCENT ? 'err' : window.usedPercent >= TIGHT_PERCENT ? 'warn' : ''}`}
                style={{ width: `${Math.max(2, Math.min(100, window.usedPercent))}%` }}
              />
            </span>
            <span className="value">{window.usedPercent.toFixed(0)}%</span>
            <span className="value faint">resets in {resetHint(window.resetsAt) || '?'}</span>
          </div>
        )
      })}
    </>
  )
}

/**
 * One harness's section, which never gets shorter while the panel is open.
 *
 * Reserving window rows covers the shrink we could name in advance. It does not
 * cover the others, and there are others: the `Reading…` line goes away the
 * moment the reading lands, and a harness that stops reporting a plan loses a
 * row — each of them a section quietly losing a line and dragging every row
 * above it up the panel, because a panel that hangs off the status bar grows and
 * shrinks at its top edge. Rather than keep a memo per kind of line, the section
 * keeps a floor: the tallest it has been since the panel opened. Content is
 * still free to change and to grow; it just cannot take back room the eye has
 * already used to place everything else.
 *
 * This renders `.menu-section` itself instead of calling `MenuSection`, which
 * has no way to hand back a ref — and the class has to stay a direct sibling of
 * the next section, because the rule that draws the divider between two of them
 * is an adjacency selector.
 */
function HeldSection({ label, children }: { label: string; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  const floor = useRef(0)
  // After layout, not during: the height being read is the browser's answer, and
  // it is only ever raised. Once `min-height` is set, a shrunken section still
  // measures at the floor, which is exactly what keeps the floor where it is.
  useLayoutEffect(() => {
    const element = box.current
    if (!element) return
    // `offsetHeight`, not the bounding rect. The rect is in screen space, and
    // the popover opens with a keyframe that scales it to 0.995 — so a floor
    // taken on the first frame was half a percent short of the section it was
    // supposed to hold up, and stopped holding the moment the animation ended.
    // `offsetHeight` is the laid-out height, which no transform can touch, and
    // it is already a whole pixel.
    const height = element.offsetHeight
    if (height > floor.current) {
      floor.current = height
      element.style.minHeight = `${height}px`
    }
  })
  return (
    <div className="menu-section" ref={box}>
      <div className="menu-title">{label}</div>
      {children}
    </div>
  )
}

/**
 * The body of the panel — everything inside the popover.
 *
 * It is a component of its own, and that is the whole trick: the popover only
 * renders its children while it is open, so this mounts when the panel opens and
 * is thrown away when it closes. Both memos below therefore last exactly as long
 * as someone is looking at the panel, which is exactly as long as the promise
 * they exist to keep — that nothing moves under the pointer. Reopening the panel
 * builds it again from what the server says now, so neither memo can outlive the
 * reading it was protecting.
 */
function LimitsPanel({ limits, close }: { limits: LimitSnapshot[]; close: () => void }) {
  /**
   * Every harness this panel has shown since it opened, with the last snapshot
   * actually received for it.
   *
   * The server does not send the same set of harnesses every time. The poll
   * publishes only the harnesses it polled, while the ones that answer with a
   * note ("No Usage API") are added by a different code path on a different
   * timer — so a refresh landing under the pointer deletes two whole sections
   * and the panel loses 150px in one frame, dragging every remaining row with
   * it. A section vanishing is not new data; it is the absence of an update.
   * Holding what was already shown keeps the row you are reading where it is,
   * and nothing is invented: each row still carries the last words that harness
   * itself reported. (The root cause is upstream and is reported with this
   * change; this is the panel refusing to rearrange itself over it.)
   */
  const seen = useRef(new Map<HarnessId, LimitSnapshot>())
  /**
   * The most window rows each harness has needed since the panel opened.
   *
   * Reserving two rows for a harness still reading is only half the job: if its
   * answer turns out to be one window, the section would shrink by a row the
   * moment it lands, which moves everything under it just as surely as growing
   * would. Holding the high-water mark means a section's height only ever
   * settles once. It is a memo about layout, not about data — every row it
   * keeps open stays visibly empty until something real is reported for it.
   */
  const reserved = useRef<Partial<Record<HarnessId, number>>>({})
  const slotsFor = (reading: LimitReading): number => {
    const needed = Math.max(
      reading.snapshot.windows.length,
      reading.state === 'waiting' ? RESERVED_WINDOW_ROWS : 0,
    )
    const slots = Math.max(needed, reserved.current[reading.harness] ?? 0)
    reserved.current[reading.harness] = slots
    return slots
  }

  // Fold this poll into what is already on screen. Written during render on
  // purpose: the very render that carries the new numbers has to be the one that
  // draws them, or the panel would flicker through a frame without them.
  for (const snapshot of limits) seen.current.set(snapshot.harness, snapshot)
  // The panel's own order: fixed, so a reading that lands while it is open
  // changes the numbers in a row and never which row they are in.
  const readings = panelReadings([...seen.current.values()])

  return (
    <>
      {readings.map((reading) => (
        <HeldSection key={reading.harness} label={HARNESS_LABEL[reading.harness]}>
          {/* The panel is a reading, not an essay: the plan, one row per
              window, the balance, and — where there is no number — the tag
              that replaced it, with the sentence kept in the tooltip. */}
          {reading.snapshot.plan ? (
            <div className="menu-row">
              <span>Plan</span>
              <span className="spacer" />
              <span className="value">{reading.snapshot.plan}</span>
            </div>
          ) : null}
          <WindowRows snapshot={reading.snapshot} slots={slotsFor(reading)} />
          {reading.snapshot.credits &&
          (reading.snapshot.credits.hasCredits || reading.snapshot.credits.unlimited) ? (
            <div className="menu-row">
              <span>{reading.state === 'metered' ? 'Spent' : 'Credits'}</span>
              <span className="spacer" />
              <span className="value">
                {reading.snapshot.credits.unlimited
                  ? 'Unlimited'
                  : (reading.snapshot.credits.balance ?? 'Available')}
              </span>
            </div>
          ) : null}
          {reading.state === 'silent' ? (
            // The harness's own words for why there is nothing — kept short
            // upstream so it fits where a number would have been.
            <div className="menu-note">{reading.snapshot.note}</div>
          ) : reading.state === 'off' ? (
            <div className="menu-note limit-note off" title={reading.detail}>
              Off — enable in Settings
            </div>
          ) : reading.tag ? (
            <div className={`menu-note limit-note ${reading.state}`} title={reading.detail}>
              {reading.tag}
            </div>
          ) : reading.worst && reading.snapshot.error ? (
            // The numbers are the last good reading; the latest attempt failed.
            <div className="menu-note limit-note" title={readFailure(reading.snapshot.error).detail}>
              Stale · Read {readingAge([reading.snapshot])}
            </div>
          ) : reading.state === 'metered' ? (
            <div className="menu-note" title={reading.detail}>
              No Quota · Billed To Your Keys
            </div>
          ) : null}
        </HeldSection>
      ))}
      {/* What the bars are of, and how old they are. A percentage cannot say
          what it is a percentage *of*, and the reading looked fresher than
          it was; two short lines cover both, which is as much prose as a
          glanceable readout can carry.

          They are two lines and not one on purpose: the age is the only
          text in the panel that rewrites itself while you are looking at
          it, and `just now` and `14m ago` are different widths. Sharing a
          line with the sentence, the pair could wrap differently from one
          reading to the next and change the panel's height for no reason
          anyone could see. On its own line it is far too short to wrap. */}
      <div className="menu-note limit-age">Read {readingAge(limits)}</div>
      <button
        className="menu-item"
        onClick={() => {
          refreshLimits(true)
          close()
        }}
      >
        Refresh now
      </button>
    </>
  )
}

/**
 * Subscription limits.
 *
 * The bar carries only the harnesses that have a quota to run out of. The panel
 * also keeps metered providers with actual spend, but omits disabled harnesses
 * and providers with no subscription or usage reading at all.
 */
export function LimitsGroup({
  limits,
  enabledHarnesses,
}: {
  limits: LimitSnapshot[]
  /** Harnesses enabled in preferences on the machine currently in view. */
  enabledHarnesses?: readonly HarnessId[]
}) {
  const enabled = enabledHarnesses ? new Set(enabledHarnesses) : null
  // A silent provider ("No Usage API") and a blank snapshot still waiting for
  // data carry no subscription or usage information. They used to occupy full
  // sections in the panel — notably Gemini and Grok — despite being disabled or
  // not subscribed. Keep only a real reading, real spend, or real read failure.
  const relevant = limits.filter((snapshot) => {
    if (enabled && !enabled.has(snapshot.harness)) return false
    const state = readLimit(snapshot).state
    return state !== 'silent' && state !== 'waiting'
  })
  if (!relevant.length) return null
  const shown = readLimits(relevant).filter((reading) => reading.inBar)

  return (
    <MenuTrigger
      className="group clickable"
      title="What these numbers mean"
      width={330}
      trigger={(open) => (
        <span className="meters limits-bar">
          {/* The caret opens the row, so it sits at the row's edge. Putting it
              after the word planted a divider in the middle of the bar, as if
              `Limits` were one control and the chips after it were another —
              but the whole strip *is* the limits readout, and all of it opens
              the same panel. It is one button either way (the trigger wraps the
              lot); leftmost is where that reads true. */}
          <span className="limits-title">
            <span className={`limits-caret${open ? ' open' : ''}`} aria-hidden>
              <IconCaret size={17} />
            </span>
            Limits
          </span>
          {shown.length === 0 ? (
            // Every harness reported something, and none of it was a quota. Say
            // so once rather than leaving the label standing on its own.
            <span className="limit-chip silent-all">No Quotas To Track</span>
          ) : (
            shown.map((reading) => <LimitChip key={reading.harness} reading={reading} />)
          )}
        </span>
      )}
    >
      {(close) => <LimitsPanel limits={relevant} close={close} />}
    </MenuTrigger>
  )
}
