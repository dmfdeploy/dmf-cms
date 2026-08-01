import { Link } from 'react-router-dom'
import { STAGES, type StageId } from '../../lib/workloadLifecycle'

/**
 * The compact six-stage vocabulary strip.
 *
 * WHY THIS EXISTS AT ALL — it is the answer to a tension the operator named
 * rather than a decoration anyone wanted. Two things are both true:
 *
 *   1. The canonical EBU mapping doc's media-workload lifecycle has SIX
 *      stages, Operate included, and the console's stated pedagogy goal
 *      (umbrella #200) is that an outsider "understands the EBU model
 *      better afterwards". An EBU-literate viewer must be able to count six.
 *   2. The operator rejected the presentation that taught them — six stacked
 *      cards — and moved Operate off this page entirely.
 *
 * Dropping Operate from the page would have taught a five-stage lifecycle,
 * which is a wrong model, not a simplification. So the working flow below
 * covers the five ORCHESTRATION stages, and this strip carries the whole
 * vocabulary above it: six names, verbatim, current stage highlighted,
 * Operate present as a chip that LINKS OUT to its monitoring surface rather
 * than owning a card here. Model taught correctly; page uncluttered.
 *
 * This is the operator's own candidate synthesis from the 2026-08-01
 * direction, which they left open ("Operator to confirm or override"). It is
 * therefore the one thing on this page most likely to be overridden — the
 * strip is a single component with a single call site so removing it, or
 * swapping it for something else, stays cheap.
 *
 * It renders NO state of its own. The highlight comes from the same
 * classification driving the steps below, so the strip and the flow cannot
 * disagree about where the workload is.
 */
export default function LifecycleStrip({
  active,
  slug,
}: {
  /** The workload's stage, or null when the backend could not place it. */
  active: StageId | null
  slug: string
}) {
  return (
    <nav aria-label="Media workload lifecycle" className="mt-6">
      <ol className="flex flex-wrap items-center gap-x-1 gap-y-2">
        {STAGES.map((stage, i) => {
          const isActive = stage.id === active
          const chipClass = `badge text-xs ${
            isActive ? 'bg-accent/20 text-accent' : 'bg-white/5 text-muted'
          }`
          return (
            <li key={stage.id} className="flex items-center gap-1">
              {stage.id === 'operate' ? (
                // The one chip that navigates. Operate's content is
                // observational and lives on its own route; the chip is a
                // real link to a real page, so it is not a dead control.
                <Link
                  to={`/media-workloads/${encodeURIComponent(slug)}/operate`}
                  className={`${chipClass} underline decoration-dotted underline-offset-2 hover:text-accent`}
                  aria-current={isActive ? 'step' : undefined}
                  title="Operate is a lifecycle stage, and its surface is monitoring — open it"
                >
                  {stage.label}
                </Link>
              ) : (
                <span className={chipClass} aria-current={isActive ? 'step' : undefined}>
                  {stage.label}
                </span>
              )}
              {i < STAGES.length - 1 && (
                <span className="text-muted/40" aria-hidden="true">
                  ›
                </span>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
