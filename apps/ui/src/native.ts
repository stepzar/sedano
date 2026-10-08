import { isDesktop } from './store.ts'

/**
 * The native folder chooser, when the app is running inside the desktop shell.
 *
 * For an agent, a workspace is a project you already know the location of, and
 * macOS already has the best picker for that: sidebar, recent places, search.
 * Reimplementing it would be worse in every way, so agents get the real dialog.
 *
 * Returns null everywhere else (a browser tab has no business opening a native
 * chooser), which is the signal to fall back to the in-app picker.
 */
export async function pickFolderNative(current?: string): Promise<string | null> {
  if (!isDesktop()) return null
  try {
    const dialog = await import('@tauri-apps/plugin-dialog')
    const picked = await dialog.open({
      directory: true,
      multiple: false,
      title: 'Choose a workspace',
      defaultPath: current || undefined,
    })
    return typeof picked === 'string' ? picked : null
  } catch {
    // Plugin missing or the shell refused: the caller falls back, never breaks.
    return null
  }
}

/** True when a native chooser will actually appear. */
export function hasNativeFolderPicker(): boolean {
  return isDesktop()
}

/**
 * Open a web link outside the app.
 *
 * Inside the desktop shell a `target="_blank"` link has nowhere to go — the
 * webview opens no second window — so it is handed to the system browser
 * through the opener plugin (scoped to http, https and mailto in the shell's
 * capabilities). A browser tab simply opens a new tab.
 */
export async function openExternal(url: string): Promise<void> {
  if (!isDesktop()) {
    window.open(url, '_blank', 'noopener,noreferrer')
    return
  }
  try {
    const opener = await import('@tauri-apps/plugin-opener')
    await opener.openUrl(url)
  } catch {
    /* plugin missing or the scope refused it: nothing to open, nothing broken */
  }
}
