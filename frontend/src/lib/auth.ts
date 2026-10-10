/**
 * Cognito managed login with the OAuth 2.0 authorization code flow and PKCE.
 * No client secret is used. Tokens are kept in sessionStorage, so they end with the browser tab.
 */
import type { AwsConfig } from '../config'

const SESSION_KEY = 'receiptready.session'
const PKCE_KEY = 'receiptready.pkce'

export interface Session {
  accessToken: string
  idToken: string
  refreshToken?: string
  expiresAt: number
  email?: string
}

export class AuthError extends Error {}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  bytes.forEach((b) => (binary += String.fromCharCode(b)))
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomString(byteLength: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)))
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const bytes = Uint8Array.from(atob(part), (c) => c.charCodeAt(0))
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
  } catch {
    return {}
  }
}

function saveSession(session: Session) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session))
}

export function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    return raw ? (JSON.parse(raw) as Session) : null
  } catch {
    return null
  }
}

export function clearSession() {
  sessionStorage.removeItem(SESSION_KEY)
}

interface TokenResponse {
  access_token: string
  id_token?: string
  refresh_token?: string
  expires_in: number
}

async function requestTokens(config: AwsConfig, params: Record<string, string>): Promise<TokenResponse> {
  let response: Response
  try {
    response = await fetch(`${config.cognitoDomain}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.clientId, ...params }),
    })
  } catch {
    throw new AuthError("We couldn't reach the sign-in service. Check your connection and try again.")
  }
  if (!response.ok) throw new AuthError('Your sign-in has expired. Please sign in again.')
  return (await response.json()) as TokenResponse
}

function toSession(tokens: TokenResponse, previous?: Session): Session {
  const idToken = tokens.id_token ?? previous?.idToken ?? ''
  const claims = decodeJwtPayload(idToken)
  return {
    accessToken: tokens.access_token,
    idToken,
    refreshToken: tokens.refresh_token ?? previous?.refreshToken,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    email: typeof claims.email === 'string' ? claims.email : previous?.email,
  }
}

export async function startSignIn(config: AwsConfig, screen: 'login' | 'signup' = 'login') {
  const verifier = randomString(48)
  const state = randomString(24)
  sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state }))
  const url = new URL(`${config.cognitoDomain}/${screen === 'signup' ? 'signup' : 'oauth2/authorize'}`)
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scopes,
    state,
    code_challenge: base64Url(await sha256(verifier)),
    code_challenge_method: 'S256',
  }).toString()
  window.location.assign(url.toString())
}

/** Completes a sign-in redirect if the URL contains one. Returns the new session, or null. */
export async function completeSignInRedirect(config: AwsConfig): Promise<Session | null> {
  const params = new URLSearchParams(window.location.search)
  const code = params.get('code')
  const error = params.get('error')
  if (!code && !error) return null

  const cleanUrl = `${window.location.pathname}${window.location.hash || '#/'}`
  window.history.replaceState(null, '', cleanUrl)

  if (error) throw new AuthError("Sign-in didn't finish. Please try again.")
  const stored = sessionStorage.getItem(PKCE_KEY)
  sessionStorage.removeItem(PKCE_KEY)
  const pkce = stored ? (JSON.parse(stored) as { verifier: string; state: string }) : null
  if (!pkce || pkce.state !== params.get('state')) {
    throw new AuthError('That sign-in link has expired. Please sign in again.')
  }
  const tokens = await requestTokens(config, {
    grant_type: 'authorization_code',
    code: code!,
    redirect_uri: config.redirectUri,
    code_verifier: pkce.verifier,
  })
  const session = toSession(tokens)
  saveSession(session)
  return session
}

let refreshing: Promise<Session | null> | null = null

/** Returns a valid access token, refreshing it shortly before it expires. */
export async function getAccessToken(config: AwsConfig): Promise<string | null> {
  const session = loadSession()
  if (!session) return null
  if (session.expiresAt - Date.now() > 60_000) return session.accessToken
  if (!session.refreshToken) {
    clearSession()
    return null
  }
  refreshing ??= requestTokens(config, { grant_type: 'refresh_token', refresh_token: session.refreshToken })
    .then((tokens) => {
      const next = toSession(tokens, session)
      saveSession(next)
      return next
    })
    .catch(() => {
      clearSession()
      return null
    })
    .finally(() => {
      refreshing = null
    })
  return (await refreshing)?.accessToken ?? null
}

export async function signOut(config: AwsConfig) {
  const session = loadSession()
  clearSession()
  if (session?.refreshToken) {
    // Best effort: revoke the refresh token so it can't be reused.
    await fetch(`${config.cognitoDomain}/oauth2/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: session.refreshToken, client_id: config.clientId }),
    }).catch(() => undefined)
  }
  const url = new URL(`${config.cognitoDomain}/logout`)
  url.search = new URLSearchParams({ client_id: config.clientId, logout_uri: config.logoutUri }).toString()
  window.location.assign(url.toString())
}
