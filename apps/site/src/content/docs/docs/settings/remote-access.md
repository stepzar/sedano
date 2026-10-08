---
title: Remote access
description: The Remote access section of Settings - remote mode, Tailscale instance, publishing, pairing codes and paired devices.
sidebar:
  order: 5
---

**Settings > Remote access** controls access from a phone or another device over
Tailscale. It exists only in the installed app on the Mac: a development copy
shows the status but refuses changes, and a paired phone does not show the
section at all.

| Control | What it does |
|---|---|
| Remote mode | off by default; while off, any proxied request is refused |
| Reachable at | the tailnet URL devices use |
| Only this Tailscale login | optional; any other Tailscale account is refused even with a valid device token |
| Tailscale | which instance serves Sedano: **Tailscale app** or **Dedicated** |
| Install daemon / Uninstall daemon | the dedicated `tailscaled`, as a user launchd agent |
| Log in… | sign the dedicated instance in to your account |
| Serve / Stop publishing | `tailscale serve` on and off (never Funnel) |
| Pair a device | a one-time code and QR code, valid for 5 minutes |
| Paired devices | each device's login and last use, with **Revoke** |

Settings are stored in `~/.sedano/remote.json`, readable only by your user.

The full walkthrough is in [Phone over Tailscale](/docs/remote/phone/), and the
threat model in [Security notes](/docs/remote/security/).
