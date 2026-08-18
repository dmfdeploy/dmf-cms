import { useCallback, useMemo, useState, useEffect } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useCatalog, useCurrentUser, useMediaWorkloadsGrouped, useInstanceTopology } from '../../api/hooks'
import type { CatalogEntry, MediaWorkloadInstance } from '../../api/types'
import { classifyWorkloadForHeaderSlot, buildHeaderSlotRail, useRegisterHeaderSlot } from '../../store/headerSlot'
import { buildWorkloadLifecycleInput, type WorkloadLifecycleInput } from '../../lib/workloadLifecycle'
import type { FlowStepId } from '../../lib/workloadFlow'
import { topologySourceLabel } from '../../lib/labels'
import { LOCKED_REASON } from './WorkloadDetail'
import WorkloadTile from './WorkloadTile'
import InstanceLiveModal from './InstanceLiveModal'
import { settleQuery } from '../../lib/queryState'
import { LIVE_TILE_CAP, useDocumentVisible, usePrefersReducedMotion } from './liveView'
import PageHeading from '../../components/PageHeading'
import { usePageTitle } from '../../hooks/usePageTitle'

/**
 * Operate — the workload's own monitoring route (umbrella #285, operator
 * direction 2026-08-01: "Operate leaves this page entirely").
 *
 * WHY THIS IS A SEPARATE ROUTE, NOT A STAGE ON THE FLOW. The guided flow
 * (workloadFlow.ts) walks five steps the operator WORKS THROUGH in order;
 * Operate is a thing they WATCH, indefinitely, with no "only then" gate of
 * its own — nothing has to finish here before anything else opens. (The flow
 * does continue past it: Finalise & Review is open throughout, because a
 * running workload can always be torn down. Operate simply is not the thing
 * that gates it.) Folding it back onto the flow page would either
 * force it through the same locked/open/complete vocabulary it doesn't fit,
 * or special-case it there — both worse than the mount the orchestrator
 * already wired: its own URL, reachable independent of where the flow
 * currently sits.
 *
 * WHY IT CARRIES NO ACTION OF ITS OWN. The EBU coverage matrix marks
 * live Operate-time control as not-implemented, and that is accurate — but
 * the reason is about the KIND of write, not the count. The console has two
 * writes reachable while a workload runs: Configure's switch-source and
 * Finalise & Review's teardown (Finalise is open throughout Operate, because
 * a running workload can always be torn down). Neither is live flow control:
 * the switch is a configure-time re-point performed by an automation job, and
 * a teardown ends the workload rather than steering it. What is missing is
 * any seam that steers media WHILE it runs, and that is what this stage would
 * need to carry an action of its own. A control here that looked like it
 * re-routed media live would misstate what actually happens — so the one
 * affordance below is a navigation to the real seam, never a mutation.
 *
 * Reuses exactly what the retired Operate STAGE panel reused —
 * WorkloadTile, InstanceLiveModal, and the liveView.ts polling bounds — for
 * the same reason that panel did: a second implementation of "visible tab
 * only, capped concurrent churn, reduced-motion honoured" is how a
 * backgrounded console quietly starts hammering the sidecars again.
 *
 * Arc 4 WP-3 (umbrella #347): registers the rail into the header slot too,
 * same as WorkloadDetail — the route contract puts it here with Operate
 * itself selected (`activeChip: 'operate'`, independent of the workload's
 * actual backend position — see store/headerSlot.ts's own docstring on why
 * those are two different facts) and its five stage entries NAVIGATING
 * rather than locally selecting, since this page mounts no wizard step of
 * its own to select into.
 */

// Mirrors the first four designed states WorkloadDetail.tsx uses for this
// same grouped-inventory read, so a workload that fails to resolve reads
// identically whether the operator is on the flow page or here (Art. 1 —
// two pages disagreeing about "is this workload loaded" would itself be an
// uncertainty the console presented as settled).
export default function WorkloadOperate() {
  const { slug } = useParams<{ slug: string }>()
  const { data, isLoading, error, isError, isFetching } = useMediaWorkloadsGrouped()
  // fix-round 7 (PR #81, umbrella #385, codex call-site sweep): retrofitted
  // onto settleQuery — behavior-preserving (catalogData is only ever read
  // via `.entries` for the display-name lookup below, which already
  // degrades to the function key/instance id on a miss for ANY reason, so
  // there is no absence/count/status claim here for isError to newly gate,
  // same reasoning as Topbar.tsx's breadcrumb name — but the shared
  // primitive is still the shape a new consumer should copy).
  const { data: catalogData } = settleQuery(useCatalog())
  // FIX ROUND (WP-3 spec B gate, P2-3): this page used to build its rail
  // input with only two of the eight WorkloadLifecycleInput fields set —
  // allMembersBootstrapped/anyMemberObservedRunning/membersDataTrustworthy/
  // purgeAuthorized/isPurgeableEntity were all silently absent, which
  // stageActions() reads as false/withheld regardless of what the workload
  // actually is. A purge-eligible, Finalise-open workload on WorkloadDetail
  // could read as Finalise-locked here — two derivations of the SAME
  // workload disagreeing. useCurrentUser() is the identical read
  // WorkloadDetail already holds for the same purpose (umbrella #378b).
  const userQuery = useCurrentUser()
  const [openInstance, setOpenInstance] = useState<MediaWorkloadInstance | null>(null)
  const navigate = useNavigate()

  const visible = useDocumentVisible()
  const reducedMotion = usePrefersReducedMotion()

  // Human names, not catalog slugs — same fallback chain the retired
  // Operate stage panel used:
  // catalog display_name, then the function key, then the instance id, so a
  // catalog miss degrades to something true rather than a blank label.
  //
  // umbrella #401: extends this chain, doesn't replace it — a topology-
  // spawned source (recorded via topology_parent_key/topology_source_id,
  // the launcher's own NetBox tags, read generically in
  // media_workloads.py) renders as its parent entry's topology_source_noun
  // plus its source id, BEFORE the ordinary display_name lookup even runs
  // (an ordinary catalog-key match on its own function_key would never hit
  // anyway — §3.3 forbids a per-source catalog entry). Falls back to the
  // raw function_key when the noun is absent — never FUNCTION_NOUNS or any
  // other hardcoded name.
  const catalogByKey = useMemo(() => {
    const map = new Map<string, CatalogEntry>()
    for (const entry of catalogData?.entries ?? []) map.set(entry.key, entry)
    return map
  }, [catalogData?.entries])
  const nameFor = (i: MediaWorkloadInstance) => {
    if (i.topology_source_id) {
      const parent = i.topology_parent_key ? catalogByKey.get(i.topology_parent_key) : undefined
      return topologySourceLabel(parent?.topology_source_noun, i.function_key ?? i.instance, i.topology_source_id)
    }
    return catalogByKey.get(i.function_key ?? '')?.display_name ?? i.function_key ?? i.instance
  }

  // Arc 4 WP-3 (umbrella #347): the rail is present here too, Operate
  // selected, its five stage entries navigating rather than locally
  // selecting (this page mounts no wizard step of its own). Computed here,
  // ahead of every early return below, and the HOOK CALL is unconditional
  // (useRegisterHeaderSlot must run in the same order every render) —
  // WorkloadDetail.tsx gets to call it deeper in an inner component because
  // ITS early returns all happen in an outer wrapper that owns no hooks of
  // its own (WorkloadWizard simply never mounts on an errored/unconfigured
  // read, so its registration never fires); this page has no such split, so
  // the CONTENT passed to the hook has to carry the gate instead.
  //
  // FIX ROUND (PR #90 review, dmf-cms#391): `hasReadError`/`isUnconfigured`
  // below are the exact two atoms the early returns further down branch on;
  // `readUnusable` is their OR and gates ONLY the rail's registered content
  // (never `workloadForRail` itself — the error/unconfigured PageHeadings
  // below still want the workload's real name over the raw slug when stale
  // data still has one). Before this fix the rail was gated on
  // `workloadForRail` alone, with no reference to either atom: a failed
  // BACKGROUND refetch (React Query retains the prior successful `data`
  // while `error`/`isError` flip non-null — documented behaviour, not an
  // edge case) left the Topbar showing a fully populated, running-count-
  // bearing rail built from stale data while the body said the workload
  // could not be loaded. Because the rail gate and the early returns read
  // the SAME `hasReadError`/`isUnconfigured` variables, the two cannot drift
  // out of step the way two hand-kept-in-sync guards could.
  const hasReadError = error != null
  const isUnconfigured = data != null && !data.configured
  const readUnusable = hasReadError || isUnconfigured

  const workloadForRail = data?.workloads.find((w) => w.slug === slug)
  // Unconditional, ahead of every early return below — same reasoning as
  // the rail registration two comments up (hooks must run every render).
  usePageTitle(workloadForRail ? `${workloadForRail.name} — Operate` : slug)
  // Built through the SAME shared constructor WorkloadDetail.tsx uses —
  // see that file's identical comment on its own `input` for what this
  // fixes and why. No job-state flags: Operate runs no jobs of its own
  // (the file docstring's "WHY IT CARRIES NO ACTION OF ITS OWN").
  // FIX ROUND (P3-5): passes the raw reads through — buildWorkloadLifecycleInput
  // runs isGroupedReadTrustworthy/isPurgeAuthorized internally now, so this
  // call site no longer reduces them to booleans itself (see that
  // constructor's own docstring for why the boolean-shaped seam was the gap).
  const railInput: WorkloadLifecycleInput | null = workloadForRail
    ? buildWorkloadLifecycleInput(workloadForRail, {
        groupedRead: { isError, isFetching, configured: data?.configured, degraded: data?.degraded },
        userRead: {
          isFetching: userQuery.isFetching,
          isError: userQuery.isError,
          role: userQuery.data?.role,
        },
      })
    : null
  useRegisterHeaderSlot(
    !readUnusable && railInput && workloadForRail
      ? {
          slug: workloadForRail.slug,
          rail: buildHeaderSlotRail(classifyWorkloadForHeaderSlot(railInput, workloadForRail.instances), {
            activeChip: 'operate',
            lockedReasons: LOCKED_REASON,
            jobOwnerLabel: null,
            jobInFlight: false,
            // umbrella dmf-cms#391 Pass 1, FIX ROUND (codex gate — P1, the
            // counts): this call site used to compute running/total itself
            // and hand them in here (same gap as WorkloadDetail.tsx's
            // identical block — a caller-supplied count with no formula
            // behind it, forgeable independently of `trustworthy`).
            // Removed entirely: classifyWorkloadForHeaderSlot now takes
            // workloadForRail.instances directly (above) and derives
            // running/total itself, alongside trustworthy, stored together
            // in the TRUST WeakMap — see store/headerSlot.ts's TRUST side
            // table docstring. RailModelExtras no longer has a
            // runningReadout field for this call site to fill in at all.
            onSelect: (step: FlowStepId) =>
              navigate(`/media-workloads/${encodeURIComponent(workloadForRail.slug)}#${step}`),
          }),
        }
      : null,
  )

  if (isLoading) {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        {/* Umbrella #385 finding 5 audit, WP-4 stage 2: this branch had no
            h1 at all — distinct from the !workload branch below, which
            already carries its own visible "Workload not found" heading and
            must not also get this one. Same value usePageTitle above
            already resolved. */}
        <PageHeading>{workloadForRail ? `${workloadForRail.name} — Operate` : slug}</PageHeading>
        <p className="text-muted">Loading workload…</p>
      </div>
    )
  }

  if (hasReadError) {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <PageHeading>{workloadForRail ? `${workloadForRail.name} — Operate` : slug}</PageHeading>
        <div className="panel border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          This workload could not be loaded right now. Retrying automatically.
        </div>
      </div>
    )
  }

  if (isUnconfigured) {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <PageHeading>{workloadForRail ? `${workloadForRail.name} — Operate` : slug}</PageHeading>
        <div className="panel border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          Media Workloads is not configured for this environment.
        </div>
      </div>
    )
  }

  // Same lookup the rail registration above already made — reused, not
  // recomputed, so there is exactly one "which workload is this" answer
  // per render.
  const workload = workloadForRail

  if (!workload) {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <h1 className="text-lg font-semibold text-text">Workload not found</h1>
        <div className="panel mt-4 border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          No workload named &quot;{slug}&quot; is in your scope right now.
        </div>
        <Link to="/media-workloads" className="mt-4 inline-block text-sm text-accent hover:underline">
          ← Back to Media Workloads
        </Link>
      </div>
    )
  }

  const instances = [...workload.instances].sort((a, b) => a.instance.localeCompare(b.instance))

  // Same cap + gating as the retired Operate stage panel: only the first
  // LIVE_TILE_CAP eligible
  // tiles auto-churn, and every tile's polling stops outright while the
  // modal is open (the modal is the one surface allowed the fast cadence).
  const motionTiles = new Set<string>()
  for (const inst of instances) {
    if (inst.live_view && motionTiles.size < LIVE_TILE_CAP) motionTiles.add(inst.instance)
  }
  const tilesActive = visible && openInstance === null

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <PageHeading>{workload.name} — Operate</PageHeading>
      <p className="text-sm text-muted">
        The monitoring surface for this workload — observed running state only. Changes are
        requested at the flow&apos;s own steps, not from here.
      </p>

      <Link
        to={`/media-workloads/${workload.slug}`}
        className="mt-2 inline-block text-sm text-accent hover:underline"
      >
        ← Back to {workload.name}
      </Link>

      {instances.length === 0 ? (
        <div className="panel mt-6 py-10 text-center text-sm text-muted">
          Nothing is running yet for this workload — Operate will show live state once
          Provision and Configure have run.
        </div>
      ) : (
        <>
          {/*
            THE LIVE VIEW doubles as INSTANCE HEALTH: WorkloadTile already
            renders the requested-vs-observed pair (stateBadges.ts palettes
            and titles) beside the preview, and the WO for this page is
            explicit that the two must not be shown twice on one page — a
            second list of the same requested/observed facts would be a
            second, potentially divergent, presentation of a single truth
            (Art. 1's whole complaint). So there is one grid here, not two.
          */}
          <section className="panel mt-6 border border-white/10" aria-label="Live view">
            <div className="border-b border-white/10 px-4 py-3">
              <h2 className="text-base font-semibold">Live view</h2>
            </div>
            <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2 xl:grid-cols-3">
              {instances.map((inst) => (
                <WorkloadTile
                  key={inst.instance}
                  instance={inst}
                  displayName={nameFor(inst)}
                  active={tilesActive}
                  motionAllowed={motionTiles.has(inst.instance) && !reducedMotion}
                  onOpen={setOpenInstance}
                />
              ))}
            </div>
          </section>

          <ActiveSourceSection instances={instances} />
        </>
      )}

      {openInstance && (
        <InstanceLiveModal
          instance={openInstance}
          displayName={nameFor(openInstance)}
          onClose={() => setOpenInstance(null)}
        />
      )}

      {/*
        The one affordance this page offers, and it is a navigation, not a
        write: Operate owns no mutation, so there is nothing here to arm or
        confirm. Copy is held to the register the operator specified —
        "request", "configure-time re-point performed by an automation job"
        — and away from anything that reads as this page controlling the
        flow live (the forbidden-words test in workloadOperate.test.tsx
        pins that this section never regresses into "switch"/"re-route"/
        "cut"/"take"/"live" phrasing).
      */}
      <section
        className="panel mt-6 border border-white/10 p-4 text-sm"
        aria-label="Request a configuration change"
      >
        <h2 className="text-base font-semibold">Request a configuration change</h2>
        <p className="mt-2 text-muted">
          Source selection happens at the Configure step — changing this workload&apos;s
          source is a configure-time re-point performed by an automation job, not
          real-time flow control.
        </p>
        <Link
          to={`/media-workloads/${workload.slug}#configure`}
          className="mt-3 inline-block text-accent hover:underline"
        >
          Go to Configure →
        </Link>
      </section>
    </div>
  )
}

/**
 * ACTIVE SOURCE, for the subset of instances that resolve a topology (the
 * receiver/"viewer" role — most instances are producers with none).
 *
 * The heading and the per-instance rows are gated on the SAME fact: whether
 * any instance in this workload actually has one. Each InstanceActiveSource
 * below decides independently (its own useInstanceTopology call resolves or
 * 404s on its own schedule), so the parent cannot know in advance — it has
 * to be told as each child settles. Rendering the heading unconditionally
 * would produce exactly the "empty box" umbrella #285 rules out for a
 * workload with no viewer at all; gating it on the reported set means the
 * section is simply absent until real data exists for it (Art. 9 — no
 * undesigned blank, but also no designed chrome around an absence).
 */
function ActiveSourceSection({ instances }: { instances: MediaWorkloadInstance[] }) {
  const [hasTopology, setHasTopology] = useState<Record<string, boolean>>({})

  // Same bail-out-to-the-same-object shape as ConfigureStage's
  // setInstancePending: an instance reporting the same answer it already
  // reported must not trigger a re-render, or every 15s inventory poll would
  // re-run this state update for no observable change.
  const reportTopology = useCallback((instance: string, has: boolean) => {
    setHasTopology((prev) => (prev[instance] === has ? prev : { ...prev, [instance]: has }))
  }, [])

  // One row per instance regardless of the outcome below — each keeps
  // running its own useInstanceTopology so a topology that resolves later
  // (or a sibling's that never does) can still flip the wrapper on. The
  // rows themselves are the existing null-if-absent contract; what varies
  // here is only whether they sit inside a labelled panel or bare. The
  // wrapper below reads hasTopology through this same `instances` list —
  // an instance that leaves the inventory takes its vote with it, because
  // nothing prunes hasTopology on unmount and a departed instance's last
  // report is not evidence for a panel that describes the current fleet.
  const rows = instances.map((inst) => (
    <InstanceActiveSource key={inst.instance} instance={inst.instance} onResolved={reportTopology} />
  ))

  if (!instances.some((inst) => hasTopology[inst.instance])) {
    // Nothing resolved yet (most workloads have no receiver at all): no
    // panel, no heading, no empty box — Art. 9 rules out designed chrome
    // around an absence as firmly as it rules out an undesigned blank.
    return <>{rows}</>
  }

  return (
    <section className="panel mt-6 border border-white/10" aria-label="Active source">
      <div className="border-b border-white/10 px-4 py-3">
        <h2 className="text-base font-semibold">Active source</h2>
      </div>
      <div className="p-4 text-sm">{rows}</div>
    </section>
  )
}

/** One instance's row: its declared sources and which one is active. */
function InstanceActiveSource({
  instance,
  onResolved,
}: {
  instance: string
  onResolved: (instance: string, has: boolean) => void
}) {
  const topology = useInstanceTopology(instance)
  const has = !topology.isError && Boolean(topology.data && Array.isArray(topology.data.sources))
  useEffect(() => onResolved(instance, has), [instance, has, onResolved])

  // An instance without a topology renders nothing — not an empty card, not
  // an error: most instances are producers, not receivers, and "no topology"
  // is their normal resting fact, established already by ConfigureStage's
  // switch control (the same null-if-absent contract, reused rather than
  // reinvented here). An errored read is unknown, not absence: a failed
  // refetch can retain the prior successful data while isError flips true,
  // so the row withdraws on error too — the newest read is the one it speaks
  // for.
  if (!has || !topology.data) return null
  const { sources, active_source: activeSource } = topology.data

  return (
    <div className="border-t border-white/5 pt-3 first:border-t-0 first:pt-0">
      <div className="text-xs uppercase tracking-wide text-muted">
        Source · <span className="font-mono normal-case text-muted">{instance}</span>
      </div>
      <div className="mt-1 font-mono text-sm text-text">{activeSource ?? '—'}</div>
      <ul className="mt-1 flex flex-wrap gap-2 text-xs text-muted">
        {sources.map((s) => (
          <li key={s.id} className={s.id === activeSource ? 'text-accent' : ''}>
            {s.id} ({s.pattern})
          </li>
        ))}
      </ul>
    </div>
  )
}
