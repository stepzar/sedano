import { Component, type ReactNode } from 'react'

/**
 * Keeps one render error from blanking everything around it.
 *
 * Without a boundary React unmounts the whole root on any throw, so a single
 * malformed event (a row persisted by an older server, a field a harness left
 * out) turned the entire window white with no way back but a reload. Wrapped
 * around a turn, the rest of the transcript stays readable; wrapped around the
 * app, the window at least says what happened and offers the reload.
 */
export class Boundary extends Component<
  { children: ReactNode; label: string; scope: 'turn' | 'app'; resetKey?: unknown },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  override componentDidCatch(error: unknown): void {
    console.error(`sedano: ${this.props.label} failed to render`, error)
  }

  // New data is a new chance: a turn that failed on a half-written event is
  // tried again once the event it was missing arrives.
  override componentDidUpdate(previous: { resetKey?: unknown }): void {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({ error: null })
  }

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="line-error render-error" role="alert" data-scope={this.props.scope}>
        <div className="error-head">
          <span className="error-headline">
            {this.props.label} could not be displayed: {error.message}
          </span>
        </div>
        {this.props.scope === 'app' ? (
          <button type="button" className="ghost" onClick={() => location.reload()}>
            Reload
          </button>
        ) : (
          <button type="button" className="ghost" onClick={() => this.setState({ error: null })}>
            Try Again
          </button>
        )}
      </div>
    )
  }
}
