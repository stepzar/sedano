/**
 * The landing page's side of the demo's postMessage protocol (apps/site/DEMO.md),
 * shared by every demo iframe on the page. Each iframe has its own state; the
 * page's theme is the one thing they share: the bulb drives all of them, and a
 * theme picked inside any demo moves the page (and so the others).
 */
export type Theme = 'light' | 'dark';

export interface DemoBridge {
  /** Load (or reload) the iframe at `source()`; the page theme is read at that moment. */
  load(): void;
  /** Post to the demo when it is live; otherwise reload it so the URL carries the change. */
  sendOrReload(message: object): void;
}

const root = document.documentElement;
export const pageTheme = (): Theme => (root.dataset.theme === 'dark' ? 'dark' : 'light');

export function bridgeDemo(frame: HTMLIFrameElement, source: () => string): DemoBridge {
  // Set by the demo's ready message; a reload clears it until the next one.
  let live = false;
  let loaded = Boolean(frame.getAttribute('src'));
  const send = (message: object) => frame.contentWindow?.postMessage(message, location.origin);
  const load = () => {
    live = false;
    loaded = true;
    frame.src = source();
  };

  window.addEventListener('message', (event) => {
    if (event.source !== frame.contentWindow || event.origin !== location.origin) return;
    if (event.data?.type === 'sedano-demo:ready') {
      live = event.data.liveTheme === true;
      // The page may have changed theme while the demo was booting.
      if (live) send({ type: 'sedano:theme', theme: pageTheme() });
    } else if (event.data?.type === 'sedano-demo:theme') {
      const next = event.data.theme;
      if ((next !== 'light' && next !== 'dark') || next === pageTheme()) return;
      root.dataset.theme = next;
      try {
        localStorage.setItem('starlight-theme', next);
      } catch {}
    }
  });

  let shown = pageTheme();
  new MutationObserver(() => {
    if (pageTheme() === shown) return;
    shown = pageTheme();
    // A lazy iframe not loaded yet picks the theme up when it loads.
    if (!loaded) return;
    if (live) send({ type: 'sedano:theme', theme: shown });
    else load();
  }).observe(root, { attributes: true, attributeFilter: ['data-theme'] });

  return {
    load,
    sendOrReload(message) {
      if (live) send(message);
      else load();
    },
  };
}
