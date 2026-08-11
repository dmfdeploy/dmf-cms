import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { isOperation, useCatalog, useDeployCatalog, useFacilitySummary } from '../../api/hooks'
import type { CatalogEntry, FacilitySummary } from '../../api/types'
import { classifyDraftFlow, FLOW_STEPS, type DraftProgress, type FlowStepId } from '../../lib/workloadFlow'
import { isValidWorkloadSlug } from '../../lib/workloadSlug'
import { APIError } from '../../api/client'
import ReasonConfirm from '../../components/ReasonConfirm'
import DraftFlowStep from './DraftFlowStep'

/**
 * Create Media Workload — the draft leg of the guided sequential flow
 * (umbrella #285 addendum, operator direction 2026-08-01).
 *
 * WHY THIS PAGE HOLDS ITS OWN STATE INSTEAD OF READING A RECORD. A
 * workload's identity is not something the console can create: it is the
 * `workload:<slug>` NetBox tag the AWX launcher stamps when a deploy runs,
 * carried there by the deploy seam this page already reuses
 * (POST /api/catalog/{key}/deploy, extra_vars.workload_slug). There is no
 * create endpoint and this page adds none. So the studio name, the chosen
 * template and the resolved facility live in plain React state until
 * Provision fires — at which point the deploy is ACCEPTED, and the page
 * hands off to the real (backend-driven) detail route CARRYING THAT LAUNCH.
 *
 * Acceptance is not existence, and the difference is a page state rather
 * than a nuance: the workload begins to exist only when the launcher stamps
 * the tag and the inventory reports it, some seconds later. The destination
 * renders a designed materializing view for that window (see
 * WorkloadMaterializing.tsx) instead of denying the workload exists.
 *
 * The cost of that is real and stated where the operator can see it, next
 * to the field that starts the draft: refresh this tab before Provision and
 * the draft is gone. That is a designed limit, not a bug to route around —
 * localStorage/sessionStorage persistence would be new state tracking this
 * arc doesn't call for, and would trade an honest "you'll lose this" for a
 * silent maybe-still-there that is worse when it's wrong.
 *
 * THE GATE ITSELF IS NOT THIS FILE'S TO OWN. lib/workloadFlow.ts's
 * classifyDraftFlow() is the only place "what unlocks next" is decided; this
 * component only turns the operator's inputs into the three booleans that
 * function reads (hasName, hasTemplate, hasFacility) and renders whatever it
 * returns. Configure and Finalise & Review are never reachable from here —
 * classifyDraftFlow locks them for the whole draft, because nothing has run
 * yet to configure or tear down.
 */

const FLOW_STEP_LABELS: Record<FlowStepId, string> = {
  design: 'Design',
  plan: 'Plan',
  provision: 'Provision',
  configure: 'Configure',
  finalise: 'Finalise & Review',
}

/**
 * What the console can honestly say after a deploy that did not return
 * cleanly (GATE-B P1).
 *
 * `refused` — the server answered and rejected the request, so nothing was
 *   launched. Safe to say so.
 * `unknown` — the request threw before an answer came back (connection lost,
 *   unparseable reply). The POST may well have reached AWX. The console does
 *   NOT know, and must not resolve that ambiguity in either direction: the
 *   operator needs to go and look, not be told to try again.
 */
type DeployOutcome = { kind: 'refused'; status: number } | { kind: 'unknown' }

/**
 * Designed refusal copy keyed on HTTP status, per Art. 8 — what happened,
 * what it means, what to do next. Deliberately NOT the backend's own error
 * string: APIError.message carries a raw token ("reason-required",
 * "conflicting lifecycle operation in progress") that is our implementation
 * leaking, and Art. 3 keeps that behind expert level.
 */
const REFUSAL_COPY: Record<number, string> = {
  400: 'The request was rejected as malformed — check the workload identity and reason.',
  403: 'Your role is not permitted to deploy on this facility.',
  404: 'That template is no longer in the catalog.',
  409: 'A deploy or teardown is already in flight for this template. Wait for it to finish.',
  503: 'The automation platform is not available right now.',
}

// Only Plan and Provision ever render a locked step in the draft (Design
// starts current and only ever completes); Configure/Finalise are locked
// for the draft's entire life. Design needs no entry here — FlowStep's own
// fallback text is never reached for it.
const LOCKED_REASON: Partial<Record<FlowStepId, string>> = {
  plan: 'This step opens once Design is complete: a studio name that resolves to a valid workload identity, and a chosen template.',
  provision: 'This step opens once Plan is complete: this platform must resolve to exactly one facility first.',
  configure: 'Locked for the whole draft — nothing has been provisioned yet, so there is nothing to configure.',
  finalise: 'Locked for the whole draft — nothing has been provisioned yet, so there is nothing to finalise or tear down.',
}

/**
 * Turn a human studio name into the slug the backend will actually record.
 * Mirrors, rather than replaces, WORKLOAD_SLUG_RE (workloadSlug.ts): this
 * only proposes a candidate for the operator to accept or edit — the single
 * validity check that decides whether it is USABLE stays isValidWorkloadSlug,
 * called at the one call site below.
 */
function deriveSlug(name: string): string {
  let candidate = name.toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '')
  candidate = candidate.replace(/^-+/, '').replace(/-+$/, '')
  if (candidate.length > 40) candidate = candidate.slice(0, 40).replace(/-+$/, '')
  return candidate
}

export default function CreateWorkload() {
  const navigate = useNavigate()

  const [studioName, setStudioName] = useState('')
  const [slug, setSlug] = useState('')
  // Latches true the first time the operator edits the slug field directly,
  // so their edit is never clobbered by a later keystroke in the name field.
  const [slugTouched, setSlugTouched] = useState(false)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  // WP-3 spec D: the placement CONFIRMATION gate — the operator's explicit
  // acknowledgement of the resolved facility, distinct from the facility
  // simply having resolved. See DraftProgress.facilityConfirmed and
  // PlanAssignment for the full rationale.
  const [facilityConfirmed, setFacilityConfirmed] = useState(false)
  const [arming, setArming] = useState(false)
  // A failed deploy has TWO distinguishable outcomes and the console must
  // not flatten them (GATE-B P1). See handleProvisionConfirm for why.
  const [deployOutcome, setDeployOutcome] = useState<DeployOutcome | null>(null)

  const {
    data: catalogData,
    isLoading: catalogLoading,
    isError: catalogFailed,
    isFetching: catalogFetching,
  } = useCatalog()
  const { data: facilityData, isLoading: facilityLoading, isError: facilityFailed } = useFacilitySummary()
  const deployMutation = useDeployCatalog()

  const entries = catalogData?.entries ?? []
  const selectedEntry = entries.find((e) => e.key === selectedKey) ?? null
  const sites = facilityData?.sites ?? []

  const trimmedSlug = slug.trim()
  const slugValid = trimmedSlug !== '' && isValidWorkloadSlug(trimmedSlug)

  const draft: DraftProgress = {
    hasName: slugValid,
    hasTemplate: selectedEntry !== null,
    // Loading/error both read as "not resolved" — only a clean read of
    // exactly one site counts, the same honest-non-answer rule PlanStage
    // already applies to the real workload's Plan stage.
    hasFacility: !facilityLoading && !facilityFailed && sites.length === 1,
    // WP-3 spec D: the resolved-vs-acknowledged split lives here, one level
    // up from the raw read — classifyDraftFlow decides what it means for
    // the flow, this component only reports the operator's own action.
    facilityConfirmed,
  }
  const flow = classifyDraftFlow(draft)

  function handleNameChange(value: string) {
    setStudioName(value)
    if (!slugTouched) setSlug(deriveSlug(value))
  }

  function handleSlugChange(value: string) {
    setSlugTouched(true)
    setSlug(value)
  }

  async function handleProvisionConfirm(reason: string) {
    if (!selectedEntry) return
    try {
      const result = await deployMutation.mutateAsync({
        key: selectedEntry.key,
        reason,
        workload: trimmedSlug,
      })
      // A DEPLOY IS ACCEPTED, NOT COMPLETED (GATE-B P1). The workload's
      // identity does not exist yet: it comes into being when the launcher
      // stamps the workload:<slug> tag and the inventory picks it up. So the
      // navigation carries the launch — whichever of the two shapes the seam
      // returned — and the destination renders the materializing story until
      // the record appears. Navigating bare would land the operator on
      // "Workload not found" for the workload they just created.
      navigate(`/media-workloads/${encodeURIComponent(trimmedSlug)}`, {
        state: {
          launch: isOperation(result)
            ? { entryKey: selectedEntry.key, operationId: result.operation_id }
            : { entryKey: selectedEntry.key, jobId: result.job_id },
        },
      })
    } catch (e) {
      // Art. 8: the operator gets what happened and what it means, never the
      // raw exception. Closing the arm panel here (rather than leaving it
      // open on a stale mutation) and rendering the failure as a standing
      // fact of the step is what keeps this loop closed (Art. 2) instead of
      // a toast that could vanish before it is read.
      //
      // THE DISTINCTION THAT MATTERS (GATE-B P1). An APIError means the
      // server answered and refused — nothing was launched, and saying so is
      // safe. ANY OTHER throw means the request may have reached AWX and we
      // simply never learned the outcome: a dropped connection after the
      // POST left, a reply we could not parse. Reporting that as "nothing
      // was created" would be a claim the console cannot support, and the
      // expensive direction to be wrong in — an operator told nothing
      // happened will deploy again, on top of a workload that may already be
      // coming up.
      console.error('Provision failed:', e)
      setArming(false)
      setDeployOutcome(
        e instanceof APIError ? { kind: 'refused', status: e.status } : { kind: 'unknown' },
      )
    }
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="panel mt-6 p-4">
        <label htmlFor="studio-name" className="block text-xs uppercase tracking-wide text-muted">
          Studio name
        </label>
        <input
          id="studio-name"
          type="text"
          className="mt-1 w-full rounded border border-white/10 bg-black/20 p-2 text-sm text-text"
          placeholder="e.g. Studio A"
          value={studioName}
          onChange={(e) => handleNameChange(e.target.value)}
        />

        <label htmlFor="workload-slug" className="mt-3 block text-xs uppercase tracking-wide text-muted">
          Workload identity
        </label>
        {/* This is the literal value that gets recorded (the workload:<slug>
            NetBox tag) — shown and editable, never a hidden derivation of the
            name above, which is the Art. 1 failure mode a "friendly name that
            secretly becomes something else" would be. */}
        <div className="mt-1 flex items-center gap-1">
          <span className="font-mono text-sm text-muted">workload:</span>
          <input
            id="workload-slug"
            type="text"
            className="w-full rounded border border-white/10 bg-black/20 p-2 font-mono text-sm text-text"
            value={slug}
            onChange={(e) => handleSlugChange(e.target.value)}
          />
        </div>
        {trimmedSlug !== '' && !slugValid && (
          <p className="mt-1 text-xs text-red-300">
            Only lowercase letters, digits and hyphens are allowed, and it can&apos;t start or end
            with a hyphen — up to 40 characters.
          </p>
        )}

        <p className="mt-3 text-xs text-amber-200/80">
          This draft lives only in this browser tab until Provision runs — refreshing or closing
          the tab before then loses it, and nothing about it is recorded anywhere until then.
        </p>
      </div>

      <div className="mt-4 space-y-4">
        {FLOW_STEPS.map((id, index) => (
          <DraftFlowStep
            key={id}
            number={index + 1}
            label={FLOW_STEP_LABELS[id]}
            state={flow.steps[id]}
            // The draft's position step is pinned open. classifyDraftFlow
            // never reports a draft step as `open` (a draft bears no backend
            // affordance), so here `current` and the position always
            // coincide — the prop is still passed explicitly rather than
            // left to DraftFlowStep to infer, matching the same disclosure
            // rule the deployed workload's own flow used before it became a
            // wizard (umbrella #347 WO-D1).
            pinned={id === flow.current}
            lockedReason={LOCKED_REASON[id]}
            summary={
              id === 'design' && selectedEntry
                ? selectedEntry.display_name
                : id === 'plan' && draft.hasFacility
                  ? sites[0]?.name
                  : undefined
            }
          >
            {id === 'design' && (
              <TemplatePicker
                entries={entries}
                loading={catalogLoading}
                failed={catalogFailed}
                selectedKey={selectedKey}
                onSelect={setSelectedKey}
              />
            )}
            {id === 'plan' && (
              <PlanAssignment
                loading={facilityLoading}
                failed={facilityFailed}
                sites={sites}
                confirmed={facilityConfirmed}
                onConfirm={() => setFacilityConfirmed(true)}
              />
            )}
            {id === 'provision' && (
              <ProvisionSection
                entry={selectedEntry}
                // The read's outcome, not just its payload — see
                // ProvisionSection's `blocked`. react-query keeps the last
                // good entries alongside isError, so without this the step
                // would go on acting from a catalog it knows it cannot read.
                catalogFailed={catalogFailed}
                catalogFetching={catalogFetching}
                slug={trimmedSlug}
                arming={arming}
                pending={deployMutation.isPending}
                outcome={deployOutcome}
                onArm={() => {
                  setDeployOutcome(null)
                  setArming(true)
                }}
                onCancel={() => setArming(false)}
                onConfirm={handleProvisionConfirm}
              />
            )}
            {/* Configure and Finalise & Review never open in a draft — see
                LOCKED_REASON above — so there is deliberately no content
                branch for them here. DraftFlowStep does not render children
                for a locked step at all, so anything written here would be
                dead code standing in for the (already honest) lockedReason. */}
          </DraftFlowStep>
        ))}
      </div>
    </div>
  )
}

/**
 * Design — a template picker over the live catalog, presented the way
 * DesignStage.tsx presents a deployed workload's templates (display name,
 * summary, EBU system details behind a disclosure) so the draft and the
 * real workload teach the same vocabulary. What DesignStage adds beyond
 * this — the per-instance composition line — describes running instances,
 * which a draft does not have yet; there is nothing dishonest to show in
 * its place, so this simply doesn't render that section.
 */
function TemplatePicker({
  entries,
  loading,
  failed,
  selectedKey,
  onSelect,
}: {
  entries: CatalogEntry[]
  loading: boolean
  failed: boolean
  selectedKey: string | null
  onSelect: (key: string) => void
}) {
  if (loading) return <p className="text-muted">Loading template information…</p>
  if (failed) {
    return (
      // "Retrying automatically" is the console's usual error tail and it is
      // true of the many hooks that carry a refetchInterval — but NOT of
      // useCatalog, which has none. With retry exhausted at 1 and nothing
      // polling, this promised a recovery that never arrives (GATE-B7 round
      // 4). It is the same false claim the Provision step below had, two
      // hundred lines away, so it gets the same true one.
      <p className="text-amber-200/80">
        The catalog couldn&apos;t be read right now, so no templates can be shown. Reload
        the page to try the read again.
      </p>
    )
  }
  if (entries.length === 0) {
    return <p className="text-muted">No templates are published to this console yet.</p>
  }

  return (
    <ul className="space-y-3">
      {entries.map((entry) => {
        const selected = entry.key === selectedKey
        // The catalog's own lifecycle, the same field ProvisionStage.tsx
        // reads to decide whether a deploy may be offered at all. `active`
        // is catalog.py's aggregate over this template's NetBox service(s):
        // every one of them tagged lifecycle:active. The template is
        // deployed, and a second deploy would re-run it against those same
        // services rather than stand up a separate one.
        const deployed = entry.lifecycle === 'active'
        return (
          <li key={entry.key} className="border-t border-white/5 pt-3 first:border-t-0 first:pt-0">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <span className="font-medium text-text">{entry.display_name}</span>
                {entry.summary && <p className="mt-1 text-xs text-muted">{entry.summary}</p>}
              </div>
              {/* Never a disabled button — ProvisionStage.tsx's own rule,
                  carried here with the guard it belongs to. An entry is
                  either selectable or it is not offered, and the reason is
                  prose below rather than a greyed-out control. */}
              {selected ? (
                <span className="badge shrink-0 bg-accent/20 text-xs text-accent">Selected</span>
              ) : deployed ? (
                <span className="badge shrink-0 bg-white/5 text-xs text-muted">Already deployed</span>
              ) : (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm shrink-0"
                  onClick={() => onSelect(entry.key)}
                >
                  Use this template
                </button>
              )}
            </div>
            {deployed && (
              // Rendered for a SELECTED active entry too, not just an
              // unselected one: a template can go active between the
              // operator choosing it and reaching Provision, and in that
              // case the "Selected" badge above is the only other thing on
              // the row — it would otherwise read as ready to go.
              <p className="mt-1 text-xs text-muted">
                Already deployed on this facility, so it can&apos;t start a new workload here.
              </p>
            )}
            {(entry.ebu_layer || entry.ebu_vertical || entry.ebu_media_function_type || entry.ebu_lifecycle_owner) && (
              <details className="mt-1 text-xs text-muted">
                <summary className="cursor-pointer select-none opacity-80 hover:opacity-100">
                  System details
                </summary>
                <p className="mt-1 pl-4">
                  {entry.ebu_layer ? `EBU layer ${entry.ebu_layer}` : ''}
                  {entry.ebu_layer && (entry.ebu_vertical || entry.ebu_media_function_type) ? ' · ' : ''}
                  {entry.ebu_vertical ? <span className="capitalize">{entry.ebu_vertical}</span> : ''}
                  {entry.ebu_media_function_type ? (
                    <span className="capitalize"> {entry.ebu_media_function_type}</span>
                  ) : (
                    ''
                  )}
                  {(entry.ebu_layer || entry.ebu_vertical || entry.ebu_media_function_type) &&
                  entry.ebu_lifecycle_owner
                    ? ' · '
                    : ''}
                  {entry.ebu_lifecycle_owner ? <span className="capitalize">{entry.ebu_lifecycle_owner}</span> : ''}
                </p>
              </details>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * Plan — the same honest single-facility assignment PlanStage.tsx renders
 * for a real workload, ported here because the draft doesn't have a
 * MediaWorkload to hand PlanStage's own copy. Zero sites and more-than-one
 * sites are both designed non-answers (Art. 1: a rail that guesses which
 * facility a draft belongs to is worse than one that says it can't tell) —
 * deliberately not a picker, because federation is an explicit v0.1
 * non-goal and there is nothing to choose between yet. GATE ONLY IN THE
 * EXACTLY-ONE-FACILITY CASE (WP-3 spec D): both non-answer branches below
 * are untouched by the placement confirmation gate — there is nothing to
 * confirm when the console cannot even say which single facility this is.
 *
 * WP-3 spec D adds the CONFIRMATION itself, in the one branch that resolves
 * to something concrete: the operator must explicitly acknowledge the
 * resolved placement before Provision opens (classifyDraftFlow's
 * facilityConfirmed) — not because the fact is in doubt, but because
 * Provision is consequential and "the console already knew this" should
 * not be the operator's first read of it. It is a CONFIRMATION, not a
 * CHOICE: there is no workload-to-facility relationship anywhere in the
 * backend (nothing in media_workloads.py ties a workload to a site, and
 * the AWX launcher takes no site field), so a dropdown here would write to
 * nothing. The copy states a true fact and implies nothing more — "will
 * run on", never "select" or "assign".
 */
function PlanAssignment({
  loading,
  failed,
  sites,
  confirmed,
  onConfirm,
}: {
  loading: boolean
  failed: boolean
  sites: FacilitySummary['sites']
  /** The operator has acknowledged the resolved placement below. */
  confirmed: boolean
  onConfirm: () => void
}) {
  if (loading) return <p className="text-muted">Loading facility assignment…</p>
  if (failed) return <p className="text-amber-200/80">Facility inventory is unreachable right now.</p>
  if (sites.length === 0) {
    return (
      <p className="text-muted">
        No facility is registered in NetBox yet, so an assignment can&apos;t be shown.
      </p>
    )
  }
  if (sites.length > 1) {
    return (
      <p className="text-muted">
        {sites.length} facilities are registered; workload-to-facility assignment isn&apos;t
        tracked yet.
      </p>
    )
  }
  const site = sites[0]
  if (confirmed) {
    return (
      <p className="text-text">
        <span aria-hidden="true">✓</span> Confirmed — this workload will run on{' '}
        <span className="font-medium">{site.name}</span>.
      </p>
    )
  }
  return (
    <div>
      <p className="text-text">
        This workload will run on <span className="font-medium">{site.name}</span>.
      </p>
      <button type="button" className="btn btn-secondary btn-sm mt-2" onClick={onConfirm}>
        Confirm placement
      </button>
    </div>
  )
}

/**
 * Provision — deliberately a full SECTION of provisioning methods with one
 * resident row ("Provision now"), not a bare button in a panel (umbrella
 * #285 addendum, operator: future residents are scheduled provisioning and
 * an exposed external trigger). The headroom is structural only: there is
 * no second row, no disabled control, and no "coming soon" copy standing in
 * for either of those — a reader looking at the pixels has no way to tell
 * anything else is planned, which is the point of "structural, not
 * advertised".
 *
 * The action itself reuses the exact seam ProvisionStage.tsx arms
 * (useDeployCatalog + the ReasonConfirm mandatory-reason pattern) and packs
 * in the slug this draft already resolved, rather than re-collecting it as
 * ProvisionStage's own optional workload field does for an already-running
 * workload.
 */
function ProvisionSection({
  entry,
  catalogFailed,
  catalogFetching,
  slug,
  arming,
  pending,
  outcome,
  onArm,
  onCancel,
  onConfirm,
}: {
  entry: CatalogEntry | null
  catalogFailed: boolean
  catalogFetching: boolean
  slug: string
  arming: boolean
  pending: boolean
  outcome: DeployOutcome | null
  onArm: () => void
  onCancel: () => void
  onConfirm: (reason: string) => void
}) {
  const templateName = entry?.display_name ?? 'the selected template'
  // THE GUARD THAT DID NOT TRAVEL WITH THE SEAM (operator review, PR #66),
  // plus the one the guard itself needed (GATE-B7).
  //
  // `deployed` — ProvisionStage.tsx offers its deploy only for a non-active
  // entry; this page reused that page's deploy seam and left the condition
  // behind, so the draft flow would arm and fire a second deploy against a
  // template already tagged lifecycle:active.
  //
  // `unverifiable` — the guard above is only as good as the read it judges,
  // and a lifecycle read that FAILED still has a value. react-query keeps
  // the last successful data alongside isError, so on a failed refetch
  // `entry` is a stale snapshot: it can say `bootstrapped` for a template
  // that went active in exactly the window the console stopped being able
  // to look. Trusting it there fires the duplicate this guard exists to
  // prevent, so a failing catalog read withdraws the action outright rather
  // than acting on the last thing we happened to see. It is checked FIRST
  // for that reason — when the read is failing, `lifecycle` is not evidence
  // of anything, including "already deployed".
  //
  // `checking` — a refetch is in flight, so the console has an outstanding
  // question about the very field the guard judges, and the read in transit
  // is precisely the one that would correct a lifecycle that has moved.
  // Acting on the old answer while its replacement is on the wire is the
  // part of the staleness problem that IS closeable here. I argued against
  // this for two gate rounds on the grounds that it closes a narrower window
  // than plain staleness and would read as a freshness check it isn't —
  // then adopted it when the premise underneath that argument turned out to
  // be false (see the backstop paragraph).
  //
  // These are the same rule PlanStage now applies to the demand summary: a
  // read the console cannot currently stand behind must not produce a
  // confident output, whether that output is a claim or an affordance.
  //
  // WHAT THIS GUARD IS NOT. It does NOT make a duplicate deploy
  // unreachable. Even a settled, successful read is a snapshot: staleTime
  // holds it for 30s and an unfocused tab holds it indefinitely, so an
  // operator can still click on a lifecycle that moved since the console
  // last looked, with no refetch in flight to catch it. That residue is not
  // closeable on this side of the wire.
  //
  // AND THERE IS NO SERVER-SIDE BACKSTOP. This comment previously claimed
  // the backend was the authoritative gate. It is not. api_catalog_deploy
  // refuses on the per-entry lifecycle LOCK (a conflicting operation already
  // in flight), the capacity preflight, and a dirty failed-rollback run —
  // but it never calls get_lifecycle_status, which is read only by GET
  // /api/catalog. Nothing server-side rejects deploying an entry that is
  // already lifecycle:active. This guard is therefore the ONLY thing between
  // the operator and a duplicate, which is why it is drawn as wide as the
  // client honestly can — and why the durable fix is a conditional deploy on
  // the backend rather than more logic here.
  //
  // All three gate the confirm panel as well as the arm button: any of them
  // can arrive WHILE that panel is open, and suppressing only the affordance
  // would leave a live "Confirm provision" standing on exactly the state it
  // exists to refuse. The outcome messages below are deliberately NOT gated:
  // they record what happened to a request this page already made, and that
  // history does not stop being true when the lifecycle moves.
  const blocked: 'unverifiable' | 'checking' | 'deployed' | null = catalogFailed
    ? 'unverifiable'
    : catalogFetching
      ? 'checking'
      : entry?.lifecycle === 'active'
        ? 'deployed'
        : null
  return (
    <div>
      <h3 className="text-xs uppercase tracking-wide text-muted">Provisioning methods</h3>
      <div className="mt-2 rounded-lg border border-white/10 p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="font-medium text-text">Provision now</div>
            <p className="text-xs text-muted">
              {blocked === 'unverifiable'
                ? 'The catalog could not be read, so this template’s deployment state is unknown.'
                : blocked === 'checking'
                  ? `Checking whether ${templateName} is still undeployed…`
                  : blocked === 'deployed'
                    ? `${templateName} is already deployed on this facility.`
                    : `Launches ${templateName} immediately via the AWX launcher, recorded as workload:${slug}.`}
            </p>
          </div>
          {blocked === null && !arming && !pending && (
            <button type="button" className="btn btn-primary btn-sm shrink-0" onClick={onArm}>
              ▶ Provision now
            </button>
          )}
        </div>

        {blocked === 'deployed' && (
          // Same designed state ProvisionStage renders as "Already
          // deployed.", said at the length this page's step needs: there it
          // is one template of several on a running workload, here it is the
          // operator's whole draft with nowhere to go — so this names what
          // to do instead rather than only stating the fact.
          <p className="mt-2 text-xs text-muted">
            There is nothing here to launch. Open it from Media Workloads, or go back to
            Design and choose a template that isn&apos;t deployed yet.
          </p>
        )}

        {blocked === 'unverifiable' && (
          // Withheld, and said as a withholding rather than a refusal: the
          // console is not claiming this template is deployed, only that it
          // has stopped being able to tell — and that provisioning blind is
          // the one thing it will not do.
          //
          // The last line took two goes to make true, which is the point of
          // the whole step. It first promised "the console keeps retrying on
          // its own" (retry is 1, there is no refetchInterval — nothing
          // polls), then "read again when you return to this tab", which
          // overstates refetchOnWindowFocus: that only refetches a STALE
          // query, and staleTime is 30s, so a return inside that window
          // issues no request at all. Both would have left an operator
          // waiting on a recovery that never arrived. What is unconditionally
          // true is the CONDITION, plus one action that always works —
          // reloading builds a new QueryClient with an empty cache.
          <p className="mt-2 text-xs text-amber-200/80">
            Provisioning is withheld until the catalog can be read again — launching
            without it risks a second deploy onto a template that is already running.
            Reload the page to try the read now.
          </p>
        )}

        {blocked === null && arming && (
          <div className="mt-2">
            <ReasonConfirm
              title="Provision this workload now?"
              description={`Deploys ${templateName} via its AWX job template and records it as workload:${slug}. Operator-gated: your reason is recorded in the audit trail.`}
              confirmLabel="Confirm provision"
              pendingLabel="Provisioning…"
              pending={pending}
              onConfirm={onConfirm}
              onCancel={onCancel}
            />
          </div>
        )}

        {/* Rendered by the SECTION, not the confirm panel, so it survives
            the panel closing (see handleProvisionConfirm's catch branch) —
            the same reason ProvisionStage's clear-for-deployment failure
            lives on the stage rather than inside its own armed subtree. */}
        {!arming && outcome?.kind === 'refused' && (
          <p className="mt-2 text-xs text-red-300">
            Provisioning didn&apos;t go through — nothing was created for workload:{slug}.{' '}
            {REFUSAL_COPY[outcome.status] ??
              'The facility refused the request. Check your access and the reason, then try again.'}
          </p>
        )}
        {/* The honest half of the split. The console lost the connection
            before it learned what happened, so it says exactly that and
            sends the operator to look — never "nothing was created", which
            would invite a second deploy on top of a workload that may
            already be starting. */}
        {!arming && outcome?.kind === 'unknown' && (
          <p className="mt-2 text-xs text-amber-300">
            Outcome unknown — the connection was lost before the facility answered, so
            the console cannot tell whether the deploy for workload:{slug} started.
            Check Media Workloads before trying again: deploying a second time when the
            first one did start is the more expensive mistake.
          </p>
        )}
      </div>
    </div>
  )
}
