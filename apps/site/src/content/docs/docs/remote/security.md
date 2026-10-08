---
title: Security notes
description: Sedano's threat model - a local API without authentication by design, Origin and Host checks, opt-in Tailscale access, and what a paired device can do.
sidebar:
  order: 3
---

Sedano is a single-user desktop app. It starts coding-agent CLIs and shells on
your behalf, so anyone who can drive its API can run commands as you. The rules
below follow from that.

- **Local API, no authentication by design.** The server listens only on
  `127.0.0.1`. Requests from this Mac are trusted without a token, the same way
  a terminal on your Mac is. Any process on this Mac that can reach the loopback
  port can use it.
- **Browser protections.** Every `/api/*` call and WebSocket upgrade checks the
  `Origin` header against an allowlist (the app's webview and local origins),
  and the `Host` header is checked to block DNS rebinding. A web page open in
  your browser cannot drive the API.
- **Nothing is public.** Remote access is off by default. When on, it goes only
  through `tailscale serve` inside your tailnet. Tailscale Funnel is refused
  when publishing and on every request. With remote mode off, any request that
  came through a proxy is refused, so an accidental `tailscale serve` exposes
  nothing.
- **Devices must pair.** A remote request needs a device token: 256 random bits
  in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie, stored on the Mac only as
  a hash. Pairing codes are one-time, valid for 5 minutes and rate limited. You
  can also restrict access to one Tailscale login.
- **A paired device has full control.** It can start agents, approve their tool
  calls and open terminals, which means it can run any command on the Mac and on
  every SSH host you enabled. Pair only devices you own, and revoke a lost one
  at once.
- **Remote access is managed from the Mac only.** A phone cannot pair more
  devices or change these settings.
- **SSH hosts are an allowlist.** Only the `~/.ssh/config` aliases you enable
  are ever used as an `ssh` destination.
- **No telemetry.** Sedano sends no analytics or usage data. Its outbound
  requests are the ones features need: harness release and model checks, the
  usage endpoints of the harnesses whose limits it shows (see
  [Limits and usage](/docs/settings/limits/)), and Tailscale when remote mode is
  on. The agent CLIs talk to their own vendors under their own terms.
- **Local data.** Sessions and settings live in `~/.sedano`. Credentials of the
  agent CLIs stay where those CLIs keep them; Sedano does not copy them.

Out of scope: attacks that already require code execution as your user, and the
behaviour of the third-party CLIs themselves.

To report a vulnerability, follow the
[security policy](https://github.com/stepzar/sedano/blob/master/SECURITY.md).
Do not open a public issue.
