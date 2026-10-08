/**
 * Keyboard chords shared by the window handler and the terminals.
 *
 * On a Mac the app's chords are ⌘ ones and Control belongs to the shell; on
 * other platforms Control is the app's modifier, as in a browser.
 */
export const APPLE = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)

/**
 * The tab position ⌘1…⌘9 (Ctrl elsewhere) asks for: 1 is the leftmost tab and
 * 9 the last one, as in a browser. Read from the physical key, so a layout that
 * needs Shift for its digits (AZERTY) still gets ⌘1. Null for any other key.
 */
export function tabShortcut(event: KeyboardEvent): number | null {
  const chord = APPLE ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  if (!chord || event.altKey || event.shiftKey) return null
  const digit = /^Digit([1-9])$/.exec(event.code)?.[1] ?? (/^[1-9]$/.test(event.key) ? event.key : null)
  return digit ? Number(digit) : null
}

/** The tab a position points at: `9` is always the last one. */
export function tabAtShortcut(tabs: string[], position: number): string | null {
  if (!tabs.length) return null
  return (position === 9 ? tabs.at(-1) : tabs[position - 1]) ?? null
}
