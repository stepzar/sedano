# Contributing to Sedano

Thanks for helping. This file covers how to get a working copy, how changes
flow into `master`, and which checks have to pass.

## Development setup

You need [Bun](https://bun.sh) (CI pins 1.2.2). Rust and the Tauri CLI are only
needed for the desktop shell, and Chrome only for the browser checks. A vendor
CLI (Claude Code, Codex, Gemini CLI, Grok, opencode, Command Code, Freebuff) is
only needed for the harnesses you want to try by hand: the test suite never
needs one.

```bash
bun install
bun run dev            # UI on :5174 (hot reload), API on 127.0.0.1:7789
bun run desktop:dev    # the same development copy inside a native window
```

Without vite, `bun run build:ui && bun run start` serves the built bundle from
the API port alone. The development copy keeps its state in `~/.sedano-dev`
(move it with `SEDANO_DEV_HOME`), separate from an installed app in `~/.sedano`.

The API does not hot-reload on purpose: restarting it interrupts live agent
turns. Restart it yourself after backend changes, or use
`bun run dev:server:watch` when no session is running.

## Branches and pull requests

1. Fork the repository and create a feature branch from `master`.
2. Keep commits small and focused. Write messages in English that explain why
   the change is needed, not only what it does.
3. Open a pull request against `master` and fill in the template. Never push
   directly to `master`.
4. CI must be green before a merge. A reviewer may ask for a regression test
   when a fix lacks one.

When you fix a bug, fix the shared cause rather than the single example, and
check the same mechanism across every harness, local and SSH hosts, and the
session lifecycle states it touches.

## Tests

Every gate is hermetic: it runs against fixtures, fake CLIs and fake transports
in `scripts/fixtures/`, with a temporary home directory. No account, API key or
reachable host is needed.

```bash
bun run typecheck                                   # the tree compiles
bun scripts/lib/check-all.ts --without browser rust # what CI's main job runs
bun run check:all                                   # every gate, with a summary
bun run check:<name>                                # a single gate (see package.json)
```

The `browser` group needs Chrome (or `SEDANO_BROWSER=chromium` with
Playwright's Chromium) and a built UI (`bun run build:ui`); the `rust` group
needs a cargo toolchain. [docs/testing.md](docs/testing.md) explains what each
gate proves. Smokes that need a real vendor CLI (`check:smoke`, `check:term`,
`check:term-ui`) are manual and are not required for a pull request.

Add or update a test with every behaviour change. Test what a user would see,
not implementation details.

## Harness protocol coverage

Every protocol type a harness publishes must be mapped as handled or ignored in
`apps/server/src/harnesses/coverage/<protocol>.mapping.json`. A daily workflow
opens an issue when a new harness release adds a type. To refresh the
inventories locally:

```bash
bun scripts/coverage/extract.ts --latest --write && bun run check:coverage
```

## Code style

Prefer simple, readable code over clever abstractions. Comment only where the
reason is not obvious from the code. Follow the conventions of the file you are
editing.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
