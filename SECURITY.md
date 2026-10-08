# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately
through [GitHub Security Advisories](../../security/advisories/new) on this
repository. Include the version or commit, the steps to reproduce, and the
impact you expect. You will get an answer as soon as possible, and a fix will be
coordinated with you before anything is disclosed.

Only the latest release and the `master` branch receive security fixes.

## Threat model

Sedano is a single-user desktop app. It starts coding-agent CLIs and shells on
your behalf, so anyone who can drive its API can run commands as you. The design
choices below follow from that.

- **Local API, no authentication by design.** The server listens only on
  `127.0.0.1`. Requests from this machine are trusted without a token, the same
  way a terminal on your machine is trusted. Any process on this machine that can
  reach the loopback port can use it.
- **Browser protections.** Every `/api/*` call and websocket upgrade checks the
  `Origin` header against an allowlist (the Tauri webview and `localhost` /
  `127.0.0.1` / `[::1]`), and the `Host` header is checked to block DNS
  rebinding. A web page open in your browser cannot drive the API.
- **Remote mode is opt-in and goes only through Tailscale.** When enabled, the
  app is published with Tailscale Serve on a separate Tailscale instance, over
  HTTPS, inside your tailnet and never on the public internet. A new device must
  enter a pairing code (valid for five minutes) shown on the Mac, then receives a device
  token (stored hashed, revocable from Settings). You can also restrict access
  to one Tailscale login. Wrong pairing codes are rate limited.
- **A paired device has full control.** It can start agent sessions, approve
  their tool calls and open terminals, which means it can run arbitrary commands
  on the Mac and on every SSH host you enabled. Pair only devices you own, and
  revoke the ones you no longer use.
- **SSH hosts are an allowlist.** Only the `~/.ssh/config` aliases you enable in
  Settings are ever used as an `ssh` destination.
- **No telemetry.** Sedano sends no analytics or usage data. Its outbound
  requests are the ones the features need: harness release and model checks,
  the subscription-usage endpoints of the harnesses whose limits it shows, and
  Tailscale when remote mode is on. The agent CLIs themselves talk to their own
  vendors under their own terms.
- **Local data.** Sessions and settings live in `~/.sedano` (a SQLite file);
  paired-device tokens are stored hashed in a file readable only by your user. Credentials of the agent
  CLIs stay where those CLIs keep them; Sedano does not copy them.

Out of scope: attacks that already require code execution as your user, and
the behaviour of the third-party agent CLIs themselves.
