import { useCallback, useRef } from 'react'
import { getState, updateSettings } from '../store.ts'

/**
 * The grab strip on the edge of a side panel.
 *
 * Dragging writes straight to the CSS variable so the panel follows the pointer
 * at frame rate — the preference itself is saved once, when the drag ends, rather
 * than on every mouse move. A double click puts the panel back to the width it
 * starts at, which is the only reason to remember the original number.
 */
export interface ResizeSpec {
  /** CSS variable the width lives in. */
  variable: string
  /** The setting that keeps it, and the width a double click restores. */
  setting: 'railWidth' | 'filesWidth'
  fallback: number
  min: number
  max: number
  /** Which side the panel is on: the handle sits on its inner edge. */
  side: 'left' | 'right'
}

export function Resizer({ spec }: { spec: ResizeSpec }) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null)

  const clamp = useCallback(
    (value: number) => Math.max(spec.min, Math.min(spec.max, Math.round(value))),
    [spec.max, spec.min],
  )

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = getState().settings[spec.setting] ?? spec.fallback
    drag.current = { startX: event.clientX, startWidth: current }
    event.currentTarget.setPointerCapture(event.pointerId)
    document.body.classList.add('resizing')
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = drag.current
    if (!state) return
    const delta = event.clientX - state.startX
    // Dragging the handle towards the panel widens it, whichever side it is on.
    const width = clamp(state.startWidth + (spec.side === 'left' ? delta : -delta))
    document.documentElement.style.setProperty(spec.variable, `${width}px`)
  }

  const end = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = drag.current
    drag.current = null
    document.body.classList.remove('resizing')
    if (!state) return
    const delta = event.clientX - state.startX
    const width = clamp(state.startWidth + (spec.side === 'left' ? delta : -delta))
    updateSettings({ [spec.setting]: width })
  }

  return (
    <div
      className={`resizer ${spec.side}`}
      role="separator"
      aria-orientation="vertical"
      title="Drag to resize · double click to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => updateSettings({ [spec.setting]: spec.fallback })}
    />
  )
}

export const RAIL_RESIZE: ResizeSpec = {
  variable: '--rail-width',
  setting: 'railWidth',
  fallback: 298,
  min: 220,
  max: 460,
  side: 'left',
}

export const FILES_RESIZE: ResizeSpec = {
  variable: '--files-width',
  setting: 'filesWidth',
  fallback: 236,
  min: 180,
  max: 560,
  side: 'right',
}

/* Bottom terminal ---------------------------------------------------------- */

/**
 * The quick terminal's top edge. Same recipe as the side panels — the drag
 * writes a CSS variable (once per frame), the value is saved when it ends —
 * but the height lives in this window's localStorage rather than in the
 * settings: it is about the size of this window, not a preference to sync.
 * The xterm inside refits through its own ResizeObserver, and the transcript
 * above keeps its reading position through its own.
 */
const DOCK_HEIGHT_KEY = 'sedano.dock-height'
const DOCK_VARIABLE = '--dock-height'
export const DOCK_MIN_HEIGHT = 120

function dockMaxHeight(): number {
  return Math.round(window.innerHeight * 0.8)
}

function clampDock(height: number): number {
  return Math.max(DOCK_MIN_HEIGHT, Math.min(dockMaxHeight(), Math.round(height)))
}

/** Puts back the height the terminal was last dragged to, before it first renders. */
export function restoreDockHeight(): void {
  const saved = Number(localStorage.getItem(DOCK_HEIGHT_KEY))
  if (Number.isFinite(saved) && saved > 0) document.documentElement.style.setProperty(DOCK_VARIABLE, `${clampDock(saved)}px`)
}

export function DockResizer() {
  const drag = useRef<{ startY: number; startHeight: number; height: number; frame: number | null } | null>(null)

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const dock = event.currentTarget.parentElement
    if (!dock) return
    event.preventDefault()
    drag.current = { startY: event.clientY, startHeight: dock.getBoundingClientRect().height, height: 0, frame: null }
    drag.current.height = drag.current.startHeight
    event.currentTarget.setPointerCapture(event.pointerId)
    document.body.classList.add('resizing', 'resizing-rows')
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = drag.current
    if (!state) return
    // Up makes it taller: the panel rises from the bottom edge.
    state.height = clampDock(state.startHeight + state.startY - event.clientY)
    if (state.frame !== null) return
    state.frame = requestAnimationFrame(() => {
      state.frame = null
      document.documentElement.style.setProperty(DOCK_VARIABLE, `${state.height}px`)
    })
  }

  const end = () => {
    const state = drag.current
    drag.current = null
    document.body.classList.remove('resizing', 'resizing-rows')
    if (!state) return
    if (state.frame !== null) cancelAnimationFrame(state.frame)
    document.documentElement.style.setProperty(DOCK_VARIABLE, `${state.height}px`)
    localStorage.setItem(DOCK_HEIGHT_KEY, String(state.height))
  }

  return (
    <div
      className="dock-resizer"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the terminal"
      title="Drag to resize · double click to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => {
        document.documentElement.style.removeProperty(DOCK_VARIABLE)
        localStorage.removeItem(DOCK_HEIGHT_KEY)
      }}
    />
  )
}
