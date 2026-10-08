---
title: Adding a harness
description: How to wire a new coding-agent CLI into Sedano - an ACP row, or an adapter and driver - plus capabilities, usage, updates, coverage and tests.
sidebar:
  order: 6
---

The UI never needs to change: it only sees the normalized events from
`packages/shared`. A new harness is server work, plus a logo and a label.

## If it speaks ACP

Add a row to `ACP_AGENTS` in `apps/server/src/harnesses/acp/adapter.ts`:

```ts
{
  harness: 'example',      // a new HarnessId in packages/shared
  id: 'example',
  label: 'Example',
  bin: 'example',
  args: ['acp'],
  note: 'ACP · one continuous session',
  models: [],
}
```

Optional fields cover what differs between agents: `argv` when model or effort
must be passed at spawn (Grok), `initTimeoutMs` for a slow first handshake
(Gemini), and how the agent reports prompt usage. The shared client already
handles permissions, elicitation, resume through `session/load`, and images as
the agent declares them.

## If it has its own protocol

Write an **Adapter** (`detect`, `models`, `images`, `create`) and a **Driver**
(`send`, `interrupt`, `configure`, `stop`, and `answerQuestion` only if the
protocol can ask) under `apps/server/src/harnesses/<name>/`, then register the
adapter in `registry.ts`. The driver's job is to translate its protocol into
`DriverHooks` calls. See [Architecture](/docs/contributing/architecture/#adapters-and-drivers).

Rules that apply to both paths:

- **Do not fake capabilities.** If the protocol has no subagents, emit none. If
  it reports no cost, leave it unreported, not zero.
- **Run through the transport.** Never spawn directly, so SSH hosts work for
  free.
- **Durable if it can be.** A line-protocol CLI can run as a durable process
  (`durableLaunch`) so it survives a server restart.

## The rest of the wiring

1. **Catalog:** add it to `HARNESS_CATALOG` in `registry.ts` with its binary
   name. A TUI-only tool gets `tui: true` and opens as a terminal tab.
2. **Approval modes:** extend `permissionModesFor` only with modes the CLI
   really distinguishes.
3. **Usage:** a reader in `apps/server/src/usage/` if the vendor exposes one;
   otherwise add it to the "No Usage API" list.
4. **Updates:** a row in `UPDATE_SPECS` in `harnesses/updates.ts` with the exact
   package name.
5. **Coverage:** an inventory and a mapping in
   `apps/server/src/harnesses/coverage/` if it is a new protocol.
6. **Tests:** a fake CLI in `scripts/fixtures/` and a hermetic `check:*` gate
   for the driver.
7. **Docs:** a row in `docs/capabilities.md`, a page here, and the logo in
   `apps/ui/src/components/Icons.tsx`.
