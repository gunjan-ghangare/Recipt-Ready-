import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ApiError, type ExpenseApi } from '../lib/api'
import { computeAttention, fieldDomId, type AttentionItem } from '../lib/attention'
import { formatDate, formatMoney, formatTimestamp } from '../lib/format'
import { links, navigate } from '../lib/router'
import { useToast } from '../lib/toast'
import { CATEGORIES, type Box, type Category, type Draft, type Expense, type ExtractedField, type LineItem } from '../types'
import { ProcessingSteps } from './ProcessingSteps'
import { ReceiptViewer } from './ReceiptViewer'
import { ConfirmDialog, Notice, Spinner, StatusPill } from './ui'

const EMPTY_DRAFT: Draft = { merchant: null, date: null, total: null, currency: null, category: null, lineItems: [] }
const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'CHF', 'JPY', 'INR', 'SEK', 'HKD', 'CNY', 'SGD', 'MXN', 'BRL']
const AMOUNT = /^\d{1,8}(\.\d{1,3})?$/
const QUANTITY = /^\d{1,6}(\.\d{1,3})?$/
const SLOW_AFTER_MS = 75_000

type Busy = null | 'save' | 'approve' | 'reject' | 'delete' | 'retry'
type HeadField = 'merchant' | 'date' | 'total' | 'currency'
type LineField = keyof LineItem

function asApiError(err: unknown): ApiError {
  return err instanceof ApiError ? err : new ApiError('INTERNAL_ERROR', 'Something went wrong. Try again in a moment.')
}

function trimOrNull(value: string | null | undefined): string | null {
  const text = (value ?? '').trim()
  return text ? text : null
}

/** Trimmed copy that keeps row positions, so error keys line up with the form rows. */
function normalize(draft: Draft): Draft {
  return {
    merchant: trimOrNull(draft.merchant),
    date: trimOrNull(draft.date),
    total: trimOrNull(draft.total)?.replace(/,/g, '') ?? null,
    currency: trimOrNull(draft.currency)?.toUpperCase() ?? null,
    category: draft.category,
    lineItems: draft.lineItems.map((item) => ({
      description: trimOrNull(item.description),
      quantity: trimOrNull(item.quantity),
      amount: trimOrNull(item.amount)?.replace(/,/g, '') ?? null,
    })),
  }
}

const hasContent = (item: LineItem) => Boolean(item.description || item.quantity || item.amount)

function forServer(draft: Draft): Draft {
  const clean = normalize(draft)
  return { ...clean, lineItems: clean.lineItems.filter(hasContent) }
}

function formatErrors(draft: Draft): Record<string, string> {
  const errors: Record<string, string> = {}
  if (draft.total && !AMOUNT.test(draft.total)) errors.total = 'Enter a number like 12.50.'
  if (draft.currency && !/^[A-Z]{3}$/.test(draft.currency)) errors.currency = 'Use a 3-letter code like USD.'
  draft.lineItems.forEach((item, i) => {
    if (item.amount && !AMOUNT.test(item.amount)) errors[`lineItems.${i}.amount`] = 'Enter a number like 4.50.'
    if (item.quantity && !QUANTITY.test(item.quantity)) errors[`lineItems.${i}.quantity`] = 'Enter a number.'
  })
  return errors
}

function approvalErrors(draft: Draft): Record<string, string> {
  const errors = formatErrors(draft)
  if (!draft.merchant) errors.merchant = 'Add the merchant name.'
  if (!draft.date) errors.date = 'Add the receipt date.'
  if (!draft.total) errors.total = 'Add the total amount.'
  else if (!errors.total && Number(draft.total) <= 0) errors.total = 'The total must be more than zero.'
  if (!draft.currency) errors.currency = 'Add the currency.'
  if (!draft.category) errors.category = 'Choose a category.'
  return errors
}

function sameDraft(a: Draft, b: Draft) {
  return JSON.stringify(forServer(a)) === JSON.stringify(forServer(b))
}

/** Where a value came from, in plain words. Confidence is shown only when Amazon Textract returned it. */
function describeSource(expense: Expense, extracted: ExtractedField | undefined, value: string | null): string | null {
  const shows = extracted?.raw ? ` \u00b7 receipt shows \u201c${extracted.raw}\u201d` : ''
  if (!extracted || extracted.value === null) return value ? `Entered by you${shows}` : null
  if ((trimOrNull(value) ?? null) !== extracted.value) return `Edited by you${shows}`
  if (expense.source === 'DEMO') return `Sample value (demo data, not read by Textract)${shows}`
  const asRead = extracted.raw && extracted.raw !== extracted.value ? ` as \u201c${extracted.raw}\u201d` : ''
  const confidence = extracted.confidence !== null ? ` \u00b7 ${Math.round(extracted.confidence)}% confidence` : ''
  return `Read by Amazon Textract${asRead}${confidence}`
}

function suggestionNote(expense: Expense): string {
  const suggestion = expense.suggestion
  if (expense.source === 'DEMO') {
    return suggestion?.category
      ? `Sample suggestion: ${suggestion.category}. This is demo data, not an Amazon Bedrock result.`
      : 'Demo mode has no suggestion for your own file. Choose a category.'
  }
  if (suggestion?.status === 'SUGGESTED' && suggestion.category) {
    return `Suggested by Amazon Bedrock from the merchant and items: ${suggestion.category}. It\u2019s a best guess, so check it.`
  }
  switch (suggestion?.status) {
    case 'NOT_ENOUGH_DATA':
      return 'There wasn\u2019t enough on the receipt to suggest a category. Choose one.'
    case 'NOT_CONFIGURED':
      return 'Category suggestions aren\u2019t set up for this deployment. Choose a category.'
    case 'INVALID_RESPONSE':
      return 'We couldn\u2019t get a usable suggestion this time. Choose a category.'
    default:
      return 'Category suggestions aren\u2019t available right now. Choose a category.'
  }
}

interface FieldProps {
  fieldKey: string
  label: string
  hint: string | null
  issue?: AttentionItem
  error?: string
  children: (props: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode
}

function Field({ fieldKey, label, hint, issue, error, children }: FieldProps) {
  const id = fieldDomId(fieldKey)
  const describedBy = [error && `${id}-error`, !error && issue && `${id}-issue`, hint && `${id}-hint`].filter(Boolean).join(' ') || undefined
  return (
    <div className={`field${issue ? ` field-${issue.severity}` : ''}${error ? ' field-invalid' : ''}`}>
      <label htmlFor={id}>
        {label}
        {issue && !error && <span className={`flag flag-${issue.severity}`}>{issue.severity === 'missing' ? 'Missing' : 'Check'}</span>}
      </label>
      {children({ id, describedBy, invalid: Boolean(error) })}
      {error && (
        <p className="field-message error-text" id={`${id}-error`}>
          {error}
        </p>
      )}
      {!error && issue && (
        <p className="field-message" id={`${id}-issue`}>
          {issue.reason}
        </p>
      )}
      {hint && (
        <p className="field-hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
    </div>
  )
}

export function Review({ api, id }: { api: ExpenseApi; id: string }) {
  const toast = useToast()
  const [expense, setExpense] = useState<Expense | null>(null)
  const [loadError, setLoadError] = useState<ApiError | null>(null)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [savedDraft, setSavedDraft] = useState<Draft>(EMPTY_DRAFT)
  const [rowKeys, setRowKeys] = useState<number[]>([])
  const [categoryConfirmed, setCategoryConfirmed] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [confirm, setConfirm] = useState<null | 'reject' | 'delete'>(null)
  const [slow, setSlow] = useState(false)
  const nextRowKey = useRef(0)
  const focusedFirstIssue = useRef(false)

  const applyExpense = useCallback((next: Expense, keepRows?: boolean[]) => {
    setExpense(next)
    if (!next.draft) return
    setDraft(next.draft)
    setSavedDraft(next.draft)
    setRowKeys((keys) => {
      if (keepRows) return keys.filter((_, i) => keepRows[i])
      return next.draft!.lineItems.map(() => nextRowKey.current++)
    })
  }, [])

  const load = useCallback(async () => {
    try {
      applyExpense(await api.get(id))
      setLoadError(null)
    } catch (err) {
      setLoadError(asApiError(err))
    }
  }, [api, id, applyExpense])

  useEffect(() => {
    void load()
  }, [load])

  // Poll while the receipt is being read.
  const status = expense?.status
  useEffect(() => {
    if (status !== 'PROCESSING') return
    const started = Date.now()
    const timer = window.setInterval(async () => {
      if (Date.now() - started > SLOW_AFTER_MS) setSlow(true)
      try {
        applyExpense(await api.get(id))
      } catch {
        // Keep polling; a transient network error shouldn't end the wait.
      }
    }, 1500)
    return () => window.clearInterval(timer)
  }, [api, id, status, applyExpense])

  const attention = useMemo(
    () => (expense?.status === 'NEEDS_REVIEW' ? computeAttention(expense, normalize(draft), categoryConfirmed) : []),
    [expense, draft, categoryConfirmed],
  )
  const issueFor = (key: string) => attention.find((item) => item.key === key)

  const goToField = useCallback((key: string) => {
    const element = document.getElementById(fieldDomId(key))
    if (!element) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    element.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' })
    element.focus({ preventScroll: true })
    setActiveKey(key)
  }, [])

  // Bring the user straight to the first field that needs attention, once per draft.
  useEffect(() => {
    if (expense?.status !== 'NEEDS_REVIEW' || focusedFirstIssue.current) return
    focusedFirstIssue.current = true
    const first = attention[0]
    if (first) window.requestAnimationFrame(() => goToField(first.key))
  }, [expense?.status, attention, goToField])

  function boxFor(key: string | null): Box | null {
    const extraction = expense?.extraction
    if (!key || !extraction) return null
    if (key === 'currency') return extraction.currency.box ?? extraction.total.box
    if (key === 'merchant' || key === 'date' || key === 'total') return extraction[key].box
    const match = key.match(/^lineItems\.(\d+)\.(description|quantity|amount)$/)
    if (!match) return null
    const index = Number(match[1])
    const source = extraction.lineItems[index]
    const current = draft.lineItems[index]
    // Only highlight if the row still corresponds to what was extracted.
    if (!source || !current || (current.description !== source.description.value && current.amount !== source.amount.value)) return null
    return source[match[2] as LineField].box ?? source.description.box
  }

  function setField(key: HeadField, value: string) {
    setDraft((d) => ({ ...d, [key]: key === 'currency' ? value.toUpperCase().slice(0, 3) : value }))
    setErrors(({ [key]: _removed, ...rest }) => rest)
  }

  function setLine(index: number, key: LineField, value: string) {
    setDraft((d) => ({ ...d, lineItems: d.lineItems.map((item, i) => (i === index ? { ...item, [key]: value } : item)) }))
    setErrors(({ [`lineItems.${index}.${key}`]: _removed, ...rest }) => rest)
  }

  function addLine() {
    setDraft((d) => ({ ...d, lineItems: [...d.lineItems, { description: '', quantity: null, amount: '' }] }))
    const key = nextRowKey.current++
    setRowKeys((keys) => [...keys, key])
    window.requestAnimationFrame(() => document.getElementById(fieldDomId(`lineItems.${draft.lineItems.length}.description`))?.focus())
  }

  function removeLine(index: number) {
    setDraft((d) => ({ ...d, lineItems: d.lineItems.filter((_, i) => i !== index) }))
    setRowKeys((keys) => keys.filter((_, i) => i !== index))
    setErrors({})
  }

  function showErrors(found: Record<string, string>, message: string) {
    setErrors(found)
    const first = Object.keys(found)[0]
    if (first) window.requestAnimationFrame(() => goToField(first))
    toast.show(message, 'error')
  }

  function handleServerError(err: unknown) {
    const apiError = asApiError(err)
    if (apiError.fields.length > 0) {
      showErrors(Object.fromEntries(apiError.fields.map((f) => [f.field, f.message])), apiError.message)
    } else {
      toast.show(apiError.message, 'error')
      if (apiError.status === 409 || apiError.status === 404) void load()
    }
  }

  async function save() {
    const clean = normalize(draft)
    const found = formatErrors(clean)
    if (Object.keys(found).length) return showErrors(found, 'Fix the highlighted fields to save.')
    setBusy('save')
    try {
      applyExpense(await api.saveDraft(id, forServer(draft)), clean.lineItems.map(hasContent))
      setErrors({})
      toast.show('Draft saved.')
    } catch (err) {
      handleServerError(err)
    } finally {
      setBusy(null)
    }
  }

  async function approve() {
    const clean = normalize(draft)
    const found = approvalErrors(clean)
    if (Object.keys(found).length) return showErrors(found, 'A few fields need attention before you can approve.')
    setBusy('approve')
    try {
      await api.approve(id, forServer(draft))
      toast.show('Expense approved and saved.')
      navigate(links.home)
    } catch (err) {
      handleServerError(err)
      setBusy(null)
    }
  }

  async function discard(kind: 'reject' | 'delete') {
    setBusy(kind)
    try {
      if (kind === 'reject') await api.reject(id)
      else await api.remove(id)
      toast.show(kind === 'reject' ? 'Draft rejected. The receipt file was deleted.' : 'Expense deleted, along with its receipt file.', 'info')
      navigate(links.home)
    } catch (err) {
      handleServerError(err)
      setBusy(null)
      setConfirm(null)
    }
  }

  async function retry() {
    setBusy('retry')
    setSlow(false)
    try {
      applyExpense(await api.retry(id))
    } catch (err) {
      handleServerError(err)
    } finally {
      setBusy(null)
    }
  }

  if (loadError) {
    return (
      <main className="page narrow" id="main" tabIndex={-1}>
        <a className="back-link" href={links.home}>
          &larr; All expenses
        </a>
        <Notice
          tone="error"
          title={loadError.status === 404 ? 'Expense not found' : "Couldn't open this expense"}
          action={
            loadError.status === 404 ? undefined : (
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>
                Try again
              </button>
            )
          }
        >
          {loadError.message}
        </Notice>
      </main>
    )
  }

  if (!expense) {
    return (
      <main className="page" id="main" tabIndex={-1}>
        <Spinner label="Opening expense\u2026" />
      </main>
    )
  }

  const isDemo = expense.source === 'DEMO'
  const viewer = (
    <ReceiptViewer
      key={expense.receipt.viewUrl ?? 'none'}
      url={expense.receipt.viewUrl}
      contentType={expense.receipt.contentType}
      fileName={expense.receipt.fileName}
      highlight={boxFor(activeKey)}
      highlightLabel={activeKey ? issueFor(activeKey)?.label : undefined}
      onReload={() => void load()}
    />
  )
  const confirmDialog = (
    <ConfirmDialog
      open={confirm !== null}
      title={confirm === 'delete' ? 'Delete this expense?' : 'Reject this draft?'}
      body={
        confirm === 'delete'
          ? 'The approved expense and its receipt file will be permanently deleted.'
          : 'The draft and its receipt file will be permanently deleted. Nothing will be saved as an expense.'
      }
      confirmLabel={confirm === 'delete' ? 'Delete expense' : 'Reject and delete'}
      busy={busy === 'reject' || busy === 'delete'}
      onConfirm={() => confirm && void discard(confirm)}
      onCancel={() => setConfirm(null)}
    />
  )
  const header = (
    <>
      <a className="back-link" href={links.home}>
        &larr; All expenses
      </a>
      <div className="review-head">
        <h1>{expense.status === 'APPROVED' ? draft.merchant || 'Expense' : 'Review draft'}</h1>
        <StatusPill status={expense.status} />
      </div>
      <p className="source-line">
        {isDemo
          ? 'Demo sample data. These values were not produced by Amazon Textract or Amazon Bedrock.'
          : `Uploaded ${formatTimestamp(expense.createdAt)}${expense.receipt.fileName ? ` \u00b7 ${expense.receipt.fileName}` : ''}`}
      </p>
    </>
  )

  if (expense.status === 'PROCESSING' || expense.status === 'AWAITING_UPLOAD') {
    return (
      <main className="page narrow" id="main" tabIndex={-1}>
        {header}
        <div className="card">
          <h2>Reading your receipt</h2>
          <p className="muted">This usually takes a few seconds. You can leave this page; the draft will be waiting for you.</p>
          <ProcessingSteps stage={expense.stage} source={expense.source} />
          {slow && (
            <Notice
              tone="warn"
              title="This is taking longer than usual"
              action={
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => void retry()} disabled={busy === 'retry'}>
                  Try again
                </button>
              }
            >
              The receipt reader may be busy. Keep waiting, or try again.
            </Notice>
          )}
        </div>
      </main>
    )
  }

  if (expense.status === 'FAILED') {
    return (
      <main className="page" id="main" tabIndex={-1}>
        {header}
        <div className="review-grid">
          <section className="receipt-pane" aria-label="Receipt">
            {viewer}
          </section>
          <section className="form-pane">
            <Notice tone="error" title="This receipt couldn't be read">
              {expense.error?.message ?? 'Something went wrong while reading this receipt.'}
            </Notice>
            <div className="button-row">
              {expense.error?.retryable && (
                <button type="button" className="btn btn-primary" onClick={() => void retry()} disabled={busy !== null}>
                  {busy === 'retry' && <Spinner />}
                  Try again
                </button>
              )}
              <a className="btn btn-secondary" href={links.upload}>
                Upload a different photo
              </a>
              <button type="button" className="btn btn-ghost" onClick={() => setConfirm('reject')} disabled={busy !== null}>
                Discard
              </button>
            </div>
          </section>
        </div>
        {confirmDialog}
      </main>
    )
  }

  if (expense.status === 'APPROVED') {
    return (
      <main className="page" id="main" tabIndex={-1}>
        {header}
        <div className="review-grid">
          <section className="receipt-pane" aria-label="Receipt">
            {viewer}
          </section>
          <section className="form-pane">
            <div className="card">
              <p className="muted small">Approved {formatTimestamp(expense.approvedAt)}. Approved expenses are read-only.</p>
              <dl className="summary">
                <dt>Merchant</dt>
                <dd>{draft.merchant}</dd>
                <dt>Date</dt>
                <dd>{formatDate(draft.date)}</dd>
                <dt>Total</dt>
                <dd>{formatMoney(draft.total, draft.currency)}</dd>
                <dt>Category</dt>
                <dd>{draft.category}</dd>
              </dl>
              {draft.lineItems.length > 0 && (
                <table className="items-table">
                  <caption>Line items</caption>
                  <thead>
                    <tr>
                      <th scope="col">Item</th>
                      <th scope="col">Qty</th>
                      <th scope="col">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {draft.lineItems.map((item, i) => (
                      <tr key={i}>
                        <td>{item.description ?? '\u2014'}</td>
                        <td>{item.quantity ?? ''}</td>
                        <td>{formatMoney(item.amount, draft.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="button-row">
              <button type="button" className="btn btn-danger-ghost" onClick={() => setConfirm('delete')}>
                Delete expense
              </button>
            </div>
          </section>
        </div>
        {confirmDialog}
      </main>
    )
  }

  // NEEDS_REVIEW: the editable draft.
  const extraction = expense.extraction
  const dirty = !sameDraft(draft, savedDraft)
  const suggestion = expense.suggestion
  const showKeepSuggestion = Boolean(suggestion?.category) && draft.category === suggestion?.category && !categoryConfirmed

  const headField = (key: HeadField, label: string, input: (p: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode) => (
    <Field fieldKey={key} label={label} hint={describeSource(expense, extraction?.[key], draft[key])} issue={issueFor(key)} error={errors[key]}>
      {input}
    </Field>
  )

  return (
    <main className="page" id="main" tabIndex={-1}>
      {header}
      <div className="review-grid">
        <section className="receipt-pane" aria-label="Receipt">
          {viewer}
        </section>

        <form
          className="form-pane"
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            void approve()
          }}
        >
          {extraction?.warnings.includes('DEMO_FILE_NOT_READ') && (
            <Notice tone="demo" title="Your file wasn't read">
              Demo mode doesn&rsquo;t send files anywhere. Fill in the fields from your receipt to try the review flow.
            </Notice>
          )}
          {extraction?.warnings.includes('MULTIPLE_RECEIPTS') && (
            <Notice tone="warn" title="More than one receipt found">
              Only the first receipt in this image was read. For best results, upload one receipt per photo.
            </Notice>
          )}

          <section className={`attention${attention.length ? '' : ' attention-clear'}`} aria-labelledby="attention-heading">
            {attention.length ? (
              <>
                <h2 id="attention-heading">
                  {attention.length === 1 ? '1 thing needs your attention' : `${attention.length} things need your attention`}
                </h2>
                <ul>
                  {attention.map((item) => (
                    <li key={item.key}>
                      <button type="button" className={`attention-item attention-${item.severity}`} onClick={() => goToField(item.key)}>
                        <span className="attention-label">{item.label}</span>
                        <span className="attention-reason">{item.reason}</span>
                        <span className="attention-go" aria-hidden="true">
                          Go to field &rarr;
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <h2 id="attention-heading">Everything was found. Give it a quick look, then approve.</h2>
            )}
          </section>

          <div className="card fields">
            {headField('merchant', 'Merchant', ({ id: fid, describedBy, invalid }) => (
              <input
                id={fid}
                className="input"
                value={draft.merchant ?? ''}
                maxLength={120}
                autoComplete="off"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                onFocus={() => setActiveKey('merchant')}
                onChange={(e) => setField('merchant', e.target.value)}
              />
            ))}
            <div className="field-pair">
              {headField('date', 'Date', ({ id: fid, describedBy, invalid }) => (
                <input
                  id={fid}
                  className="input"
                  type="date"
                  value={draft.date ?? ''}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  onFocus={() => setActiveKey('date')}
                  onChange={(e) => setField('date', e.target.value)}
                />
              ))}
              {headField('total', 'Total', ({ id: fid, describedBy, invalid }) => (
                <input
                  id={fid}
                  className="input"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={draft.total ?? ''}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  onFocus={() => setActiveKey('total')}
                  onChange={(e) => setField('total', e.target.value)}
                />
              ))}
              {headField('currency', 'Currency', ({ id: fid, describedBy, invalid }) => (
                <>
                  <input
                    id={fid}
                    className="input input-short"
                    list="currency-options"
                    placeholder="USD"
                    autoComplete="off"
                    value={draft.currency ?? ''}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    onFocus={() => setActiveKey('currency')}
                    onChange={(e) => setField('currency', e.target.value)}
                  />
                  <datalist id="currency-options">
                    {CURRENCIES.map((code) => (
                      <option key={code} value={code} />
                    ))}
                  </datalist>
                </>
              ))}
            </div>

            <Field fieldKey="category" label="Category" hint={suggestionNote(expense)} issue={issueFor('category')} error={errors.category}>
              {({ id: fid, describedBy, invalid }) => (
                <div className="category-row">
                  <select
                    id={fid}
                    className="input"
                    value={draft.category ?? ''}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    onFocus={() => setActiveKey('category')}
                    onChange={(e) => {
                      setDraft((d) => ({ ...d, category: (e.target.value || null) as Category | null }))
                      setCategoryConfirmed(true)
                      setErrors(({ category: _removed, ...rest }) => rest)
                    }}
                  >
                    <option value="">Choose a category</option>
                    {CATEGORIES.map((category) => (
                      <option key={category} value={category}>
                        {category}
                        {suggestion?.category === category ? (isDemo ? ' (sample suggestion)' : ' (suggested)') : ''}
                      </option>
                    ))}
                  </select>
                  {showKeepSuggestion && (
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setCategoryConfirmed(true)}>
                      Keep {suggestion?.category}
                    </button>
                  )}
                </div>
              )}
            </Field>

            <fieldset className="line-items">
              <legend>
                Line items <span className="muted">(optional)</span>
              </legend>
              {draft.lineItems.length === 0 && <p className="muted small">No line items found. Add them if you want the detail.</p>}
              {draft.lineItems.length > 0 && (
                <div className="line-head" aria-hidden="true">
                  <span>Description</span>
                  <span>Qty</span>
                  <span>Amount</span>
                  <span />
                </div>
              )}
              {draft.lineItems.map((item, index) => {
                const base = `lineItems.${index}`
                const issue = issueFor(`${base}.amount`)
                const rowError = errors[`${base}.amount`] ?? errors[`${base}.quantity`] ?? errors[`${base}.description`]
                const lineInput = (key: LineField, label: string, extra: Record<string, string> = {}) => (
                  <input
                    id={fieldDomId(`${base}.${key}`)}
                    className={`input${key === 'amount' && issue ? ` input-${issue.severity}` : ''}`}
                    aria-label={`Line ${index + 1} ${label}`}
                    aria-invalid={Boolean(errors[`${base}.${key}`])}
                    value={item[key] ?? ''}
                    onFocus={() => setActiveKey(`${base}.${key}`)}
                    onChange={(e) => setLine(index, key, e.target.value)}
                    {...extra}
                  />
                )
                return (
                  <div className="line-row" key={rowKeys[index] ?? `row-${index}`}>
                    {lineInput('description', 'description', { maxLength: '200' })}
                    {lineInput('quantity', 'quantity', { inputMode: 'decimal' })}
                    {lineInput('amount', 'amount', { inputMode: 'decimal' })}
                    <button type="button" className="icon-btn" aria-label={`Remove line ${index + 1}`} onClick={() => removeLine(index)}>
                      &times;
                    </button>
                    {(rowError || issue) && <p className={`line-message${rowError ? ' error-text' : ''}`}>{rowError ?? issue?.reason}</p>}
                  </div>
                )
              })}
              <button type="button" className="btn btn-ghost btn-sm" onClick={addLine}>
                + Add line item
              </button>
            </fieldset>
          </div>

          <div className="action-bar">
            <button type="button" className="btn btn-danger-ghost" onClick={() => setConfirm('reject')} disabled={busy !== null}>
              Reject
            </button>
            <span className="action-status" aria-live="polite">
              {dirty ? 'Unsaved changes' : 'All changes saved'}
            </span>
            <button type="button" className="btn btn-secondary" onClick={() => void save()} disabled={busy !== null || !dirty}>
              {busy === 'save' && <Spinner />}
              Save draft
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy !== null}>
              {busy === 'approve' && <Spinner />}
              Approve expense
            </button>
          </div>
        </form>
      </div>
      {confirmDialog}
    </main>
  )
}
