import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useCatalog, useDeployCatalog, useFacilitySummary } from '../../api/hooks'
import type { CatalogEntry, FacilitySummary } from '../../api/types'
import { classifyDraftFlow, FLOW_STEPS, type DraftProgress, type FlowStepId } from '../../lib/workloadFlow'
import { isValidWorkloadSlug } from '../../lib/workloadSlug'
import ReasonConfirm from '../../components/ReasonConfirm'
import FlowStep from './FlowStep'

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
 * Provision fires — at which point the deploy call is what actually causes
 * the workload to start existing, and the page hands off to the real
 * (backend-driven) detail route.
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
  const [arming, setArming] = useState(false)
  const [deployFailed, setDeployFailed] = useState(false)

  const { data: catalogData, isLoading: catalogLoading, isError: catalogFailed } = useCatalog()
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
      await deployMutation.mutateAsync({ key: selectedEntry.key, reason, workload: trimmedSlug })
      // The deploy call is the moment the workload starts existing; from
      // here the real, backend-driven flow (WorkloadDetail) takes over.
      navigate(`/media-workloads/${encodeURIComponent(trimmedSlug)}`)
    } catch (e) {
      // Art. 8: the operator gets what happened and that nothing was
      // created, never the raw exception. Closing the arm panel here (rather
      // than leaving it open on a stale mutation) and rendering the failure
      // as a standing fact of the step is what keeps this loop closed
      // (Art. 2) instead of a toast that could vanish before it's read.
      console.error('Provision failed:', e)
      setArming(false)
      setDeployFailed(true)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="hero">
        <p className="kicker">Media Workloads</p>
        <h1>Create media workload</h1>
      </div>

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
          <FlowStep
            key={id}
            number={index + 1}
            label={FLOW_STEP_LABELS[id]}
            state={flow.steps[id]}
            // The draft's position step is pinned open, same contract the
            // deployed flow uses. classifyDraftFlow never reports a draft
            // step as `open` (a draft bears no backend affordance), so here
            // `current` and the position always coincide — the prop is still
            // passed explicitly rather than left to FlowStep to infer, so
            // both call sites answer the disclosure question the same way.
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
              <PlanAssignment loading={facilityLoading} failed={facilityFailed} sites={sites} />
            )}
            {id === 'provision' && (
              <ProvisionSection
                entry={selectedEntry}
                slug={trimmedSlug}
                arming={arming}
                pending={deployMutation.isPending}
                failed={deployFailed}
                onArm={() => {
                  setDeployFailed(false)
                  setArming(true)
                }}
                onCancel={() => setArming(false)}
                onConfirm={handleProvisionConfirm}
              />
            )}
            {/* Configure and Finalise & Review never open in a draft — see
                LOCKED_REASON above — so there is deliberately no content
                branch for them here. FlowStep does not render children for a
                locked step at all, so anything written here would be dead
                code standing in for the (already honest) lockedReason. */}
          </FlowStep>
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
      <p className="text-amber-200/80">
        The catalog couldn&apos;t be read right now, so no templates can be shown. Retrying
        automatically.
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
        return (
          <li key={entry.key} className="border-t border-white/5 pt-3 first:border-t-0 first:pt-0">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <span className="font-medium text-text">{entry.display_name}</span>
                {entry.summary && <p className="mt-1 text-xs text-muted">{entry.summary}</p>}
              </div>
              {/* A real, always-actionable control: every rendered entry is
                  selectable, so this is never a dead button standing in for
                  a capability that doesn't exist. */}
              {selected ? (
                <span className="badge shrink-0 bg-accent/20 text-xs text-accent">Selected</span>
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
 * non-goal and there is nothing to choose between yet.
 */
function PlanAssignment({
  loading,
  failed,
  sites,
}: {
  loading: boolean
  failed: boolean
  sites: FacilitySummary['sites']
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
  return (
    <p className="text-text">
      This platform runs one facility, so the workload is assigned to it:{' '}
      <span className="font-medium">{site.name}</span>.
    </p>
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
  slug,
  arming,
  pending,
  failed,
  onArm,
  onCancel,
  onConfirm,
}: {
  entry: CatalogEntry | null
  slug: string
  arming: boolean
  pending: boolean
  failed: boolean
  onArm: () => void
  onCancel: () => void
  onConfirm: (reason: string) => void
}) {
  const templateName = entry?.display_name ?? 'the selected template'
  return (
    <div>
      <h3 className="text-xs uppercase tracking-wide text-muted">Provisioning methods</h3>
      <div className="mt-2 rounded-lg border border-white/10 p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="font-medium text-text">Provision now</div>
            <p className="text-xs text-muted">
              Launches {templateName} immediately via the AWX launcher, recorded as workload:
              {slug}.
            </p>
          </div>
          {!arming && !pending && (
            <button type="button" className="btn btn-primary btn-sm shrink-0" onClick={onArm}>
              ▶ Provision now
            </button>
          )}
        </div>

        {arming && (
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
        {!arming && failed && (
          <p className="mt-2 text-xs text-red-300">
            Provisioning didn&apos;t go through — nothing was created for workload:{slug}. Check
            your access and the reason, then try again.
          </p>
        )}
      </div>
    </div>
  )
}
