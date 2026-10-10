import { useEffect, useRef, useState } from 'react'
import type { Box } from '../types'

interface ReceiptViewerProps {
  url?: string
  contentType: string | null
  fileName: string | null
  highlight: Box | null
  highlightLabel?: string
  onReload(): void
}

/** Shows the receipt next to the form. When a field is focused, its location on the receipt is spotlighted. */
export function ReceiptViewer({ url, contentType, fileName, highlight, highlightLabel, onReload }: ReceiptViewerProps) {
  const [failed, setFailed] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!highlight) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    boxRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reduce ? 'auto' : 'smooth' })
  }, [highlight])

  if (!url) {
    return (
      <div className="receipt-missing">
        <p>The receipt preview isn&rsquo;t available.</p>
        <p className="muted small">In demo mode, previews of your own files only last until the page reloads.</p>
      </div>
    )
  }

  if (failed) {
    return (
      <div className="receipt-missing">
        <p>The preview link has expired.</p>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onReload}>
          Reload preview
        </button>
      </div>
    )
  }

  if (contentType === 'application/pdf') {
    return (
      <div>
        <iframe className="receipt-pdf" src={url} title={`Receipt ${fileName ?? ''}`} onError={() => setFailed(true)} />
        <p className="muted small">Field highlights are shown for photos only.</p>
      </div>
    )
  }

  return (
    <div className={`receipt-frame${highlight ? ' spotlight' : ''}`}>
      <img src={url} alt={`Receipt${fileName ? ` ${fileName}` : ''}`} onError={() => setFailed(true)} />
      {highlight && highlight.page === 1 && (
        <div
          ref={boxRef}
          className="receipt-highlight"
          style={{
            left: `${highlight.left * 100}%`,
            top: `${highlight.top * 100}%`,
            width: `${highlight.width * 100}%`,
            height: `${highlight.height * 100}%`,
          }}
          aria-hidden="true"
        >
          {highlightLabel && <span className="receipt-highlight-label">{highlightLabel}</span>}
        </div>
      )}
    </div>
  )
}
