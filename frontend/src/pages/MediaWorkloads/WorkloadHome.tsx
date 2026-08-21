import { useCallback, useMemo, useState, useEffect } from 'react'
import { Link, Navigate, useNavigate, useParams, useLocation } from 'react-router-dom'
import { useCatalog, useCurrentUser, useMediaWorkloadsGrouped, useInstanceTopology } from '../../api/hooks'
import type { CatalogEntry, MediaWorkloadInstance } from '../../api/types'
import { classifyWorkloadForHeaderSlot, buildHeaderSlotRail, useRegisterHeaderSlot } from '../../store/headerSlot'
import { buildWorkloadLifecycleInput, type WorkloadLifecycleInput } from '../../lib/workloadLifecycle'
import { FLOW_STEPS, classifyHomeState, type FlowStepId } from '../../lib/workloadFlow'
import { workloadSetupPath } from '../../lib/routes'
import { topologySourceLabel } from '../../lib/labels'
import { LOCKED_REASON } from './WorkloadSetup'
import WorkloadTile from './WorkloadTile'
import InstanceLiveModal from './InstanceLiveModal'
import { settleQuery } from '../../lib/queryState'
import { LIVE_TILE_CAP, useDocumentVisible, usePrefersReducedMotion } from './liveView'
import PageHeading from '../../components/PageHeading'
import { usePageTitle } from '../../hooks/usePageTitle'

/**
 * WorkloadHome — the bare workload URL, and the workload's HOME
 * (dmfdeploy#414, operator ruling: "the bare workload URL is the workload's
 * home"). This supersedes the route contract umbrella #285/#347 shipped
 * (Operate on its own `/operate` route, off the flow entirely) and the
 * Glossary entries recording it — see `docs/design/DMF Console Glossary.md`'s
 * wording-pass log for the supersession record.
 *
 * WHY THE INVERSION. The flow used to own the bare slug, with Operate
 * reachable only from a rail link or a body pointer. dmfdeploy#412 found
 * that the flow's own forward affordance never led there at all — pressed
 * once more past Configure, it arrived at Finalise & Review's teardown
 * controls, with no path to the surface that shows the workload actually
 * working. dmfdeploy#414 fixes the information architecture behind that
 * defect rather than patching the symptom again: the ordinary
 * resource-detail convention is bare-slug-is-home, which makes the return
 * path STRUCTURAL — the breadcrumb's workload crumb, the back button,
 * bookmarks and every existing link to the bare slug land here by
 * construction, with no second "where does the live view live" fact to keep
 * in sync anywhere else. The guided flow moved to its own `/setup` route
 * (WorkloadSetup.tsx) instead.
 *
 * THREE HONEST RENDERINGS, NEVER A REDIRECT. lib/workloadFlow.ts's
 * classifyHomeState is the single classifier: 'live' (a trusted read reports
 * the workload operating — renders the live view below, the same content
 * the retired Operate route rendered), 'setup' (a trusted read reports a
 * real workload short of Operate with nothing observed running — the
 * "isn't running yet" cold-entry state, one sentence, one CTA into the
 * guided flow), or 'unresolved' (every other case — loading, errored,
 * stale, degraded, unknown, or genuinely ambiguous — with NO affordance
 * asserting setup is the right next action). This route NEVER redirects on
 * its own account: an unconditional redirect would guess a destination on a
 * read the console cannot yet stand behind, and would make the same
 * bookmark mean two different things depending on timing — exactly what the
 * operator ruling this file implements rules out. The one exception is the
 * LEGACY HASH sweep just below, which is a URL-SHAPE correction, not a
 * guess about workload state.
 *
 * LEGACY HASH REDIRECT (dmfdeploy#414 migration hazard H2). Before this
 * change, `/:slug#configure` and the rail's `/:slug#design` drove stage
 * selection on what was then the flow page. After the inversion those
 * hashes would silently open home and drop the hash entirely — a bookmark
 * or a runbook copy that used to land on a specific step would now land on
 * a different page altogether, with no error to notice it by. Recognised
 * legacy flow hashes (exactly the five FLOW_STEPS ids) are redirected to
 * the equivalent `/setup#<step>` URL; anything else is left alone — an
 * unrecognised hash was never actionable before this change either, and
 * redirecting arbitrary hashes would be a guess this route has no basis
 * for. This check runs unconditionally, ahead of every data-dependent
 * branch below, because it is a pure URL-shape fact, not a workload-state
 * one.
 *
 * WHY IT CARRIES NO ACTION OF ITS OWN (unchanged from the retired Operate
 * route). The EBU coverage matrix marks live Operate-time control as
 * not-implemented, and that is accurate — but the reason is about the KIND
 * of write, not the count. The console has two writes reachable while a
 * workload runs: Configure's switch-source and Finalise & Review's
 * teardown (Finalise stays reachable throughout, because a running workload
 * can always be torn down) — both live on the guided flow, not here.
 * Neither is live flow control: the switch is a configure-time re-point
 * performed by an automation job, and a teardown ends the workload rather
 * than steering it. What is missing is any seam that steers media WHILE it
 * runs, and that is what a control here would need to carry. A control that
 * looked like it re-routed media live would misstate what actually
 * happens — so the one affordance below in the live-view case is a
 * navigation to the real seam, never a mutation.
 *
 * Reuses exactly what the retired Operate STAGE panel (and after it, the
 * retired Operate route) reused — WorkloadTile, InstanceLiveModal, and the
 * liveView.ts polling bounds — for the same reason both did: a second
 * implementation of "visible tab only, capped concurrent churn,
 * reduced-motion honoured" is how a backgrounded console quietly starts
 * hammering the sidecars again.
 *
 * THE RAIL REGISTERS HERE TOO (dmfdeploy#414 point 1: "keep the rail
 * visible at all times"). Its five keys read exactly as they did on the
 * retired Operate route — navigating, never locally selecting, since this
 * page mounts no wizard step of its own — except `activeChip` is `null`
 * rather than `'operate'`: Operate is no longer a rail key for any chip to
 * equal (LifecycleStrip.tsx no longer has a Control group at all — see that
 * file's own docstring), so nothing on the five-key rail reads as selected
 * while the operator is looking at home. `onSelect` now routes through
 * workloadSetupPath (dmfdeploy#414 H3 — the two centralised route helpers)
 * rather than a hand-built `/:slug#<step>` string, which — post-inversion —
 * would silently reopen home instead of the flow (the same H2 hazard the
 * legacy-hash sweep above exists to close, this time for the rail's own
 * link rather than an old bookmark).
 */

// Mirrors the first four designed states WorkloadSetup.tsx uses for this
// same grouped-inventory read, so a workload that fails to resolve reads
// identically whether the operator is on the flow page or here (Art. 1 —
// two pages disagreeing about "is this workload loaded" would itself be an
// uncertainty the console presented as settled).
export default function WorkloadHome() {
  const { slug } = useParams<{ slug: string }>()
  const { hash } = useLocation()
  const { data, isLoading, error, isError, isFetching } = useMediaWorkloadsGrouped()
  const { data: catalogData } = settleQuery(useCatalog())
  const userQuery = useCurrentUser()
  const [openInstance, setOpenInstance] = useState<MediaWorkloadInstance | null>(null)
  // umbrella #432 fix round (item 4): distinct from `openInstance` being
  // null (closed) — true once a settled, trustworthy read has confirmed the
  // instance the operator opened no longer exists. See the reconciliation
  // effect below for when this flips.
  const [openInstanceGone, setOpenInstanceGone] = useState(false)
  const closeModal = useCallback(() => {
    setOpenInstance(null)
    setOpenInstanceGone(false)
  }, [])
  const navigate = useNavigate()

  const visible = useDocumentVisible()
  const reducedMotion = usePrefersReducedMotion()

  // Human names, not catalog slugs — same fallback chain the retired
  // Operate stage panel used: catalog display_name, then the function key,
  // then the instance id, so a catalog miss degrades to something true
  // rather than a blank label. umbrella #401 extends this chain with the
  // topology-spawned-source case (see the original comment history on the
  // retired Operate.tsx for the full account).
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

  const hasReadError = error != null
  // umbrella #432 fix round (item 2): distinct from `hasReadError` alone —
  // TanStack Query retains the prior successful `data` across a BACKGROUND
  // refetch failure (queryState.ts:3-11), so `hasReadError` alone can't tell
  // a first-ever load failure (nothing to show) apart from a later poll
  // failing after the workload already rendered once (plenty to keep
  // showing). Only the former is genuinely unrenderable.
  const firstLoadFailed = hasReadError && data == null
  const isUnconfigured = data != null && !data.configured
  // Still `hasReadError`, not `firstLoadFailed` — the header rail (below)
  // keeps its existing PR #90 behaviour of withdrawing on ANY read error,
  // including a background one, so it never shows a stale running-count
  // built from data the current read no longer vouches for. That is a
  // narrower, stricter surface than the body content below, which item 2
  // now keeps rendering through a background failure.
  const readUnusable = hasReadError || isUnconfigured

  const workloadForRail = data?.workloads.find((w) => w.slug === slug)
  // Unconditional, ahead of every early return below (hooks must run every
  // render) — same reasoning as the rail registration below.
  usePageTitle(workloadForRail ? workloadForRail.name : slug)
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
            activeChip: null,
            lockedReasons: LOCKED_REASON,
            jobOwnerLabel: null,
            jobInFlight: false,
            onSelect: (step: FlowStepId) => navigate(`${workloadSetupPath(workloadForRail.slug)}#${step}`),
          }),
        }
      : null,
  )

  // Hoisted above every early return below for the same hooks-must-run-
  // unconditionally reason as usePageTitle/useRegisterHeaderSlot above: the
  // reconciliation effect right below needs the CURRENT instance list, and
  // an effect cannot sit after a conditional return. Memoised on
  // `workloadForRail`'s own reference (stable across renders that don't
  // change the underlying data — React Query keeps `data` referentially
  // equal while a background poll is in flight) so the effect below doesn't
  // re-run on every unrelated render.
  const instances = useMemo(
    () => [...(workloadForRail?.instances ?? [])].sort((a, b) => a.instance.localeCompare(b.instance)),
    [workloadForRail],
  )

  // umbrella #432 fix round (item 4): openInstance is a ONE-TIME snapshot
  // (set by WorkloadTile's onOpen below) — nothing previously reconciled it
  // against a later read, so a modal opened on an instance that then left
  // the inventory stayed open indefinitely, polling an endpoint that could
  // only 404. This effect is the reconciliation: it runs only when
  // `railInput.membersDataTrustworthy` is true (the STRICT, isFetching-
  // folding formula — never `membersDataRetained`, which is deliberately
  // lenient about an in-flight poll and would reconcile off a read that
  // hasn't actually confirmed anything new). While the read is in flight,
  // degraded, errored, or first-loading, the modal is left exactly as the
  // operator last saw it — there is no fresh truth yet to reconcile against.
  useEffect(() => {
    if (openInstance == null) return
    if (!railInput?.membersDataTrustworthy) return
    const fresh = instances.find((i) => i.instance === openInstance.instance)
    if (fresh) {
      if (fresh !== openInstance) setOpenInstance(fresh)
      setOpenInstanceGone(false)
    } else {
      setOpenInstanceGone(true)
    }
  }, [openInstance, railInput?.membersDataTrustworthy, instances])

  // dmfdeploy#414 H2: a recognised legacy flow-step hash (the five
  // FLOW_STEPS ids, from a pre-inversion `/:slug#<step>` link) redirects to
  // the equivalent setup URL. Any other hash — unrecognised, or none at
  // all — is left exactly alone; this is a URL-shape correction, never a
  // guess. Checked ahead of every data-dependent branch below, because it
  // depends on nothing but the URL itself.
  const requestedStep = hash.replace(/^#/, '')
  if (slug && FLOW_STEPS.includes(requestedStep as FlowStepId)) {
    return <Navigate to={`${workloadSetupPath(slug)}#${requestedStep}`} replace />
  }

  if (isLoading) {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        {/* Umbrella #385 finding 5 audit, WP-4 stage 2: this branch had no
            h1 at all — distinct from the !workload branch below, which
            already carries its own visible "Workload not found" heading and
            must not also get this one. Same value usePageTitle above
            already resolved. */}
        <PageHeading>{workloadForRail ? workloadForRail.name : slug}</PageHeading>
        <p className="text-muted">Loading workload…</p>
      </div>
    )
  }

  // umbrella #432 fix round (item 2): a genuine FIRST load failure — no
  // retained payload exists to fall back on — still gets the bare error
  // page; there is nothing else honest to show. A BACKGROUND refetch
  // failure retains its prior `data` (queryState.ts documents this exact
  // TanStack Query behaviour) and no longer takes this branch — it falls
  // through to the normal render below, which shows the SAME notice text as
  // a conditional sibling alongside the retained grid/modal rather than
  // blanking them (see the `hasReadError` notice further down).
  if (firstLoadFailed) {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <PageHeading>{workloadForRail ? workloadForRail.name : slug}</PageHeading>
        <div className="panel border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          This workload could not be loaded right now. Retrying automatically.
        </div>
      </div>
    )
  }

  if (isUnconfigured) {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <PageHeading>{workloadForRail ? workloadForRail.name : slug}</PageHeading>
        <div className="panel border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          Media Workloads is not configured for this environment.
        </div>
      </div>
    )
  }

  // Same lookup the rail registration above already made — reused, not
  // recomputed, so there is exactly one "which workload is this" answer per
  // render.
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

  // railInput is guaranteed non-null here: `workload` above is
  // `workloadForRail`, the exact condition railInput's own ternary tests.
  const input = railInput as WorkloadLifecycleInput
  const homeState = classifyHomeState(input)
  // Gate round 3 finding: this used to be named/commented as "current
  // confirmed observation", which overclaimed. `homeState === 'live'` is a
  // VALUE, and that value persists through an ordinary in-flight background
  // poll of retained, error-free, non-degraded data — classifyHomeState
  // gates on `membersDataRetained`, not the isFetching-folding
  // `membersDataTrustworthy` (see that module's own docstring, and
  // workloadLifecycle.ts's on the two fields). So `homeStateIsLive` being
  // true does NOT mean "this exact instant was freshly reconfirmed"; it
  // means "the last settled-or-still-in-flight read classifies as live",
  // which is the right thing for the heading (and everything else gated on
  // `homeState === 'live'` below) to keep saying "Live view" through. It
  // only goes false on a GENUINE transition — an error, a degraded payload,
  // an unconfigured environment, or the backend's own position moving —
  // which is exactly when classifyHomeState returns 'unresolved' instead.
  // Used below to decide the section heading's wording alone (item 5, gate
  // round 3): `showLiveGrid` itself widens past 'live' on purpose (see its
  // own comment) and is not driven by this.
  const homeStateIsLive = homeState === 'live'

  // `instances` is now computed once, above every early return (see its own
  // comment up there) — reused here rather than recomputed, so there is
  // exactly one "what does the retained inventory say" answer per render.

  // umbrella #432 §A / fix round item 1. Content persistence, NOT a trust
  // relaxation.
  //
  // classifyHomeState is correct: on a read with no usable retained payload
  // it returns 'unresolved', and no affordance may be offered from that
  // state (Art. 1). What was originally wrong was using that verdict to
  // decide whether observed content RENDERS AT ALL — see workloadFlow.ts's
  // `classifyHomeState` docstring for how #432's fix round stopped an
  // in-flight background poll from being the trigger for that at all.
  //
  // What THIS gate got wrong on the first attempt (fix round item 1): it
  // gated on `instances.length > 0`, which proves MEMBERSHIP, not running.
  // A 'setup' workload's bootstrapped-but-never-started instances satisfy
  // that condition too, so a genuine transition into 'unresolved' (an
  // actual error or degraded read, not merely a poll in flight — see
  // classifyHomeState) rendered a "Live view" section over a workload that
  // had never run. `anyMemberObservedRunning` is the right discriminant: at
  // least one instance the console has actually observed running, which
  // still covers the partial-bring-up case §A requires (lifecycle
  // 'configure' with some-but-not-all instances running classifies as
  // 'unresolved', not 'live' — anyMemberObservedRunning is true there and
  // the tiles are exactly what the operator needs to see).
  //
  // The grid's OWN gate additionally widens to include 'unresolved' (so
  // tiles survive a genuine transition into ambiguity too, not merely
  // in-flight — see anyMemberObservedRunning above); every affordance below
  // stays gated on homeState === 'live' alone, so it correctly withdraws on
  // a GENUINE transition out of 'live' — an error, a degraded payload, the
  // backend's own position moving. Gate round 3 correction: this is NOT the
  // same thing as "claims disappear during an in-flight poll" — homeState
  // itself does not flip for an ordinary background poll of unchanged good
  // data (classifyHomeState reads membersDataRetained, not the
  // isFetching-folding membersDataTrustworthy), so every affordance gated on
  // homeState === 'live' below — the setup CTA, ActiveSourceSection, the
  // Configure link, this heading's wording — persists through that poll
  // exactly as the grid does. What "content persists, claims do not" meant,
  // and still means, is narrower: a claim needs the STATE VALUE to still be
  // 'live'/'setup'; it is not entitled to keep asserting itself once that
  // value has genuinely changed, the way retained CONTENT (the grid) is
  // entitled to keep showing what it last observed even into 'unresolved'.
  const showLiveGrid =
    Boolean(input.anyMemberObservedRunning) && (homeState === 'live' || homeState === 'unresolved')

  // Same cap + gating as the retired Operate stage panel: only the first
  // LIVE_TILE_CAP eligible tiles auto-churn, and every tile's polling stops
  // outright while the modal is open (the modal is the one surface allowed
  // the fast cadence).
  const motionTiles = new Set<string>()
  for (const inst of instances) {
    if (inst.live_view && motionTiles.size < LIVE_TILE_CAP) motionTiles.add(inst.instance)
  }
  const tilesActive = visible && openInstance === null

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <PageHeading>{workload.name}</PageHeading>

      {homeState === 'setup' && (
        // dmfdeploy#414 Addendum 2: cold entry — "a real page identity, one
        // sentence, one CTA to setup", gated on the SAME trusted facts as
        // the rest of the page (classifyHomeState). Copy is lifecycle-aware
        // rather than the issue's single example sentence verbatim: a
        // workload already at `configure` HAS been provisioned, so saying
        // "continue setup to provision it" there would misstate what
        // Provision already did.
        <div className="panel mt-6 border-white/10 px-4 py-6 text-center text-sm">
          <p className="text-text">
            {input.lifecycle === 'provision'
              ? "This workload isn't running yet. Continue setup to provision it."
              : "This workload isn't running yet. Continue setup to finish configuring it."}
          </p>
          <Link to={workloadSetupPath(workload.slug)} className="btn btn-primary btn-sm mt-3 inline-block">
            Continue setup
          </Link>
        </div>
      )}

      {/*
        dmfdeploy#414 Addendum 2 / umbrella #432 fix round item 2: loading and
        a genuine FIRST-load failure are their own branches above (this
        component's own firstLoadFailed/isUnconfigured/isLoading checks) —
        these two notices cover what classifyHomeState alone can tell apart
        once past those: a BACKGROUND refetch that just failed with retained
        data still around (`hasReadError`, specific copy — item 2), or every
        other reason a read cannot be stood behind: a degraded payload, an
        undetermined backend position, or a genuinely ambiguous one (position
        `configure` yet something already observed running — neither
        "nothing running" nor a trusted Operate position). The two are
        mutually exclusive so only one notice ever shows at once. Neither
        carries a CTA — Art. 1: an affordance here would assert a next action
        the console cannot currently stand behind, in either direction.

        Both are NOTICES, not replacements — content persists alongside them
        (see `showLiveGrid`'s own comment for why a poll in flight no longer
        even reaches this branch at all; what still does is a REAL change:
        an actual error, a degraded payload, or the backend's own position
        moving).
      */}
      {hasReadError && (
        <div className="panel mt-6 border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          This workload could not be loaded right now. Retrying automatically.
        </div>
      )}

      {!hasReadError && homeState === 'unresolved' && (
        <div className="panel mt-6 border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          This workload&apos;s status isn&apos;t clear enough right now to recommend a next step.
        </div>
      )}

      {homeState === 'live' && (
        <p className="text-sm text-muted">
          The monitoring surface for this workload — observed running state only. Changes are
          requested at the flow&apos;s own steps, not from here.
        </p>
      )}

      {homeState === 'live' && !input.anyMemberObservedRunning && (
        <div className="panel mt-6 py-10 text-center text-sm text-muted">
          Nothing is currently observed running for this workload.
        </div>
      )}

      {/*
        THE LIVE VIEW doubles as INSTANCE HEALTH: WorkloadTile already
        renders the requested-vs-observed pair (stateBadges.ts palettes and
        titles) beside the preview, and the WO for the retired Operate route
        was explicit that the two must not be shown twice on one page — a
        second list of the same requested/observed facts would be a second,
        potentially divergent, presentation of a single truth (Art. 1's whole
        complaint). So there is one grid here, not two.

        umbrella #432 §A — WHY THIS IS A FIXED SIBLING SLOT AND NOT INSIDE A
        BRANCH. React reconciles a given JSX position by the element type
        that sits there, not by the `homeState` branch that produced it — so
        the ORIGINAL bug was rendering this same subtree from inside two
        different `homeState &&` branches: on a transition between them, the
        `<section>` at 'live's position and the `<section>` at 'unresolved's
        position are, to React, two unrelated elements that happen to look
        alike, so it unmounts one and mounts the other, resetting every
        tile's local state (the preview tick, in-flight queries) even though
        nothing the operator cares about actually changed. Hoisting the
        section to its OWN slot — one `{showLiveGrid && <section>...}`,
        gated on a condition that WIDENS rather than switching branches —
        means the same JSX position renders the same element type on every
        render where it renders at all, so React matches it up and preserves
        the subtree; the notices above are separate, genuinely-conditional
        siblings, and do not affect this slot's identity either way.
        (Fix round: after item 3's fix, `homeState` itself no longer flips on
        an in-flight background poll of unchanged data — see
        classifyHomeState's own docstring — so this slot mechanism now only
        has to survive the transitions that are still real: an error, a
        degraded payload, or the backend's own position moving.)

        `showLiveGrid` deliberately does NOT relax any trust gate. Once
        homeState has genuinely LEFT 'live' — a real error, a degraded
        payload, an undetermined position, or the ambiguous configure-with-
        something-running case, never merely a poll in flight (see
        classifyHomeState's own docstring) — the grid still renders exactly
        what it already had, while ActiveSourceSection's read-only
        source-list content (a CLAIM about the current active source, not an
        affordance — nothing in it is clickable) and every real affordance
        (the Configure link, the setup CTA) stay withheld below, because both
        assert something about the current moment a read that has left
        'live' cannot stand behind.

        GATE ROUND 3 CORRECTION — read this before assuming "claims do not
        persist" applies to an in-flight poll: it does not. `homeState`
        itself stays 'live' through an ordinary background poll of retained,
        error-free, non-degraded data (classifyHomeState gates on
        `membersDataRetained`, not the isFetching-folding
        `membersDataTrustworthy`), so every affordance below — including
        ActiveSourceSection, the Configure link, and homeStateIsLive-driven
        heading wording — persists through that poll exactly as the grid
        does, unchanged. Mechanically re-gating any of them on the strict
        `membersDataTrustworthy` to "be extra safe" would reintroduce the
        exact 15s flicker this whole feature exists to remove — see
        workloadHomeLiveGridPersistence.test.tsx's "claims persist through an
        in-flight poll" coverage, which is a regression test against exactly
        that mistake. "Content persists; claims do not" is true ONLY about a
        GENUINE transition out of 'live' — the grid's widened gate lets it
        keep showing retained content into 'unresolved' where a claim's
        narrower gate does not — never about an in-flight poll that hasn't
        left 'live' at all.
      */}
      {showLiveGrid && (
        <section className="panel mt-6 border border-white/10" aria-label="Live view">
          <div className="border-b border-white/10 px-4 py-3">
            <h2 className="text-base font-semibold">
              {/* umbrella #432 fix round item 5: "Live view" unqualified is
                  false on an unresolved-but-retained read — the tiles below
                  are the last CONFIRMED observation, not a claim about this
                  instant. Same "showing the last reading" register
                  LivePreviewBox.tsx uses per-instance, applied once here at
                  the section level rather than repeated per tile. */}
              {homeStateIsLive ? 'Live view' : 'Live view — showing last known state'}
            </h2>
          </div>
          <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2 xl:grid-cols-3">
            {instances.map((inst) => (
              <WorkloadTile
                key={inst.instance}
                instance={inst}
                displayName={nameFor(inst)}
                active={tilesActive}
                motionAllowed={motionTiles.has(inst.instance) && !reducedMotion}
                onOpen={(selected) => {
                  setOpenInstance(selected)
                  setOpenInstanceGone(false)
                }}
              />
            ))}
          </div>
        </section>
      )}

      {homeState === 'live' && instances.length > 0 && (
        <ActiveSourceSection instances={instances} />
      )}

      {/*
        umbrella #432 §A — the modal is gated on `openInstance` ALONE, not on
        homeState. It was previously a child of the `live` branch, which meant
        a background refetch flipping homeState to 'unresolved' closed a modal
        the operator was actively watching. That is the sharpest form of this
        bug, not a lesser one: the modal polls at MODAL_PREVIEW_TICK_MS and is
        the surface someone is looking at precisely when they care most.
        Dismissal stays the operator's decision, so this slot is fixed too.

        umbrella #432 fix round item 4: `openInstance` is a one-time snapshot
        that nothing used to reconcile — the effect declared near the top of
        this component (see its own comment) keeps it in step with the
        CURRENT inventory once a settled, trustworthy read confirms one, and
        sets `openInstanceGone` rather than silently closing the modal when
        the instance it names has been removed.
      */}
      {openInstance && (
        <InstanceLiveModal
          instance={openInstance}
          displayName={nameFor(openInstance)}
          onClose={closeModal}
          unavailable={openInstanceGone}
        />
      )}

      {homeState === 'live' && (
        <>
          {/*
            The one affordance the live view offers, and it is a navigation,
            not a write — see the file docstring's "WHY IT CARRIES NO ACTION
            OF ITS OWN". Copy is held to the register the operator
            specified — "request", "configure-time re-point performed by an
            automation job" — and away from anything that reads as this page
            controlling the flow live (the forbidden-words test in
            workloadHome.test.tsx pins that this section never regresses into
            "switch"/"re-route"/"cut"/"take"/"live" phrasing).
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
              to={`${workloadSetupPath(workload.slug)}#configure`}
              className="mt-3 inline-block text-accent hover:underline"
            >
              Go to Configure →
            </Link>
          </section>
        </>
      )}
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
