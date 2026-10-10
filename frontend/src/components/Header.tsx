import { links } from '../lib/router'

interface HeaderProps {
  mode: 'aws' | 'demo' | 'signedOut'
  email?: string
  onSignOut?(): void
  onExitDemo?(): void
  onResetDemo?(): void
}

export function Header({ mode, email, onSignOut, onExitDemo, onResetDemo }: HeaderProps) {
  return (
    <>
      <a className="skip-link" href="#main" onClick={(e) => {
        e.preventDefault()
        document.getElementById('main')?.focus()
      }}>
        Skip to content
      </a>
      {mode === 'demo' && (
        <div className="demo-banner" role="note">
          <strong>Demo mode</strong> &middot; This app is under development. The data shown here is pre-loaded sample
          data, and nothing leaves your browser.
        </div>
      )}
      <header className="topbar">
        <a className="brand" href={links.home}>
          <svg viewBox="0 0 32 32" className="brand-mark" aria-hidden="true">
            <rect x="4" y="2" width="24" height="28" rx="5" fill="var(--accent)" />
            <path d="M10 10h12M10 15h12M10 20h7" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
          </svg>
          <span>ReceiptReady</span>
        </a>
        {mode !== 'signedOut' && (
          <nav className="topbar-actions" aria-label="Main">
            <a className="btn btn-primary btn-sm" href={links.upload}>
              Upload receipt
            </a>
            {mode === 'aws' && (
              <>
                {email && (
                  <span className="user-email" title={email}>
                    {email}
                  </span>
                )}
                <button type="button" className="btn btn-ghost btn-sm" onClick={onSignOut}>
                  Sign out
                </button>
              </>
            )}
            {mode === 'demo' && (
              <>
                <button type="button" className="btn btn-ghost btn-sm" onClick={onResetDemo}>
                  Reset demo
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={onExitDemo}>
                  Exit demo
                </button>
              </>
            )}
          </nav>
        )}
      </header>
    </>
  )
}
