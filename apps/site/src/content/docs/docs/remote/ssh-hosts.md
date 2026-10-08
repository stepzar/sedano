---
title: SSH hosts
description: Run agent sessions and terminal tabs on machines from your ~/.ssh/config, enabled one by one as an explicit allowlist.
sidebar:
  order: 1
---

Sedano can run agent sessions and terminal tabs on other machines over `ssh`.
The harness CLI runs on that machine, in a folder on that machine; Sedano only
carries the protocol back.

## Enable a host

1. Add the host to `~/.ssh/config` with a literal alias:

   ```
   Host build-box
     HostName 10.0.0.12
     User you
   ```

2. Open **Settings > Machines**. Every literal `Host` alias is listed. Turn on
   the switch for the ones Sedano may use. The test button next to a host
   connects once and reports what happened.

3. The host's workspaces and harnesses now appear in the pickers.

The ticked list is stored in `~/.sedano/config.json` and is an allowlist: every
endpoint, session and transport checks it, so a host nobody enabled never
becomes an `ssh` argument. Patterns such as `Host *` or `Host !staging` are not
destinations and are not offered. `Include` directives are followed.

## Requirements on the host

- Non-interactive login. Sedano runs the system `ssh` with `BatchMode=yes`, so a
  host that asks for a password or a passphrase fails instead of hanging. Use a
  key loaded in your agent.
- The harness CLIs you want, installed and logged in **on that host**. Their
  login, models and limits are that host's own.
- `tmux` on the host for terminal tabs.

Connections are shared (`ControlMaster`, sockets in `~/.sedano/ssh`), so
opening many tabs does not open many logins.

## What differs from local sessions

- Model lists and update checks are per machine.
- Hiding a harness in Settings applies to one machine only.
- Durable agents on a host keep their files in that host's `~/.sedano/agents`.
- The import picker only scans harness stores on this Mac.
- ACP resume hints are not prefixed with `ssh <host>`.
- A dropped connection is reported as an error (`unreachable`, `timeout`, and so
  on), never as an empty folder or as a fallback to this Mac.
