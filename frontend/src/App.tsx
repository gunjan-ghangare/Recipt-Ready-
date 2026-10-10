import { useEffect, useMemo, useState } from 'react'
import { Dashboard } from './components/Dashboard'
import { Header } from './components/Header'
import { Review } from './components/Review'
import { Spinner } from './components/ui'
import { Upload } from './components/Upload'
import { Welcome } from './components/Welcome'
import { awsConfig, demoEnabled } from './config'
import { createAwsApi } from './lib/api'
import { completeSignInRedirect, getAccessToken, loadSession, signOut, startSignIn } from './lib/auth'
import { createDemoApi } from './lib/demoApi'
import { links, navigate, useRoute } from './lib/router'

type Mode =
  | { kind: 'loading' }
  | { kind: 'signedOut'; authError: string | null }
  | { kind: 'aws'; email?: string }
  | { kind: 'demo' }

const MODE_KEY = 'receiptready.mode'

function initialMode(): Mode {
  if (awsConfig && new URLSearchParams(window.location.search).has('code')) return { kind: 'loading' }
  if (awsConfig && loadSession()) return { kind: 'aws', email: loadSession()?.email }
  if (demoEnabled && sessionStorage.getItem(MODE_KEY) === 'demo') return { kind: 'demo' }
  return { kind: 'signedOut', authError: null }
}

export default function App() {
  const [mode, setMode] = useState<Mode>(initialMode)
  const [demoVersion, setDemoVersion] = useState(0)
  const route = useRoute()

  useEffect(() => {
    if (!awsConfig) return
    completeSignInRedirect(awsConfig)
      .then((session) => {
        if (session) setMode({ kind: 'aws', email: session.email })
      })
      .catch((err: Error) => setMode({ kind: 'signedOut', authError: err.message }))
  }, [])

  const api = useMemo(() => {
    if (mode.kind === 'demo') return createDemoApi()
    if (mode.kind === 'aws' && awsConfig) {
      const config = awsConfig
      return createAwsApi(
        config,
        () => getAccessToken(config),
        () => setMode({ kind: 'signedOut', authError: 'Your session ended. Sign in again to continue.' }),
      )
    }
    return null
  }, [mode.kind])

  if (mode.kind === 'loading') {
    return (
      <main className="page narrow" id="main">
        <Spinner label="Signing you in\u2026" />
      </main>
    )
  }

  if (mode.kind === 'signedOut' || !api) {
    return (
      <>
        <Header mode="signedOut" />
        <Welcome
          awsReady={Boolean(awsConfig)}
          demoEnabled={demoEnabled}
          authError={mode.kind === 'signedOut' ? mode.authError : null}
          onSignIn={() => awsConfig && void startSignIn(awsConfig, 'login')}
          onSignUp={() => awsConfig && void startSignIn(awsConfig, 'signup')}
          onDemo={() => {
            sessionStorage.setItem(MODE_KEY, 'demo')
            navigate(links.home)
            setMode({ kind: 'demo' })
          }}
        />
      </>
    )
  }

  return (
    <>
      <Header
        mode={mode.kind}
        email={mode.kind === 'aws' ? mode.email : undefined}
        onSignOut={() => awsConfig && void signOut(awsConfig)}
        onExitDemo={() => {
          sessionStorage.removeItem(MODE_KEY)
          navigate(links.home)
          setMode({ kind: 'signedOut', authError: null })
        }}
        onResetDemo={() => {
          api.resetDemo?.()
          navigate(links.home)
          setDemoVersion((v) => v + 1)
        }}
      />
      {route.name === 'home' && <Dashboard key={demoVersion} api={api} />}
      {route.name === 'upload' && <Upload api={api} />}
      {route.name === 'expense' && <Review key={`${route.id}-${demoVersion}`} api={api} id={route.id} />}
      {route.name === 'notFound' && (
        <main className="page narrow" id="main" tabIndex={-1}>
          <h1>Page not found</h1>
          <p className="muted">That page doesn&rsquo;t exist.</p>
          <a className="btn btn-primary" href={links.home}>
            Back to my expenses
          </a>
        </main>
      )}
    </>
  )
}
