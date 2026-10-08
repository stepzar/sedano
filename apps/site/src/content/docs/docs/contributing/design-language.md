---
title: Design language
description: The app's visual rules - one neutral accent, hairlines, two surface levels, a 4px grid, CSS-variable themes and enforced contrast.
sidebar:
  order: 5
---

The app is deliberately quiet: one accent, hairlines instead of borders, two
surface levels, a 4px spacing grid and a single type scale for the interface.

| Token group | Values |
|---|---|
| Accent | neutral ink `#0d0d0d` (light) / `#ececec` (dark), chroma 0, asserted by `check:ui` |
| Surfaces | `--bg` `--surface` `--surface-2` `--surface-3` `--sunken` |
| Text | `--fg` `--fg-2` `--fg-mute` `--fg-faint` |
| Radii | 4 / 6 / 8 / 11 / 14 px |
| Type | system UI stack, `--ui-font-size` (chrome) and `--content-font-size` (conversation) |
| Motion | 130ms, `cubic-bezier(.22,.61,.36,1)`, off under `prefers-reduced-motion` |

## Rules

- **Achromatic.** Surfaces and the accent carry no hue. The only tinted tokens
  are semantic (`--ok`, `--warn`, `--err`, `--info`) and the running-state dot.
- **Themes are token overrides.** Everything is a CSS variable in
  `apps/ui/src/styles.css`: no rebuild, no CSS-in-JS.
- **One popover primitive** draws every menu. There is no native `<select>`
  anywhere, and `check:ui` asserts it.
- **Contrast is enforced.** `bun run check:contrast` walks the rendered app and
  the gallery in both themes and fails if any text and background pair drops
  below its floor.

To review a change without spending quota, use the gallery at
`http://localhost:5174/preview.html` (add `?theme=dark` for dark); see
[Dev setup](/docs/contributing/dev-setup/#component-gallery).

This website uses its own, separate look (ink on paper, a blue pen accent); it
does not follow these app tokens.
