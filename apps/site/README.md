# Sedano website

The public site: landing page (`/`), download page (`/download`) and docs
(`/docs`, Starlight). Astro, static output, no client framework. The only
JavaScript is small and dependency-free: the hanging-bulb theme switch (shared
with the docs through a Starlight `ThemeSelect` override), the screenshot
lightbox, the landing's two demo frames, and the latest-release lookup on
`/download`.

The landing embeds the interactive demo from `public/demo/` (built separately)
twice: as `/demo/?embed=1&theme=…` in the app window, and as
`/demo/?embed=1&phone=1&theme=…` in its phone layout inside a phone mockup
(loaded only near the viewport). When `public/demo/index.html` is missing at
build time, both show the static screenshots instead.

Re-runnable image scripts (from the repo root): `bun scripts/site-og.ts`
regenerates `public/og-default.png`; `bun scripts/site-phone-shots.ts`
regenerates `public/shots/phone-{light,dark}.webp` from the built site served on
port 4401.

This folder is standalone on purpose: its own `package.json` and `bun.lock`,
not part of the root workspaces, so the app's install and CI are unaffected.

## Develop

```bash
cd apps/site
bun install
bun run dev        # http://localhost:4321
bun run build      # static site in dist/ (Pagefind index + sitemap); fails on a broken docs link
bun run preview    # serve dist/
bunx astro check   # type and template check
```

`SITE_URL` sets the canonical origin used by the sitemap, `robots.txt` and
Open Graph tags (default `https://sedano-fawn.vercel.app`).

## Layout

```
astro.config.mjs          Starlight + sitemap; the docs sidebar (one group per directory)
src/pages/                index, download, 404, robots.txt
src/content/docs/docs/    docs pages, served under /docs/
src/components/doodles/   hand-drawn SVG kit (Squiggle, Circle, Arrow, Note, SketchFrame, Highlighter, Celery)
src/components/           Nav, Footer, Sticker, HarnessLogo, Shot (framed docs screenshot), Starlight overrides
src/styles/tokens.css     design tokens (light + [data-theme=dark])
src/styles/starlight.css  tokens mapped onto Starlight's --sl-* variables
public/shots/             hero screenshots (hero-light.webp, hero-dark.webp)
```

**Docs.** Add a Markdown/MDX file to one of the directories under
`src/content/docs/docs/` and it appears in that sidebar group automatically
(order with `sidebar.order` in frontmatter). Link between docs pages with
root-relative paths (`/docs/settings/limits/`); `starlight-links-validator`
checks every link and anchor at build time and fails the build on a broken one.
In `.mdx` pages, `<Shot>` wraps a screenshot from `public/shots/` in the
hand-drawn frame. A new group is one line in the
`groups` list in `astro.config.mjs`.

**Screenshots.** Drop `hero-light.webp` and `hero-dark.webp` (about 1520×950)
into `public/shots/`; the landing page uses them at build time and shows the
hand-drawn placeholder while either is missing.

**Harness logos** are copied unmodified from
`apps/ui/src/components/Icons.tsx`; keep the two in sync.

## Deploy (Vercel)

- Root directory: `apps/site`
- Install command: `bun install`
- Build command: `bun run build`
- Output directory: `dist`
- Environment: `SITE_URL=https://<your-domain>` once a custom domain exists

The download page reads `releases/latest` from the GitHub API in the browser;
while the repository has no public release it shows the build-from-source path,
and without JavaScript the button links to the releases page.
