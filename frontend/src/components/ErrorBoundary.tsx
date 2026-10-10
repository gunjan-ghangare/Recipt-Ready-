import { Component, type ReactNode } from 'react'

interface State {
  failed: boolean
}

/** Catches unexpected rendering errors and shows a friendly recovery screen (no stack traces). */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <main className="page narrow">
        <div className="card center-card">
          <h1>Something went wrong</h1>
          <p className="muted">This screen hit an unexpected problem. Your saved drafts and expenses are safe.</p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              window.location.hash = '#/'
              window.location.reload()
            }}
          >
            Back to my expenses
          </button>
        </div>
      </main>
    )
  }
}
