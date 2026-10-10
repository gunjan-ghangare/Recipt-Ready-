import { Notice, ReceiptArt } from './ui'

interface WelcomeProps {
  awsReady: boolean
  demoEnabled: boolean
  authError: string | null
  onSignIn(): void
  onSignUp(): void
  onDemo(): void
}

const STEPS = [
  { title: 'Snap or upload', body: 'A photo or PDF of a receipt. Location data is removed from photos before upload.' },
  { title: 'Get a draft', body: 'Merchant, date, total, currency, and line items are filled in, plus a suggested category.' },
  { title: 'You decide', body: 'Uncertain fields are flagged. Fix what you need, then approve or reject. Nothing is approved without you.' },
]

export function Welcome({ awsReady, demoEnabled, authError, onSignIn, onSignUp, onDemo }: WelcomeProps) {
  return (
    <main className="page welcome" id="main">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">For freelancers and solo consultants</p>
          <h1>Receipts in, ready-to-file expenses out.</h1>
          <p className="lead">
            ReceiptReady turns a receipt photo into a draft expense, takes you straight to anything it isn&rsquo;t sure about,
            and waits for your approval.
          </p>
          {authError && (
            <Notice tone="error" title="You're not signed in">
              {authError}
            </Notice>
          )}
          <div className="hero-actions">
            {awsReady && (
              <>
                <button type="button" className="btn btn-primary btn-lg" onClick={onSignIn}>
                  Sign in
                </button>
                <button type="button" className="btn btn-secondary btn-lg" onClick={onSignUp}>
                  Create an account
                </button>
              </>
            )}
            {demoEnabled && (
              <button type="button" className={`btn btn-lg ${awsReady ? 'btn-ghost' : 'btn-primary'}`} onClick={onDemo}>
                Explore the demo
              </button>
            )}
          </div>
          {demoEnabled && (
            <p className="fine-print">
              The demo runs in your browser with synthetic sample receipts. No account or AWS needed.
            </p>
          )}
          {!awsReady && (
            <Notice tone="info" title="Live mode isn't configured">
              No AWS backend settings were found, so only the demo is available. To connect a deployed backend, fill in the
              values from <code>.env.example</code> as described in the README.
            </Notice>
          )}
        </div>
        <div className="hero-art" aria-hidden="true">
          <ReceiptArt />
        </div>
      </section>

      <ol className="steps">
        {STEPS.map((step, index) => (
          <li key={step.title} className="step">
            <span className="step-number" aria-hidden="true">
              {index + 1}
            </span>
            <h2>{step.title}</h2>
            <p>{step.body}</p>
          </li>
        ))}
      </ol>
    </main>
  )
}
