/**
 * `/demo/?phone=1` opened on a wide screen: the phone layout needs a phone-sized
 * viewport, so the page becomes a plain stage holding the demo in a 402×874
 * frame (scaled down to fit a short window). A real phone, or the landing
 * page's mockup, gets the demo itself.
 */
const WIDTH = 402
const HEIGHT = 874

export function wantsPhoneHost(params: URLSearchParams): boolean {
  return params.get('phone') === '1' && window.self === window.top && innerWidth > 600
}

export function mountPhoneHost(params: URLSearchParams): void {
  const root = document.documentElement
  const inner = new URLSearchParams(params)
  inner.set('theme', root.dataset.theme === 'dark' ? 'dark' : 'light')

  const style = document.createElement('style')
  style.textContent = `
html, body { height: 100%; margin: 0; overflow: hidden; background: color-mix(in srgb, var(--bg) 92%, #808080); }
.demo-phone-host { height: 100%; display: grid; place-items: center; }
.demo-phone-host > div { width: ${WIDTH}px; height: ${HEIGHT}px; transform-origin: center; }
.demo-phone-host iframe {
  width: 100%; height: 100%; border: 1px solid var(--line-strong); border-radius: 44px;
  background: var(--bg); box-shadow: 0 24px 60px rgba(0, 0, 0, 0.18);
}
`
  document.head.append(style)
  const stage = document.createElement('main')
  stage.className = 'demo-phone-host'
  const holder = document.createElement('div')
  const frame = document.createElement('iframe')
  frame.title = 'Sedano demo, phone layout'
  frame.src = `${location.pathname}?${inner}`
  holder.append(frame)
  stage.append(holder)
  document.getElementById('root')?.replaceWith(stage)

  const fit = () => {
    holder.style.transform = `scale(${Math.min(1, (innerHeight - 32) / HEIGHT, (innerWidth - 32) / WIDTH)})`
  }
  fit()
  window.addEventListener('resize', fit)
  // The demo's own Settings may switch the theme: the stage follows.
  window.addEventListener('message', (event) => {
    if (event.source !== frame.contentWindow || event.origin !== location.origin) return
    const data = event.data as { type?: unknown; theme?: unknown } | null
    if (data?.type === 'sedano-demo:theme' && (data.theme === 'light' || data.theme === 'dark')) root.dataset.theme = data.theme
  })
}
