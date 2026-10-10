import { useEffect, useRef, type ReactNode } from 'react'
import type { ExpenseStatus } from '../types'

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="spinner-wrap" role={label ? 'status' : undefined}>
      <span className="spinner" aria-hidden="true" />
      {label && <span>{label}</span>}
    </span>
  )
}

const STATUS_TEXT: Record<ExpenseStatus, string> = {
  AWAITING_UPLOAD: 'Uploading',
  PROCESSING: 'Reading',
  NEEDS_REVIEW: 'Needs review',
  APPROVED: 'Approved',
  FAILED: 'Needs attention',
}

export function StatusPill({ status }: { status: ExpenseStatus }) {
  return <span className={`pill pill-${status.toLowerCase().replace('_', '-')}`}>{STATUS_TEXT[status]}</span>
}

export function Notice({ tone = 'info', title, children, action }: { tone?: 'info' | 'warn' | 'error' | 'demo'; title?: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className={`notice notice-${tone}`} role={tone === 'error' ? 'alert' : undefined}>
      <div>
        {title && <p className="notice-title">{title}</p>}
        {children && <div className="notice-body">{children}</div>}
      </div>
      {action && <div className="notice-action">{action}</div>}
    </div>
  )
}

export function EmptyState({ title, children, action, art }: { title: string; children?: ReactNode; action?: ReactNode; art?: ReactNode }) {
  return (
    <div className="empty">
      {art ?? <ReceiptArt />}
      <h2>{title}</h2>
      {children && <div className="empty-body">{children}</div>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  )
}

export function ReceiptArt() {
  return (
    <svg className="empty-art" viewBox="0 0 120 120" aria-hidden="true">
      <circle cx="60" cy="60" r="56" fill="var(--accent-soft)" />
      <path d="M38 24h44v72l-7-5-7 5-7-5-7 5-7-5-9 5z" fill="#fff" stroke="var(--accent)" strokeWidth="3" strokeLinejoin="round" />
      <path d="M47 40h26M47 50h26M47 60h16" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" />
      <circle cx="78" cy="74" r="11" fill="var(--accent)" />
      <path d="m73 74 4 4 7-8" stroke="#fff" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

interface ConfirmDialogProps {
  open: boolean
  title: string
  body: ReactNode
  confirmLabel: string
  tone?: 'danger' | 'primary'
  busy?: boolean
  onConfirm(): void
  onCancel(): void
}

/** Native <dialog> gives focus trapping and Escape-to-close for free. */
export function ConfirmDialog({ open, title, body, confirmLabel, tone = 'danger', busy, onConfirm, onCancel }: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="dialog-title"
      onCancel={(event) => {
        event.preventDefault()
        onCancel()
      }}
    >
      <h2 id="dialog-title">{title}</h2>
      <div className="dialog-body">{body}</div>
      <div className="dialog-actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className={`btn ${tone === 'danger' ? 'btn-danger' : 'btn-primary'}`} onClick={onConfirm} disabled={busy}>
          {busy ? <Spinner /> : null}
          {confirmLabel}
        </button>
      </div>
    </dialog>
  )
}
