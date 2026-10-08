# The interactive demo (`/demo/`)

`/demo/` is the real Sedano UI (`apps/ui`) running entirely in the visitor's
browser. A fake server in the page (`apps/ui/src/demo/`) answers `/api/*` and the
`/api/ws` socket with the app's own wire protocol, plays scripted turns
(streamed text, tools, diffs, a subagent, question and permission cards) and
invents a machine (`/Users/you/Projects/acme-api`, harnesses, limits). No server,
no model, no network: nothing typed leaves the browser.

It is built from source on every site build, never committed:

```bash
bun run build:demo    # from the repo root → apps/site/public/demo/ (git-ignored)
bun run check:demo    # browser walk of the built demo (streaming, queue, cards, settings, phone)
bun run dev:demo      # vite dev server with the demo on (http://localhost:5174)
```

`apps/site`'s `build` script runs `build:demo` first, so `astro build` copies
the bundle to `dist/demo/`. The bundle uses a relative base and works under any
path. The normal app build compiles the demo out (`check:demo-isolated`).

## Query parameters

| Param | Effect |
|---|---|
| `?theme=dark` / `light` / `system` | the theme (stored, like the app's own choice) |
| `?session=<id>` | open that seeded session: `demo-claude`, `demo-codex`, `demo-gemini`, `demo-opencode`, `demo-cmd`, `demo-web`, `demo-terminal`; `demo-question` and `demo-permission` boot with a question / permission card already waiting |
| `?panel=limits` | open the limits panel |
| `?embed=1` | inside an iframe: `focus()` never scrolls the host page until the visitor touches the demo (also on automatically when framed) |
| `?phone=1` | the phone layout and appearance on any browser: touch media queries answer as on a phone and `screen` reports 402×874 (`apps/ui/src/demo/phone-prepaint.js`). Opened on its own on a wide screen, the page frames the demo in a 402×874 box |
| `?embed=1&phone=1` | also the iPhone's safe areas (62px top, 34px bottom), for the landing page's phone mockup, which draws the status bar, Dynamic Island and home indicator over them |

The page carries `<meta name="robots" content="noindex">`.

Framed by a same-origin page, the demo posts `{ type: 'sedano-demo:ready', liveTheme: true }`
to its parent, then follows `{ type: 'sedano:theme', theme }` and
`{ type: 'sedano:goto', session?, panel? }` live, without reloading, and reports
a theme picked in its own Settings as `{ type: 'sedano-demo:theme', theme }`
(the landing page's `DemoStage.astro` and `PhoneStage.astro` use all four,
through `src/scripts/demo-bridge.ts`; each iframe keeps its own state, and the
page theme keeps them in step).

## Vercel

`apps/site` is a standalone package (own `bun.lock`), but the demo is built from
`apps/ui`, which needs the root workspace install. Project settings:

| Setting | Value |
|---|---|
| Root Directory | `apps/site` |
| Include files outside the Root Directory | **enabled** (the build reads `../../apps/ui`, `../../packages/shared`) |
| Install Command | `cd ../.. && bun install --frozen-lockfile && cd apps/site && bun install --frozen-lockfile` |
| Build Command | `bun run build` (default) |
| Output Directory | `dist` (default) |

Verified from a clean clone with exactly those two commands: `dist/demo/index.html`
is produced.

## What is mocked, and what degrades

Works for real, in memory: sessions, tabs, prompts and the prompt queue,
cancel, Esc/stop, question and permission cards, model / effort / approval
pickers, rename, pin, delete, archive and Import Sessions (invented native
conversations), new sessions from the launchpad, the folder picker and file
tree (a fake tree), terminals (a pretend shell: `ls`, `cd`, `git log`, `bun
test`…), limits, Settings (appearance, sidebar, harness switches, machines,
machine colours, usage readers) — appearance persists in `localStorage`.
A reload restarts the tour; sessions created in the demo are not kept.

Answers "not available in the browser demo" (a toast, never a blank): opening a
file in its app, dictation, harness updates, remote pairing, saving an export
to the server (the browser download still works).
