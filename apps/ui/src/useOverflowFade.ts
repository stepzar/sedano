import { useCallback, useRef } from 'react'

/**
 * Marks a horizontally scrolling lane with which of its ends hide content.
 *
 * The composer's pickers shrink to fit first (see `.composer-controls`); only
 * when even their shortest form does not fit does the lane scroll. A hidden
 * scrollbar then gave no hint that anything was cut, so a chevron sliced in
 * half read as a rendering bug. `data-fade-start` / `data-fade-end` let the
 * stylesheet fade the edge that has more behind it.
 *
 * Returns a callback ref, so a lane that mounts after its component (the
 * launchpad shows a chooser first) is still watched.
 */
export function useOverflowFade<T extends HTMLElement>() {
  const stop = useRef<(() => void) | null>(null)
  return useCallback((lane: T | null) => {
    stop.current?.()
    stop.current = null
    if (!lane) return
    const update = () => {
      lane.toggleAttribute('data-fade-start', lane.scrollLeft > 1)
      lane.toggleAttribute('data-fade-end', lane.scrollLeft + lane.clientWidth < lane.scrollWidth - 1)
    }
    update()
    const sizes = new ResizeObserver(update)
    sizes.observe(lane)
    const changes = new MutationObserver(() => {
      // A picker's label changed or a picker appeared: its new size matters.
      for (const child of lane.children) sizes.observe(child)
      update()
    })
    for (const child of lane.children) sizes.observe(child)
    changes.observe(lane, { childList: true, subtree: true, characterData: true })
    lane.addEventListener('scroll', update, { passive: true })
    stop.current = () => {
      sizes.disconnect()
      changes.disconnect()
      lane.removeEventListener('scroll', update)
    }
  }, [])
}
