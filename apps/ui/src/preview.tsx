/**
 * Component gallery — dev only (`/preview.html`).
 *
 * Renders the transcript with realistic fixtures plus every primitive in both
 * themes, so design work and visual review never need a live session.
 *
 *   /preview.html?theme=dark&ui=12.5&content=14.5
 */
import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { ErrorCard, Transcript } from './components/Transcript.tsx'
import { ContextMeter, StatusBar, SubagentMenu } from './components/Chrome.tsx'
import { MenuTrigger } from './components/Menu.tsx'
import {
  FIXTURE_FAILURES,
  fixtureFailureCases,
  fixtureContextInferred,
  fixtureContextReported,
  fixtureContextUnknown,
  fixtureCostUnreported,
  fixtureCostZero,
  fixtureEvents,
  fixtureLive,
  fixtureSession,
  fixtureSettings,
  fixtureStaleLive,
  fixtureState,
  fixtureTableMarkdown,
  fixtureTurnCases,
  fixtureHarnessCases,
  fixtureWideTableMarkdown,
} from './fixtures.ts'
import { Markdown } from './markdown.tsx'
import type { UiSettings } from './store.ts'
import {
  IconAgent,
  IconCaret,
  IconClose,
  IconCopy,
  IconError,
  IconInfo,
  IconMic,
  IconMoon,
  IconPlus,
  IconSearch,
  IconSend,
  IconSettings,
  IconSidebar,
  IconStar,
  IconSuccess,
  IconSun,
  IconTerminal,
  IconWarning,
} from './components/Icons.tsx'

const params = new URLSearchParams(location.search)
const theme = params.get('theme') === 'dark' ? 'dark' : 'light'
document.documentElement.dataset.theme = theme
document.documentElement.style.setProperty('--ui-font-size', `${params.get('ui') ?? 12.5}px`)
document.documentElement.style.setProperty('--content-font-size', `${params.get('content') ?? 14.5}px`)

const settings: UiSettings = { ...fixtureSettings, theme }

/**
 * `?live=stale` replays the state a dropped socket leaves behind: the buffer
 * still holds the first turn's reply while the second turn is on screen. The
 * transcript must drop it — the timeline already contains that text — and the
 * gallery is the only place that state can be staged, since it needs a socket to
 * die mid-stream and a timeline to arrive after it.
 */
const live = params.get('live') === 'stale' ? fixtureStaleLive : fixtureLive

const SESSIONS = [
  { title: 'Add a rate limiter to /api/orders', harness: 'Claude Code', model: 'opus', time: 'now', active: true },
  { title: 'Fix the flaky billing webhook test', harness: 'Claude Code', model: 'sonnet', time: '1h' },
  { title: 'Migrate the legacy CSV importer', harness: 'Codex', model: 'gpt-5.6', time: '3h' },
  { title: 'Document the deploy runbook', harness: 'Claude Code', model: 'haiku', time: '2d' },
]

function Caption({ children }: { children: React.ReactNode }) {
  return <div className="rail-title" style={{ padding: '0 0 6px' }}>{children}</div>
}

function Gallery() {
  const [toggle, setToggle] = useState(true)

  return (
    <div className="app">
      <div className="bar">
        <span className="brand">sedano</span>
        <span className="crumb">
          <span>acme-api</span>
          <span className="path">/Users/you/Projects/acme-api</span>
          <span className="chip mono">feat/rate-limit</span>
        </span>
        <span className="spacer" />
        <div className="bar-actions">
          <button className="icon-btn" title="New tab">
            <IconPlus />
          </button>
          <button className="icon-btn" title="Sidebar">
            <IconSidebar />
          </button>
          <button className="icon-btn" title="Theme">
            <IconMoon />
          </button>
          <button className="icon-btn" title="Appearance">
            <IconSettings />
          </button>
          <span className="chip mono">
            <span className="dot running" />
            live
          </span>
        </div>
      </div>

      <div className="body">
        <div className="rail">
          <div className="rail-inner">
            <div className="rail-search">
              <IconSearch />
              <input placeholder="Search sessions" readOnly />
            </div>
            <div className="rail-section">
              <div className="rail-title">
                <IconStar size={14} /> Pinned
              </div>
              <div className="session-item">
                <div className="title">Deploy runbook for prod</div>
                <div className="meta">
                  <span className="dot idle" />
                  <span>Claude Code</span>
                  <span className="sep">·</span>
                  <span>4d</span>
                </div>
                <div className="right always">
                  <button className="pin-btn on">
                    <IconStar size={14} />
                  </button>
                </div>
              </div>
            </div>
            <div className="rail-section">
              <div className="rail-title">
                <IconSidebar size={14} /> Workspaces
                <span className="count">4</span>
              </div>
              <div className="rail-title">
                <span className="chevron">
                  <IconCaret size={16} />
                </span>
                <span style={{ textTransform: 'none', letterSpacing: 0, fontSize: '1.06em' }}>acme-api</span>
                <span className="dot running" />
                <span className="count">3</span>
              </div>
              {SESSIONS.slice(0, 3).map((session) => (
                <div key={session.title} className={`session-item${session.active ? ' active' : ''}`}>
                  <div className="title">{session.title}</div>
                  <div className="meta">
                    <span className={`dot ${session.active ? 'running' : 'idle'}`} />
                    <span>{session.harness}</span>
                    <span className="sep">·</span>
                    <span className="mono">{session.model}</span>
                    <span className="sep">·</span>
                    <span>{session.time}</span>
                  </div>
                </div>
              ))}
              <div className="rail-title">
                <span className="chevron open">
                  <IconCaret size={16} />
                </span>
                <span style={{ textTransform: 'none', letterSpacing: 0, fontSize: '1.06em' }}>platform-infra</span>
                <span className="count">1</span>
              </div>
              <div className="session-item">
                <div className="title">Document the deploy runbook</div>
                <div className="meta">
                  <span className="dot idle" />
                  <span>Claude Code</span>
                  <span className="sep">·</span>
                  <span>2d</span>
                </div>
              </div>
            </div>
          </div>
          <div className="rail-foot">
            <span>9 sessions · 4 workspaces</span>
          </div>
        </div>

        <div className="pane">
          <div className="tabs">
            <div className="tab active">
              <span className="dot running" />
              <span className="label">Add a rate limiter to /api/orders</span>
              <span className="x">×</span>
            </div>
            <div className="tab">
              <span className="dot idle" />
              <span className="label">Fix the flaky billing webhook test</span>
              <span className="x">×</span>
            </div>
            <button className="tab-add">
              <IconPlus size={16} />
            </button>
            <span className="spacer" />
            <div className="row">
              <button className="icon-btn">
                <IconStar size={16} />
              </button>
              <button className="icon-btn">
                <IconCopy size={16} />
              </button>
            </div>
          </div>

          <Transcript session={fixtureSession} events={fixtureEvents} live={live} settings={settings} connected foldFinished={false} />

          <div className="composer">
            <div className="composer-inner">
              <textarea rows={1} placeholder="Message Claude Code" readOnly />
              <div className="composer-row">
                <div className="composer-controls" aria-label="Message options">
                <ContextMeter session={fixtureSession} />
                <span className="chip-select">
                  Opus
                  <span className="caret">▾</span>
                </span>
                <span className="chip-select">
                  high effort
                  <span className="caret">▾</span>
                </span>
                <span className="chip-select">
                  accept edits
                  <span className="caret">▾</span>
                </span>
                </div>
                <div className="composer-actions">
                <button className="send">
                  <IconSend />
                </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* The app's own status bar, fed the widest state it ever has to draw: five
          harnesses reporting, a running session with metrics, and subagents. It
          used to be hand-written markup here, which meant the one surface a
          check can measure was a copy of the bar rather than the bar. */}
      <StatusBar state={fixtureState} session={fixtureSession} />

      {/* ---------------- primitives ---------------- */}
      <div
        style={{
          position: 'fixed',
          // Above the transcript's own layers (the pinned thinking block sits at
          // 6), or message text paints over the primitives and their captions.
          zIndex: 20,
          right: 16,
          bottom: 40,
          width: 330,
          maxHeight: 'calc(100vh - 90px)',
          overflowY: 'auto',
          padding: 14,
          borderRadius: 'var(--r-xl)',
          background: 'var(--surface)',
          border: '1px solid var(--line-strong)',
          boxShadow: 'var(--shadow-3)',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        <Caption>Buttons</Caption>
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          <button>Default</button>
          <button className="primary">Primary</button>
          <button className="ghost">Ghost</button>
          <button disabled>Disabled</button>
          <button className="icon-btn">
            <IconSun size={16} />
          </button>
        </div>

        <Caption>Chips · dots · meters</Caption>
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          <span className="chip">chip</span>
          <span className="chip mono">+18 −4</span>
          <span className="chip accent">running</span>
          <span className="chip warn">68%</span>
          <span className="chip err">failed</span>
          <span className="dot running" />
          <span className="dot idle" />
          <span className="dot error" />
        </div>
        <div className="row" style={{ gap: 14 }}>
          <span className="meter">
            <span className="label">5h</span>
            <span className="track">
              <span className="fill" style={{ width: '22%' }} />
            </span>
            <span className="mono">22%</span>
          </span>
          <span className="meter">
            <span className="label">7d</span>
            <span className="track">
              <span className="fill warn" style={{ width: '76%' }} />
            </span>
            <span className="mono">76%</span>
          </span>
          <span className="meter">
            <span className="label">ctx</span>
            <span className="track">
              <span className="fill err" style={{ width: '94%' }} />
            </span>
            <span className="mono">94%</span>
          </span>
        </div>

        {/* The same readouts the app draws, each fed the metrics of one harness:
            the point is which SessionMetrics produces which reading, so every
            case renders the real component rather than a copy of its markup. */}
        <Caption>Context ring</Caption>
        <div className="row" style={{ flexWrap: 'wrap', gap: 14 }}>
          {[
            { id: 'ctx-reported', label: 'Reported', session: fixtureContextReported },
            { id: 'ctx-inferred', label: 'Estimated', session: fixtureContextInferred },
            { id: 'ctx-unknown', label: 'Not Reported', session: fixtureContextUnknown },
          ].map((item) => (
            <span key={item.id} className="row" style={{ gap: 6 }} data-case={item.id}>
              <ContextMeter session={item.session} />
              <span style={{ color: 'var(--fg-faint)' }}>{item.label}</span>
            </span>
          ))}
        </div>

        <Caption>Cost readout</Caption>
        {/* The limits are dropped here on purpose: these two cases are about the
            price the session reports, and the meters of five harnesses beside it
            would be a second subject in the same picture. */}
        <div data-case="cost-unreported">
          <StatusBar state={{ ...fixtureState, limits: [] }} session={fixtureCostUnreported} />
        </div>
        <div data-case="cost-zero">
          <StatusBar state={{ ...fixtureState, limits: [] }} session={fixtureCostZero} />
        </div>

        {/* Tables: the alignment of each column comes from the delimiter row, the
            pipe inside the last cell is escaped, and two cells carry inline
            markdown. The wide one proves the overflow stays inside its own box
            instead of widening whatever contains it. */}
        <Caption>Markdown table</Caption>
        <div data-case="md-table">
          <Markdown text={fixtureTableMarkdown} />
        </div>
        <div data-case="md-table-wide">
          <Markdown text={fixtureWideTableMarkdown} />
        </div>

        <Caption>Segmented · switch · chips</Caption>
        <div className="segment">
          <button className="on">
            <IconAgent size={15} /> Agent
          </button>
          <button>
            <IconTerminal size={15} /> Terminal
          </button>
        </div>
        <div className="row" style={{ gap: 12 }}>
          <button className={`switch${toggle ? ' on' : ''}`} onClick={() => setToggle(!toggle)} aria-label="Toggle">
            <span className="knob" />
          </button>
          <span className="chip-select">
            Opus
            <span className="caret">▾</span>
          </span>
          <span className="chip-select">
            accept edits
            <span className="caret">▾</span>
          </span>
        </div>

        <Caption>Settings row</Caption>
        <div className="settings-row" style={{ padding: '10px 0', borderBottom: 'none', gap: 16 }}>
          <div className="settings-text">
            <div className="settings-label">Conversation text — 14.5px</div>
            <p className="settings-help">Shortcut ⌘ + / ⌘ −. Never resizes the interface.</p>
          </div>
          <div className="settings-control">
            <input type="range" min={10} max={28} value={14.5} readOnly style={{ width: 120 }} />
          </div>
        </div>
        <input value="/Users/you/Projects/acme-api" readOnly />
        <select value="acceptEdits" onChange={() => undefined}>
          <option value="acceptEdits">accept edits</option>
          <option value="plan">plan only</option>
        </select>
        <button className="mic" title="Dictate with the local model">
          <IconMic size={16} />
        </button>

        <Caption>Palette</Caption>
        <div style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-lg)', overflow: 'hidden' }}>
          <div className="palette-head">
            <input placeholder="Search" readOnly />
            <span className="mono" style={{ color: 'var(--fg-faint)' }}>
              3
            </span>
          </div>
          <div className="palette-list">
            <div className="palette-group">Actions</div>
            <div className="palette-item sel">
              <IconPlus size={16} />
              <span>New tab</span>
              <span className="spacer" />
              <span className="path mono">any workspace</span>
            </div>
            <div className="palette-group">Workspaces</div>
            <div className="palette-item">
              <span>acme-api</span>
              <span className="spacer" />
              <span className="path mono">/Users/you/Projects/acme-api</span>
            </div>
          </div>
        </div>

        {/* One card per failure shape, each carrying the exact text the server
            writes for a real report (see `FIXTURE_FAILURES`). They are here
            rather than only on the turns page because this is the page the
            contrast gate reads: a surface it cannot find is a surface nobody
            measures. The wide reading of them is `preview.html?only=turns`. */}
        <Caption>Failures</Caption>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {(Object.keys(FIXTURE_FAILURES) as Array<keyof typeof FIXTURE_FAILURES>).map((id) => (
            <div key={id} data-case={id}>
              <ErrorCard ev={{ k: 'error', text: FIXTURE_FAILURES[id] }} />
            </div>
          ))}
        </div>

        <Caption>Toasts</Caption>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {(
            [
              ['success', IconSuccess, 'Limits refreshed'],
              ['info', IconInfo, 'Refreshing Codex in the background…'],
              ['warning', IconWarning, 'Not connected to the sedano server — queued until it is back'],
              ['error', IconError, 'Stop the running turn before changing the model'],
            ] as const
          ).map(([level, Icon, text]) => (
            <div key={level} className={`toast ${level}`}>
              <span className="toast-icon">
                <Icon size={16} />
              </span>
              <span className="toast-text">{text}</span>
              <button className="toast-close" aria-label="Dismiss">
                <IconClose size={13} />
              </button>
            </div>
          ))}
        </div>

        <Caption>Keys</Caption>
        <div className="row" style={{ gap: 10, color: 'var(--fg-mute)' }}>
          <span className="row">
            <kbd>⌘</kbd>
            <kbd>K</kbd>
          </span>
          <span className="row">
            <kbd>⌘</kbd>
            <kbd>T</kbd>
          </span>
          <span className="row">
            <kbd>⌥</kbd>
            <kbd>⌘</kbd>
            <kbd>+</kbd>
          </span>
        </div>
      </div>
    </div>
  )
}

/**
 * `?only=turns` — the turn states, side by side and nothing else.
 *
 * The floating panel of primitives sits over the transcript, which is fine for
 * looking at a button and useless for judging a turn: it covers the very region
 * under review, and a bounding-box check run against it would measure the
 * overlap of the gallery's own furniture. So this page has no furniture. Each
 * case is a real `Transcript` with its own fixtures, wrapped in a `data-case` so
 * a check can address one turn without reaching into another.
 */
function TurnStates() {
  return (
    <div className="app">
      <div className="body">
        <div className="pane">
          <div style={{ overflowY: 'auto', padding: '0 0 40px' }}>
            {[...fixtureTurnCases, ...fixtureFailureCases].map((item) => (
              <div key={item.id} data-case={item.id} style={{ borderBottom: '1px solid var(--line)' }}>
                <div className="rail-title" style={{ padding: '14px 32px 0' }}>
                  {item.label}
                </div>
                {/* Height, not flex: each case is its own scroll container, so
                    one long turn cannot squeeze the next into a sliver. */}
                <div style={{ height: 420, display: 'flex' }}>
                  <Transcript
                    session={item.session}
                    events={item.events}
                    live={item.live}
                    foldFinished={false}
                    settings={settings}
                    connected
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * `?only=harnesses` — one settled turn per harness, work open, tall enough to
 * read whole. `&case=<id>` renders just one, for a screenshot per harness.
 */
function HarnessTurns() {
  const only = params.get('case')
  const cases = fixtureHarnessCases.filter((item) => !only || item.id === only)
  return (
    <div className="app">
      <div className="body">
        <div className="pane">
          <div style={{ overflowY: 'auto', padding: '0 0 40px' }}>
            {cases.map((item) => (
              <div key={item.id} data-case={item.id} style={{ borderBottom: '1px solid var(--line)' }}>
                <div className="rail-title" style={{ padding: '14px 32px 0' }}>{item.label}</div>
                <div style={{ height: Number(params.get('height') ?? 900), display: 'flex' }}>
                  <Transcript session={item.session} events={item.events} live={item.live} foldFinished={false} settings={settings} connected />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('#root missing')
createRoot(root).render(
  <StrictMode>{params.get('only') === 'turns' ? <TurnStates /> : params.get('only') === 'harnesses' ? <HarnessTurns /> : <Gallery />}</StrictMode>,
)
