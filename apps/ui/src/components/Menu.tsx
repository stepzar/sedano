import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconCaret } from './Icons.tsx'

/**
 * One menu for the whole app.
 *
 * The composer's chips used to be invisible native `<select>` elements sitting
 * under a styled span, so half the dropdowns in sedano looked like macOS and the
 * other half looked like sedano — two visual languages for one idea. Everything
 * that opens a list now opens this surface: same anchor, same items, same keys.
 *
 * The popover is rendered into `document.body` rather than next to its trigger.
 * The composer and the launchpad clip their contents (`overflow: hidden`, for
 * their rounded corners), which used to hide the dropdown behind the very box
 * it was opened from; a portal can never be clipped by an ancestor.
 */

export interface MenuOption {
  value: string
  label: string
  /** Optional second line, for lists where the choice needs explaining. */
  hint?: string
  /** Small tag at the end of the row — the part that is the same on every row. */
  suffix?: string
  /** Leading mark (a harness logo); the trigger shows the chosen one's. */
  icon?: ReactNode
}

/**
 * Where a popover sits. Exactly one of `top`/`bottom` is set: a menu that opens
 * downwards is pinned by its top edge, one that opens upwards by its bottom, so
 * in both cases the edge touching the trigger stays put as the content changes.
 */
interface Placement {
  left: number
  top: number | null
  bottom: number | null
  maxHeight: number
}

/** Below how much free space a side stops being worth opening into. */
const MIN_ROOM = 180

/**
 * A trigger and the popover it owns. `children` receives `close`, so an item can
 * dismiss the menu without every caller wiring its own state.
 */
export function MenuTrigger({
  trigger,
  children,
  title,
  className = '',
  disabled = false,
  width = 232,
  align = 'start',
}: {
  trigger: (open: boolean) => ReactNode
  children: (close: () => void) => ReactNode
  title?: string
  className?: string
  disabled?: boolean
  width?: number
  align?: 'start' | 'end'
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<Placement | null>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const pop = useRef<HTMLDivElement>(null)

  // Place the popover against its trigger: below when there is room, above when
  // there is not, and never off the side of the window.
  const place = () => {
    const anchor = wrap.current?.getBoundingClientRect()
    if (!anchor) return
    const gap = 6
    const margin = 8
    const left = Math.max(
      margin,
      Math.min(align === 'start' ? anchor.left : anchor.right - width, window.innerWidth - width - margin),
    )
    // The room that is actually there decides everything, and *only* the room:
    // the menu's own height is deliberately not measured any more. Sampling it
    // was the defect behind the limits panel that "changed shape" — the height
    // of the content on the frame the menu opened became a permanent ceiling
    // (`maxHeight`) and, when flipped, a permanent top edge, so a reading that
    // arrived a second later was cut off at the bottom instead of shown, and
    // the next scroll re-measured and moved the panel. Deriving the box from
    // the viewport alone means content can arrive without the geometry
    // answering back: the menu fills the room it was given and scrolls inside
    // it. (The older bug this replaced is still fixed: a 27-row model list
    // opens below and scrolls rather than flipping up over its own composer.)
    const below = window.innerHeight - margin - (anchor.bottom + gap)
    const above = anchor.top - gap - margin
    const viewport = window.innerHeight - margin * 2
    // Neither side can hold a usable menu (a very short window): fall back to
    // the viewport itself, so the menu is never taller than the screen.
    if (below < MIN_ROOM && above < MIN_ROOM) {
      setPos({ left, top: margin, bottom: null, maxHeight: viewport })
      return
    }
    const flip = below < MIN_ROOM && above > below
    // Flipped menus hang from their bottom edge rather than being pushed to a
    // computed top: the edge that touches the trigger is the one that must not
    // move, and growth then extends upwards into the room already reserved.
    setPos(
      flip
        ? { left, top: null, bottom: window.innerHeight - anchor.top + gap, maxHeight: Math.min(above, viewport) }
        : { left, top: anchor.bottom + gap, bottom: null, maxHeight: Math.min(below, viewport) },
    )
  }

  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    place()
    const onMove = () => place()
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    return () => {
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (wrap.current?.contains(target) || pop.current?.contains(target)) return
      setOpen(false)
    }
    // Captured and marked handled, so the Esc that closes this does not also
    // reach the app's Esc (which interrupts the running turn).
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  return (
    <div className={`menu ${className}`.trim()} ref={wrap} title={title}>
      <button
        type="button"
        className={`select-trigger${open ? ' open' : ''}`}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {trigger(open)}
      </button>
      {open
        ? createPortal(
            <div
              className="menu-pop"
              ref={pop}
              role="menu"
              style={{
                position: 'fixed',
                width,
                left: pos?.left ?? -9999,
                // Only the anchored edge holds a value; the opposite one is
                // written as `auto` on purpose, and not merely left out. The
                // stylesheet gives `.menu-pop` a `top` for the menus that are
                // not portalled, and a box with both a top and a bottom is
                // stretched between them — which pinched this popover to
                // twelve pixels the first time it hung from its bottom edge.
                top: pos?.top ?? 'auto',
                bottom: pos?.bottom ?? 'auto',
                maxHeight: pos?.maxHeight,
                overflowY: 'auto',
                visibility: pos ? 'visible' : 'hidden',
              }}
            >
              {children(() => setOpen(false))}
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}

export function Select({
  value,
  options,
  onChange,
  title,
  disabled,
  width = 232,
  align = 'start',
  placeholder = 'Pick One',
  footerAction,
  icon,
}: {
  value: string
  options: MenuOption[]
  onChange: (value: string) => void
  title?: string
  disabled?: boolean
  width?: number
  align?: 'start' | 'end'
  placeholder?: string
  footerAction?: { label: string; onClick: () => void }
  /** Says what the choice is about, so the label can be just the value. */
  icon?: ReactNode
}) {
  const [query, setQuery] = useState('')
  const current = options.find((option) => option.value === value)
  const triggerIcon = icon ?? current?.icon
  // Long lists (Command Code has dozens of models) get a search field; short ones
  // stay a plain list.
  const searchable = options.length > 8
  const needle = query.trim().toLowerCase()
  const list =
    searchable && needle
      ? options.filter(
          (option) => option.label.toLowerCase().includes(needle) || option.value.toLowerCase().includes(needle),
        )
      : options
  useEffect(() => setQuery(''), [value, options.length])

  return (
    <MenuTrigger
      title={title}
      disabled={disabled}
      width={width}
      align={align}
      className="select-wrap"
      trigger={(open) => (
        <span className="chip-select">
          {triggerIcon ? <span className="chip-icon">{triggerIcon}</span> : null}
          <span className="chip-label">{current?.label ?? placeholder}</span>
          <span className={`caret${open ? ' open' : ''}`}>
            <IconCaret size={17} />
          </span>
        </span>
      )}
    >
      {(close) => (
        <>
          {searchable ? (
            <div className="menu-search">
              <input
                autoFocus
                spellCheck={false}
                placeholder="Search…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.stopPropagation()
                    close()
                  }
                  if (event.key === 'Enter' && list[0]) {
                    event.preventDefault()
                    close()
                    onChange(list[0].value)
                  }
                }}
              />
            </div>
          ) : null}
          {list.length === 0 ? (
            <div className="menu-empty">Nothing matches</div>
          ) : (
            list.map((option) => (
              <button
                key={option.value}
                className={`menu-item${option.value === value ? ' current' : ''}`}
                onClick={() => {
                  close()
                  onChange(option.value)
                }}
              >
                {option.icon ? <span className="menu-item-icon">{option.icon}</span> : null}
                <span className="menu-item-name">{option.label}</span>
                {option.hint ? <span className="menu-item-meta">{option.hint}</span> : null}
                <span className="spacer" />
                {option.suffix ? <span className="menu-item-suffix">{option.suffix}</span> : null}
                {option.value === value ? <span className="check">✓</span> : null}
              </button>
            ))
          )}
          {footerAction ? (
            <>
              <div className="menu-sep" />
              <button type="button" className="menu-item menu-action" onClick={() => {
                close()
                footerAction.onClick()
              }}>{footerAction.label}</button>
            </>
          ) : null}
        </>
      )}
    </MenuTrigger>
  )
}

/** A labelled group inside a menu, for the read-only explainer panels. */
export function MenuSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="menu-section">
      <div className="menu-title">{label}</div>
      {children}
    </div>
  )
}
