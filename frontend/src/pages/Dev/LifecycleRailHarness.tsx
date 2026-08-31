import { type FlowStepId } from '../../lib/workloadFlow'
import type { WorkloadLifecycleInput } from '../../lib/workloadLifecycle'
import LifecycleStrip from '../MediaWorkloads/LifecycleStrip'
import { LOCKED_REASON } from '../MediaWorkloads/WorkloadSetup'
import { classifyWorkloadForHeaderSlot, buildHeaderSlotRail } from '../../store/headerSlot'

/**
 * dmf-cms#391 — the lifecycle-rail inspection harness. DEV-ONLY: reachable
 * only through devHarnessRoute.ts's gate (see that file for why this exists
 * and how it bypasses App.tsx's normal auth flow). Statically imported by
 * App.tsx (see that file), but only ever reached behind the DEV-only gate —
 * a production build eliminates it regardless (empirically verified, not
 * merely asserted — see the PR description's bundle grep).
 *
 * Every specimen below builds a WorkloadLifecycleInput PLUS a synthetic
 * `instances` array (the same two things a real workload page owns — a
 * MediaWorkload's own `instances`, and the derived facts
 * buildWorkloadLifecycleInput reduces from it) and runs both through the
 * SAME two-phase pipeline those pages use — classifyWorkloadForHeaderSlot
 * then buildHeaderSlotRail (store/headerSlot.ts) — never classifyWorkloadFlow
 * called directly, and never a hand-built rail model.
 * `locked`/`current`/`offFlow`/`trustworthy`/the run counts printed under
 * each specimen are all read back off the real `rail` object at render
 * time, not asserted separately.
 *
 * FIX ROUND (dmf-cms#391, codex gate — new P2, then P1/the counts): TWO
 * rounds of this same lesson. First: an earlier version of this file called
 * classifyWorkloadFlow directly and hand-supplied `runningReadout.trustworthy`
 * itself, bypassing buildHeaderSlotRail entirely — fixed by routing through
 * the real pipeline instead. Second, after that fix: this file still
 * supplied `running`/`total` as plain hand-typed numbers passed alongside
 * the input, because at the time that was still how the real pipeline
 * itself worked (a caller-supplied count, independent of trustworthy) —
 * that WAS the actual gap codex found in production code, not just here,
 * and closing it in store/headerSlot.ts changed classifyWorkloadForHeaderSlot's
 * own signature to take a real `instances` array instead of a pre-computed
 * count. This file follows that change: no specimen states `running`/
 * `total` directly any more — each states a synthetic `instances` array
 * (via the tiny `fixtureInstances` helper below, or by hand for the one
 * specimen that needs mixed states), and classifyWorkloadForHeaderSlot
 * derives the counts itself, the same formula (`observed_state ===
 * 'running'` over `instances.length`) WorkloadSetup.tsx/WorkloadHome.tsx
 * would apply to a real workload's instances.
 *
 * DMFDEPLOY#414: `activeChip` no longer accepts `'operate'` — Operate is no
 * longer a rail entry at all (LifecycleStrip.tsx's own docstring), so there
 * is nothing left for a chip value to select. The specimens that used to
 * demonstrate the Operate-key tally divergence/convergence pair (formerly
 * #6 and #7) were removed with it, before the tally itself was.
 *
 * FIX ROUND (orchestrator/codex gate, redesign): LifecycleStrip no longer
 * accepts (or renders) a position marker of any kind — the position tally
 * and `aria-current` were removed entirely (see that component's own
 * docstring point B: the backend can never derive design/plan/finalise as
 * a position, so a marker could only ever land on two of five keys, and
 * `aria-current="step"` contradicted the IA doc's #493 "peer view"
 * amendment). `rail.current`/`rail.offFlow` in the debug `<dl>` below are
 * STILL genuinely computed by the real `buildHeaderSlotRail` pipeline —
 * `store/headerSlot.ts` was deliberately left untouched (its own trust/
 * derivation machinery has test coverage this fix round's scope doesn't
 * extend to, and a future consumer may still want it) — but LifecycleStrip
 * itself no longer reads either field. The `<dl>` rows exist for debugging
 * the classifier's own output, not to demonstrate anything the rail still
 * shows; every specimen note below has been corrected to say so, since a
 * note claiming "the tally should render here" would now be describing
 * behaviour that does not exist.
 *
 * SAME FIX ROUND: hue is also gone from the rail entirely — tried as a
 * fill, then as a line, measured at each stage, and removed once the line
 * measured imperceptible (dE2000 0.85-1.17) for one pair under the two
 * common CVDs. Every key renders the same neutral fill/ink now; only icon
 * and label carry identity. No specimen note below claims otherwise.
 */

interface Specimen {
  id: string
  slug: string
  title: string
  note: string
  input: WorkloadLifecycleInput
  /** A minimal, real-shaped instances array — classifyWorkloadForHeaderSlot
   *  derives running/total from this itself; nothing here states a count
   *  directly. See the file docstring's FIX ROUND note. */
  instances: { observed_state: string }[]
  activeChip: FlowStepId | null
  jobOwnerLabel: string | null
  jobInFlight: boolean
}

/** Builds `total` synthetic instances, `running` of them observed running
 *  and the rest in some other observed state — a plausible fixture, not a
 *  shortcut: classifyWorkloadForHeaderSlot still does the real
 *  observed_state filtering over whatever this produces. */
function fixtureInstances(running: number, total: number): { observed_state: string }[] {
  return [
    ...Array.from({ length: running }, () => ({ observed_state: 'running' })),
    ...Array.from({ length: Math.max(total - running, 0) }, () => ({ observed_state: 'unknown' })),
  ]
}

// A shared base for the three "operate" specimens (3, 6, 7) — the whole
// point of that trio is to hold POSITION constant and vary only SELECTION,
// so they deliberately share one classifier input rather than three
// independently-tuned ones.
const OPERATE_HEALTHY: WorkloadLifecycleInput = {
  lifecycle: 'operate',
  hasBootstrappedMembers: false,
  allMembersBootstrapped: false,
  anyMemberObservedRunning: true,
  membersDataTrustworthy: true,
  purgeAuthorized: true,
  isPurgeableEntity: true,
}
const OPERATE_HEALTHY_INSTANCES = fixtureInstances(2, 2)

const SPECIMENS: Specimen[] = [
  {
    id: '1-provision',
    slug: 'harness-provision',
    title: '1 · lifecycle=provision — 2 locked, Design selected (position was Provision; the rail no longer marks it)',
    note: 'hasBootstrappedMembers: false, so Provision carries only "deploy" — Configure and Finalise both lock (neither has a predecessor to act on yet). activeChip is pinned to Design. The classifier still derives a distinct backend position (Provision, visible in the "current" debug row below) but the rail itself carries no marker for that fact any more — Design (the selected face) is the only state any key shows here.',
    input: {
      lifecycle: 'provision',
      hasBootstrappedMembers: false,
      allMembersBootstrapped: false,
      anyMemberObservedRunning: false,
      membersDataTrustworthy: true,
      purgeAuthorized: true,
      isPurgeableEntity: true,
    },
    instances: fixtureInstances(0, 2),
    activeChip: 'design',
    jobOwnerLabel: null,
    jobInFlight: false,
  },
  {
    id: '2-configure',
    slug: 'harness-configure',
    title: '2 · lifecycle=configure — fully open/complete, selection on Configure',
    note: 'Position and selection happen to both sit on Configure here (no hash override), but that\'s incidental now — the rail has no position concept left to converge or diverge from selection. Configure and Finalise both carry live actions (switch-source, tear-down) and are unlocked, so both render as ordinary keys; only Configure additionally reads as selected (the selected face), because it is activeChip.',
    input: {
      lifecycle: 'configure',
      hasBootstrappedMembers: false,
      allMembersBootstrapped: false,
      anyMemberObservedRunning: true,
      membersDataTrustworthy: true,
      purgeAuthorized: true,
      isPurgeableEntity: true,
    },
    instances: fixtureInstances(3, 4),
    activeChip: 'configure',
    jobOwnerLabel: null,
    jobInFlight: false,
  },
  {
    id: '3-operate-default',
    slug: 'harness-operate-default',
    title: '3 · lifecycle=operate — WorkloadSetup\'s own real default selection (Finalise & Review)',
    note: 'offFlow is true, every flow step reads complete/open, no flow step is "current". activeChip mirrors WorkloadSetup.tsx\'s own defaultSelection ladder for an off-flow workload with no hash target ("if (offFlow) return \'finalise\'") — this is what an operator actually sees landing on the setup route for a running workload, not a synthetic case. The rail carries no position marker on any key any more (fix round: the tally was removed rail-wide, not merely because Operate — dmfdeploy#414 — left no sixth key for it to land on) — Finalise & Review (the selection) genuinely diverges from the workload\'s real position (Operate, off this rail entirely), and that divergence is stated in prose only, on WorkloadSetup\'s own offFlow banner, never on this rail.',
    input: OPERATE_HEALTHY,
    instances: OPERATE_HEALTHY_INSTANCES,
    activeChip: 'finalise',
    jobOwnerLabel: null,
    jobInFlight: false,
  },
  {
    id: '4-operate-tearing-down',
    slug: 'harness-tearing-down',
    title: '4 · lifecycle=operate + tearingDown — active job overrides the classifier\'s position to Finalise & Review',
    note: 'tearingDown: true wins the classifier\'s own active-stage precedence ladder (teardown beats the lifecycle field), so the classifier\'s own position (rail.current, in the debug row below) resolves to Finalise & Review, NOT off-flow, even though the backend lifecycle value is still "operate" — busy() also suppresses every stageActions() list. activeChip is pinned to finalise too (the operator started the teardown from that panel), so this is the one specimen where a key is simultaneously the classifier\'s position, the selection, AND busy — the rail marks none of that separately from selection any more, but it still exercises the job-in-flight sr-only "Selected" node, since a busy key renders as a `<div>`, not a `<button>`, and needs that text node in place of `aria-pressed`.',
    input: {
      lifecycle: 'operate',
      tearingDown: true,
      hasBootstrappedMembers: false,
      allMembersBootstrapped: false,
      anyMemberObservedRunning: true,
      membersDataTrustworthy: true,
      purgeAuthorized: true,
      isPurgeableEntity: true,
    },
    // Deliberately non-zero (stale note removed: this used to document a
    // RunningReadout component that Shell Round 2 already deleted outright
    // — see LifecycleStrip.tsx's own docstring, "row-end run-count readout
    // ... is deleted outright too". Kept non-zero anyway so the debug
    // running/total row below still shows a real derived count during a
    // job, even though LifecycleStrip itself no longer renders one.
    instances: fixtureInstances(2, 2),
    activeChip: 'finalise',
    jobOwnerLabel: 'Finalise & Review',
    jobInFlight: true,
  },
  {
    id: '5-unknown',
    slug: 'harness-unknown',
    title: '5 · lifecycle=unknown — 2 record, 3 locked',
    note: 'The backend could not place this workload. Design/Plan render as "record" (readable, no claim of completion) — the only two steps that survive an undetermined position; Provision/Configure/Finalise all lock with a stated reason. current is null (see the debug row below) — the rail carries no position marker regardless, so this specimen looks the same on that front as any other. membersDataTrustworthy is left unset on this specimen\'s input (an unknown-lifecycle workload has no member-state read worth trusting) — this is NOT a "TRUST lookup miss": classifyWorkloadForHeaderSlot always runs `TRUST.set(classified, { trustworthy: input.membersDataTrustworthy ?? false, ... })`, so the omitted field is stored as an explicit `false`, same as any other optional WorkloadLifecycleInput field defaulting via `?? false`. instances here are deliberately non-zero (3 running of 5) anyway, so this specimen still doubles as a live proof that the REAL pipeline withholds the count on that stored false, not a hand-asserted one: it should read "Count unavailable" regardless of what the instances array actually says.',
    input: {
      lifecycle: 'unknown',
    },
    instances: fixtureInstances(3, 5),
    activeChip: 'design',
    jobOwnerLabel: null,
    jobInFlight: false,
  },
]

function SpecimenRow({ specimen }: { specimen: Specimen }) {
  // The SAME two-phase call every production page makes — see this file's
  // own docstring for why calling classifyWorkloadFlow directly (the
  // pre-fix version of this harness) was the actual gap, and why passing
  // `instances` here (rather than a pre-computed running/total) closes the
  // later one.
  const flow = classifyWorkloadForHeaderSlot(specimen.input, specimen.instances)
  const rail = buildHeaderSlotRail(flow, {
    activeChip: specimen.activeChip,
    lockedReasons: LOCKED_REASON,
    jobOwnerLabel: specimen.jobOwnerLabel,
    jobInFlight: specimen.jobInFlight,
    onSelect: () => {},
  })
  const lockedCount = Object.values(rail.steps).filter((s) => s === 'locked').length
  const recordCount = Object.values(rail.steps).filter((s) => s === 'record').length

  return (
    <section data-testid={`specimen-${specimen.id}`} className="mb-8">
      <h2 className="text-base font-semibold text-text">{specimen.title}</h2>
      <p className="mt-1 max-w-3xl text-sm text-muted">{specimen.note}</p>
      <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 font-mono text-2xs uppercase tracking-wide text-muted">
        <div>
          <dt className="inline">current: </dt>
          <dd className="inline text-text">{rail.current ?? 'null'}</dd>
        </div>
        <div>
          <dt className="inline">offFlow: </dt>
          <dd className="inline text-text">{String(rail.offFlow)}</dd>
        </div>
        <div>
          <dt className="inline">locked: </dt>
          <dd className="inline text-text">{lockedCount}</dd>
        </div>
        <div>
          <dt className="inline">record: </dt>
          <dd className="inline text-text">{recordCount}</dd>
        </div>
        <div>
          <dt className="inline">activeChip: </dt>
          <dd className="inline text-text">{specimen.activeChip ?? 'null'}</dd>
        </div>
        <div>
          <dt className="inline">trustworthy: </dt>
          <dd className="inline text-text">{String(rail.runningReadout.trustworthy)}</dd>
        </div>
        <div>
          <dt className="inline">running/total: </dt>
          <dd className="inline text-text">{rail.runningReadout.running}/{rail.runningReadout.total}</dd>
        </div>
      </dl>

      {/* Reproduces Topbar's real header-slot row (header bg + the row's own
          border/padding) so what renders here matches what actually ships —
          not a bare, unstyled mount. VISUAL PARITY FIX ROUND (#512): kept in
          sync with Topbar.tsx's own className change — bg-sidebar, no
          border-b — so this harness previews the real merged-with-the-nav
          look, not the pre-fix seam. */}
      <div className="mt-3 bg-bg">
        <div
          data-testid="header-slot-row"
          className="relative flex flex-nowrap items-center gap-3 bg-sidebar px-4 py-2"
        >
          <div className="min-w-0 flex-1 overflow-x-auto">
            {/* Same spread Topbar.tsx and testUtils/HeaderSlotProbe.tsx both
                use for the real header slot content — rail is the genuine
                HeaderSlotRailModel buildHeaderSlotRail produced above, not
                a hand-assembled prop bag. */}
            <LifecycleStrip {...rail} />
          </div>
        </div>
      </div>
    </section>
  )
}

export default function LifecycleRailHarness() {
  return (
    <div data-testid="lifecycle-rail-harness" className="min-h-screen bg-bg p-6 text-text">
      <h1 className="text-lg font-semibold">Lifecycle rail inspection harness</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        dmf-cms#391 — dev-only, reachable without a passkey (see devHarnessRoute.ts). Every
        specimen below feeds a hand-built WorkloadLifecycleInput and instances array through the
        real classifyWorkloadForHeaderSlot + buildHeaderSlotRail pipeline and renders the real
        LifecycleStrip with the result — see this file's own docstring.
      </p>
      <div className="mt-6">
        {SPECIMENS.map((specimen) => (
          <SpecimenRow key={specimen.id} specimen={specimen} />
        ))}
      </div>
    </div>
  )
}
