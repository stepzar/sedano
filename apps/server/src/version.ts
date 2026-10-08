import rootPackage from '../../../package.json'

/**
 * The release this server belongs to. Read from the root `package.json` — the
 * one version source (`scripts/lib/version.ts`) — and inlined by the bundler, so
 * a compiled sidecar reports the version it was built from, not whatever tree it
 * happens to run beside.
 */
export const SEDANO_VERSION: string = rootPackage.version

/** Set by `scripts/build-sidecar.ts` with `--define`; absent when run from source. */
declare const SEDANO_BUILD_ID: string | undefined

/**
 * Which build of that version: `<git describe>@<UTC time>` for a compiled
 * sidecar, `source` for `bun apps/server/src/index.ts`. Diagnostic only — the
 * desktop shell decides on `SEDANO_VERSION` (see `lib.rs`).
 */
export const SEDANO_BUILD: string = typeof SEDANO_BUILD_ID === 'string' ? SEDANO_BUILD_ID : 'source'
