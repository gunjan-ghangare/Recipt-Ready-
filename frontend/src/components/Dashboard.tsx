import { useCallback, useEffect, useState } from 'react'
import { ApiError, type ExpenseApi } from '../lib/api'
import { computeAttention } from '../lib/attention'
import { formatDate, formatMoney, totalsByCurrency } from '../lib/format'
import { links } from '../lib/router'
import type { Expense } from '../types'
import { EmptyState, Notice, Spinner, StatusPill } from './ui'

/** Count of fields that need a look (the "category is only a suggestion" reminder is left out of the list view). */
function checksFor(expense: Expense): number {
  if (expense.status !== 'NEEDS_REVIEW' || !expense.draft) return 0
  return computeAttention(expense, expense.draft, false).filter((i) => !(i.key === 'category' && i.severity === 'check')).length
}

function ExpenseRow({ expense }: { expense: Expense }) {
  const draft = expense.draft
  const title = draft?.merchant || expense.receipt.fileName || 'Receipt'
  const checks = checksFor(expense)
  let sub: string
  if (expense.status === 'PROCESSING') sub = 'Reading your receipt\u2026'
  else if (expense.status === 'FAILED') sub = expense.error?.message ?? "This receipt couldn't be read."
  else sub = [formatDate(draft?.date ?? null), draft?.category ?? 'No category yet'].join(' \u00b7 ')

  return (
    <li>
      <a className="expense-row" href={links.expense(expense.id)}>
        <span className="row-main">
          <span className="row-title">{title}</span>
          <span className="row-sub">{sub}</span>
        </span>
        <span className="row-side">
          {draft?.total && <span className="row-amount">{formatMoney(draft.total, draft.currency)}</span>}
          <span className="row-badges">
            {checks > 0 && <span className="flag flag-check">{checks} to check</span>}
            {expense.status === 'PROCESSING' ? <Spinner /> : <StatusPill status={expense.status} />}
          </span>
        </span>
      </a>
    </li>
  )
}

export function Dashboard({ api }: { api: ExpenseApi }) {
  const [expenses, setExpenses] = useState<Expense[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setExpenses(await api.list())
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Your expenses couldn't be loaded.")
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load])

  const processing = expenses?.some((e) => e.status === 'PROCESSING') ?? false
  useEffect(() => {
    if (!processing) return
    const timer = window.setInterval(() => void load(), 3000)
    return () => window.clearInterval(timer)
  }, [processing, load])

  if (error && !expenses) {
    return (
      <main className="page" id="main" tabIndex={-1}>
        <Notice
          tone="error"
          title="Couldn't load your expenses"
          action={
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>
              Try again
            </button>
          }
        >
          {error}
        </Notice>
      </main>
    )
  }
  if (!expenses) {
    return (
      <main className="page" id="main" tabIndex={-1}>
        <Spinner label="Loading your expenses\u2026" />
      </main>
    )
  }

  if (expenses.length === 0) {
    return (
      <main className="page narrow" id="main" tabIndex={-1}>
        <EmptyState
          title="Let's get your first receipt in"
          action={
            <a className="btn btn-primary btn-lg" href={links.upload}>
              Upload a receipt
            </a>
          }
        >
          <ol className="checklist">
            <li>Upload a photo or PDF of a receipt.</li>
            <li>Check the draft. Anything uncertain is flagged for you.</li>
            <li>Approve it to save it to your expenses, or reject it to discard it.</li>
          </ol>
          {api.mode === 'demo' && <p className="muted">In demo mode you can start with one of the sample receipts.</p>}
        </EmptyState>
      </main>
    )
  }

  const toReview = expenses.filter((e) => e.status !== 'APPROVED')
  const approved = expenses.filter((e) => e.status === 'APPROVED')
  const totals = totalsByCurrency(approved.map((e) => ({ total: e.draft?.total ?? null, currency: e.draft?.currency ?? null })))

  return (
    <main className="page" id="main" tabIndex={-1}>
      <div className="page-head">
        <h1>Your expenses</h1>
      </div>
      {error && <Notice tone="warn">{error}</Notice>}

      <section className="section" aria-labelledby="review-heading">
        <div className="section-head">
          <h2 id="review-heading">Needs your review</h2>
          <span className="count">{toReview.length}</span>
        </div>
        {toReview.length === 0 ? (
          <p className="section-empty">You&rsquo;re all caught up. New uploads show up here for review.</p>
        ) : (
          <ul className="expense-list">
            {toReview.map((e) => (
              <ExpenseRow key={e.id} expense={e} />
            ))}
          </ul>
        )}
      </section>

      <section className="section" aria-labelledby="approved-heading">
        <div className="section-head">
          <h2 id="approved-heading">Approved</h2>
          <span className="count">{approved.length}</span>
          {totals.length > 0 && (
            <span className="totals">Total: {totals.map((t) => formatMoney(t.total, t.currency)).join(' \u00b7 ')}</span>
          )}
        </div>
        {approved.length === 0 ? (
          <p className="section-empty">Approved expenses appear here. Nothing is approved until you choose to approve it.</p>
        ) : (
          <ul className="expense-list">
            {approved.map((e) => (
              <ExpenseRow key={e.id} expense={e} />
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
