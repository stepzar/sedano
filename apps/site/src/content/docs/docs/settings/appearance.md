---
title: Appearance and interface
description: Theme, typefaces, text sizes and the interface switches in Sedano's Settings.
sidebar:
  order: 1
---

Open Settings with `⌘,`. Sections are listed on the left; the search box filters
every row across all sections. Appearance and interface settings are kept per
device, so a phone and the Mac can differ.

## Appearance

| Setting | What it does |
|---|---|
| Theme | System, Light or Dark |
| Interface typeface | font for the sidebar, tabs and status bar, with a preview |
| Conversation typeface | font for messages and the composer; code stays monospace |
| Conversation text | size in px, also `⌘+` and `⌘−` |
| Interface text | size in px, also `⌥⌘+` and `⌥⌘−` |

The two text sizes are independent. A typeface you type in that is not installed
on the device falls back to the default, and the row says so.

## Interface

| Setting | What it does |
|---|---|
| Sidebar | show or hide the session sidebar, also `⌘B` |
| Show reasoning | show the model's reasoning blocks in the transcript |
| Collapse finished turns | show each finished turn as one line |
| Chime when a turn finishes | play a sound at the end of a turn |
| Show estimated cost | show cost figures; only meaningful on API billing |

## Sessions

**Transfer handoff prompt** is the template used when you transfer a session to
another harness. It can use the fields `{sourceHarness}`, `{sourceSession}`,
`{summary}` and `{remaining}`. **Restore Default** puts the original back.

## Advanced

- **Type scales > Reset to defaults** resets sizes and typefaces.
- **Unhandled events** appears only when a harness sent an event type Sedano
  does not handle yet. They are recorded, not shown in the transcript.

Usage limits and installed software are covered in
[Limits and usage](/docs/settings/limits/) and
[Harnesses and machines](/docs/settings/harnesses/).
