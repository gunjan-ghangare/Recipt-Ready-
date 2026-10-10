# ReceiptReady

ReceiptReady turns a receipt photo into a draft expense. Amazon Textract reads the merchant, date, total, currency, and line items, Amazon Bedrock suggests a category, and you check anything flagged before you approve or reject the draft. Nothing is approved without you.

```
frontend/       React + TypeScript web app (Vite)
backend/src/    Python Lambda code: HTTP API handler and receipt worker
template.yaml   AWS SAM template: Cognito, HTTP API, Lambda, S3, DynamoDB, Textract, Bedrock
```

## Run the preview (no AWS needed)

Requires Node.js 20.19+ or 22.12+.

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173
```

Choose **Explore the demo**. Demo mode runs entirely in the browser with synthetic sample receipts saved in `localStorage`. Nothing is uploaded or sent to AWS.

To check the production build instead:

```bash
npm run build
npm run preview      # http://localhost:4173
```

## Deploy the backend

You need an AWS account with credentials configured, a recent [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html), and Python 3.14 (or build with `sam build --use-container`).

```bash
sam build
sam deploy --guided
```

Deploy to a US Region such as `us-east-1`: Amazon Textract and the default `us.` Bedrock inference profile both need to be available there. Parameters to review:

| Parameter | Default | Notes |
| --- | --- | --- |
| `AllowedOrigins` | `http://localhost:5173` | Origins allowed to call the API and upload to S3. No trailing slash. |
| `CallbackUrls`, `LogoutUrls` | `http://localhost:5173/` | Cognito sign-in and sign-out redirects. With trailing slash. |
| `BedrockModelId` | `us.amazon.nova-2-lite-v1:0` | Model or inference profile ID used for category suggestions. |
| `CognitoDomainPrefix` | `receiptready-<account id>` | Managed login domain prefix. Must be unique in the Region. |

If drafts say category suggestions aren't available, check that the account can invoke the configured model in Amazon Bedrock. Receipts are still read and drafted without a suggestion.

## Connect the web app

1. Copy `.env.example` to `.env` in the repository root.
2. Fill in `VITE_API_URL`, `VITE_COGNITO_DOMAIN`, and `VITE_COGNITO_CLIENT_ID` from the stack outputs:
   ```bash
   aws cloudformation describe-stacks --stack-name <stack name> --query "Stacks[0].Outputs"
   ```
3. Restart `npm run dev`. The welcome screen now offers **Sign in** and **Create an account**.

To host the app, run `npm run build` and serve `frontend/dist` as static files over HTTPS. Add that origin to `AllowedOrigins`, `CallbackUrls`, and `LogoutUrls`, then deploy again. Routes use the URL hash, so the host needs no rewrite rules. The same applies to `npm run preview`: add `http://localhost:4173` to those parameters if you want to sign in from the preview build.

## How data is protected

- Every API route requires a Cognito access token with the `receiptready/expenses` scope, checked by the API Gateway JWT authorizer. The user ID always comes from the token, so each user can only reach their own records and files.
- Files go straight from the browser to a private, encrypted S3 bucket through a presigned POST that pins the object key, content type, and 10 MB limit. File signatures are checked before processing. JPEG photos are re-encoded in the browser first, which strips camera and location metadata.
- Sign-in uses the OAuth authorization code flow with PKCE and no client secret. Tokens are kept in `sessionStorage`.
- Only the merchant name and item descriptions are sent to Bedrock, and the reply must be one of the five allowed categories.
- Logs record IDs, stages, durations, and error codes, never receipt contents.

## Checks

From the repository root:

```bash
(cd frontend && npm run typecheck && npm run lint && npm run build)
pip install -r backend/requirements-dev.txt && cfn-lint template.yaml
```

## Troubleshooting

- **"Receipt reading isn't set up for this deployment yet"**: the worker couldn't call Textract (access denied or an unsupported Region). Check the stack's Region and the worker function's role.
- **CORS errors in the browser console**: the page's origin is missing from `AllowedOrigins`.
- **Cognito shows `redirect_mismatch`**: the page's URL is missing from `CallbackUrls`, or `VITE_COGNITO_REDIRECT_URI` doesn't match it.
