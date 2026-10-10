import type { DataSource, ProcessingStage } from '../types'

const STEPS = [
  { label: 'Receipt uploaded', aws: null, demo: null },
  { label: 'Reading the receipt', aws: 'Amazon Textract', demo: 'simulated' },
  { label: 'Suggesting a category', aws: 'Amazon Bedrock', demo: 'simulated' },
  { label: 'Ready for your review', aws: null, demo: null },
]

export function ProcessingSteps({ stage, source }: { stage: ProcessingStage | null; source: DataSource }) {
  const current = stage === 'CATEGORIZING' ? 2 : 1
  return (
    <div className="processing">
      <ol className="progress-steps">
        {STEPS.map((step, index) => {
          const state = index < current ? 'done' : index === current ? 'active' : 'pending'
          const by = source === 'DEMO' ? step.demo : step.aws
          return (
            <li key={step.label} className={`progress-step ${state}`} aria-current={state === 'active' ? 'step' : undefined}>
              <span className="progress-dot" aria-hidden="true">
                {state === 'done' ? '\u2713' : index + 1}
              </span>
              <span>
                {step.label}
                {by && <span className="progress-by"> &middot; {by}</span>}
              </span>
            </li>
          )
        })}
      </ol>
      <p className="visually-hidden" aria-live="polite">
        {STEPS[current].label}
      </p>
    </div>
  )
}
