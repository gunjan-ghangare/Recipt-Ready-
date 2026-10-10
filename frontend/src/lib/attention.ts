import { LOW_CONFIDENCE_THRESHOLD } from '../config'
import type { Box, Draft, DraftField, Expense, ExtractedField } from '../types'

export type AttentionSeverity = 'missing' | 'check'

export interface AttentionItem {
  /** Form field id suffix, e.g. "merchant" or "lineItems.2.amount". */
  key: string
  label: string
  reason: string
  severity: AttentionSeverity
  box: Box | null
}

const LABELS: Record<Exclude<DraftField, 'category'>, string> = {
  merchant: 'Merchant',
  date: 'Date',
  total: 'Total',
  currency: 'Currency',
}

function lowConfidence(field: ExtractedField): boolean {
  return field.confidence !== null && field.confidence < LOW_CONFIDENCE_THRESHOLD
}

function quote(text: string | null) {
  return text ? `\u201c${text}\u201d` : ''
}

/** Why an extracted (and unedited) value deserves a second look, if it does. */
export function uncertaintyReason(field: ExtractedField, isDemo: boolean): string | null {
  if (field.ambiguous) return `Day and month could be swapped. The receipt shows ${quote(field.raw)}.`
  if (field.label === 'AMOUNT_PAID') return 'Read from the \u201camount paid\u201d line. Confirm it\u2019s the total.'
  if (lowConfidence(field)) return `Low extraction confidence (${Math.round(field.confidence!)}%). Compare with the receipt.`
  if (isDemo && field.demoUncertain) return 'Marked uncertain in this sample. Compare with the receipt.'
  return null
}

export function computeAttention(expense: Expense, draft: Draft, categoryConfirmed: boolean): AttentionItem[] {
  const extraction = expense.extraction
  const isDemo = expense.source === 'DEMO'
  const items: AttentionItem[] = []

  for (const key of ['merchant', 'date', 'total', 'currency'] as const) {
    const extracted = extraction?.[key]
    const value = draft[key]
    const edited = (value ?? null) !== (extracted?.value ?? null)
    if (!value) {
      let reason = 'Not found on the receipt. Add it from the image.'
      if (extracted?.unparsed && extracted.raw) reason = `The receipt shows ${quote(extracted.raw)}, but the format wasn\u2019t recognized. Enter it here.`
      else if (extracted?.value) reason = 'This is required before approving.'
      items.push({ key, label: LABELS[key], reason, severity: 'missing', box: extracted?.box ?? null })
      continue
    }
    if (edited || !extracted) continue
    const reason = uncertaintyReason(extracted, isDemo)
    if (reason) items.push({ key, label: LABELS[key], reason, severity: 'check', box: extracted.box })
  }

  if (!draft.category) {
    items.push({ key: 'category', label: 'Category', reason: 'Choose the category that fits.', severity: 'missing', box: null })
  } else if (!categoryConfirmed && expense.suggestion?.category && draft.category === expense.suggestion.category) {
    items.push({
      key: 'category',
      label: 'Category',
      reason: 'This is a suggestion, not a certainty. Confirm it or pick another.',
      severity: 'check',
      box: null,
    })
  }

  extraction?.lineItems.forEach((line, index) => {
    const current = draft.lineItems[index]
    if (!current || current.amount !== line.amount.value) return
    const reason = uncertaintyReason(line.amount, isDemo)
    if (reason) {
      items.push({ key: `lineItems.${index}.amount`, label: `Line item ${index + 1} amount`, reason, severity: 'check', box: line.amount.box })
    }
  })

  return items.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'missing' ? -1 : 1))
}

export function fieldDomId(key: string) {
  return `field-${key.replace(/\./g, '-')}`
}
