#!/usr/bin/env bun
/**
 * The reply renderer against every GitHub-Flavored Markdown feature the
 * harnesses write, drawn to static markup the way the transcript draws it.
 *
 * "Nothing may be missing": a feature that stops rendering (a nested list
 * flattened to dashes, a checklist shown as brackets) fails here by name. It
 * also holds the safety line — raw HTML in a reply is shown, never run — and
 * keeps the cost of a long reply in sight.
 *
 *   bun scripts/markdown-test.ts
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { renderMarkdown } from '../apps/ui/src/markdown.tsx'
import { FileLinksContext } from '../apps/ui/src/components/FileLink.tsx'

const failures: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? '  ok ' : '  FAIL'} ${label}`)
  if (!ok) failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 400)}`}`)
}
const html = (text: string) => renderToStaticMarkup(renderMarkdown(text))

const FIXTURE = `# Title
## Section
### Sub

Plain **bold** *em* ~~gone~~ \`code\` and a [link](https://example.com), an autolink https://auto.example.com and a [file](src/view.ts).
First line  
second line after a hard break.

- one
- two
  - nested
    1. deep ordered
- [ ] todo
- [x] done

3. three
4. four

> quoted
> > nested quote

| left | centre | right |
|:-----|:------:|------:|
| a    | b      | c     |

\`\`\`ts
const answer = 42
\`\`\`

---

A claim[^source].

![chart](https://example.com/c.png) ![local](./x.png)

<script>alert(1)</script>

Inline <b>raw</b> &amp; entities &lt;ok&gt;

[^source]: The footnote text.
`

const out = html(FIXTURE)
check('headings', /<h3 class="md-heading">Title<\/h3>/.test(out) && /<h4 class="md-heading">Sub<\/h4>/.test(out), out)
check('bold, emphasis, strikethrough', out.includes('<strong>bold</strong>') && out.includes('<em>em</em>') && out.includes('<del>gone</del>'))
check('inline code', out.includes('<code class="md-code">code</code>'))
check('links keep their href', out.includes('href="https://example.com"'))
check('autolinks are links', out.includes('href="https://auto.example.com"'))
check('a relative link is marked as not a web link', out.includes('title="src/view.ts (not a web link)"'))
check('hard breaks', /First line<br\/>/.test(out), out.match(/First line.{0,20}/)?.[0])
check('nested lists stay nested', /<li>two<ul class="md-list"><li>nested<ol class="md-list"><li>deep ordered/.test(out), out.match(/<li>two.{0,120}/)?.[0])
check('task lists are checkboxes', out.includes('type="checkbox"') && /checked=""[^>]*disabled/.test(out) || /disabled=""[^>]*checked=""|checked=""[^>]*disabled=""/.test(out), out.match(/<li class="md-task">.{0,120}/g))
check('ordered lists keep their start', out.includes('<ol class="md-list" start="3">'))
check('nested blockquotes', /<blockquote class="md-quote"><p class="md-p">quoted<\/p><blockquote class="md-quote">/.test(out), out.match(/<blockquote.{0,120}/)?.[0])
check('tables keep their alignment', out.includes('text-align:left') && out.includes('text-align:center') && out.includes('text-align:right'))
check('fenced code keeps its language', out.includes('<pre class="code" data-lang="ts">const answer = 42</pre>'))
check('horizontal rules', out.includes('<hr class="md-rule"/>'))
const footRef = /<sup class="md-footnote-ref"[^>]*><a href="#(md-fn-[\w-]+)">1<\/a><\/sup>/.exec(out)
check('footnote references point at their note', Boolean(footRef && out.includes(`<li id="${footRef[1]}">`)), out.match(/<sup.{0,120}/)?.[0])
check('footnotes are listed at the end', out.lastIndexOf('md-footnotes') > out.lastIndexOf('md-rule') && out.includes('The footnote text.'))
check('a web image is not fetched until asked for', !out.includes('src="https://example.com/c.png"') && out.includes('class="md-image-remote"'), out.match(/md-image.{0,120}/g))
check('and the placeholder says where it would come from', /Load image “chart” from example\.com/.test(out), out.match(/md-image-remote.{0,120}/)?.[0])
check('an inline data image is drawn', html('![dot](data:image/png;base64,iVBORw0KGgo=)').includes('<img class="md-image" src="data:image/png;base64,iVBORw0KGgo="'))
check('an attachment of this app is drawn', html('![pasted](/api/attachment/abc.png)').includes('<img class="md-image" src="/api/attachment/abc.png"'))
check('an http image elsewhere on this machine is not fetched either', !html('![x](http://127.0.0.1:9/a.png)').includes('<img'))
check('a local image is not fetched', out.includes('[image: local]') && !out.includes('src="./x.png"'))
check('raw HTML is shown, never interpreted', !out.includes('<script>') && out.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && !out.includes('<b>raw</b>'))
check('entities read as characters', out.includes('&lt;b&gt;raw&lt;/b&gt; &amp; entities &lt;ok&gt;'), out.match(/Inline.{0,80}/)?.[0])
check('a message without notes has no footnote section', !html('just text').includes('md-footnotes'))
check('a javascript: link is not a web link', html('[x](javascript:alert(1))').includes('not a web link'))

// A long reply stays cheap. This is a guard against a catastrophic regression
// only: Bun's engine runs marked's lexer several times slower than a browser
// and not quite linearly, while in Chrome and WebKit (the desktop shell) the
// same 30k-char reply parses in 3–4ms and 60k in 5–7ms, linear.
const part = (index: number) => `## Part ${index}\n\n${'Some **text** with \`code\` and a [link](https://x.y). '.repeat(8)}\n\n- a\n- b\n  - c\n\n| a | b |\n|---|---|\n| 1 | 2 |\n`
const long = Array.from({ length: 60 }, (_, index) => part(index)).join('\n')
html(long)
const started = performance.now()
for (let index = 0; index < 3; index += 1) html(long)
const perRender = (performance.now() - started) / 3
console.log(`  long reply (${Math.round(long.length / 1000)}k chars): ${perRender.toFixed(1)}ms per render in Bun`)
check('a long reply renders in bounded time', perRender < 1000, perRender)

// A path the session touched is a link to open it; where opening is off (a
// phone, a remote session) the same reply is plain code again.
{
  const reply = 'Created `test.md` — see `useState` and [the file](test.md).'
  const links = { cwd: '/Users/x', touched: ['/Users/x/Desktop/test.md'], open: () => {} }
  const withLinks = renderToStaticMarkup(createElement(FileLinksContext.Provider, { value: links }, renderMarkdown(reply)))
  check('a touched file in code is a link', withLinks.includes('title="Open /Users/x/Desktop/test.md"><code class="md-code">test.md</code>'), withLinks)
  check('code that names no file stays code', withLinks.includes('<code class="md-code">useState</code>') && !withLinks.includes('Open useState'))
  check('a markdown link to a touched file opens it', withLinks.includes('title="Open /Users/x/Desktop/test.md">the file</a>'), withLinks)
  const off = renderToStaticMarkup(createElement(FileLinksContext.Provider, { value: { ...links, open: null } }, renderMarkdown(reply)))
  check('with opening off nothing is a link', !off.includes('file-link'), off)
}

if (failures.length) {
  console.log(`\nmarkdown-test: ${failures.length} FAILURES`)
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exit(1)
}
console.log('\nmarkdown-test: PASSED')
process.exit(0)
