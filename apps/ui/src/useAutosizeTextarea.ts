import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'

export function useAutosizeTextarea(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null)

  const resize = useCallback(() => {
    const node = ref.current
    if (!node) return

    node.style.height = '0px'
    const maxHeight = Number.parseFloat(getComputedStyle(node).maxHeight)
    const capped = Number.isFinite(maxHeight) && node.scrollHeight > maxHeight
    const height = capped ? maxHeight : node.scrollHeight
    node.style.height = `${height}px`
    node.style.overflowY = capped ? 'auto' : 'hidden'
  }, [])

  // Only when the text changes. Without deps this ran after every render of the
  // composer — every streamed token — and each run forces a synchronous layout
  // of the whole window (height 0, then read scrollHeight), which in a long
  // transcript is the most expensive thing a token does.
  useLayoutEffect(resize, [value, resize])

  useEffect(() => {
    const node = ref.current
    if (!node || typeof ResizeObserver === 'undefined') return

    const target = node.parentElement ?? node
    let frame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(resize)
    })
    observer.observe(target)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [resize])

  return ref
}
