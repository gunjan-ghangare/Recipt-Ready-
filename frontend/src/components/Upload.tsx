import { useRef, useState, type DragEvent } from 'react'
import { ApiError, type ExpenseApi } from '../lib/api'
import { ACCEPTED_TYPES, FileProblem, prepareReceiptFile } from '../lib/files'
import { links, navigate } from '../lib/router'
import { Notice, Spinner } from './ui'

type Phase = 'idle' | 'preparing' | 'uploading' | 'starting'

const PHASE_TEXT: Record<Exclude<Phase, 'idle'>, string> = {
  preparing: 'Preparing your file\u2026',
  uploading: 'Uploading securely\u2026',
  starting: 'Starting to read your receipt\u2026',
}

export function Upload({ api }: { api: ExpenseApi }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const cameraRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<{ message: string; expenseId?: string } | null>(null)
  const busy = phase !== 'idle'

  function onProgress(fraction: number) {
    setProgress(fraction)
    if (fraction >= 1) setPhase('starting')
  }

  function fail(err: unknown) {
    setPhase('idle')
    if (err instanceof FileProblem) setError({ message: err.message })
    else if (err instanceof ApiError) setError({ message: err.message, expenseId: err.expenseId })
    else setError({ message: 'Something went wrong. Try again.' })
  }

  async function handleFile(file: File | undefined) {
    if (!file || busy) return
    setError(null)
    setPhase('preparing')
    try {
      const prepared = await prepareReceiptFile(file)
      setProgress(0)
      setPhase('uploading')
      const expense = await api.upload(prepared, onProgress)
      navigate(links.expense(expense.id))
    } catch (err) {
      fail(err)
    }
  }

  async function handleSample(sampleId: string) {
    if (busy || !api.uploadSample) return
    setError(null)
    setProgress(0)
    setPhase('uploading')
    try {
      const expense = await api.uploadSample(sampleId, onProgress)
      navigate(links.expense(expense.id))
    } catch (err) {
      fail(err)
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDragging(false)
    void handleFile(event.dataTransfer.files[0])
  }

  return (
    <main className="page narrow" id="main" tabIndex={-1}>
      <a className="back-link" href={links.home}>
        &larr; All expenses
      </a>
      <h1>Upload a receipt</h1>
      <p className="lead">We&rsquo;ll read it and prepare a draft for you to review. You approve every expense yourself.</p>

      {api.mode === 'demo' && api.samples && (
        <section className="card samples-card" aria-labelledby="samples-heading">
          <h2 id="samples-heading">Try a sample receipt</h2>
          <p className="muted">Synthetic receipts with preset sample values, each showing a different review situation.</p>
          <div className="samples">
            {api.samples.map((sample) => (
              <button key={sample.id} type="button" className="sample" onClick={() => void handleSample(sample.id)} disabled={busy}>
                <img src={sample.imageUrl} alt="" />
                <span className="sample-title">{sample.title}</span>
                <span className="sample-desc">{sample.description}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <div
        className={`dropzone${dragging ? ' dragging' : ''}${busy ? ' busy' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          if (!busy) setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        {busy ? (
          <div className="upload-progress" aria-live="polite">
            <Spinner label={PHASE_TEXT[phase as Exclude<Phase, 'idle'>]} />
            {phase !== 'preparing' && (
              <progress max={1} value={phase === 'starting' ? 1 : progress} aria-label="Upload progress">
                {Math.round(progress * 100)}%
              </progress>
            )}
          </div>
        ) : (
          <>
            <p className="dropzone-title">{api.mode === 'demo' ? 'Or use your own file' : 'Drop your receipt here'}</p>
            <p className="muted">JPEG or PNG photos, or a single-page PDF, up to 10 MB.</p>
            <div className="button-row center">
              <button type="button" className="btn btn-primary" onClick={() => fileRef.current?.click()}>
                Choose a file
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => cameraRef.current?.click()}>
                Take a photo
              </button>
            </div>
            {api.mode === 'demo' && (
              <p className="fine-print">Demo mode doesn&rsquo;t read your file. You&rsquo;ll fill in the fields yourself to try the review flow.</p>
            )}
          </>
        )}
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPTED_TYPES}
          className="visually-hidden"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            void handleFile(e.target.files?.[0])
            e.target.value = ''
          }}
        />
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="visually-hidden"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            void handleFile(e.target.files?.[0])
            e.target.value = ''
          }}
        />
      </div>

      {error && (
        <Notice
          tone="error"
          title="That upload didn't work"
          action={
            error.expenseId ? (
              <a className="btn btn-secondary btn-sm" href={links.expense(error.expenseId)}>
                View upload
              </a>
            ) : undefined
          }
        >
          {error.message}
        </Notice>
      )}

      <section className="tips" aria-labelledby="tips-heading">
        <h2 id="tips-heading">For the best read</h2>
        <ul>
          <li>Lay the receipt flat in good light and fit the whole receipt in the frame.</li>
          <li>Hold steady so the text is sharp. Blurry or very small text is often missed.</li>
          <li>One receipt per photo. English, French, German, Italian, Portuguese, and Spanish are supported.</li>
        </ul>
      </section>
    </main>
  )
}
