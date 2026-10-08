import { Fragment, memo, useContext, useId, useMemo, useState, type ReactNode } from 'react'
import { Marked, type Token, type Tokens } from 'marked'
import markedFootnote from 'marked-footnote'
import { openExternal } from './native.ts'
import { CodeSpan, FileLinksContext } from './components/FileLink.tsx'
import { fileReference } from './fileLinks.ts'

/** `%20` back to a space; a malformed escape stays as written. */
function safeDecode(text: string): string {
  try {
    return decodeURI(text)
  } catch {
    return text
  }
}

/**
 * Markdown, the way the harnesses write it: CommonMark plus GitHub's
 * extensions — nested and task lists, tables with alignment, strikethrough,
 * autolinks, footnotes, hard breaks.
 *
 * `marked` does the parsing and only the parsing: its token tree is drawn here
 * as React elements, never as an HTML string, so nothing a reply contains can
 * be injected into the page. Raw HTML in a reply is shown as the text it is.
 * The hand-written parser this replaced covered the common shapes and silently
 * flattened the rest — a nested list came out as dashes, a checklist as
 * brackets — and a reply that renders wrong reads as a reply that is wrong.
 */
const parser = new Marked({ gfm: true, breaks: false }).use(markedFootnote())

/** The links worth leaving the app for; anything else is not opened. */
const WEB_LINK = /^(https?:\/\/|mailto:)/i
/** A web image: shown only when asked for (see `RemoteImage`). */
const WEB_IMAGE = /^https?:\/\//i
/** Drawn straight away: inline bytes, or an attachment this app's server holds. */
const INLINE_IMAGE = /^data:image\//i

function ownAttachment(href: string): boolean {
  const api = typeof window !== 'undefined' ? (window as { __SEDANO_API__?: string }).__SEDANO_API__ : undefined
  const prefixes = ['/api/attachment/', ...(api ? [`http://${api}/api/attachment/`] : [])]
  return prefixes.some((prefix) => href.startsWith(prefix))
}

/**
 * A web image in a reply, behind a click.
 *
 * A reply is written by an agent that read whatever it was pointed at, and an
 * image URL is fetched the moment it is drawn — which tells that server you
 * read it, and can carry anything the agent put into the URL. So it waits
 * until the person asks for it, and says where it would come from.
 */
function RemoteImage({ href, alt, title }: { href: string; alt: string; title?: string }) {
  const [shown, setShown] = useState(false)
  if (shown) {
    return <img className="md-image" src={href} alt={alt} title={title} loading="lazy" referrerPolicy="no-referrer" />
  }
  let host = href
  try {
    host = new URL(href).host
  } catch {
    // Kept as written: the button still says what would be fetched.
  }
  return (
    <button type="button" className="md-image-remote" title={href} onClick={() => setShown(true)}>
      Load image{alt ? ` “${alt}”` : ''} from {host}
    </button>
  )
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }

/** The lexer keeps entities as written; text on screen wants the characters. */
function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (whole, name: string) => {
    const lower = name.toLowerCase()
    if (lower.startsWith('#x')) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16))
    if (lower.startsWith('#')) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10))
    return ENTITIES[lower] ?? whole
  })
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  const web = WEB_LINK.test(href)
  const links = useContext(FileLinksContext)
  // A link to a file of the session opens that file, the way its path in
  // backticks does.
  const file = !web && links?.open ? fileReference(safeDecode(href.replace(/^file:\/\//i, '')), links.cwd, links.touched) : null
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      title={web ? href : file ? `Open ${file}` : `${href} (not a web link)`}
      onClick={(event) => {
        // Never let a click navigate the app's own window: a relative link is
        // almost always a file path from the agent's workspace, which means
        // nothing to this page. Web links go to the browser.
        event.preventDefault()
        if (web) void openExternal(href)
        else if (file) links?.open?.(file)
      }}
    >
      {children}
    </a>
  )
}

interface Context {
  /** Prefix for footnote anchors, unique per rendered message. */
  scope: string
}

function inline(tokens: Token[] | undefined, context: Context): ReactNode[] {
  return (tokens ?? []).map((token, index) => <Fragment key={index}>{inlineToken(token, context)}</Fragment>)
}

function inlineToken(token: Token, context: Context): ReactNode {
  switch (token.type) {
    case 'text':
    case 'escape':
      return 'tokens' in token && token.tokens?.length ? inline(token.tokens, context) : decode(token.text)
    case 'strong':
      return <strong>{inline(token.tokens, context)}</strong>
    case 'em':
      return <em>{inline(token.tokens, context)}</em>
    case 'del':
      return <del>{inline(token.tokens, context)}</del>
    case 'codespan':
      return <CodeSpan text={decode(token.text)} />
    case 'br':
      return <br />
    case 'link':
      return <Link href={token.href}>{inline(token.tokens, context)}</Link>
    case 'image':
      if (INLINE_IMAGE.test(token.href) || ownAttachment(token.href)) {
        return <img className="md-image" src={token.href} alt={token.text} title={token.title ?? undefined} loading="lazy" referrerPolicy="no-referrer" />
      }
      if (WEB_IMAGE.test(token.href)) {
        return <RemoteImage href={token.href} alt={token.text} title={token.title ?? undefined} />
      }
      return <span className="md-image-missing">[image: {token.text || token.href}]</span>
    case 'footnoteRef': {
      const ref = token as unknown as { id: string; label: string; index: number }
      return (
        <sup className="md-footnote-ref" id={`${context.scope}-ref-${ref.id}`}>
          <a
            href={`#${context.scope}-fn-${ref.id}`}
            onClick={(event) => {
              event.preventDefault()
              document.getElementById(`${context.scope}-fn-${ref.id}`)?.scrollIntoView({ block: 'nearest' })
            }}
          >
            {ref.index + 1}
          </a>
        </sup>
      )
    }
    case 'html':
      // Shown as written, never interpreted.
      return token.text
    default:
      return 'text' in token && typeof token.text === 'string' ? decode(token.text) : null
  }
}

function blocks(tokens: Token[], context: Context): ReactNode[] {
  return tokens.map((token, index) => <Fragment key={index}>{block(token, context)}</Fragment>)
}

function block(token: Token, context: Context): ReactNode {
  switch (token.type) {
    case 'space':
    case 'def':
      return null
    case 'paragraph':
      return <p className="md-p">{inline(token.tokens, context)}</p>
    case 'text':
      // A tight list item's content: inline, with no paragraph around it.
      return 'tokens' in token && token.tokens?.length ? inline(token.tokens, context) : decode(token.text)
    case 'heading': {
      const Tag = (token.depth <= 2 ? 'h3' : token.depth === 3 ? 'h4' : 'h5') as 'h3' | 'h4' | 'h5'
      return <Tag className="md-heading">{inline(token.tokens, context)}</Tag>
    }
    case 'hr':
      return <hr className="md-rule" />
    case 'code': {
      const code = token as Tokens.Code
      return (
        <pre className="code" data-lang={code.lang || undefined}>
          {code.text}
        </pre>
      )
    }
    case 'blockquote':
      return <blockquote className="md-quote">{blocks(token.tokens ?? [], context)}</blockquote>
    case 'list': {
      const list = token as Tokens.List
      const items = list.items.map((item, index) => (
        <li key={index} className={item.task ? 'md-task' : undefined}>
          {item.task ? <input type="checkbox" checked={Boolean(item.checked)} disabled readOnly aria-label={item.checked ? 'Done' : 'Not done'} /> : null}
          {blocks(item.tokens.filter((child) => child.type !== 'checkbox'), context)}
        </li>
      ))
      return list.ordered ? (
        <ol className="md-list" start={typeof list.start === 'number' && list.start !== 1 ? list.start : undefined}>{items}</ol>
      ) : (
        <ul className={`md-list${list.items.some((item) => item.task) ? ' md-tasks' : ''}`}>{items}</ul>
      )
    }
    case 'table': {
      const table = token as Tokens.Table
      const align = (index: number) => (table.align[index] ? { textAlign: table.align[index]! } : undefined)
      return (
        // The wrapper is what keeps a wide table inside the transcript column:
        // the table scrolls in its own box instead of widening the thread.
        <div className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {table.header.map((cell, index) => (
                  <th key={index} style={align(index)}>{inline(cell.tokens, context)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, index) => (
                    <td key={index} style={align(index)}>{inline(cell.tokens, context)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }
    case 'footnotes': {
      const notes = token as unknown as { items: Array<{ label: string; refs: Array<{ id: string }>; content: Token[] }> }
      // The extension always emits the section; a message with no notes has none.
      if (!notes.items.length) return null
      return (
        <section className="md-footnotes" aria-label="Footnotes">
          <ol>
            {notes.items.map((note) => (
              <li key={note.label} id={`${context.scope}-fn-${note.refs[0]?.id ?? note.label}`}>
                {blocks(note.content, context)}
              </li>
            ))}
          </ol>
        </section>
      )
    }
    case 'html':
      return <p className="md-p">{token.text}</p>
    default:
      return 'text' in token && typeof token.text === 'string' ? <p className="md-p">{decode(token.text)}</p> : null
  }
}

/**
 * Footnotes come out of the lexer first; they belong at the end of the
 * message, where a reader looks for them.
 */
function inReadingOrder(tokens: Token[]): Token[] {
  const notes = tokens.filter((token) => token.type === 'footnotes')
  return [...tokens.filter((token) => token.type !== 'footnotes'), ...notes]
}

/** The token tree of a message; exported for the fixture test. */
export function lexMarkdown(text: string): Token[] {
  return inReadingOrder(parser.lexer(text.replace(/\r\n/g, '\n')))
}

/**
 * Memoised on the text: every streamed token re-renders the running turn, and
 * re-parsing each earlier message of it on every chunk is work for nothing.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }): ReactNode {
  const scope = useId().replace(/:/g, '')
  const tokens = useMemo(() => lexMarkdown(text), [text])
  return <>{blocks(tokens, { scope: `md${scope}` })}</>
})

/** For the fixture test: the same drawing, outside React's rendering. */
export function renderMarkdown(text: string, scope = 'md'): ReactNode {
  return <>{blocks(lexMarkdown(text), { scope })}</>
}
