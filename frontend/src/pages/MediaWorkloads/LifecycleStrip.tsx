import { Link } from 'react-router-dom'
import { FLOW_STEPS, type FlowStepId, type FlowStepState } from '../../lib/workloadFlow'
import { STAGE_FILL, CONTROL_FILL } from '../../lib/stagePalette'

/**
 * The wizard rail (umbrella #347 WO-D1, operator direction 2026-08-02:
 * "the EBU-colored rail as the prominent navigation spine"). Replaces the
 * S1/Arc-B vocabulary strip's role: instead of a read-only chip row plus a
 * separate numbered-step list below it, the five orchestration chips ARE the
 * wizard's step selector — clicking one selects it, exactly one is mounted
 * below (FlowStep.tsx).
 *
 * Per the operator's 2026-08-02 ruling on the EBU Facility Orchestration
 * Model graphic, Operate is still not a sixth step of the orchestration
 * flow — it sits in the Control vertical, set apart under its own group
 * label and rendered as a real route link, never a wizard step.
 *
 * COLOUR IS STAGE IDENTITY, NEVER STATE. Each of the five chips carries a
 * fixed EBU-mapping colour regardless of open/complete/locked/current — the
 * hard gate is "never colour alone" (Constitution Art. 11), not "no colour
 * ever": state is carried by the icon + text label + (for locked) a dashed
 * border, layered on top of the constant identity fill. The fill values
 * themselves (Arc 4 WP-2) live as tokens in index.css, turned into class
 * names by lib/stagePalette.ts — this file only consumes STAGE_FILL /
 * CONTROL_FILL, it does not own the hex values anymore.
 *
 * SELECTION AND POSITION ARE TWO DIFFERENT FACTS, deliberately never
 * conflated onto one signal. `aria-pressed` + a focus-style outline mark
 * which chip is SELECTED (mounted below); a separate "Current position" text
 * + icon mark which chip is the backend-derived POSITION — the wizard can
 * have the operator reviewing Design while the workload's position is
 * Configure, and the rail has to say both without one overloading the
 * other.
 */

const STEP_LABEL: Record<FlowStepId, string> = {
  design: 'Design',
  plan: 'Plan',
  provision: 'Provision',
  configure: 'Configure',
  finalise: 'Finalise & Review',
}

const STATE_TEXT: Record<FlowStepState, string> = {
  current: 'Now',
  open: 'Ready',
  complete: 'Done',
  record: 'Record',
  locked: 'Locked',
}

function StateGlyph({ state }: { state: FlowStepState }) {
  switch (state) {
    case 'complete':
      return (
        <path
          d="M20 6 9 17l-5-5"
          stroke="currentColor"
          strokeWidth="2.5"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )
    case 'locked':
      return (
        <path
          d="M6 10V7a6 6 0 1112 0v3M5 10h14v10H5V10z"
          stroke="currentColor"
          strokeWidth="2"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )
    case 'record':
      return (
        <path
          d="M4 6h16M4 12h16M4 18h10"
          stroke="currentColor"
          strokeWidth="2"
          fill="none"
          strokeLinecap="round"
        />
      )
    case 'current':
      return (
        <path
          d="M12 2l2.4 7.2H22l-6 4.6 2.4 7.2L12 16.4l-6.4 4.6L8 13.8l-6-4.6h7.6z"
          fill="currentColor"
        />
      )
    case 'open':
    default:
      return <circle cx="12" cy="12" r="6" fill="currentColor" />
  }
}

/** The same "current position" glyph used inline, for the caption beneath. */
function PositionGlyph() {
  return (
    <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 2l2.4 7.2H22l-6 4.6 2.4 7.2L12 16.4l-6.4 4.6L8 13.8l-6-4.6h7.6z"
        fill="currentColor"
      />
    </svg>
  )
}

export default function LifecycleStrip({
  steps,
  activeStep,
  current,
  offFlow,
  lockedReasons,
  jobOwnerLabel,
  jobInFlight,
  onSelect,
  slug,
}: {
  steps: Record<FlowStepId, FlowStepState>
  /** The wizard's mounted step — drives the selection outline + aria-pressed. */
  activeStep: FlowStepId
  /** The workload's backend-derived position, or null. */
  current: FlowStepId | null
  /** The workload's position is Operate — the Control chip carries it instead. */
  offFlow: boolean
  lockedReasons: Record<FlowStepId, string>
  /** Verbatim stage label of the step that owns the in-flight job, if any. */
  jobOwnerLabel: string | null
  jobInFlight: boolean
  onSelect: (step: FlowStepId) => void
  slug: string
}) {
  const jobReason = jobOwnerLabel
    ? `A ${jobOwnerLabel} job is in progress — wait for its outcome.`
    : ''

  return (
    <nav aria-label="Media workload lifecycle" className="mt-6 flex flex-wrap items-start gap-x-3 gap-y-3">
      <ol className="flex flex-wrap items-start gap-x-3 gap-y-3">
        {FLOW_STEPS.map((id) => {
          const state = steps[id]
          const locked = state === 'locked'
          const isPosition = id === current
          const isSelected = id === activeStep
          const interactive = !jobInFlight && !locked

          const chipClass = [
            'flex items-center gap-2 rounded-lg border px-3 py-2 transition-shadow',
            STAGE_FILL[id],
            locked ? 'border-dashed border-white/40 opacity-60' : 'border-transparent',
            isSelected ? 'ring-2 ring-white ring-offset-2 ring-offset-bg' : '',
          ].join(' ')

          const inner = (
            <>
              <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <StateGlyph state={state} />
              </svg>
              <span className="flex flex-col items-start leading-tight">
                <span className="text-xs font-semibold">{STEP_LABEL[id]}</span>
                <span className="text-2xs uppercase tracking-wide opacity-80">
                  {jobInFlight ? 'Waiting' : STATE_TEXT[state]}
                </span>
              </span>
            </>
          )

          return (
            <li key={id} className="flex flex-col items-center gap-1">
              {interactive ? (
                <button
                  type="button"
                  className={chipClass}
                  // Explicit accessible name — the visible chip also carries
                  // a state word (Ready/Done/…) that shouldn't be part of
                  // what a step selector is called.
                  aria-label={STEP_LABEL[id]}
                  aria-pressed={isSelected}
                  aria-current={isPosition ? 'step' : undefined}
                  onClick={() => onSelect(id)}
                >
                  {inner}
                </button>
              ) : (
                <div
                  className={chipClass}
                  aria-label={STEP_LABEL[id]}
                  aria-current={isPosition ? 'step' : undefined}
                >
                  {inner}
                </div>
              )}
              {isPosition && (
                <span className="flex items-center gap-1 text-2xs text-muted">
                  <PositionGlyph />
                  Current position
                </span>
              )}
              {/* GATE-D1 acceptance note 8: rendered unconditionally, not just
                  inside the interactive branch — aria-pressed lives only on
                  the <button> variant (a plain <div> has no toggle
                  semantics to hang it on), so without this TEXT marker the
                  selected step's own indication would silently vanish the
                  moment a job in flight demotes every chip to inert
                  <div>s. Current-position's marker already had this
                  property; selection needed the same one. */}
              {isSelected && (
                <span className="text-2xs text-muted">Selected</span>
              )}
              {locked && (
                <span className="max-w-[9rem] text-center text-2xs text-muted">
                  {lockedReasons[id]}
                </span>
              )}
              {jobInFlight && !locked && (
                <span className="max-w-[9rem] text-center text-2xs text-muted">{jobReason}</span>
              )}
            </li>
          )
        })}
      </ol>

      {/* GATE-D1 P1.2: Control/Operate is NOT a sixth <li> in the
          orchestration <ol> above — an ordinal list item there would make it
          read as a sixth step of the SAME sequence, exactly the claim spec B
          and the operator's 2026-08-02 ruling rule out. It is a sibling
          labelled group instead, visually adjacent (the divider is now on
          this group, not inside the list) but structurally outside the
          ordered list entirely. */}
      <div
        role="group"
        aria-label="Control"
        className="flex flex-col items-center gap-1 border-l border-white/10 pl-3"
      >
        <span className="text-2xs uppercase tracking-wide text-muted">Control</span>
        {!jobInFlight ? (
          <Link
            to={`/media-workloads/${encodeURIComponent(slug)}/operate`}
            className={`rounded-lg px-3 py-2 text-xs font-semibold ${CONTROL_FILL} ${
              offFlow ? 'ring-2 ring-white ring-offset-2 ring-offset-bg' : ''
            }`}
            aria-current={offFlow ? 'step' : undefined}
            title="Operate sits in the Control vertical — open its surface"
          >
            Operate
          </Link>
        ) : (
          <div
            className={`rounded-lg px-3 py-2 text-xs font-semibold ${CONTROL_FILL}`}
            title="Operate sits in the Control vertical — open its surface"
          >
            Operate
          </div>
        )}
        {offFlow && (
          <span className="flex items-center gap-1 text-2xs text-muted">
            <PositionGlyph />
            Current position
          </span>
        )}
        {jobInFlight && (
          <span className="max-w-[9rem] text-center text-2xs text-muted">{jobReason}</span>
        )}
      </div>
    </nav>
  )
}
