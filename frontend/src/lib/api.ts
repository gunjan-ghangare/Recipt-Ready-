import type { AwsConfig } from '../config'
import type { Draft, Expense, FieldError } from '../types'

export class ApiError extends Error {
  readonly code: string
  readonly status: number
  readonly fields: FieldError[]
  /** Set when an upload succeeded but processing couldn't start, so the user can retry. */
  readonly expenseId?: string

  constructor(code: string, message: string, status = 0, fields: FieldError[] = [], expenseId?: string) {
    super(message)
    this.code = code
    this.status = status
    this.fields = fields
    this.expenseId = expenseId
  }
}

export interface DemoSample {
  id: string
  title: string
  description: string
  imageUrl: string
}

export interface ExpenseApi {
  readonly mode: 'aws' | 'demo'
  list(): Promise<Expense[]>
  get(id: string): Promise<Expense>
  upload(file: File, onProgress: (fraction: number) => void): Promise<Expense>
  retry(id: string): Promise<Expense>
  saveDraft(id: string, draft: Draft): Promise<Expense>
  approve(id: string, draft: Draft): Promise<Expense>
  reject(id: string): Promise<void>
  remove(id: string): Promise<void>
  /** Demo mode only. */
  samples?: DemoSample[]
  uploadSample?(sampleId: string, onProgress: (fraction: number) => void): Promise<Expense>
  resetDemo?(): void
}

const NETWORK_MESSAGE = "We couldn't reach ReceiptReady. Check your connection and try again."

const STATUS_MESSAGES: Record<number, [string, string]> = {
  401: ['UNAUTHORIZED', 'Your session has ended. Sign in again to continue.'],
  403: ['FORBIDDEN', "You don't have access to that."],
  404: ['NOT_FOUND', "We couldn't find that expense. It may have been deleted."],
  429: ['SERVICE_BUSY', 'ReceiptReady is busy right now. Wait a moment and try again.'],
  503: ['SERVICE_UNAVAILABLE', 'ReceiptReady is temporarily unavailable. Try again in a few minutes.'],
  504: ['SERVICE_UNAVAILABLE', 'That took too long. Try again in a moment.'],
}

async function toApiError(response: Response): Promise<ApiError> {
  let payload: { error?: { code?: string; message?: string; fields?: FieldError[] } } | null = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  const fallback = STATUS_MESSAGES[response.status] ?? ['INTERNAL_ERROR', 'Something went wrong. Try again in a moment.']
  const error = payload?.error
  return new ApiError(
    error?.code ?? fallback[0],
    error?.message ?? fallback[1],
    response.status,
    Array.isArray(error?.fields) ? error.fields : [],
  )
}

function uploadToS3(url: string, fields: Record<string, string>, file: File, onProgress: (f: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const form = new FormData()
    Object.entries(fields).forEach(([key, value]) => form.append(key, value))
    form.append('file', file) // S3 requires the file to be the last form field.
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total)
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve()
      const tooLarge = xhr.responseText.includes('EntityTooLarge')
      reject(
        new ApiError(
          tooLarge ? 'FILE_TOO_LARGE' : 'UPLOAD_FAILED',
          tooLarge
            ? 'This file is larger than 10 MB. Try a smaller photo or a compressed PDF.'
            : "The upload didn't go through. Try again.",
          xhr.status,
        ),
      )
    }
    xhr.onerror = () => reject(new ApiError('NETWORK', NETWORK_MESSAGE))
    xhr.send(form)
  })
}

export function createAwsApi(
  config: AwsConfig,
  getToken: () => Promise<string | null>,
  onUnauthorized: () => void,
): ExpenseApi {
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await getToken()
    if (!token) {
      onUnauthorized()
      throw new ApiError('UNAUTHORIZED', STATUS_MESSAGES[401][1], 401)
    }
    let response: Response
    try {
      response = await fetch(`${config.apiUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
    } catch {
      throw new ApiError('NETWORK', NETWORK_MESSAGE)
    }
    if (response.status === 401) onUnauthorized()
    if (!response.ok) throw await toApiError(response)
    return (await response.json()) as T
  }

  return {
    mode: 'aws',
    async list() {
      const all: Expense[] = []
      let nextToken: string | null = null
      for (let page = 0; page < 10; page++) {
        const query = nextToken ? `?nextToken=${encodeURIComponent(nextToken)}` : ''
        const result: { expenses: Expense[]; nextToken: string | null } = await request('GET', `/expenses${query}`)
        all.push(...result.expenses)
        nextToken = result.nextToken
        if (!nextToken) break
      }
      return all
    },
    async get(id) {
      return (await request<{ expense: Expense }>('GET', `/expenses/${id}`)).expense
    },
    async upload(file, onProgress) {
      const created = await request<{ expense: Expense; upload: { url: string; fields: Record<string, string> } }>(
        'POST',
        '/receipts',
        { fileName: file.name, contentType: file.type, size: file.size },
      )
      await uploadToS3(created.upload.url, created.upload.fields, file, onProgress)
      try {
        return (await request<{ expense: Expense }>('POST', `/receipts/${created.expense.id}/process`)).expense
      } catch (err) {
        const e = err instanceof ApiError ? err : new ApiError('INTERNAL_ERROR', 'Something went wrong.')
        throw new ApiError(e.code, e.message, e.status, e.fields, created.expense.id)
      }
    },
    async retry(id) {
      return (await request<{ expense: Expense }>('POST', `/receipts/${id}/process`)).expense
    },
    async saveDraft(id, draft) {
      return (await request<{ expense: Expense }>('PATCH', `/expenses/${id}`, { draft })).expense
    },
    async approve(id, draft) {
      return (await request<{ expense: Expense }>('POST', `/expenses/${id}/approve`, { draft })).expense
    },
    async reject(id) {
      await request('POST', `/expenses/${id}/reject`)
    },
    async remove(id) {
      await request('DELETE', `/expenses/${id}`)
    },
  }
}
