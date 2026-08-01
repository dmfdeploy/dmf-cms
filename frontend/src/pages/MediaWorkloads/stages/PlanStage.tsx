import { Link } from 'react-router-dom'
import { useCatalog, useFacilityDetail, useFacilitySummary } from '../../../api/hooks'
import type { CatalogEntry, FacilityDetailResponse, MediaWorkload } from '../../../api/types'
import type { StageState } from '../../../lib/workloadLifecycle'
import StageCard from './StageCard'

/**
 * Plan — two facts, not a decision:
 *
 * 1. The assigned facility: name plus a link to its detail page. The
 *    platform runs a single facility today (federation is an explicit v0.1
 *    non-goal — architectural-commitments-v1.md), so "the assigned
 *    facility" is read from the one site the facility summary reports.
 *    Zero or more-than-one sites are both honest non-answers here, not
 *    guesses — the assignment is real but trivial (one forced choice), and
 *    a picker over a single option would dress that up as a decision the
 *    operator never actually made.
 *
 * 2. umbrella #285 S3 — the capacity comparison, added beneath the
 *    assignment: this workload's summed declared demand (each function's
 *    provision.resources.requests, joined function_key -> CatalogEntry.key
 *    the same way DesignStage.tsx joins them, times how many instances of
 *    it this workload runs) laid beside the facility's allocatable
 *    capacity, with requests-committed shown as scheduler context — never
 *    "used"/"free", because committed is a scheduler bound, not a
 *    utilisation measurement.
 *
 *    WHY COMMITTED IS NOT THIS-WORKLOAD-EXCLUDED (GATE-B). It would be
 *    natural to read committed as "what everything ELSE has taken", and the
 *    label used to say exactly that. It was false in the one direction that
 *    matters: once this workload is deployed, its own requests are inside
 *    that number, so committed + requests double-counts it. Excluding them
 *    would need per-pod attribution, and the console has none — capacity.py
 *    reads NODE-level kube-state-metrics aggregates through Prometheus, with
 *    no pod-to-workload join anywhere in the payload. Rather than invent one
 *    or quietly keep a wrong label, the copy states what the number actually
 *    is. The two figures are for reading side by side, not for arithmetic.
 *
 *    This is deliberately NOT a fit/no-fit verdict (Constitution Art. 1).
 *    capacity.py's own preflight gate (test_capacity_gate.py) already
 *    renders that verdict at the one moment it actually matters — the
 *    deploy click on Provision. This stage sits earlier, before anything
 *    is armed, purely to let the operator read the same two numbers that
 *    gate will weigh later. Headroom is free to move between this read and
 *    that click, so freezing a verdict here would be a promise the console
 *    cannot keep — the operator reads the numbers, the scheduler decides
 *    at admission time.
 *
 * The comparison only renders once the facility assignment above resolved
 * to exactly one addressable (slugged) site — with zero, several, or an
 * un-slugged site there is nothing concrete yet to fetch a capacity read
 * for, and that gap is already named by the Facility body above.
 */
export default function PlanStage({
  workload,
  state,
}: {
  workload: MediaWorkload
  state: StageState
}) {
  const { data, isLoading, isError } = useFacilitySummary()
  const sites = data?.sites ?? []
  const catalog = useCatalog()
  const catalogEntries = catalog.data?.entries ?? []
  // Called unconditionally (React's hook-order rule) with '' when there is
  // no single addressable site — useFacilityDetail no-ops on an empty site
  // (see hooks.ts's `enabled: site.length > 0`), and the section below
  // simply isn't rendered in that case, so the perpetual "disabled query"
  // loading state it'd otherwise report is never shown to anyone.
  const singleSite = sites.length === 1 ? sites[0] : null
  const facilityDetail = useFacilityDetail(singleSite?.slug ?? '')

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
      <div className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-xs uppercase tracking-wide text-muted">Facility</h3>
          {body}
        </div>
        {singleSite && (
          <div className="space-y-2 border-t border-white/5 pt-3">
            <h3 className="text-xs uppercase tracking-wide text-muted">Capacity</h3>
            {singleSite.slug ? (
              <CapacityComparison
                demand={summarizeDemand(workload, catalogEntries, catalog.isLoading)}
                capacity={summarizeCapacity(facilityDetail)}
              />
            ) : (
              // The un-slugged-site gap, one level further: without a slug
              // there is no URL the facility-detail endpoint can be asked
              // through either, so the capacity read is unreachable for the
              // same underlying reason the link above is absent.
              <p className="text-muted">
                NetBox has this site but no slug for it yet, so the console can&apos;t address it
                for a capacity read.
              </p>
            )}
          </div>
        )}
      </div>
    </StageCard>
  )
}

// ---------------------------------------------------------------------------
// The demand side: this workload's summed declared requests, and how
// honestly incomplete that sum is (§3.2(a)'s console-side mirror — the
// backend's read_entry_demand refuses to guess, and this must not either).
// ---------------------------------------------------------------------------

type DemandSummary =
  | { kind: 'loading' }
  | { kind: 'no-functions' }
  | { kind: 'none-declared'; total: number }
  | { kind: 'partial'; cpuM: number; memB: number; missing: number; total: number }
  | { kind: 'complete'; cpuM: number; memB: number }

/**
 * Sum provision_demand across the workload's functions, exactly the way
 * DesignStage.tsx joins function_key -> CatalogEntry.key, scaled by each
 * function's instance count (fn.count — how many instances of that
 * function this workload actually runs, per media_workloads.py's own
 * aggregation) since a template's demand is declared PER INSTANCE, not per
 * workload. A function whose catalog entry is missing entirely counts the
 * same as one whose entry declares no demand: either way the console has
 * no honest number for it, and the two are indistinguishable from here on
 * purpose. Never silently drops the missing ones from the total while
 * presenting the partial sum as complete — a workload with 2 of 3
 * templates undeclared says so, in those terms.
 */
function summarizeDemand(
  workload: MediaWorkload,
  catalogEntries: CatalogEntry[],
  catalogLoading: boolean,
): DemandSummary {
  if (catalogLoading) return { kind: 'loading' }
  const total = workload.functions.length
  if (total === 0) return { kind: 'no-functions' }

  let cpuM = 0
  let memB = 0
  let missing = 0
  for (const fn of workload.functions) {
    const demand = catalogEntries.find((e) => e.key === fn.function_key)?.provision_demand
    if (demand) {
      cpuM += demand.cpu_m * fn.count
      memB += demand.mem_b * fn.count
    } else {
      missing += 1
    }
  }

  if (missing === total) return { kind: 'none-declared', total }
  if (missing > 0) return { kind: 'partial', cpuM, memB, missing, total }
  return { kind: 'complete', cpuM, memB }
}

// ---------------------------------------------------------------------------
// The supply side: the facility's capacity read, or an honest reason it
// couldn't be read (Art. 8 — never the raw fail-soft token).
// ---------------------------------------------------------------------------

type CapacitySummary =
  | { kind: 'loading' }
  | { kind: 'unreadable'; message: string }
  | { kind: 'ok'; cpuAllocM: number; memAllocB: number; cpuCommittedM: number | null; memCommittedB: number | null }

/**
 * capacity.reason token -> operator-language copy. Deliberately a small,
 * local mapping rather than importing Facility/Detail.tsx's own
 * `facilityReasonCopy` — that page renders a full section banner for a
 * different context (Detail's own capacity table), and this stage owns its
 * three-line comparison independently rather than reaching across a page
 * boundary neither this leg nor that one is scoped to touch.
 */
function capacityReasonMessage(reason: string): string {
  switch (reason) {
    case 'prometheus-not-configured':
      return 'monitoring is not configured in this environment'
    case 'budget-unavailable':
      return 'monitoring could not be read just now'
    case 'multi-node-unsupported':
      return 'this facility reports more than one node, and the console only summarises a single-node facility today'
    default:
      // Art. 8: an unrecognised token is our gap, not the operator's
      // vocabulary — translate it rather than print it, without claiming
      // to know a cause we don't.
      return 'the reading did not succeed'
  }
}

function summarizeCapacity(facilityDetail: {
  isLoading: boolean
  data?: FacilityDetailResponse
}): CapacitySummary {
  if (facilityDetail.isLoading && !facilityDetail.data) return { kind: 'loading' }
  if (!facilityDetail.data) return { kind: 'unreadable', message: 'the reading did not succeed' }
  const cap = facilityDetail.data.capacity
  // reason !== '' is facility.py's own fail-soft signal; the two null
  // allocatable checks are a defensive second line (FacilityCapacity's
  // fields are typed nullable) so a malformed reason:'' payload degrades to
  // the same honest refusal instead of a NaN/undefined leaking into the
  // numbers below.
  if (cap.reason !== '' || cap.allocatable_cpu_m == null || cap.allocatable_mem_b == null) {
    return { kind: 'unreadable', message: capacityReasonMessage(cap.reason) }
  }
  return {
    kind: 'ok',
    cpuAllocM: cap.allocatable_cpu_m,
    memAllocB: cap.allocatable_mem_b,
    cpuCommittedM: cap.requests_committed_cpu_m,
    memCommittedB: cap.requests_committed_mem_b,
  }
}

function formatCpuM(m: number): string {
  return `${m}m`
}

function formatMemB(bytes: number): string {
  const gi = bytes / 1024 ** 3
  if (gi >= 1) return `${gi.toFixed(gi >= 10 ? 0 : 1)} GiB`
  const mi = bytes / 1024 ** 2
  return `${mi.toFixed(mi >= 10 ? 0 : 1)} MiB`
}

function RequestsCell({ demand }: { demand: DemandSummary }) {
  switch (demand.kind) {
    case 'loading':
      return <p className="text-muted">Loading this workload&apos;s declared demand…</p>
    case 'no-functions':
      return (
        <p className="text-muted">This workload has no functions recorded yet, so there is nothing to sum.</p>
      )
    case 'none-declared':
      return (
        <p className="text-muted">
          None of this workload&apos;s {demand.total} template{demand.total !== 1 ? 's' : ''} declare a
          resource demand to the console, so the comparison here is incomplete.
        </p>
      )
    case 'partial':
      return (
        <>
          <p className="font-mono text-sm text-text">
            {formatCpuM(demand.cpuM)} CPU · {formatMemB(demand.memB)} memory
          </p>
          <p className="mt-1 text-xs text-amber-200/80">
            Partial — {demand.missing} of {demand.total} templates don&apos;t declare a demand to the
            console, so this sum omits them rather than guessing.
          </p>
        </>
      )
    case 'complete':
      return (
        <p className="font-mono text-sm text-text">
          {formatCpuM(demand.cpuM)} CPU · {formatMemB(demand.memB)} memory
        </p>
      )
  }
}

/**
 * The two numbers, side by side, plus committed as context underneath —
 * never a verdict. See the file-level docstring for why a verdict does not
 * belong on this stage.
 */
function CapacityComparison({ demand, capacity }: { demand: DemandSummary; capacity: CapacitySummary }) {
  if (capacity.kind === 'loading') {
    return <p className="text-muted">Loading facility capacity…</p>
  }
  if (capacity.kind === 'unreadable') {
    return (
      <p className="text-amber-200/80">
        This facility&apos;s capacity could not be read ({capacity.message}), so no comparison can be
        shown here.
      </p>
    )
  }

  return (
    <div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-muted">Requests (this workload)</p>
          <RequestsCell demand={demand} />
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-muted">Allocatable (facility)</p>
          <p className="font-mono text-sm text-text">
            {formatCpuM(capacity.cpuAllocM)} CPU · {formatMemB(capacity.memAllocB)} memory
          </p>
        </div>
      </div>
      <p className="mt-2 text-xs text-muted">
        Committed (every request the scheduler has already promised on this facility,
        including this workload&apos;s own once it is deployed — a scheduler bound, not a
        measurement of usage):{' '}
        {capacity.cpuCommittedM != null ? formatCpuM(capacity.cpuCommittedM) : '—'} CPU ·{' '}
        {capacity.memCommittedB != null ? formatMemB(capacity.memCommittedB) : '—'} memory
      </p>
    </div>
  )
}
