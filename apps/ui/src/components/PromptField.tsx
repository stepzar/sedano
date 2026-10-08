import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ClipboardEvent, KeyboardEvent, ReactNode, RefObject, SyntheticEvent, TextareaHTMLAttributes } from 'react'
import { imageTokenSpans, withoutImageTokens, type ImageTokenSpan } from '../attachments.ts'

/**
 * The prompt textarea, with each `[image:N]` token drawn as an "Image N" chip.
 *
 * The text stays a plain `<textarea>` holding the tokens: typing, IME, undo,
 * copy/paste and the autosize hook are the browser's own, and the text sent to
 * the harness is exactly what is in the field.
 *
 * While the text holds a chip, the textarea's own glyphs are made transparent
 * (its caret and selection stay) and a mirror laid over it draws *all* of the
 * text, with each token's glyphs kept — invisible — under its label. So the raw
 * `[image:N]` can never show, and a chip is exactly as wide as its token: the
 * mirror wraps where the textarea wraps. The mirror copies every property that
 * moves a glyph (font, spacing, padding, wrapping), takes the textarea's inner
 * width (a scrollbar included), and follows its scroll with a transform —
 * `scrollTop` on the mirror itself would be clamped wherever the textarea has
 * more to scroll (a trailing newline makes a line there, and none in a div).
 * Without chips there is no mirror at all, and the textarea is untouched.
 *
 * A contenteditable would draw real chips, but it takes over IME, undo and
 * paste — the parts a textarea already gets right on every engine.
 *
 * The chip is atomic: the caret is moved out of a token whenever it lands
 * inside one, and Backspace/Delete next to a chip selects the whole token
 * before the browser deletes it, so one keystroke removes it (and, through the
 * composer's `syncImageTokens`, its picture) and ⌘Z can bring the text back.
 */
type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value'> & {
  ref: RefObject<HTMLTextAreaElement | null>
  value: string
  /** Pictures that have finished uploading: a chip past that is still on its way. */
  ready: number
}

/** What the mirror copies from the textarea so its text lays out identically. */
const MIRRORED = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'fontStretch',
  'fontKerning',
  'fontVariant',
  'fontFeatureSettings',
  'fontVariationSettings',
  'fontOpticalSizing',
  'textRendering',
  'whiteSpace',
  'wordBreak',
  'overflowWrap',
  'lineHeight',
  'letterSpacing',
  'wordSpacing',
  'tabSize',
  'textIndent',
  'textTransform',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
] as const

function tokenAround(spans: ImageTokenSpan[], position: number): ImageTokenSpan | undefined {
  return spans.find((span) => position > span.start && position < span.end)
}

/**
 * Where a caret that landed inside a token goes: out the far side when an arrow
 * or a word jump carried it in, to the nearer edge when it was clicked there.
 */
function snapCaret(spans: ImageTokenSpan[], position: number, previous: number, clicked: boolean): number {
  const span = tokenAround(spans, position)
  if (!span) return position
  const nearest = position - span.start <= span.end - position ? span.start : span.end
  if (clicked) return nearest
  if (previous >= span.end) return span.start
  if (previous <= span.start) return span.end
  return nearest
}

export function PromptField({
  ref,
  value,
  ready,
  onKeyDown,
  onPaste,
  onSelect,
  onScroll,
  onMouseDown,
  onCompositionStart,
  onCompositionEnd,
  ...rest
}: Props) {
  const layer = useRef<HTMLDivElement>(null)
  const spans = useMemo(() => imageTokenSpans(value), [value])
  const [selection, setSelection] = useState<[number, number]>([0, 0])
  const lastFocus = useRef(0)
  const clicked = useRef(false)
  const composing = useRef(false)

  const content = useRef<HTMLDivElement>(null)

  /** Lay the mirror exactly over the textarea's text box, scrolled as it is. */
  const place = useCallback(() => {
    const area = ref.current
    const node = layer.current
    if (!area || !node) return
    const style = getComputedStyle(area)
    for (const key of MIRRORED) node.style[key] = style[key]
    // From the boxes, not `offsetTop`/`offsetLeft`: those are rounded to whole
    // pixels, and a centred field sits on a fraction of one — enough to move
    // every glyph of the mirror off the textarea's by half a pixel.
    const box = area.getBoundingClientRect()
    const frame = (node.offsetParent ?? area.parentElement)?.getBoundingClientRect()
    node.style.top = `${box.top - (frame?.top ?? 0) + area.clientTop}px`
    node.style.left = `${box.left - (frame?.left ?? 0) + area.clientLeft}px`
    // `clientWidth` is rounded to a whole pixel too, and a mirror a fraction
    // narrower than the textarea wraps a token onto the next line while the
    // textarea keeps it on this one. The real width, less borders and the
    // scrollbar (which is whole pixels), is the textarea's own wrap width.
    const borders = Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.borderRightWidth)
    const bordersY = Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth)
    const scrollbar = Math.max(0, area.offsetWidth - area.clientWidth - Math.round(borders))
    node.style.width = `${box.width - borders - scrollbar}px`
    node.style.height = `${box.height - bordersY}px`
    if (content.current) {
      content.current.style.transform = `translate(${-area.scrollLeft}px, ${-area.scrollTop}px)`
    }
  }, [ref])

  const hasChips = spans.length > 0
  // Once now, and once after the frame: the autosize hook resizes (and so may
  // scroll) the textarea in its own layout effect, which runs after this one.
  useLayoutEffect(() => {
    place()
    const frame = requestAnimationFrame(place)
    return () => cancelAnimationFrame(frame)
  }, [value, hasChips, place])

  // The textarea is also resized by the window: follow its box when it changes.
  useEffect(() => {
    const area = ref.current
    if (!area || !hasChips || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(place)
    observer.observe(area)
    return () => observer.disconnect()
  }, [ref, hasChips, place])

  const keepChipsWhole = (event: SyntheticEvent<HTMLTextAreaElement>) => {
    const area = event.currentTarget
    const { selectionStart: start, selectionEnd: end } = area
    const backward = area.selectionDirection === 'backward'
    let nextStart = start
    let nextEnd = end
    if (spans.length && !composing.current) {
      if (start === end) {
        nextStart = nextEnd = snapCaret(spans, start, lastFocus.current, clicked.current)
      } else {
        // The moving end follows the arrow; the fixed end only ever widens, so
        // a selection holds whole chips and Shift+arrow can still shrink it.
        const focus = snapCaret(spans, backward ? start : end, lastFocus.current, clicked.current)
        const anchorAt = backward ? end : start
        const anchorSpan = tokenAround(spans, anchorAt)
        const anchor = anchorSpan ? (backward ? anchorSpan.end : anchorSpan.start) : anchorAt
        nextStart = Math.min(focus, anchor)
        nextEnd = Math.max(focus, anchor)
      }
      if (nextStart !== start || nextEnd !== end) {
        area.setSelectionRange(nextStart, nextEnd, backward ? 'backward' : 'forward')
      }
    }
    clicked.current = false
    lastFocus.current = backward ? nextStart : nextEnd
    setSelection((current) => (current[0] === nextStart && current[1] === nextEnd ? current : [nextStart, nextEnd]))
  }

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    clicked.current = false
    const plain = !event.altKey && !event.metaKey && !event.ctrlKey && !event.nativeEvent.isComposing
    const area = event.currentTarget
    if (plain && area.selectionStart === area.selectionEnd && (event.key === 'Backspace' || event.key === 'Delete')) {
      const caret = area.selectionStart
      const span = spans.find((item) => (event.key === 'Backspace' ? item.end === caret : item.start === caret))
      // Not prevented: the browser deletes the selection itself, which keeps the
      // deletion on its undo stack.
      if (span) area.setSelectionRange(span.start, span.end)
    }
    onKeyDown?.(event)
  }

  const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    onPaste?.(event)
    if (event.defaultPrevented) return
    const text = event.clipboardData.getData('text/plain')
    const clean = withoutImageTokens(text)
    if (clean === text) return
    event.preventDefault()
    const area = event.currentTarget
    // `insertText` keeps the paste undoable; the fallback still reaches React.
    if (!document.execCommand('insertText', false, clean)) {
      area.setRangeText(clean, area.selectionStart, area.selectionEnd, 'end')
      area.dispatchEvent(new Event('input', { bubbles: true }))
    }
  }

  const chips: ReactNode[] = []
  let cursor = 0
  for (const span of spans) {
    if (span.start > cursor) chips.push(value.slice(cursor, span.start))
    const selected = selection[0] < selection[1] && selection[0] <= span.start && selection[1] >= span.end
    chips.push(
      <span
        key={span.start}
        className={`image-chip in-field${span.n > ready ? ' pending' : ''}${selected ? ' selected' : ''}`}
        data-label={`Image ${span.n}`}
      >
        {value.slice(span.start, span.end)}
      </span>,
    )
    cursor = span.end
  }
  if (hasChips && cursor < value.length) chips.push(value.slice(cursor))
  // A textarea gives a trailing newline a line of its own; a div does not.
  if (hasChips && value.endsWith('\n')) chips.push('\u200b')

  return (
    <div className={`prompt-field${hasChips ? ' has-chips' : ''}`}>
      <textarea
        ref={ref}
        value={value}
        {...rest}
        onKeyDown={keyDown}
        onPaste={paste}
        onSelect={(event) => {
          keepChipsWhole(event)
          onSelect?.(event)
        }}
        onScroll={(event) => {
          place()
          onScroll?.(event)
        }}
        onMouseDown={(event) => {
          clicked.current = true
          onMouseDown?.(event)
        }}
        onCompositionStart={(event) => {
          composing.current = true
          onCompositionStart?.(event)
        }}
        onCompositionEnd={(event) => {
          composing.current = false
          onCompositionEnd?.(event)
        }}
      />
      {hasChips ? (
        <div className="prompt-chips" ref={layer} aria-hidden="true">
          <div className="prompt-chips-text" ref={content}>
            {chips}
          </div>
        </div>
      ) : null}
    </div>
  )
}
