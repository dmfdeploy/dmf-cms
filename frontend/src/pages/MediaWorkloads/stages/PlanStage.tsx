import { Link } from 'react-router-dom'
import { useFacilitySummary } from '../../../api/hooks'
import type { MediaWorkload } from '../../../api/types'
import type { StageState } from '../../../lib/workloadLifecycle'
import StageCard from './StageCard'

/**
 * Plan — the assigned facility: name plus a link to its detail page.
 * Deliberately NOT a capacity comparison (template resource requests vs
 * facility free) — that is S3 (umbrella #285 operative spec), an explicit
 * later slice. v1 is the record of WHERE, not whether it fits.
 *
 * The platform runs a single facility today (federation is an explicit
 * v0.1 non-goal — architectural-commitments-v1.md), so "the assigned
 * facility" is read from the one site the facility summary reports. Zero
 * or more-than-one sites are both honest non-answers here, not guesses.
 */
export default function PlanStage({
  state,
}: {
  // Accepted for parity with every other stage component (and because S3's
  // capacity comparison will need it) even though v1's read doesn't yet key
  // off the workload itself — see the file docstring.
  workload: MediaWorkload
  state: StageState
}) {
  const { data, isLoading, isError } = useFacilitySummary()
  const sites = data?.sites ?? []

  let body: React.ReactNode
  if (isLoading) {
    body = <p className="text-muted">Loading facility assignment…</p>
  } else if (isError) {
    body = <p className="text-amber-200/80">Facility inventory is unreachable right now.</p>
  } else if (sites.length === 0) {
    body = (
      <p className="text-muted">
        No facility is registered in NetBox yet, so an assignment can&apos;t be shown.
      </p>
    )
  } else if (sites.length > 1) {
    // Honest non-answer (Art. 1): a rail that guesses which of several
    // sites a workload belongs to is worse than one that says it doesn't
    // track that yet.
    body = (
      <p className="text-muted">
        {sites.length} facilities are registered; workload-to-facility assignment isn&apos;t
        tracked yet.
      </p>
    )
  } else {
    const site = sites[0]
    body = (
      <div>
        {site.slug ? (
          <Link
            to={`/facilities/${encodeURIComponent(site.slug)}`}
            className="font-medium text-accent hover:underline"
          >
            {site.name}
          </Link>
        ) : (
          // Same honest gap Facility/index.tsx already names: NetBox has the
          // site but no slug for it, so there is nothing to link to yet.
          <span className="font-medium text-text">{site.name}</span>
        )}
        <p className="mt-1 text-xs text-muted">
          {site.device_count} device{site.device_count !== 1 ? 's' : ''}
        </p>
      </div>
    )
  }

  return (
    <StageCard label="Plan" state={state}>
      <div className="space-y-1">
        <h3 className="text-xs uppercase tracking-wide text-muted">Facility</h3>
        {body}
      </div>
    </StageCard>
  )
}
