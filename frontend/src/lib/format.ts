export function formatMoney(amount: string | null, currency: string | null): string {
  if (!amount) return '\u2014'
  const value = Number(amount)
  if (!Number.isFinite(value)) return amount
  if (currency && /^[A-Z]{3}$/.test(currency)) {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value)
    } catch {
      // Unknown currency code: fall through to a plain number.
    }
  }
  return `${value.toFixed(2)}${currency ? ` ${currency}` : ''}`
}

export function formatDate(iso: string | null): string {
  if (!iso) return '\u2014'
  const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' }).format(date)
}

export function formatTimestamp(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export function formatBytes(size: number | null): string {
  if (!size) return ''
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

/** Sum amounts per currency without floating-point drift (works in minor units). */
export function totalsByCurrency(rows: { total: string | null; currency: string | null }[]) {
  const sums = new Map<string, bigint>()
  for (const row of rows) {
    if (!row.total || !row.currency) continue
    const [whole, fraction = ''] = row.total.split('.')
    const minor = BigInt(whole) * 1000n + BigInt((fraction + '000').slice(0, 3))
    sums.set(row.currency, (sums.get(row.currency) ?? 0n) + minor)
  }
  return [...sums.entries()].map(([currency, minor]) => ({
    currency,
    total: `${minor / 1000n}.${(minor % 1000n).toString().padStart(3, '0').slice(0, 2)}`,
  }))
}
