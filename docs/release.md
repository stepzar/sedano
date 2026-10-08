# Releasing Sedano

How a version goes from this repository to the Macs of the people using it,
and how it is taken back if it is wrong. The pre-flight checks (gates, vendor
smokes, the store) are in [the release checklist](release-checklist.md); this
page is the procedure around them.

## The pieces

| Piece | Where | What it does |
|---|---|---|
| Version | root `package.json` | The one source. `tauri.conf.json` points at it; `bump-version.ts` writes the manifests that need a literal; `check:version` fails on drift. |
| Release workflow | `.github/workflows/release.yml` | On a `v*` tag: builds the app on an Apple Silicon runner, signs it, and creates a **draft** GitHub release with the DMG, the updater bundle (`.app.tar.gz` + `.sig`) and `latest.json`. |
| Updater | `tauri-plugin-updater`, `apps/ui/src/updater.ts` | The installed app reads `https://github.com/stepzar/sedano/releases/latest/download/latest.json` at launch and every 4 hours, verifies the download against the public key compiled into it, installs, and restarts when the user says so. |
| Updater key | owner's machine + GitHub secret | Signs every update. The app only installs what this key signed. |
| Apple signature | GitHub secrets (optional) | Decides what Gatekeeper says on first launch. None today: the app is ad-hoc signed. |
| Store backup | `apps/server/src/db-backup.ts` | The first open by a release that changes the schema keeps `~/.sedano/sedano.db.bak-<previous version>` (last three). |
| Stale-server guard | `lib.rs` (`classify`) | An app never attaches to a server of another version left on its port; it stops that one and starts its own. |

## Before the first release (owner, once)

### 1. The repository must be reachable without a login

The updater and the download link fetch release assets **anonymously**. On a
private repository `releases/latest/download/...` answers 404 to everyone but
you, so the app would report "Update check failed" forever. Either make
`stepzar/sedano` public, or publish releases to a separate public repository
(e.g. `stepzar/sedano-releases`): set `owner`/`repo` on the tauri-action step,
give the workflow a token that can write there, and change the endpoint in
`tauri.conf.json` to that repository.

### 2. The updater key

```bash
bunx tauri signer generate -w ~/.tauri/sedano.key
```

It asks for a password; use a long one from your password manager. It writes
two files:

- `~/.tauri/sedano.key` — the **private** key. Never commit it, never paste it
  in an issue or a chat.
- `~/.tauri/sedano.key.pub` — the public key.

Then:

1. Put the content of `sedano.key.pub` (one base64 line) in
   `apps/desktop/src-tauri/tauri.conf.json` → `plugins.updater.pubkey`,
   replacing the `PLACEHOLDER-…` value, and commit it. The release workflow
   refuses to build while the placeholder is there.
2. In GitHub → Settings → Secrets and variables → Actions, add:
   - `TAURI_SIGNING_PRIVATE_KEY` — the content of `~/.tauri/sedano.key`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — its password
3. Back the key up: the private key file **and** its password, in your password
   manager (as a secure note / attachment) and on one offline medium. Check the
   backup can be read.

Key custody, plainly: whoever has the key and its password can push code to
every installed Sedano. If the key is **lost**, installed apps can never be
updated again — every user has to download a new DMG by hand, built with a new
key. If it **leaks**, generate a new key, ship one release signed with the
*old* key that carries the *new* public key, then revoke the old secrets.

### 3. Signing mode (Gatekeeper)

Nothing to do for the free path. The workflow picks the mode from the secrets
that exist, and the same file works for both:

**Ad-hoc (today, free).** No Apple secrets → the bundle is signed with `-`
(ad-hoc) with the hardened runtime and `Entitlements.plist`. It is not
notarized, so on first launch macOS says it cannot verify the developer. The
user, once:

- macOS 15 and later: open the app, dismiss the warning, then System Settings →
  Privacy & Security → scroll to "Sedano was blocked…" → **Open Anyway**, and
  confirm with the password.
- macOS 13–14: right-click (Control-click) Sedano in Applications → **Open** →
  **Open**.
- Or in Terminal, after copying it to Applications:
  `xattr -dr com.apple.quarantine /Applications/Sedano.app`

Updates installed by the app itself are not quarantined, so this happens once
per Mac, not once per version.

**Developer ID + notarization ($99/year Apple Developer Program).** Then:

1. Enrol at <https://developer.apple.com/programs/> (individual is fine; Apple
   verifies identity, can take a day or two).
2. Xcode → Settings → Accounts → Manage Certificates → **+** →
   *Developer ID Application*. Export it from Keychain Access as a `.p12` with
   a password.
3. App Store Connect → Users and Access → Integrations → **App Store Connect
   API** → generate a key with the *Developer* role; download the `.p8` (only
   once), note the Key ID and the Issuer ID.
4. Add these repository secrets:
   - `APPLE_CERTIFICATE` — `base64 -i DeveloperID.p12 | pbcopy`
   - `APPLE_CERTIFICATE_PASSWORD` — the `.p12` password
   - `APPLE_SIGNING_IDENTITY` — e.g. `Developer ID Application: Your Name (TEAMID)`
     (`security find-identity -v -p codesigning`)
   - `APPLE_API_ISSUER` — the Issuer ID
   - `APPLE_API_KEY` — the Key ID
   - `APPLE_API_PRIVATE_KEY` — the content of the `.p8` file (the workflow
     writes it to a file and passes `APPLE_API_KEY_PATH` to Tauri)

   Instead of the API key you can set `APPLE_ID`, `APPLE_PASSWORD` (an
   app-specific password from appleid.apple.com) and `APPLE_TEAM_ID`.

The next tag is signed and notarized; nothing in the workflow changes. The
step "signing mode" in the run log says which mode was used. A certificate
without notarization credentials is signed but **not** notarized, which
Gatekeeper treats like the free path — the log warns about it.

Why the entitlements: the server inside the app is a `bun build --compile`
executable. Under the hardened runtime (required for notarization)
JavaScriptCore's JIT needs `com.apple.security.cs.allow-jit` and
`com.apple.security.cs.allow-unsigned-executable-memory`. The plist has no
comments because `codesign` refuses XML comments in entitlements.

Why bun ≥ 1.2.4: older `bun build --compile` output fails `codesign` strict
validation, so Tauri could not sign the bundle at all (ad-hoc included).
`ci.yml` and `release.yml` pin the same bun.

## Cutting a release

1. **Pre-flight.** Work through [the release checklist](release-checklist.md)
   on the commit you intend to tag (`check:all`, the vendor smokes, the store).
2. **Bump.**
   ```bash
   bun scripts/bump-version.ts 0.2.0
   bun run check:version
   git commit -am "Release 0.2.0"
   ```
   Merge that to `master` through a PR like any change.
3. **Tag** the merged commit and push the tag:
   ```bash
   git tag v0.2.0 && git push origin v0.2.0
   ```
   The workflow refuses a tag that does not match `package.json`. It can also
   be started by hand (Actions → release → Run workflow); the draft is then
   named after the version in `package.json`.
4. **Wait for the draft.** Actions → release. The draft release `v0.2.0` holds
   `Sedano_0.2.0_aarch64.dmg`, `Sedano_aarch64.dmg` (same file, stable name),
   `Sedano_0.2.0_aarch64.app.tar.gz` + `.sig`, and `latest.json`. A draft is
   invisible to the updater and to `releases/latest/...` links.
5. **Smoke test on a clean Mac** — a second macOS user account, or a VM (UTM
   with a macOS guest). Not your own account: it has `~/.sedano`, PATH and
   harnesses that hide first-run problems.
   - Download `Sedano_aarch64.dmg` **through a browser** (so it is
     quarantined like a user's), drag to Applications, open it. Note exactly
     what Gatekeeper says; it must match the mode in the run log.
   - The window opens, `curl -s 127.0.0.1:7788/api/health` shows the new
     `version`, a session starts with a harness installed in that account.
   - Settings → Advanced → Version shows the version; **Check for updates**
     says it is the latest (or errors visibly if the repo is not public yet).
   - Quit: no `sedano-server` process is left (`pgrep -fl sedano-server`).
   - Upgrade path: install the *previous* release first, open it, then publish
     (step 6) and confirm the pill offers the update, installs it, and the
     restart lands on the new version with the sessions intact and
     `~/.sedano/sedano.db.bak-<old>` present if the schema changed.
6. **Publish.** Edit the draft, write the notes (what changed for a user), make
   sure "Set as the latest release" is ticked, **Publish release**. From this
   moment `releases/latest/download/latest.json` and `…/Sedano_aarch64.dmg`
   point to it.

## How updates reach users

An installed app checks `latest.json` ten seconds after launch and every four
hours. If its `version` is newer, a pill appears in the bottom-right corner:
**Update to X** → it downloads the `.app.tar.gz`, verifies the signature
against the public key compiled into the running app, and replaces
`Sedano.app` → **Restart to update** → asks, then quits and reopens. Quitting
stops the old server (and if one is somehow left, the new app replaces it
rather than attach). Durable agents run in their own process groups and keep
running across the restart. Any failure stays visible in the pill and in
Settings → Advanced → Version; nothing retries silently.

Nothing is checked under `tauri dev`, in a browser tab or on a paired phone.

## Rollback

The updater only moves forward to a higher version, so a rollback is a new,
higher release:

1. **Stop the spread**: edit the bad release on GitHub and either mark the
   previous good one as latest or turn the bad one back into a draft. Apps that
   have not updated stop seeing it within four hours. (Deleting assets breaks
   people mid-download; un-publishing is enough.)
2. **Ship the fix as `X.Y.Z+1`** — usually `git revert` of the culprit, bump,
   tag. Users on the bad version update to it like any other release.
3. **The store.** If the bad release migrated the schema, an older build cannot
   read the store. Its pre-migration copy is
   `~/.sedano/sedano.db.bak-<version it migrated from>`. To go back by hand on
   one Mac: quit Sedano, `mv ~/.sedano/sedano.db ~/.sedano/sedano.db.broken`,
   `rm -f ~/.sedano/sedano.db-wal ~/.sedano/sedano.db-shm`,
   `cp ~/.sedano/sedano.db.bak-<v> ~/.sedano/sedano.db`, install the older DMG.
   Anything written after the migration is in the `.broken` copy only.

## Intel

Not built yet. The pieces are ready: `scripts/build-sidecar.ts` follows
`TAURI_ENV_TARGET_TRIPLE` and cross-compiles the server with bun, and the
release job is a matrix with one entry. Add
`- { target: x86_64-apple-darwin, arch: x64 }` to it; the tauri-action merges
both architectures into the same `latest.json` and the stable name becomes
`Sedano_x64.dmg`. Smoke-test it on an Intel Mac or with Rosetta.

## Local builds

`bun run desktop:build` builds `.app` + `.dmg` for this Mac without signing
and without updater artifacts (those come from `tauri.release.conf.json`, used
only by the workflow), so it needs neither key. `bun run install:app` is the
way to put a local build in `/Applications`.

To reproduce the release build locally, with a **throwaway** key:

```bash
bunx tauri signer generate --ci -p test -w /tmp/k/test.key
TAURI_SIGNING_PRIVATE_KEY="$(cat /tmp/k/test.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD=test \
APPLE_SIGNING_IDENTITY=- \
  bun run desktop:build --config apps/desktop/src-tauri/tauri.release.conf.json
```

If ad-hoc signing fails with `failed to run xattr`, a Python `xattr` package
is shadowing `/usr/bin/xattr` on your PATH; run the build with
`PATH=/usr/bin:$PATH`.
