export interface AwsConfig {
  apiUrl: string
  cognitoDomain: string
  clientId: string
  redirectUri: string
  logoutUri: string
  scopes: string
}

const env = import.meta.env

function trimUrl(value: string | undefined): string {
  return (value ?? '').trim().replace(/\/+$/, '')
}

function readAwsConfig(): AwsConfig | null {
  const apiUrl = trimUrl(env.VITE_API_URL)
  const domain = trimUrl(env.VITE_COGNITO_DOMAIN)
  const clientId = (env.VITE_COGNITO_CLIENT_ID ?? '').trim()
  if (!apiUrl || !domain || !clientId) return null
  const appUrl = `${window.location.origin}/`
  return {
    apiUrl,
    cognitoDomain: domain.startsWith('https://') ? domain : `https://${domain}`,
    clientId,
    redirectUri: env.VITE_COGNITO_REDIRECT_URI?.trim() || appUrl,
    logoutUri: env.VITE_COGNITO_LOGOUT_URI?.trim() || appUrl,
    // receiptready/expenses is the API scope defined in template.yaml (ApiResourceServer).
    scopes: 'openid email receiptready/expenses',
  }
}

/** Null when the AWS backend isn't configured; the app then offers demo mode only. */
export const awsConfig = readAwsConfig()

export const demoEnabled = (env.VITE_ENABLE_DEMO ?? 'true').trim().toLowerCase() !== 'false'

/** Extracted values below this Textract confidence are flagged for review. */
export const LOW_CONFIDENCE_THRESHOLD = 90
