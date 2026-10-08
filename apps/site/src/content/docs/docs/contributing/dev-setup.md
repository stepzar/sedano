---
title: Dev setup
description: Run a development copy of Sedano next to the installed app - ports, data directories, the desktop shell and why the API does not hot-reload.
sidebar:
  order: 1
---

## Prerequisites

- [Bun](https://bun.sh) for everything.
- Rust and the Tauri CLI only for the desktop shell.
- Chrome only for the browser checks.
- A vendor CLI only for the harnesses you want to try by hand. The test suite
  never needs one.

## Run it

```bash
bun install
bun run dev            # UI on :5174 (hot reload), API on 127.0.0.1:7789
bun run desktop:dev    # the same development copy inside a native "Sedano Dev" window
```

`SEDANO_UI_PORT` and `SEDANO_DEV_PORT` move the two ports. Without vite,
`bun run build:ui && bun run start` serves the built bundle from the API port
alone.

## Installed app versus development copy

They never share a port, a store or a window:

| | installed app | development copy |
|---|---|---|
| started by | `/Applications/Sedano.app` | `bun run dev`, `dev:server`, `desktop:dev` |
| API port | 7788 | 7789 (`SEDANO_DEV_PORT`) |
| data | `~/.sedano` | `~/.sedano-dev` (`SEDANO_DEV_HOME`) |
| bundle id / window | `app.sedano.desktop`, "Sedano" | `app.sedano.desktop.dev`, "Sedano Dev" |
| remote access | yes | read-only, changes refused |

## The API does not hot-reload

The UI hot-reloads; the API deliberately does not, because restarting it
interrupts live ACP turns on every machine. Restart it yourself after backend
changes, once active work has finished. For isolated backend work with no
sessions running, use `bun run dev:server:watch` (or `SEDANO_WATCH_SERVER=1`).

The desktop shell attaches to a server already on its port when `/api/health`
reports the same instance and the same data directory. So restarting
`desktop:dev` alone keeps the old server; see
[stale server after a dev restart](/docs/faq/troubleshooting/#the-dev-window-runs-old-server-code).

## Component gallery

`/preview.html` is a dev-only gallery that renders the transcript from fixtures
(live subagent, diffs, thinking, a running turn) and every primitive, in either
theme, without spending any quota:

```
http://localhost:5174/preview.html?theme=dark
```

## Desktop builds

```bash
bun run sidecar        # bun build --compile: the server as one binary
bun run desktop:build  # .app + .dmg, bundling the sidecar
bun run install:app    # build and install /Applications/Sedano.app
```

Branches, pull requests and code style are in
[CONTRIBUTING.md](https://github.com/stepzar/sedano/blob/master/CONTRIBUTING.md).
