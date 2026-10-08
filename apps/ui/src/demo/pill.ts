/**
 * The one thing the demo adds to the screen: a small pill saying what this is,
 * with the prompts worth trying behind it. Plain DOM outside React, so the app
 * renders exactly as it ships; dismissed for the rest of the visit.
 */
const DISMISSED_KEY = 'sedano.demo.pill-dismissed'

const TRY = [
  ['write tests for the orders route', 'a question card'],
  ['fix the expiry bug', 'a permission card'],
  ['refactor the order handler', 'diffs'],
  ['explain the auth middleware', 'a long answer'],
]

const CSS = `
.demo-pill {
  position: fixed;
  z-index: 60;
  left: 12px;
  bottom: calc(var(--statusbar-height, 32px) + 10px);
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: calc(100vw - 24px);
  padding: 4px 4px 4px 10px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  background: color-mix(in srgb, var(--surface) 88%, transparent);
  -webkit-backdrop-filter: blur(10px);
  backdrop-filter: blur(10px);
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.08);
  color: var(--fg-mute);
  font: 500 12px/1.2 var(--font-ui);
  animation: demo-pill-in 360ms var(--ease, ease) both;
}
.demo-pill .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ok);
  flex: none;
}
.demo-pill b { color: var(--fg); font-weight: 600; }
.demo-pill button {
  display: inline-grid;
  place-items: center;
  height: 22px;
  min-width: 22px;
  padding: 0 7px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--fg-mute);
  font: inherit;
  cursor: pointer;
}
.demo-pill button:hover { background: var(--hover); color: var(--fg); }
.demo-pill .try { border: 1px solid var(--line); }
.demo-tips {
  position: fixed;
  z-index: 61;
  left: 12px;
  bottom: calc(var(--statusbar-height, 32px) + 46px);
  width: min(320px, calc(100vw - 24px));
  padding: 10px 12px;
  border: 1px solid var(--line-strong);
  border-radius: 14px;
  background: var(--surface);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.14);
  color: var(--fg-mute);
  font: 400 12.5px/1.45 var(--font-ui);
}
.demo-tips p { margin: 0 0 6px; }
.demo-tips ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 4px; }
.demo-tips code { font: 500 12px/1.4 var(--font-mono); color: var(--fg); }
@keyframes demo-pill-in { from { opacity: 0; transform: translateY(6px); } }
@media (max-width: 760px) {
  /* The phone's bottom belongs to the composer and its top bar is full: float
     under the tab row, as small as it can be. */
  .demo-pill { left: 10px; bottom: auto; top: calc(var(--safe-top, env(safe-area-inset-top, 0px)) + 110px); padding: 2px 2px 2px 8px; font-size: 11px; }
  .demo-pill .long { display: none; }
  .demo-tips { left: 10px; bottom: auto; top: calc(var(--safe-top, env(safe-area-inset-top, 0px)) + 142px); }
}
`

function dismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISSED_KEY) === '1'
  } catch {
    return false
  }
}

export function installPill(embedded: boolean): void {
  if (dismissed()) return
  const mount = () => {
    const style = document.createElement('style')
    style.textContent = CSS
    document.head.append(style)

    const pill = document.createElement('div')
    pill.className = 'demo-pill'
    pill.setAttribute('role', 'note')
    pill.innerHTML = `<span class="dot" aria-hidden="true"></span><span><b>Demo</b><span class="long"> — nothing leaves your browser</span></span>`

    const tips = document.createElement('div')
    tips.className = 'demo-tips'
    tips.hidden = true
    tips.innerHTML = `<p>Every reply is scripted. Prompts that show the interface off:</p><ul>${TRY.map(
      ([prompt, what]) => `<li><code>${prompt}</code> — ${what}</li>`,
    ).join('')}</ul><p style="margin:8px 0 0">Send another prompt while one runs to queue it; <b>Esc</b> interrupts.</p>`

    const tryButton = document.createElement('button')
    tryButton.type = 'button'
    tryButton.className = 'try'
    tryButton.textContent = 'Try…'
    tryButton.setAttribute('aria-expanded', 'false')
    tryButton.addEventListener('click', () => {
      tips.hidden = !tips.hidden
      tryButton.setAttribute('aria-expanded', String(!tips.hidden))
    })

    const close = document.createElement('button')
    close.type = 'button'
    close.textContent = '✕'
    close.title = 'Hide'
    close.setAttribute('aria-label', 'Hide the demo notice')
    close.addEventListener('click', () => {
      pill.remove()
      tips.remove()
      try {
        sessionStorage.setItem(DISMISSED_KEY, '1')
      } catch {
        /* private mode: hidden until the next load */
      }
    })

    pill.append(tryButton, close)
    if (embedded) pill.dataset.embedded = '1'
    document.body.append(pill, tips)
  }
  if (document.body) mount()
  else addEventListener('DOMContentLoaded', mount, { once: true })
}
