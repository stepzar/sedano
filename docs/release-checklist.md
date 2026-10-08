# Release checklist

Work down the list. Everything here is something a person can run and read the
answer to; nothing is "looks fine". Bumping, tagging, the draft release, the
smoke test on a clean Mac and publishing are in [releasing](release.md).

## 1. The store

Migrations run when the server opens the database, inside a transaction, and they
are idempotent. The first open by a release other than the one that last opened
the store keeps a copy as `~/.sedano/sedano.db.bak-<previous version>` when the
schema changes (`check:db-backup`; the last three are kept). Take your own copy
anyway before installing a build with a migration — a hand-made name like the one
below is never pruned:

```bash
cp -a ~/.sedano/sedano.db ~/.sedano/sedano.db.bak-$(date +%Y%m%d)
```

Then open a build of the new server once and check the migration landed: the
`events` table must be keyed by `(session_id, id)`, and `turn_id`,
`parent_event_id` and `parent_agent_id` must exist.

```bash
sqlite3 ~/.sedano/sedano.db 'PRAGMA table_info(events)'
sqlite3 ~/.sedano/sedano.db '.tables'   # sessions events prompt_queue requests attachments limits kv
```

If anything goes wrong, the backup is the rollback. A database migrated forward
cannot be read by an older build.

## 2. The hermetic gates

```bash
bun install
bun run check:all
```

Read the verdict line. Every gate must say `ok`; `check:all` exits non-zero
otherwise and names which ones failed. This is the part that must pass on a
clean checkout with nothing running and no personal state — see
[testing](testing.md) for what each gate proves.

## 3. The builds

```bash
bun run build:ui        # the bundle the server serves from dist
bun run sidecar         # bun build --compile → one self-contained server binary
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
bun run desktop:build   # .app + .dmg, bundling the sidecar
```

`build:ui` is already part of `check:all`; run it here only if you are building
without the gates. The sidecar has to exist before `desktop:build`, because Tauri
bundles it as an `externalBin` and expects the target triple in the file name
(`build-sidecar.ts` follows `--target` / `TAURI_ENV_TARGET_TRIPLE`, else the host).
`desktop:build` remaps the build machine's paths; confirm nothing leaked:

```bash
strings -a apps/desktop/src-tauri/target/release/bundle/macos/Sedano.app/Contents/MacOS/sedano | grep -c "$HOME"   # 0
```

Then start the packaged app and confirm the shell's own contract: it attaches to
a server already on `:7788` only if `/api/health` reports `instance: "app"`, the
same home **and the same `version`**; a server of the same instance and home but
another version is stopped (SIGTERM to its pid, after checking it owns the port)
and replaced by the bundled sidecar; any other listener is refused with a
dialog; whatever it started it stops on quit. Check for a stray server process
after quitting. The Rust side of this decision is `cargo test` in
`apps/desktop/src-tauri`.

## 3b. Install & update on this Mac

```bash
bun run install:app               # build, quit the running app, swap into /Applications, relaunch
bun run install:app --rollback    # swap Sedano.app.previous back in
```

- Data: the installed app uses `~/.sedano` and port 7788; development
  (`bun run dev`, `desktop:dev`) uses `~/.sedano-dev` and 7789. Take the store
  backup of step 1 before installing a build with a migration.
- Update = run `install:app` again from the checkout you want. The running app
  is quit through its own quit path, so durable agents survive the swap.
- Rollback keeps the rolled-back-from build as `.previous`, so it can be undone
  by running `--rollback` again. A store migrated forward stays migrated (step 1).
- After an install, check `curl -s 127.0.0.1:7788/api/health` says
  `"instance":"app"` and `"home"` is `~/.sedano`, and that a phone still loads
  over the tailnet (the sidecar serves `Contents/Resources/ui`).
- Testing the installer itself: `--target <dir> --app <bundle> --port <n> --no-launch`
  installs a given bundle into a scratch directory.

## 4. The visual checks

`check:contrast` and `check:ui` ran in step 2 and asserted what can be asserted.
What they cannot assert is whether it looks right, so look at what they left in
`.playwright-mcp/`: the app in light, dark and big-font, the palette, the
launchpad for both an agent and a terminal, settings, and the component gallery
in both themes.

While you are there, open the app and read a real transcript in both themes:
a turn with tools, a subagent card, a question card, and a terminal tab.

## 5. The vendor smokes, by hand

None of these can be gates — each needs an account, a binary or a machine this
repo cannot provide. Run the ones you have, and record which you skipped.

```bash
bun run check:smoke ~/Projects/sedano   # needs `claude` logged in — spends quota
bun run check:term                      # needs tmux
bun run check:term                      # again with a host argument, for the ssh hop
bun run check:term-ui                   # needs tmux and a running server
bun scripts/acp-probe.ts opencode acp   # protocol only, spends nothing
bun scripts/acp-probe.ts codex-acp
bun scripts/acp-probe.ts gemini --acp
```

For each harness you actually ship with, one manual turn is worth more than a
fixture: send a prompt, send a second one while the first is still running (it
must be queued, not lost), answer a question if the harness asks one, press Esc
mid-turn, and check the session lands on `stopped` rather than `error`.

If you have a host in `~/.ssh/config`, do the same once against it: a terminal
tab and one agent session. Then confirm nothing was left behind on the far side.

## 6. Before tagging

- `bun run check:version` — every manifest carries the version you are about
  to tag (`bun scripts/bump-version.ts X.Y.Z` writes them).

- The verdict line of `check:all`, pasted somewhere, with the date.
- Which vendor smokes ran and which did not — a smoke that did not run is not a
  pass.
- Any capability that changed, reflected in [capabilities](capabilities.md). The
  table is only useful while it is true.
