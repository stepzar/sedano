import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// HeroUI brings Tailwind and its own component styles; imported before this
// app's stylesheet so the rules written here still take precedence.
import '@heroui/styles'
import './styles.css'
import { App } from './App.tsx'
import { Boundary } from './components/Boundary.tsx'
import { armChime } from './chime.ts'
import { applySettings, getState } from './store.ts'
import { trackWindowFocus } from './windowFocus.ts'
import { installRemoteGuard } from './remoteClient.ts'
import { installDrawerSwipe, installSheetSwipe, syncThemeColor, trackVisualViewport } from './mobile.ts'
import { restoreDockHeight } from './components/Resize.tsx'

const root = document.getElementById('root')
if (!root) throw new Error('#root missing')

// The website demo answers `/api` in the page (src/demo/). The condition is a
// build-time constant, so every other build drops this branch and the module.
if (import.meta.env.VITE_SEDANO_DEMO === '1') await (await import('./demo/index.ts')).installDemo()

// Before anything asks the server: a revoked phone reloads into the pairing page.
installRemoteGuard()
// The phone layout: follow the on-screen keyboard, and let the drawer be swiped.
trackVisualViewport()
installDrawerSwipe()
installSheetSwipe()
syncThemeColor()
// The quick terminal comes back at the height it was last dragged to.
restoreDockHeight()
// index.html already applied the theme pre-paint; this syncs the rest.
applySettings(getState().settings)
// Browsers allow no sound before the first gesture: this waits for it.
armChime()
// Lets the stylesheet rest the endless animations while the window is in the background.
trackWindowFocus()
// A file dropped anywhere but a field that takes it (the composers take images)
// must not navigate the window to that file.
for (const type of ['dragover', 'drop'] as const) {
  window.addEventListener(type, (event) => {
    if (event.dataTransfer && [...event.dataTransfer.types].includes('Files')) event.preventDefault()
  })
}

createRoot(root).render(
  <StrictMode>
    <Boundary label="sedano" scope="app">
      <App />
    </Boundary>
  </StrictMode>,
)
