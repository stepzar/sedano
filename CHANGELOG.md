# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Apache-2.0 license, NOTICE, contributing guide, code of conduct, security
  policy, issue and pull request templates.

### Changed

- Coverage extractor tests use hand-written fixtures instead of excerpts of
  vendor packages.
- Test data uses neutral placeholder identities.

## [0.1.0] - 2026-10-07

First public version.

### Added

- One window over several coding-agent CLIs: Claude Code (native stream-json
  adapter with live subagents), Codex, Gemini CLI, Grok and opencode over the
  Agent Client Protocol, Command Code (headless NDJSON) and Freebuff (terminal
  UI).
- A normalized event domain, so messages, tool calls, questions and turn
  boundaries look the same for every harness.
- Terminal tabs backed by `tmux`, locally or on an enabled SSH host, that
  survive closing the app.
- SSH hosts from `~/.ssh/config` as an explicit allowlist.
- Subscription limits, token and cost metrics where a harness reports them.
- Prompt queue that survives restarts, session import from the harnesses' own
  stores, and session transfer between harnesses.
- Background checks for harness updates and model lists, with explicit
  installs.
- Remote mode over Tailscale Serve with pairing codes, for using the app from a
  phone.
- macOS desktop app built with Tauri.
- Hermetic test suite with fake CLIs and transports, plus a daily protocol
  coverage workflow.

[Unreleased]: https://github.com/stepzar/sedano/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/stepzar/sedano/releases/tag/v0.1.0
