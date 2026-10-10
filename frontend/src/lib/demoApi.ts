/**
 * Demo mode: an in-browser stand-in for the ReceiptReady API, backed by localStorage.
 *
 * Everything here is synthetic sample data. Nothing is sent to AWS, nothing is read by
 * Amazon Textract or Amazon Bedrock, and no confidence scores are invented: uncertain sample
 * values are marked with `demoUncertain` instead.
 */
import { ApiError, type DemoSample, type ExpenseApi } from './api'
import type { Box, Category, Draft, Expense, ExtractedField, ExtractedLineItem, Extraction } from '../types'

const STORAGE_KEY = 'receiptready.demo.v1'
const objectUrls = new Map<string, string>()

interface SampleDefinition extends DemoSample {
  category: Category
  extraction: Extraction
}

function field(value: string | null, raw: string | null, box: Box | null, extra: Partial<ExtractedField> = {}): ExtractedField {
  return { value, raw, confidence: null, box, ...extra }
}

function box(left: number, top: number, width: number, height: number): Box {
  return { left, top, width, height, page: 1 }
}

function line(description: string, amount: string, top: number, quantity: string | null = null): ExtractedLineItem {
  return {
    description: field(description, description, box(0.09, top, 0.5, 0.034)),
    quantity: field(quantity, quantity, null),
    amount: field(amount, amount, box(0.74, top, 0.17, 0.034)),
  }
}

const EMPTY = (): ExtractedField => field(null, null, null)

const SAMPLES: SampleDefinition[] = [
  {
    id: 'cafe',
    title: 'Café receipt',
    description: 'Smudged total and a date that could be read two ways.',
    imageUrl: '/demo/cafe.svg',
    category: 'Meals',
    extraction: {
      merchant: field('Bluebird Café', 'BLUEBIRD CAFÉ', box(0.19, 0.072, 0.62, 0.052)),
      date: field('2026-03-04', '03/04/26', box(0.205, 0.19, 0.235, 0.034), { ambiguous: true }),
      total: field('20.12', '$20.12', box(0.68, 0.528, 0.23, 0.042), { demoUncertain: true }),
      currency: field('USD', 'USD', null),
      lineItems: [line('Flat white', '4.50', 0.265), line('Avocado toast', '11.00', 0.309), line('Sparkling water', '3.00', 0.353)],
      warnings: [],
    },
  },
  {
    id: 'rail',
    title: 'Train ticket',
    description: 'A clean, easy read. Everything is filled in.',
    imageUrl: '/demo/rail.svg',
    category: 'Travel',
    extraction: {
      merchant: field('Northwind Rail', 'NORTHWIND RAIL', box(0.16, 0.075, 0.68, 0.06)),
      date: field('2026-09-12', '12 Sep 2026', box(0.37, 0.172, 0.3, 0.036)),
      total: field('42.80', '£42.80', box(0.7, 0.372, 0.21, 0.046)),
      currency: field('GBP', 'GBP', null),
      lineItems: [line('Off-peak return, zones 1-4', '42.80', 0.243)],
      warnings: [],
    },
  },
  {
    id: 'software',
    title: 'Software invoice',
    description: 'No currency printed, so you pick it.',
    imageUrl: '/demo/software.svg',
    category: 'Software',
    extraction: {
      merchant: field('Pixel Forge', 'Pixel Forge', box(0.125, 0.073, 0.45, 0.06)),
      date: field('2026-09-01', 'September 1, 2026', box(0.35, 0.208, 0.4, 0.034)),
      total: field('29.00', '29.00', box(0.74, 0.475, 0.17, 0.04)),
      currency: EMPTY(),
      lineItems: [line('Pro plan (monthly)', '29.00', 0.343)],
      warnings: [],
    },
  },
  {
    id: 'supplies',
    title: 'Office supplies',
    description: 'Faded store name and a quantity on one line.',
    imageUrl: '/demo/supplies.svg',
    category: 'Supplies',
    extraction: {
      merchant: field('Paper & Co.', 'Paper & Co.', box(0.24, 0.07, 0.52, 0.056), { demoUncertain: true }),
      date: field('2026-09-18', '2026-09-18', box(0.24, 0.186, 0.27, 0.034)),
      total: field('24.47', 'USD 24.47', box(0.6, 0.5, 0.31, 0.042)),
      currency: field('USD', 'USD', null),
      lineItems: [line('Printer paper A4', '17.98', 0.272, '2'), line('Gel pens (12)', '6.49', 0.316)],
      warnings: [],
    },
  },
]

function nowIso() {
  return new Date().toISOString()
}

function newId() {
  return crypto.randomUUID()
}

function draftFrom(extraction: Extraction, category: Category | null): Draft {
  return {
    merchant: extraction.merchant.value,
    date: extraction.date.value,
    total: extraction.total.value,
    currency: extraction.currency.value,
    category,
    lineItems: extraction.lineItems.map((item) => ({
      description: item.description.value,
      quantity: item.quantity.value,
      amount: item.amount.value,
    })),
  }
}

interface StoredExpense extends Expense {
  demo: { startedAt: number; sampleId: string | null }
}

function load(): StoredExpense[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as StoredExpense[]
  } catch {
    return []
  }
}

function save(expenses: StoredExpense[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(expenses))
}

const STAGE_TIMES = { reading: 700, categorizing: 2300, done: 3600 }

/** Moves simulated processing forward based on elapsed time. */
function advance(expense: StoredExpense): StoredExpense {
  if (expense.status !== 'PROCESSING') return expense
  const elapsed = Date.now() - expense.demo.startedAt
  if (elapsed < STAGE_TIMES.reading) return { ...expense, stage: 'QUEUED' }
  if (elapsed < STAGE_TIMES.categorizing) return { ...expense, stage: 'READING' }
  if (elapsed < STAGE_TIMES.done) return { ...expense, stage: 'CATEGORIZING' }

  const sample = SAMPLES.find((s) => s.id === expense.demo.sampleId)
  const extraction: Extraction = sample
    ? structuredClone(sample.extraction)
    : { merchant: EMPTY(), date: EMPTY(), total: EMPTY(), currency: EMPTY(), lineItems: [], warnings: ['DEMO_FILE_NOT_READ'] }
  return {
    ...expense,
    status: 'NEEDS_REVIEW',
    stage: null,
    updatedAt: nowIso(),
    extraction,
    draft: draftFrom(extraction, sample?.category ?? null),
    suggestion: { status: sample ? 'DEMO' : 'NOT_ENOUGH_DATA', category: sample?.category ?? null, modelId: null, source: 'DEMO' },
  }
}

function withViewUrl(expense: StoredExpense): Expense {
  const sample = SAMPLES.find((s) => s.id === expense.demo.sampleId)
  const viewUrl = sample?.imageUrl ?? objectUrls.get(expense.id)
  return { ...expense, receipt: { ...expense.receipt, viewUrl } }
}

function simulateUpload(onProgress: (fraction: number) => void) {
  return new Promise<void>((resolve) => {
    let fraction = 0
    const timer = window.setInterval(() => {
      fraction = Math.min(1, fraction + 0.2)
      onProgress(fraction)
      if (fraction >= 1) {
        window.clearInterval(timer)
        resolve()
      }
    }, 140)
  })
}

export function createDemoApi(): ExpenseApi {
  function update(id: string, change: (e: StoredExpense) => StoredExpense | null): StoredExpense | null {
    const expenses = load().map(advance)
    const index = expenses.findIndex((e) => e.id === id)
    if (index < 0) throw new ApiError('NOT_FOUND', "We couldn't find that expense. It may have been deleted.", 404)
    const next = change(expenses[index])
    if (next) expenses[index] = next
    else expenses.splice(index, 1)
    save(expenses)
    return next
  }

  async function create(file: { name: string; type: string; size: number }, sampleId: string | null, onProgress: (f: number) => void) {
    await simulateUpload(onProgress)
    const timestamp = nowIso()
    const expense: StoredExpense = {
      id: newId(),
      status: 'PROCESSING',
      stage: 'QUEUED',
      createdAt: timestamp,
      updatedAt: timestamp,
      approvedAt: null,
      source: 'DEMO',
      receipt: { fileName: file.name, contentType: file.type, size: file.size },
      draft: null,
      extraction: null,
      suggestion: null,
      demo: { startedAt: Date.now(), sampleId },
    }
    save([expense, ...load()])
    return expense
  }

  function requireDraft(expense: StoredExpense) {
    if (expense.status === 'APPROVED') {
      throw new ApiError('ALREADY_APPROVED', 'This expense is already approved. Delete it instead if it shouldn\u2019t be kept.', 409)
    }
    if (expense.status !== 'NEEDS_REVIEW') throw new ApiError('NOT_A_DRAFT', 'Only drafts can be changed.', 409)
  }

  return {
    mode: 'demo',
    samples: SAMPLES.map(({ id, title, description, imageUrl }) => ({ id, title, description, imageUrl })),
    async list() {
      const expenses = load().map(advance)
      save(expenses)
      return expenses.map(withViewUrl)
    },
    async get(id) {
      const expense = load().map(advance).find((e) => e.id === id)
      if (!expense) throw new ApiError('NOT_FOUND', "We couldn't find that expense. It may have been deleted.", 404)
      return withViewUrl(expense)
    },
    async upload(file, onProgress) {
      const expense = await create(file, null, onProgress)
      objectUrls.set(expense.id, URL.createObjectURL(file))
      return withViewUrl(expense)
    },
    async uploadSample(sampleId, onProgress) {
      const sample = SAMPLES.find((s) => s.id === sampleId)
      if (!sample) throw new ApiError('NOT_FOUND', 'That sample is not available.', 404)
      const expense = await create({ name: `${sample.id}-sample.svg`, type: 'image/svg+xml', size: 0 }, sample.id, onProgress)
      return withViewUrl(expense)
    },
    async retry(id) {
      return withViewUrl(update(id, (e) => ({ ...e, status: 'PROCESSING', stage: 'QUEUED', demo: { ...e.demo, startedAt: Date.now() } }))!)
    },
    async saveDraft(id, draft) {
      return withViewUrl(
        update(id, (e) => {
          requireDraft(e)
          return { ...e, draft, updatedAt: nowIso() }
        })!,
      )
    },
    async approve(id, draft) {
      return withViewUrl(
        update(id, (e) => {
          requireDraft(e)
          const timestamp = nowIso()
          return { ...e, draft, status: 'APPROVED', approvedAt: timestamp, updatedAt: timestamp }
        })!,
      )
    },
    async reject(id) {
      update(id, (e) => {
        if (e.status === 'APPROVED') requireDraft(e)
        return null
      })
      objectUrls.delete(id)
    },
    async remove(id) {
      update(id, () => null)
      objectUrls.delete(id)
    },
    resetDemo() {
      localStorage.removeItem(STORAGE_KEY)
      objectUrls.clear()
    },
  }
}
