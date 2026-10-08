# Using Sedano from your iPhone

Sedano keeps running on the Mac — harness CLIs, `~/.ssh/config` hosts and
sessions all stay there. The phone is a remote screen for it, reached over
[Tailscale](https://tailscale.com): private to your tailnet, HTTPS, never on the
public internet.

The Mac can stay on a **work** tailnet in Tailscale.app. Sedano runs a second,
separate Tailscale instance logged into your **personal** account, and is only
visible there.

## 1. One-time setup

**Personal tailnet.** Sign in at <https://login.tailscale.com> with your personal
account. In *DNS*, turn on **MagicDNS** and **HTTPS Certificates**.

**iPhone.** Install Tailscale from the App Store and sign in with the same
personal account. Leave it connected.

**Mac.** Tailscale.app does not ship the `tailscaled` daemon a second instance
needs; Homebrew does:

```sh
brew install tailscale
```

Do **not** run `brew services start tailscale` or `sudo tailscaled`: those
would start a system daemon competing with Tailscale.app. Sedano runs its own as
a user launchd agent, in userspace-networking mode, with its own state and socket
in `~/.sedano/tailscale` — it does not touch the app, its tailnet or your routes.

## 2. Turn on remote access

Remote access belongs to the installed app (`/Applications/Sedano.app`, port
7788, `~/.sedano`). A development copy (`bun run dev`, `desktop:dev`: port 7789,
`~/.sedano-dev`) can read the status but refuses every change — turning remote
on, pairing, `tailscale serve`, the dedicated daemon — so it can never take the
phone, the tailnet name or the launchd agent away from the real sessions.

Settings → Remote access does this with buttons (remote mode, allowed login,
Tailscale instance, daemon install, login, publish, pairing code with QR, device
list). The same steps from a terminal on the Mac (local requests need no token):

```sh
API=http://127.0.0.1:7788
j() { curl -s -H 'content-type: application/json' "$@"; echo; }

# Use the dedicated instance, only let your personal account in
j -X POST $API/api/remote -d '{"tailscale":{"instance":"dedicated","nodeName":"sedano"},"allowedLogin":"user@example.com"}'

# Install and start the dedicated tailscaled (writes ~/Library/LaunchAgents/dev.sedano.tailscaled.plist)
j -X POST $API/api/remote/tailscale -d '{"action":"daemon-install"}'

# Log it in: open the printed authUrl and sign in with the PERSONAL account
j -X POST $API/api/remote/tailscale -d '{"action":"login"}'

# Check: node.backendState "Running", node.login your personal account,
# node.dnsName sedano.<your-tailnet>.ts.net
j $API/api/remote/tailscale

# Turn remote mode on and publish Sedano on the tailnet (tailscale serve, never funnel)
j -X POST $API/api/remote -d '{"enabled":true}'
j -X POST $API/api/remote/tailscale -d '{"action":"serve-start"}'
```

`serve-start` prints the URL, e.g. `https://sedano.tail1234.ts.net/`. The first
request can take a few seconds while Tailscale issues the certificate.

## 3. Pair the phone

On the Mac:

```sh
j -X POST $API/api/remote/pairing
```

That returns a code like `K7QM-3XPA` (valid 5 minutes, usable once) and a `url`
with the code in it. On the iPhone open the URL in Safari (or open the base URL
and type the code), tap **Pair**. Sedano opens; the phone stays paired.

**Home-screen app.** Safari → Share → *Add to Home Screen*. iOS gives a home-screen
app its own cookies, so it shows the pairing page again the first time: make a
new code on the Mac and pair once more inside it.

If the phone ever opens Sedano *without* asking to pair first, turn remote mode
off and report it — it means the request was not recognised as remote.

## 4. Keep the Mac reachable

The phone can only reach Sedano while the Mac is awake and online.

- Plugged in: System Settings → Battery (or Energy) → Options → turn on
  **Prevent automatic sleeping when the display is off** and **Wake for network
  access**.
- Or keep it awake only while you need it: `caffeinate -is` in a terminal
  (stops when you press ⌃C).
- A closed MacBook lid sleeps regardless, unless it is plugged in with an external
  display.

## 5. Manage devices and turn it off

```sh
j $API/api/remote                                   # devices, with login and last seen
j -X DELETE $API/api/remote/devices/<id>            # revoke one; its open session drops at once
j -X POST $API/api/remote/tailscale -d '{"action":"serve-stop"}'
j -X POST $API/api/remote -d '{"enabled":false}'
j -X POST $API/api/remote/tailscale -d '{"action":"daemon-uninstall"}'
```

Uninstalling keeps the login in `~/.sedano/tailscale`; delete that folder and
remove the `sedano` machine in the admin console to forget it completely.

## 6. Check it on the iPhone

The layout is tested in an emulated iPhone, but a few things only a real phone
shows. Once paired, in Safari **and** in the Home-screen app:

- [ ] The top bar starts right under the clock/notch — no empty band above it,
      nothing hidden under the notch; the bottom bar clears the home indicator.
- [ ] Rotate to landscape and back: nothing overflows sideways, the notch side
      is padded.
- [ ] Tap the sidebar button, then swipe in from the left edge: the drawer
      opens; tapping a session opens it and closes the drawer.
- [ ] Tap the message field: the keyboard opens, the field and Send stay
      visible right above it, the page does not zoom in.
- [ ] Tap the model chip under the field: model, effort and approvals appear
      in full; change one.
- [ ] Tap the picture button: pick a photo (and try the camera); a thumbnail
      and its image chip appear; send it.
- [ ] Long-press a session in the drawer or a tab: Rename / Pin / Delete appear.
- [ ] Scroll a long transcript: it scrolls smoothly, the page itself never
      bounces.
- [ ] Open the quick terminal (tab bar → Terminal): it rises as a sheet, the
      grab bar resizes it, the keyboard types into the shell.
- [ ] Tap Limits at the bottom: the panel opens and fits the screen.
- [ ] Settings has no Remote access section on the phone.
- [ ] On the Mac, revoke the phone: the phone shows the pairing page within a
      second (or at its next tap).

## Security notes

- Sedano listens on 127.0.0.1 only. Tailscale serve is the only way in, and only
  for devices on your tailnet. Funnel is refused both when starting and per
  request.
- With remote mode off, any request that came through a proxy is refused — an
  accidental `tailscale serve` exposes nothing.
- Only the exact tailnet name is accepted as Host/Origin; every other name is
  refused (DNS-rebinding protection is unchanged for local use).
- Every remote request needs a device token: a random 256-bit value in an
  HttpOnly, Secure, SameSite=Strict cookie, stored on the Mac only as a hash.
  Pairing codes are one-time, short-lived and rate-limited.
- `allowedLogin` rejects any Tailscale account but yours, even with a valid token,
  and `serve-start` refuses to publish on an instance logged into another
  account (e.g. the work tailnet).
- A paired phone has the same power as the Mac's UI — it can start agents that
  run commands. Revoke a lost phone immediately (step 5), or remove it from your
  tailnet.
- Remote access is managed from the Mac only; a phone cannot pair more devices
  or change these settings.
