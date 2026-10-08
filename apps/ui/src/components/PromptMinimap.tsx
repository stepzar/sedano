import { memo, useEffect, useRef, useState, type RefObject } from 'react'
import { splitDocuments } from '@shared'

export interface MinimapPrompt {
  /** The turn's `data-turn-key`, which is how its prompt is found on screen. */
  key: string
  text: string
}

interface Mark {
  key: string
  /** Where the prompt starts in the thread, in scroll coordinates. */
  top: number
}

/** Room left above a prompt it scrolls to, so its first line is not flush. */
const LANDING_OFFSET = 12
/** Each line is a target this tall (see `.prompt-mark`). */
const HIT = 20
/** How close to the end of the thread counts as being at it. */
const AT_END = 8

/**
 * One short line per prompt, stacked evenly on the right edge of the transcript.
 *
 * It is an index of the prompts, not a scale drawing of the thread: evenly
 * spaced lines are equally easy to hit however long the turns between them
 * were. The stack sits centred on the edge and grows with the prompts; past
 * 60% of the transcript it scrolls on its own and keeps the current line in
 * view. Prompt positions are measured only when the thread or the scroller
 * change size (one observer, at most once a frame), so streaming and idling
 * cost it nothing.
 */
export const PromptMinimap = memo(function PromptMinimap({
  prompts,
  scroller,
  thread,
}: {
  prompts: MinimapPrompt[]
  scroller: RefObject<HTMLDivElement | null>
  thread: RefObject<HTMLDivElement | null>
}) {
  const [measured, setMeasured] = useState(false)
  const [current, setCurrent] = useState<string | null>(null)
  const latest = useRef<Mark[]>([])
  const strip = useRef<HTMLElement>(null)
  const enough = prompts.length >= 2

  useEffect(() => {
    const node = scroller.current
    const content = thread.current
    if (!enough || !node || !content) return
    const wanted = new Set(prompts.map((prompt) => prompt.key))

    const pick = () => {
      // At the end of the thread you are reading the last prompt, even when it
      // is too far down to ever reach the top of the view: a short last turn
      // cannot be scrolled that far, and the line then stayed on the one before.
      if (node.scrollHeight - node.scrollTop - node.clientHeight <= AT_END) {
        setCurrent(latest.current[latest.current.length - 1]?.key ?? null)
        return
      }
      // Otherwise it is the last one whose start has scrolled up to the top of
      // the view.
      const line = node.scrollTop + LANDING_OFFSET + 1
      let found: string | null = latest.current[0]?.key ?? null
      for (const mark of latest.current) if (mark.top <= line) found = mark.key
      setCurrent(found)
    }

    const measure = () => {
      // The strip is inset from the scroller's content edge, past its
      // scrollbar — as wide as this engine and setting draw it (0 when it
      // overlays the content).
      node.parentElement?.style.setProperty('--minimap-scrollbar', `${node.offsetWidth - node.clientWidth}px`)
      const box = node.getBoundingClientRect()
      const origin = box.top - node.scrollTop
      const next: Mark[] = []
      for (const section of content.querySelectorAll<HTMLElement>('.turn[data-turn-key]')) {
        const key = section.dataset.turnKey!
        const prompt = section.querySelector<HTMLElement>(':scope > .msg-user')
        if (!prompt || !wanted.has(key)) continue
        next.push({ key, top: prompt.getBoundingClientRect().top - origin })
      }
      latest.current = next
      setMeasured(true)
      pick()
    }

    let pending = 0
    const schedule = () => {
      if (pending) return
      pending = requestAnimationFrame(() => {
        pending = 0
        measure()
      })
    }
    const observer = new ResizeObserver(schedule)
    observer.observe(content)
    observer.observe(node)
    node.addEventListener('scroll', pick, { passive: true })
    schedule()
    return () => {
      if (pending) cancelAnimationFrame(pending)
      observer.disconnect()
      node.removeEventListener('scroll', pick)
    }
  }, [enough, prompts, scroller, thread])

  // A stack taller than its box scrolls, and the current line is kept in it.
  useEffect(() => {
    const box = strip.current
    if (!box || !current || box.scrollHeight <= box.clientHeight) return
    const index = prompts.findIndex((prompt) => prompt.key === current)
    if (index < 0) return
    const top = index * HIT
    if (top < box.scrollTop) box.scrollTop = top
    else if (top + HIT > box.scrollTop + box.clientHeight) box.scrollTop = top + HIT - box.clientHeight
  }, [current, prompts, measured])

  if (!enough || !measured) return null

  const jump = (key: string) => {
    const node = scroller.current
    if (!node) return
    // Where the prompt is now, read on the spot: the cached marks can be a
    // frame behind a layout that just moved.
    const landing = (): number | null => {
      const section = [...(thread.current?.querySelectorAll<HTMLElement>('.turn[data-turn-key]') ?? [])]
        .find((item) => item.dataset.turnKey === key)
      const prompt = section?.querySelector<HTMLElement>(':scope > .msg-user')
      if (!prompt) return latest.current.find((item) => item.key === key)?.top ?? null
      return prompt.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop
    }
    const start = landing()
    if (start === null) return
    // Instant, on purpose: a smooth scroll is cancelled by any other write to
    // `scrollTop`, and leaving the bottom summons the "↓ latest" row, whose
    // resize makes the transcript hold its reading position — such a write. The
    // jump then stopped wherever the animation happened to be.
    node.scrollTo({ top: Math.max(0, start - LANDING_OFFSET), behavior: 'auto' })
  }

  return (
    <nav
      ref={strip}
      className="prompt-minimap"
      aria-label="Prompts in this conversation"
    >
      {prompts.map((prompt, index) => {
        const summary = splitDocuments(prompt.text).text.replace(/\[image:(\d+)\]/g, 'Image $1').replace(/\s+/g, ' ').trim().slice(0, 80)
        return (
          <button
            key={prompt.key}
            type="button"
            className={`prompt-mark${prompt.key === current ? ' current' : ''}`}
            title={summary}
            aria-label={`Prompt ${index + 1}: ${summary}`}
            aria-current={prompt.key === current ? 'true' : undefined}
            onClick={() => jump(prompt.key)}
          />
        )
      })}
    </nav>
  )
})
