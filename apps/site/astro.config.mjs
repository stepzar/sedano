// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import sitemap from '@astrojs/sitemap';
import starlightLinksValidator from 'starlight-links-validator';

const site = process.env.SITE_URL || 'https://sedano-fawn.vercel.app';

// One sidebar group per docs directory. `autogenerate` picks up every new file
// dropped into that directory, so migrating content needs no config change.
const groups = [
  ['Getting started', 'getting-started'],
  ['Harnesses', 'harnesses'],
  ['Remote & mobile', 'remote'],
  ['Settings', 'settings'],
  ['Updates', 'updates'],
  ['Contributing', 'contributing'],
  ['FAQ', 'faq'],
];

export default defineConfig({
  site,
  output: 'static',
  trailingSlash: 'ignore',
  integrations: [
    starlight({
      title: 'Sedano',
      description: 'One app to rule all your coding agents.',
      favicon: '/favicon.svg',
      disable404Route: true,
      // Fails the build on a broken internal link or anchor in the docs.
      plugins: [starlightLinksValidator()],
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/stepzar/sedano' }],
      customCss: [
        '@fontsource-variable/inter',
        '@fontsource-variable/jetbrains-mono',
        './src/styles/tokens.css',
        './src/styles/starlight.css',
      ],
      components: {
        SiteTitle: './src/components/starlight/SiteTitle.astro',
        ThemeSelect: './src/components/starlight/ThemeSelect.astro',
        Footer: './src/components/starlight/Footer.astro',
      },
      head: [
        { tag: 'link', attrs: { rel: 'author', href: 'https://stefanozarro.com' } },
        { tag: 'meta', attrs: { property: 'og:image', content: new URL('/og-default.png', site).href } },
      ],
      sidebar: groups.map(([label, directory]) => ({
        label,
        items: [{ autogenerate: { directory: `docs/${directory}` } }],
      })),
    }),
    sitemap(),
  ],
});
