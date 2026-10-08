import { useEffect, useRef, useSyncExternalStore, type TouchEvent } from 'react'

/**
 * The phone layout: one breakpoint, a sidebar that becomes a drawer, and a
 * layout that follows the on-screen keyboard.
 *
 * The same components render on both; only what the rail *is* changes. On a
 * phone the sidebar setting (⌘B, persisted) would open a drawer over the whole
 * screen at every launch, so the drawer has its own, unsaved open state.
 */

// Narrow windows, and a phone held sideways (wide but short, touch only).
export const MOBILE_QUERY = '(max-width: 820px), (hover: none) and (pointer: coarse) and (max-height: 500px)'

function subscribeMedia(listener: () => void): () => void {
  const media = matchMedia(MOBILE_QUERY)
  media.addEventListener('change', listener)
  return () => media.removeEventListener('change', listener)
}

export function isMobile(): boolean {
  return typeof matchMedia === 'function' && matchMedia(MOBILE_QUERY).matches
}

export function useMobile(): boolean {
  return useSyncExternalStore(subscribeMedia, isMobile, () => false)
}

/* Drawer ------------------------------------------------------------------ */

let drawerOpen = false
const drawerListeners = new Set<() => void>()

export function setDrawer(open: boolean): void {
  if (drawerOpen === open) return
  drawerOpen = open
  for (const listener of drawerListeners) listener()
}

export function toggleDrawer(): void {
  setDrawer(!drawerOpen)
}

export function useDrawer(): boolean {
  return useSyncExternalStore(
    (listener) => {
      drawerListeners.add(listener)
      return () => drawerListeners.delete(listener)
    },
    () => drawerOpen,
  )
}

/**
 * Swipe right from the left edge opens the drawer; swipe left anywhere closes
 * it. Only a mostly horizontal movement counts, so scrolling a transcript never
 * opens anything.
 */
export function installDrawerSwipe(): void {
  let start: { x: number; y: number } | null = null
  window.addEventListener(
    'touchstart',
    (event) => {
      const touch = event.touches[0]
      if (!isMobile() || event.touches.length !== 1 || !touch) return
      start = drawerOpen || touch.clientX < 24 ? { x: touch.clientX, y: touch.clientY } : null
    },
    { passive: true },
  )
  window.addEventListener(
    'touchend',
    (event) => {
      const touch = event.changedTouches[0]
      if (!start || !touch) return
      const dx = touch.clientX - start.x
      const dy = touch.clientY - start.y
      start = null
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return
      if (dx > 0 && !drawerOpen) setDrawer(true)
      if (dx < 0 && drawerOpen) setDrawer(false)
    },
    { passive: true },
  )
}

/**
 * Swipe down on the header of a sheet (palette, settings, folder picker,
 * quick terminal, an image) closes it, as it would a native sheet. The sheets
 * already close on Escape, so the gesture is turned into one; the terminal is
 * put away with its own close button.
 */
const SHEET_HEADS = '.switcher-head, .palette-head, .settings-head, .settings-nav, .picker-head, .dock-head, .lightbox'

export function installSheetSwipe(): void {
  let start: { x: number; y: number; head: Element } | null = null
  window.addEventListener(
    'touchstart',
    (event) => {
      const touch = event.touches[0]
      const head = (event.target as Element | null)?.closest?.(SHEET_HEADS) ?? null
      start = isMobile() && touch && head && event.touches.length === 1 ? { x: touch.clientX, y: touch.clientY, head } : null
    },
    { passive: true },
  )
  window.addEventListener(
    'touchend',
    (event) => {
      const touch = event.changedTouches[0]
      const began = start
      start = null
      if (!began || !touch) return
      const dy = touch.clientY - began.y
      if (dy < 80 || Math.abs(touch.clientX - began.x) > dy * 0.6) return
      if (began.head.matches('.dock-head')) {
        began.head.querySelector<HTMLElement>('.dock-close')?.click()
        return
      }
      const target = (document.activeElement as HTMLElement | null) ?? document.body
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    },
    { passive: true },
  )
}

/* Keyboard ---------------------------------------------------------------- */

/**
 * iOS does not shrink the layout for the keyboard: it slides the page up under
 * it, which hides the composer. The visual viewport is what is actually on
 * screen, so the app is sized to it (`--app-height`, `--app-top`) and marked
 * `keyboard-open` while the keyboard takes a real part of the screen.
 */
export function trackVisualViewport(): void {
  const viewport = window.visualViewport
  if (!viewport) return
  const root = document.documentElement
  const update = () => {
    if (!isMobile()) {
      root.style.removeProperty('--app-height')
      root.style.removeProperty('--app-top')
      root.classList.remove('keyboard-open')
      return
    }
    root.style.setProperty('--app-height', `${Math.round(viewport.height)}px`)
    root.style.setProperty('--app-top', `${Math.round(viewport.offsetTop)}px`)
    root.classList.toggle('keyboard-open', window.innerHeight - viewport.height > 120)
  }
  viewport.addEventListener('resize', update)
  viewport.addEventListener('scroll', update)
  window.addEventListener('resize', update)
  update()
}

/* Status bar colour -------------------------------------------------------- */

/**
 * The browser's own chrome (Safari's status bar and toolbar tint, a PWA's
 * status bar) takes `theme-color`. It follows the theme the app shows, which
 * the user may have chosen against the system's: the colour is read from the
 * top bar itself so the two can never disagree.
 */
export function syncThemeColor(): void {
  const root = document.documentElement
  const apply = () => {
    const bar = document.querySelector('.bar')
    const colour = bar ? getComputedStyle(bar).backgroundColor : getComputedStyle(root).getPropertyValue('--surface').trim()
    if (!colour) return
    for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
      meta.removeAttribute('media')
      meta.content = colour
    }
  }
  new MutationObserver(apply).observe(root, { attributes: true, attributeFilter: ['data-theme'] })
  // Once the app has drawn its top bar, then on every theme change.
  setTimeout(apply, 300)
  apply()
}

/* Long press -------------------------------------------------------------- */

/**
 * The phone's right-click. iOS Safari never fires `contextmenu` on a long
 * press, so the menus behind a right-click need their own gesture there.
 * One timer serves a whole list (only one finger presses at a time):
 * `const press = useLongPress()`, then `{...press((at) => openMenu(at))}`.
 */
export function useLongPress() {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fired = useRef(false)
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  return (onLongPress: (at: { x: number; y: number }) => void) => ({
    onTouchStart: (event: TouchEvent) => {
      const touch = event.touches[0]
      if (!touch) return
      fired.current = false
      const at = { x: touch.clientX, y: touch.clientY }
      cancel()
      timer.current = setTimeout(() => {
        fired.current = true
        onLongPress(at)
      }, 500)
    },
    onTouchMove: cancel,
    onTouchEnd: (event: TouchEvent) => {
      cancel()
      // The finger lifting after a long press must not also count as a tap.
      if (fired.current) event.preventDefault()
    },
    onTouchCancel: cancel,
  })
}
