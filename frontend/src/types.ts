export const CATEGORIES = ['Travel', 'Meals', 'Software', 'Supplies', 'Other'] as const
export type Category = (typeof CATEGORIES)[number]

export type ExpenseStatus = 'AWAITING_UPLOAD' | 'PROCESSING' | 'NEEDS_REVIEW' | 'APPROVED' | 'FAILED'
export type ProcessingStage = 'QUEUED' | 'READING' | 'CATEGORIZING'
export type DataSource = 'AWS' | 'DEMO'

/** Position of a value on the receipt, as ratios of the page size (Textract Geometry.BoundingBox). */
export interface Box {
  left: number
  top: number
  width: number
  height: number
  page: number
}

/** One value as it was extracted. `confidence` is only set when Amazon Textract returned one. */
export interface ExtractedField {
  value: string | null
  raw: string | null
  confidence: number | null
  box: Box | null
  ambiguous?: boolean
  unparsed?: boolean
  label?: string
  /** Demo data only: marks a sample value as uncertain without inventing a confidence score. */
  demoUncertain?: boolean
}

export interface ExtractedLineItem {
  description: ExtractedField
  quantity: ExtractedField
  amount: ExtractedField
}

export interface Extraction {
  merchant: ExtractedField
  date: ExtractedField
  total: ExtractedField
  currency: ExtractedField
  lineItems: ExtractedLineItem[]
  pages?: number | null
  warnings: string[]
}

export interface LineItem {
  description: string | null
  quantity: string | null
  amount: string | null
}

export interface Draft {
  merchant: string | null
  date: string | null
  total: string | null
  currency: string | null
  category: Category | null
  lineItems: LineItem[]
}

export type SuggestionStatus =
  | 'SUGGESTED'
  | 'UNAVAILABLE'
  | 'INVALID_RESPONSE'
  | 'NOT_ENOUGH_DATA'
  | 'NOT_CONFIGURED'
  | 'DEMO'

export interface Suggestion {
  status: SuggestionStatus
  category: Category | null
  modelId: string | null
  source: 'BEDROCK' | 'DEMO'
}

export interface Expense {
  id: string
  status: ExpenseStatus
  stage: ProcessingStage | null
  createdAt: string
  updatedAt: string
  approvedAt: string | null
  source: DataSource
  receipt: {
    fileName: string | null
    contentType: string | null
    size: number | null
    viewUrl?: string
  }
  draft: Draft | null
  extraction: Extraction | null
  suggestion: Suggestion | null
  error?: { code: string; message: string; retryable: boolean }
}

export interface FieldError {
  field: string
  message: string
}

export type DraftField = 'merchant' | 'date' | 'total' | 'currency' | 'category'
