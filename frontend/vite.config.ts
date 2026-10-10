import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// Content Security Policy for production builds. Receipt previews and uploads use S3 presigned
// URLs (*.amazonaws.com); sign-in uses the Cognito managed login domain (*.amazoncognito.com).
const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob: data: https://*.amazonaws.com",
  "frame-src 'self' blob: https://*.amazonaws.com",
  "connect-src 'self' https://*.amazonaws.com https://*.amazoncognito.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ')

function productionCsp(): Plugin {
  return {
    name: 'receiptready-csp',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`),
  }
}

// https://vite.dev/config/
export default defineConfig({
  // One .env file at the repository root serves the whole project; only VITE_* values reach the browser.
  envDir: '..',
  plugins: [react(), productionCsp()],
})
