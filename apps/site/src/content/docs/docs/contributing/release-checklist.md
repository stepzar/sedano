---
title: Release checklist
description: The steps to run before a Sedano release - back up the store, pass the gates, build, check the visuals and run the vendor smokes by hand.
sidebar:
  order: 4
---

Everything here is something a person can run and read the answer to.

## 1. Back up the store

Migrations only go forward and nothing backs up for you:

```bash
cp -a ~/.sedano/sedano.db ~/.sedano/sedano.db.bak-$(date +%Y%m%d)
```

Open the new server once, then check the migration landed:

```bash
sqlite3 ~/.sedano/sedano.db 'PRAGMA table_info(events)'
sqlite3 ~/.sedano/sedano.db '.tables'
```

## 2. Pass the hermetic gates

```bash
bun install
bun run check:all
```

Every gate must say `ok`.

## 3. Build

```bash
bun run build:ui
bun run sidecar
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
bun run desktop:build
```

The sidecar must exist before `desktop:build`, which bundles it. Then open the
packaged app and check that it attaches only to its own kind of server on
`:7788`, refuses any other listener with a dialog, and leaves no server running
after quit.

## 4. Install on this Mac

```bash
bun run install:app
curl -s 127.0.0.1:7788/api/health    # "instance":"app", home ~/.sedano
```

Check that a paired phone still loads over the tailnet. `--rollback` must swap
`Sedano.app.previous` back in.

## 5. Look at it

`check:ui` and `check:contrast` assert what can be asserted. Look at the
screenshots they leave in `.playwright-mcp/`, then read a real transcript in
both themes: a turn with tools, a subagent card, a question card, a terminal tab.

## 6. Vendor smokes, by hand

```bash
bun run check:smoke ~/Projects/sedano   # spends quota
bun run check:term                      # and again with a host argument
bun run check:term-ui
bun scripts/acp-probe.ts opencode acp
bun scripts/acp-probe.ts codex-acp
bun scripts/acp-probe.ts gemini --acp
```

For each harness you ship with: send a prompt, send a second one while the
first runs (it must be queued), answer a question, press `esc` mid-turn and
check the session ends as `stopped`, not `error`. Do the same once on an SSH
host and check nothing is left behind there.

## 7. Before tagging

- The `check:all` verdict line, with the date.
- Which smokes ran and which did not. A smoke that did not run is not a pass.
- Any capability change reflected in the
  [capability matrix](/docs/harnesses/overview/#capability-matrix).
