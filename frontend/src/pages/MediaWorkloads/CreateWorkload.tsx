import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { isOperation, useCatalog, useDeployCatalog, useFacilitySummary } from '../../api/hooks'
import type { CatalogEntry, FacilitySummary } from '../../api/types'
import { classifyDraftFlow, FLOW_STEPS, type DraftProgress, type FlowStepId } from '../../lib/workloadFlow'
import { isValidWorkloadSlug } from '../../lib/workloadSlug'
import { workloadSetupPath } from '../../lib/routes'
import { APIError } from '../../api/client'
import ReasonConfirm from '../../components/ReasonConfirm'
import { Input } from '../../components/FormField'
import FlowStep from './FlowStep'
import { useDraftWorkloadStore } from '../../store/draftWorkload'
import PageHeading from '../../components/PageHeading'
import { usePageTitle } from '../../hooks/usePageTitle'

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
 * template and the resolved facility live in browser state until Provision
 * fires — at which point the deploy is ACCEPTED, and the page hands off to
 * the real (backend-driven) detail route CARRYING THAT LAUNCH.
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
 * localStorage/sessionStorage persistence would trade an honest "you'll
 * lose this" for a silent maybe-still-there that is worse when it's wrong
 * (see store/draftWorkload.ts's own docstring for the full reasoning).
 *
 * THE GATE ITSELF IS NOT THIS FILE'S TO OWN. lib/workloadFlow.ts's
 * classifyDraftFlow() is the only place "what unlocks next" is decided; this
 * component only turns the operator's inputs into the booleans that
 * function reads (hasName, hasTemplate, hasFacility, facilityConfirmed) and
 * renders whatever it returns. Configure and Finalise & Review never carry
 * an action from here — classifyDraftFlow locks them for the whole draft,
 * because nothing has run yet to configure or tear down.
 *
 * WP-3 spec C — THE WIZARD. This used to stack all five DraftFlowStep
 * accordion panels on one page, each independently foldable. That is
 * retired in favour of the exact one-step-at-a-time shape WorkloadSetup's
 * own wizard already uses (WO-D1): FlowStep.tsx, REUSED HERE UNCHANGED, and
 * a local selectedStep + Previous/Next, mirroring WorkloadWizard's own
 * pattern in WorkloadSetup.tsx. Studio name + slug become their own FIRST
 * step, "Identity" — deliberately NOT one of FlowStep's five numbered,
 * coloured lifecycle stages (the canonical lifecycle has six stages and the
 * orchestration rail shows five; an identity step is neither), so it gets
 * its own small, distinctly-chromed panel (IdentityStep below) rather than
 * being pushed through FlowStep.tsx.
 *
 * Next/Previous through Design → Finalise & Review is UNCONDITIONAL (a
 * plain index walk), never gated on lock state — the same reason
 * FlowStep.tsx already supports mounting a locked step at all: it renders
 * ONLY that step's stated reason then, never its children, so nothing
 * actionable is ever reachable early. This is deliberate, not an oversight:
 * gating Next on lock state would make Configure's and Finalise & Review's
 * OWN DISTINCT locked reasons unreachable in a single-mount wizard (there is
 * no rail here — see railRouteContract.test.tsx's own pin that the rail is
 * absent on this route — so a locked step's reason has nowhere else to
 * live). Identity's own Next is the one gate: advancing past it before the
 * name resolves to a valid slug would let Design mount with nothing for the
 * eventual deploy to carry.
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
// fallback text is never reached for it. Kept BYTE FOR BYTE from the
// pre-wizard version (WP-3 spec C: "do not merge those sentences") — the
// wizard changes WHERE these render, never their wording.
const LOCKED_REASON: Partial<Record<FlowStepId, string>> = {
  plan: 'This step opens once Design is complete: a studio name that resolves to a valid workload identity, and a chosen template.',
  provision: 'This step opens once Plan is complete: this platform must resolve to exactly one facility first.',
  configure: 'Locked for the whole draft — nothing has been provisioned yet, so there is nothing to configure.',
  finalise: 'Locked for the whole draft — nothing has been provisioned yet, so there is nothing to finalise or tear down.',
}

/** The wizard's own step vocabulary: Identity, then the five orchestration
 *  stages. Identity is deliberately not a FlowStepId — see the file
 *  docstring for why it must not read as a sixth lifecycle stage. */
type DraftWizardStep = 'identity' | FlowStepId
const DRAFT_WIZARD_STEPS: DraftWizardStep[] = ['identity', ...FLOW_STEPS]

export default function CreateWorkload() {
  usePageTitle('Create media workload')
  const navigate = useNavigate()

  // WP-3 spec C: the draft's DATA lives in a non-persisted, tab-lifetime
  // store (store/draftWorkload.ts) — not this component's own useState —
  // so it survives navigating to another page and back, which the wizard
  // makes a reachable path for the first time (Identity/Design/Plan are
  // real destinations now, not sections of one scrolled page). It must NOT
  // survive a reload; see that store's own docstring for why sessionStorage
  // would be the wrong tool here, not just an unused one.
  const {
    studioName,
    slug,
    selectedKey,
    confirmedFacilityName,
    setStudioName,
    setSlug,
    setSelectedKey,
    setConfirmedFacilityName,
    reset: resetDraft,
  } = useDraftWorkloadStore()

  // The wizard's own presentation state — never persisted, and never
  // derived from FlowStepState (same discipline as WorkloadWizard's
  // selectedStep in WorkloadSetup.tsx). Re-settles fresh on every mount
  // (see the effect below), so navigating away and back always lands the
  // operator back on the step their SAVED DATA implies, not wherever they
  // happened to leave the wizard visually.
  const [selectedStep, setSelectedStep] = useState<DraftWizardStep | null>(null)
  const [arming, setArming] = useState(false)
  // A failed deploy has TWO distinguishable outcomes and the console must
  // not flatten them (GATE-B P1). See handleProvisionConfirm for why. Local
  // and unpersisted — an in-flight arm/outcome is transient UI state, not
  // part of the draft itself (unlike the name/template/facility fields
  // above, which the operator would otherwise have to redo).
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

  // umbrella #432 §D1: computed ONCE here rather than inside ProvisionSection
  // (which used to derive it from its own catalogFailed/catalogFetching/entry
  // props) — both the button's own offer AND the FlowStep Next-primary
  // decision below now read this SAME value, so they cannot disagree about
  // whether Provision currently offers anything.
  const provisionBlocked: 'unverifiable' | 'checking' | 'deployed' | null = catalogFailed
    ? 'unverifiable'
    : catalogFetching
      ? 'checking'
      : selectedEntry?.lifecycle === 'active'
        ? 'deployed'
        : null

  const trimmedSlug = slug.trim()
  const slugValid = trimmedSlug !== '' && isValidWorkloadSlug(trimmedSlug)

  // Loading/error both read as "not resolved" — only a clean read of
  // exactly one site counts, the same honest-non-answer rule PlanStage
  // already applies to the real workload's Plan stage.
  const hasFacility = !facilityLoading && !facilityFailed && sites.length === 1
  const resolvedFacilityName = hasFacility ? sites[0].name : null
  // FIX ROUND (WP-3 spec D gate, P2-4): the boolean classifyDraftFlow reads
  // is derived HERE, by comparing the CONFIRMED identity to the CURRENTLY
  // resolved one — not read straight off the store. A confirmation for a
  // facility the live read has since stopped returning (or that stopped
  // being exactly one site) must not silently carry over as "yes" for
  // whatever is resolved now; see draftWorkload.ts's own docstring on
  // confirmedFacilityName for the reachable case this closes.
  const facilityConfirmed =
    resolvedFacilityName !== null && confirmedFacilityName === resolvedFacilityName

  const draft: DraftProgress = {
    hasName: slugValid,
    hasTemplate: selectedEntry !== null,
    hasFacility,
    // WP-3 spec D: the resolved-vs-acknowledged split lives here, one level
    // up from the raw read — classifyDraftFlow decides what it means for
    // the flow, this component only reports the operator's own action.
    facilityConfirmed,
  }
  const flow = classifyDraftFlow(draft)

  // React's sanctioned "derived state" pattern (same as WorkloadWizard's
  // identical effect in WorkloadSetup.tsx): persist the computed default
  // into state once, on mount (or after a Start Over resets selectedStep to
  // null) — but never again once the operator has an explicit selection, so
  // a facility query settling a moment later doesn't fight their own
  // navigation. See the file docstring for why Next is unconditional rather
  // than re-deriving this on every render instead.
  // flow.current is typed FlowStepId | null on the shared FlowState shape
  // (the real, backend-driven flow can genuinely have no current step) —
  // classifyDraftFlow itself never actually returns null for it, so the
  // fallback below is defensive typing, not a reachable branch in practice.
  const defaultStep: DraftWizardStep = draft.hasName && flow.current ? flow.current : 'identity'
  useEffect(() => {
    if (selectedStep === null) setSelectedStep(defaultStep)
  }, [defaultStep, selectedStep])
  const activeStep = selectedStep ?? defaultStep

  const activeIndex = DRAFT_WIZARD_STEPS.indexOf(activeStep)
  const prevStep = activeIndex > 0 ? DRAFT_WIZARD_STEPS[activeIndex - 1] : null
  const nextStep = activeIndex < DRAFT_WIZARD_STEPS.length - 1 ? DRAFT_WIZARD_STEPS[activeIndex + 1] : null

  function handleNameChange(value: string) {
    setStudioName(value)
  }

  function handleSlugChange(value: string) {
    setSlug(value)
  }

  function handleStartOver() {
    resetDraft()
    setArming(false)
    setDeployOutcome(null)
    setSelectedStep(null)
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
      // the record appears.
      //
      // dmfdeploy#414 migration hazard H1: this used to navigate to the bare
      // slug, which was the flow page pre-inversion. Post-inversion the bare
      // slug is WorkloadHome — a just-created workload has no members yet,
      // so it would classify as an honest but WRONG cold-entry state there
      // (or worse, "not found", since WorkloadHome has no launch-state
      // fallback the way the setup route does), silently losing the
      // materializing story this navigation exists to carry. The setup route
      // is where WorkloadMaterializing.tsx actually mounts (WorkloadSetup.tsx
      // reads `launch` off router state exactly as this used to when it was
      // named WorkloadSetup.tsx), so the destination moves with it —
      // through workloadSetupPath (H3), not a hand-built string.
      //
      // WP-3 spec C: the draft's job is done — it becomes the real workload
      // this navigation is carrying, so its browser-local state is cleared
      // rather than left to greet the operator's next visit to /new.
      resetDraft()
      navigate(workloadSetupPath(trimmedSlug), {
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

  const previousReason = prevStep === null ? 'This is the first step.' : ''
  const nextReason = nextStep === null ? 'This is the last step.' : ''

  let stepBody: React.ReactNode
  if (activeStep === 'identity') {
    stepBody = (
      <IdentityStep
        studioName={studioName}
        slug={slug}
        trimmedSlug={trimmedSlug}
        slugValid={slugValid}
        onNameChange={handleNameChange}
        onSlugChange={handleSlugChange}
        canAdvance={draft.hasName}
        onNext={() => nextStep && setSelectedStep(nextStep)}
      />
    )
  } else {
    const stepId = activeStep
    const index = FLOW_STEPS.indexOf(stepId)
    // umbrella #432 §D1: exactly one cyan promoted control per screen.
    // Design/Plan/Configure/Finalise never render a top-level primary
    // control of their own (Configure and Finalise & Review are locked for
    // the WHOLE draft — see this file's own docstring — so Provision is the
    // only stepId that can possibly disagree), so Next is primary everywhere
    // except while Provision is actually showing its own offer
    // (provisionBlocked === null — see that value's own comment).
    const nextIsPrimary = !(stepId === 'provision' && provisionBlocked === null)
    stepBody = (
      <FlowStep
        anchorId={stepId}
        number={index + 1}
        label={FLOW_STEP_LABELS[stepId]}
        state={flow.steps[stepId]}
        lockedReason={LOCKED_REASON[stepId]}
        canPrevious={prevStep !== null}
        canNext={nextStep !== null}
        onPrevious={() => prevStep && setSelectedStep(prevStep)}
        onNext={() => nextStep && setSelectedStep(nextStep)}
        nextPrimary={nextIsPrimary}
        previousReason={previousReason}
        nextReason={nextReason}
      >
        {stepId === 'design' && (
          <TemplatePicker
            entries={entries}
            loading={catalogLoading}
            failed={catalogFailed}
            selectedKey={selectedKey}
            onSelect={setSelectedKey}
          />
        )}
        {stepId === 'plan' && (
          <PlanAssignment
            loading={facilityLoading}
            failed={facilityFailed}
            sites={sites}
            confirmed={facilityConfirmed}
            // FIX ROUND P2-4: stores the IDENTITY the operator confirmed
            // (resolvedFacilityName is only non-null here in the first
            // place because onConfirm is only reachable from PlanAssignment's
            // own exactly-one-site branch), not a bare "yes".
            onConfirm={() => setConfirmedFacilityName(resolvedFacilityName)}
          />
        )}
        {stepId === 'provision' && (
          <ProvisionSection
            entry={selectedEntry}
            // The read's outcome, not just its payload — react-query keeps
            // the last good entries alongside isError, so without this the
            // step would go on acting from a catalog it knows it cannot
            // read. Computed once above (provisionBlocked), not re-derived
            // here — see that value's own comment.
            blocked={provisionBlocked}
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
        {/* Configure and Finalise & Review carry no content branch here —
            classifyDraftFlow locks them for the whole draft (LOCKED_REASON
            above), and FlowStep renders only that reason for a locked step,
            never its children. Anything written here would be dead code
            standing in for the (already honest) lockedReason. */}
      </FlowStep>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <PageHeading>Create media workload</PageHeading>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <p className="text-sm text-muted">
          Studio identity, template, and facility placement for a workload that does not exist
          yet — Provision is what creates it.
        </p>
        {/* Explicit, low-stakes reset (WP-3 spec C): this is browser-local
            draft state, not a recorded write, so it needs no ReasonConfirm
            audit trail — the same reasoning that keeps a per-panel Cancel
            unconfirmed elsewhere on this page. Always reachable, not just
            from Identity, so an operator who changed their mind on Plan or
            Provision doesn't have to step backward through every step to
            abandon the draft. flex-wrap (not nowrap) so this drops to its
            own line under the paragraph on narrow viewports instead of
            crowding it — a real ~480px regression caught by screenshot
            verification, not a hypothetical. */}
        <button type="button" className="shrink-0 text-sm text-muted hover:text-text hover:underline" onClick={handleStartOver}>
          Start over
        </button>
      </div>

      <div className="mt-4">{stepBody}</div>
    </div>
  )
}

/**
 * Identity — studio name + the workload identity it resolves to. The
 * wizard's first step, and deliberately NOT one of FlowStep's five
 * numbered, coloured lifecycle stages (WP-3 spec C — see the file
 * docstring): no step number, no lifecycle state badge, a plainly
 * different chrome so it never reads as a sixth stage of a canonically
 * six-stage, five-rail-chip model.
 */
function IdentityStep({
  studioName,
  slug,
  trimmedSlug,
  slugValid,
  onNameChange,
  onSlugChange,
  canAdvance,
  onNext,
}: {
  studioName: string
  slug: string
  trimmedSlug: string
  slugValid: boolean
  onNameChange: (value: string) => void
  onSlugChange: (value: string) => void
  canAdvance: boolean
  onNext: () => void
}) {
  return (
    <section className="panel border border-white/10" aria-label="Identity">
      <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <h2 className="text-base font-semibold">Identity</h2>
      </div>
      <div className="p-4 text-sm">
        <label htmlFor="studio-name" className="block text-xs uppercase tracking-wide text-muted">
          Studio name
        </label>
        <Input
          id="studio-name"
          type="text"
          className="mt-1 max-w-sm"
          placeholder="e.g. Studio A"
          value={studioName}
          onChange={(e) => onNameChange(e.target.value)}
          // umbrella #432 §C measured defect: document.activeElement was
          // BODY on load — nothing was ever focused. This is the wizard's
          // first field on its first step, so it takes focus once, on
          // mount, and never again (see FormField.tsx's own docstring for
          // why that's structurally true rather than a convention to keep).
          focusOnMount
        />
        {/* umbrella #432 §G (gate round 2, finding B2): this name is never
            recorded anywhere — see the amber note below — it only DERIVES
            the field beneath it (draftWorkload.ts's deriveSlug, live as you
            type unless the field below has been hand-edited). Stated here
            so that derivation is an explained outcome, not a surprise —
            the un-mangling of the derived identifier back into a display
            name is a backend gap, deferred to dmfdeploy/dmfdeploy#436. */}
        <p className="mt-1 text-xs text-muted">
          Used to derive the workload&apos;s identifier — &apos;UI Review Studio&apos; becomes
          &apos;ui-review-studio&apos;.
        </p>

        <label htmlFor="workload-slug" className="mt-3 block text-xs uppercase tracking-wide text-muted">
          Workload identity
        </label>
        {/* This is the literal value that gets recorded (the workload:<slug>
            NetBox tag) — shown and editable, never a hidden derivation of the
            name above, which is the Art. 1 failure mode a "friendly name that
            secretly becomes something else" would be. */}
        <Input
          id="workload-slug"
          type="text"
          className="mt-1 max-w-sm font-mono"
          prefix="workload:"
          value={slug}
          onChange={(e) => onSlugChange(e.target.value)}
        />
        {trimmedSlug !== '' && !slugValid && (
          <p className="mt-1 text-xs text-red-300">
            Only lowercase letters, digits and hyphens are allowed, and it can&apos;t start or end
            with a hyphen — up to 40 characters.
          </p>
        )}

        {/* umbrella #432 §G (gate round 2, finding B2): "nothing about it is
            recorded anywhere until then" overclaimed — handleProvisionConfirm
            sends only `trimmedSlug` to the deploy mutation (`workload:
            trimmedSlug`, no name field), so the studio name is discarded on
            Provision too, not merely on an early refresh. Corrected to say
            what actually gets recorded. */}
        <p className="mt-3 text-xs text-amber-200/80">
          This draft lives only in this browser tab until Provision runs — refreshing or closing
          the tab before then loses it. Provision records the workload identifier only; the
          studio name above is never stored anywhere.
        </p>
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-white/10 px-4 py-3 text-xs">
        <span className="text-muted">This is the first step.</span>
        {canAdvance ? (
          // umbrella #432 §D1: Identity offers no promoted action of its
          // own (unlike Provision), so its own Next — the one cyan control
          // on this screen — carries primary weight, same rule FlowStep.tsx
          // now applies to every step after this one.
          <button type="button" className="btn btn-primary btn-sm" onClick={onNext}>
            Next →
          </button>
        ) : (
          <span className="text-muted">
            Enter a studio name that resolves to a valid workload identity to continue.
          </span>
        )}
      </div>
    </section>
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
  blocked,
  slug,
  arming,
  pending,
  outcome,
  onArm,
  onCancel,
  onConfirm,
}: {
  entry: CatalogEntry | null
  /** umbrella #432 §D1: computed once by the caller (CreateWorkload's own
   *  provisionBlocked) — see this prop's own comment there for why this
   *  used to be re-derived from catalogFailed/catalogFetching/entry HERE
   *  instead, and no longer is. */
  blocked: 'unverifiable' | 'checking' | 'deployed' | null
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
