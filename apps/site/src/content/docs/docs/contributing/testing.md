---
title: Testing
description: Sedano's hermetic gates, run by check:all with no account or network, and the optional smokes that need a real CLI, tmux or host.
sidebar:
  order: 3
---

The suite is split in two.

- **Hermetic gates** run anywhere: no account, no network, no vendor CLI, no
  tmux, no ssh host. Each gets its own temporary `SEDANO_HOME`, its own free port
  and, where it needs a harness, a fake one from `scripts/fixtures/`. A failure
  is a bug in the repo.
- **Optional smokes** need something the repo cannot provide: a logged-in CLI,
  tmux, a real host. They are not gates.

```bash
bun run check:all     # every hermetic gate, then a summary
```

`check:all` runs every gate even after one fails, prints `ok` or `FAIL` per gate
and a verdict, and exits non-zero if any failed. It never touches `~/.sedano` or
a port in use, so it is safe while a dev server is up.

## A few of the gates

| Gate | What it proves |
|---|---|
| `bun run typecheck` | `tsc --noEmit` over every package |
| `check:lifecycle` | spawn, stop and delete under races; a mid-turn prompt is queued, not lost |
| `check:recovery` | a question cannot be answered twice or after a restart; replayed commands do not repeat |
| `check:claude` | the Claude driver against a fake `claude` speaking real `stream-json` |
| `check:acp` | the ACP driver against a fake agent: handshake, turns, permissions, resume |
| `check:cmd` | the Command Code driver against a fake `cmd` |
| `check:ssh` | the host allowlist and transport against a fake `ssh` |
| `check:replay` | recorded, sanitized sessions replayed through the manager |
| `check:coverage` | every protocol type a harness publishes is handled or knowingly ignored |
| `check:contrast` | WCAG ratios for every text and background pair, both themes |
| `check:ui` | the app in a real browser: launchpad, composers, settings, palette, themes |

Every gate is a `check:<name>` script in `package.json`. The browser checks need
Chrome installed (no browser is downloaded) and write screenshots to
`.playwright-mcp/` for a person to look at.

## Optional smokes

| Smoke | Needs |
|---|---|
| `bun run check:smoke [cwd]` | `claude` logged in; spends quota |
| `bun run check:term [ws] [cwd] [host]` | `tmux`, and a host for the remote half |
| `bun run check:term-ui [url]` | `tmux` and a running server |
| `bun scripts/acp-probe.ts <agent> [flag]` | the agent installed and signed in; spends no tokens |

## Every reported bug becomes a replay

A state bug in a session is turned into a sanitized replay with
`scripts/replay-build.ts` (it keeps structure, ids and timing, and replaces all
content), placed in `scripts/fixtures/replays/`, and kept as the regression test
once `bun scripts/replay-test.ts <name>` passes.

## Protocol coverage

Each protocol has an inventory of every message type, derived from the harness's
own published source, and a hand-kept mapping saying where each type is handled
or why it is ignored. A daily CI job re-derives the inventories from the latest
releases and opens an issue for new types. To refresh locally:

```bash
bun scripts/coverage/extract.ts --latest --write
bun run check:coverage
```

Full details:
[docs/testing.md](https://github.com/stepzar/sedano/blob/master/docs/testing.md).
