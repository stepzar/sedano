import { useSyncExternalStore } from 'react'

/**
 * Whether the window is the one the user is working in.
 *
 * The "still working" motion — spinners, the pulsing dot, the thinking orb —
 * runs for as long as an agent does, which is often hours with the window in
 * the background. A visible but unfocused WebKit window keeps painting every
 * frame of it (and WindowServer keeps compositing it), so the loops rest while
 * the window is unfocused and pick up again on focus. The state itself stays on
 * screen: colours, labels and the elapsed clock do not depend on this.
 */
function isFocused(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus()
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('focus', onChange)
  window.addEventListener('blur', onChange)
  document.addEventListener('visibilitychange', onChange)
  return () => {
    window.removeEventListener('focus', onChange)
    window.removeEventListener('blur', onChange)
    document.removeEventListener('visibilitychange', onChange)
  }
}

/** For canvas loops, which CSS cannot pause. */
export function useWindowFocused(): boolean {
  return useSyncExternalStore(subscribe, isFocused)
}

/** Mirrors focus onto `<html data-window-idle>`, which the stylesheet pauses infinite animations on. */
export function trackWindowFocus(): void {
  const sync = () => {
    document.documentElement.toggleAttribute('data-window-idle', !isFocused())
  }
  subscribe(sync)
  sync()
}
