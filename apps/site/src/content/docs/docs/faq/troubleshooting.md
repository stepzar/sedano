---
title: FAQ and troubleshooting
description: Fixes for common Sedano problems - port 7788 busy, a CLI or tmux not found, a stale dev server, the macOS warning - and where the logs are.
---

## macOS says Sedano cannot be opened

The build is not signed or notarized yet. Open **System Settings > Privacy &
Security**, scroll down and click **Open Anyway**, or run:

```bash
xattr -dr com.apple.quarantine /Applications/Sedano.app
```

Only do this for a build from the official releases page. See
[Install](/docs/getting-started/install/#install-the-dmg).

## "Port 7788 is already used by …"

The app found something on its port that is not its own server (same instance,
same data directory), so it refuses to start instead of showing the wrong
sessions. Often it is an old `bun run start` or a server started with the real
store. Find it and quit it:

```bash
lsof -nP -iTCP:7788 -sTCP:LISTEN
curl -s http://127.0.0.1:7788/api/health   # if it is a Sedano: instance, home, pid
```

`bun run install:app` behaves the same way: it installs but does not launch
while the port is taken, and says so.

## A CLI is installed but Sedano says it is missing

An app opened from Finder does not get your shell's `PATH`. Sedano searches a
fixed list of directories (Homebrew, `~/.local/bin`, nvm, Volta, Bun, pnpm,
asdf, mise and each vendor's own directory); the full list is in
[Harnesses and machines](/docs/settings/harnesses/#how-binaries-are-found).

1. Check where it is: `which claude` (or the harness's binary) in a terminal.
2. If it is somewhere else, link it: `ln -s "$(which claude)" ~/.local/bin/claude`.
3. **Settings > Advanced > Installed software > Scan again**.

For Codex, the binary Sedano needs is `codex-acp`, not `codex`. On an SSH host,
the CLI must be installed on that host.

## "tmux not found: terminal tabs need tmux"

Terminal tabs and Freebuff need `tmux` on the machine they run on:

```bash
brew install tmux
```

On an SSH host, install it there with that system's package manager.

## The dev window runs old server code

`bun run desktop:dev` attaches to a development server already on port 7789 if
it reports the same instance and data directory. Restarting only the window
keeps the old server and its old code. Check when it started:

```bash
pid=$(curl -s http://127.0.0.1:7789/api/health | sed -E 's/.*"pid":([0-9]+).*/\1/')
ps -o lstart= -p "$pid"
```

If that is older than your backend change, stop that server (after active turns
finish) and start it again. The API never hot-reloads on purpose; see
[Dev setup](/docs/contributing/dev-setup/#the-api-does-not-hot-reload).

## A host does not connect

Sedano runs `ssh` with `BatchMode=yes`, so a password or passphrase prompt
fails immediately. Make sure `ssh <alias> true` works from a terminal without
typing anything, and that the host is switched on in **Settings > Machines**.
See [SSH hosts](/docs/remote/ssh-hosts/).

## Limits show "No Usage API" or nothing

Gemini CLI, Grok and Freebuff have no usage API. For the others, see
[Limits and usage](/docs/settings/limits/). A harness that is not logged in has
nothing to read.

## A turn was interrupted after a restart

ACP agents (Codex, Gemini CLI, Grok, opencode) are child processes of the server;
restarting it interrupts their turn. Claude Code and Command Code run as durable
agents and continue. Queued prompts are kept either way.

## Where are the logs?

| Log | Path |
|---|---|
| server, when started by the app | `~/.sedano/server.log` (`~/.sedano-dev/server.log` for the dev window) |
| server, when started from a terminal | that terminal |
| dedicated Tailscale daemon | `~/.sedano/tailscale/tailscaled.log` |
| a durable agent's output | `~/.sedano/agents/agent-<session id>/` |
| harness transcripts | where each CLI keeps them, for example `~/.claude/projects/` |

## Is there a Windows or Linux build?

No. macOS 13 or later on Apple Silicon only. SSH hosts can be Linux machines.

## Does Sedano send telemetry?

No. See [Security notes](/docs/remote/security/).

## Where do I report a bug?

[GitHub issues](https://github.com/stepzar/sedano/issues). For a security
problem, follow the
[security policy](https://github.com/stepzar/sedano/blob/master/SECURITY.md)
instead.
