import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { AlertCircle, AlertTriangle, CheckCircle2, HelpCircle, RefreshCw, type LucideIcon } from 'lucide-react'
import { useMediaWorkloadsGrouped } from '../../api/hooks'
import type { MediaWorkload, MediaWorkloadInstance } from '../../api/types'
import { lifecycleBadge, type LifecycleBadge } from '../../lib/workloadFlow'
import { settleQuery } from '../../lib/queryState'
import LivePreviewBox from './LivePreviewBox'
import PageHeading from '../../components/PageHeading'
import Tile from '../../components/Tile'
import Badge, { type BadgeTone } from '../../components/Badge'
import { usePageTitle } from '../../hooks/usePageTitle'
import {
  LIVE_TILE_CAP,
  useDocumentVisible,
  usePrefersReducedMotion,
} from './liveView'

/**
 * Media Workloads (ADR-0037 + ADR-0046) — S1 IA cut (umbrella #285).
 *
 * One square control-surface TILE per workload, opening the workload detail
 * page. The per-instance grid, the live modal and the clear-for-deployment
 * control MOVED onto WorkloadDetail's lifecycle rail. The Grid|Table toggle
 * and its table view were REMOVED outright — not moved, and not reachable
 * anywhere; say removed, because "moved" would send a reader looking.
 *
 * The tile keeps a LIVE PREVIEW. That is not decoration: the preview is what
 * makes this a media-native console rather than an inventory list, and the
 * simplification is not allowed to cost it. Its polling bounds come from
 * LivePreviewBox, which is the SINGLE implementation shared by this tile,
 * the Operate stage and the live modal alike (GATE-S1 P2b — the modal used
 * to run its own unbounded timer): visible-tab only, capped number of
 * concurrently-churning tiles, reduced-motion honoured, fixed aspect box,
 * because a backgrounded console must never hammer the sidecars.
 *
 * What stays, unchanged, is the grouped-inventory HONESTY: not-configured,
 * degraded, and invalid-workload-assignment are still designed states, not a
 * blank page. A tile that renders nothing when the source of truth is
 * unreachable would be a worse lie than the list it replaced.
 *
 * The visual treatment (provider mark, tile faces, colour) is deliberately
 * NOT done here — that is the streamdeck skin pass. This commit is the
 * structure that skin will hang on.
 *
 * ADDENDUM (umbrella #285, operator direction 2026-08-01) adds three things
 * without touching any of the above: the tile's lifecycle badge now renders
 * lib/workloadFlow.ts's resting-grammar participle instead of the raw
 * `provision`/`configure`/`operate`/`unknown` token (see BADGE_GRAMMAR_TONE
 * below for why it never guesses at progress this page cannot observe); a
 * "Create media workload" entry point links out to the draft flow a sibling
 * change builds at /media-workloads/new; and the Unassigned group — defined
 * by ONE thing only, the absence of a workload:<slug> tag, and NOT by
 * anything about runtime — gets a designed explanation of why this console
 * cannot dispose of a record and what does (see UnassignedDisposalNote).
 * Facility-source-of-truth strays (no cluster object at all) are a SUBSET of
 * that group, not a synonym for it: an untagged instance can be running.
 */

/**
 * Badge tone+icon keyed by GRAMMAR, not by the label string (umbrella #285
 * addendum, migrated onto the shared Badge component in WP-4/#347). The tile
 * never sees `in-flight` today — the grouped-inventory payload carries no job
 * overlay — but the map still covers it rather than silently mis-colouring
 * the day a caller adds one, and it costs nothing to keep the three states in
 * one place next to their titles below.
 *
 * Tone/icon reasoning (Art. 11 — colour is never the only signal): `resting`
 * names a COMPLETED step (past participle — see workloadFlow.ts's own
 * RESTING_GRAMMAR docstring), so a checkmark reads correctly as "done".
 * `in-flight` gets a static (non-spinning) refresh glyph for "in motion"
 * without committing to continuous animation. `unknown` gets a plain
 * question mark. `in-flight` and `reconciling` below share the same amber
 * hue they always have, but now carry DIFFERENT icons — before this, the two
 * were visually identical except for label text, which is exactly the
 * ambiguity Art. 11 exists to close.
 */
const BADGE_GRAMMAR_TONE: Record<LifecycleBadge['grammar'], BadgeTone> = {
  resting: 'info',
  'in-flight': 'progress',
  unknown: 'neutral',
}

const BADGE_GRAMMAR_ICON: Record<LifecycleBadge['grammar'], LucideIcon> = {
  resting: CheckCircle2,
  'in-flight': RefreshCw,
  unknown: HelpCircle,
}

/**
 * The explanatory title for the badge, keyed the same way. Spelling out what
 * the participle MEANS matters here specifically because "planned" reads as
 * a plain synonym for "provision" unless the operator knows the grammar is
 * about the step just COMPLETED, not the step the workload is at (see
 * lib/workloadFlow.ts's RESTING_GRAMMAR docstring for the full reasoning).
 */
const BADGE_TITLE: Record<LifecycleBadge['grammar'], (label: string) => string> = {
  resting: (label) => `${label} — the last lifecycle step this workload has completed`,
  'in-flight': (label) => `${label} — this step's job is running right now`,
  unknown: () => 'The backend could not place this workload in the lifecycle yet',
}

/**
 * Reason-token -> operator-language copy (Art. 3: plain words, system jargon
 * hidden at default; Art. 8: what happened, what it means for the facility,
 * what to do next). The degraded banner used to print the raw backend token
 * verbatim ("netbox-not-configured") — a code says none of those three
 * things. The raw token still exists for anyone who wants it, behind a
 * details disclosure below, same convention as this page's own EBU-jargon
 * treatment in Catalog's EntryCard.
 *
 * Shared with Facility Detail's media-workloads count panel (fix-round
 * P2-4) — that panel reads the SAME grouped endpoint and was piping these
 * exact tokens through ITS OWN reason vocabulary (facilityReasonCopy),
 * which does not define them (its nearest entry is the differently-spelled
 * "netbox-unreadable") and so fell through to a generic "this section
 * cannot be read" that named neither the failed source nor gave a next
 * step. One mapper, imported by both call sites, so they can't disagree
 * about what these tokens mean again.
 */
export function degradedReasonCopy(reason: string | undefined): string {
  switch (reason) {
    case 'netbox-not-configured':
      return "The facility inventory system isn't connected in this environment. The console cannot tell you what Media Function instances exist. Ask an administrator to configure the connection."
    case 'netbox-unreachable':
      return "The facility inventory system isn't responding right now. The console cannot tell you what Media Function instances exist. This is usually temporary — retrying automatically. If it continues, contact your systems engineer."
    case 'netbox-error':
      return 'The facility inventory system returned an unexpected error. The console cannot tell you what Media Function instances exist. If this continues, contact your systems engineer.'
    default:
      // Art. 8: an unrecognised/absent token is OUR gap, not the operator's
      // vocabulary — still owes a next step, not just a shrug.
      return 'The facility inventory system could not be read for an unstated reason. The console cannot tell you what Media Function instances exist. If this continues, contact your systems engineer.'
  }
}

/**
 * Reachable-but-incomplete copy for the one `degraded` cause that is NOT a
 * failed read: NetBox answered fine, but one or more instances carry more
 * than one `workload:*` tag and were excluded from every group rather than
 * guessed into one (media_workloads.py's own contract). Distinct from
 * `degradedReasonCopy` above on purpose — conflating "could not read" with
 * "read fine, some rows excluded" would blame the wrong thing (Art. 8: what
 * happened has to be the true cause).
 */
const INCOMPLETE_INVALID_TAGS_COPY =
  'This list is incomplete — every recorded instance has a conflicting workload assignment and none could be grouped here (see Invalid workload assignments below). This is not the same as no instances existing.'

/**
 * The instance whose preview represents the workload on its tile: the first
 * live-view-capable one in deterministic order, so an unchanged poll never
 * swaps which instance the tile is showing.
 */
function representativeInstance(wl: MediaWorkload): MediaWorkloadInstance | null {
  const sorted = [...wl.instances].sort((a, b) => a.instance.localeCompare(b.instance))
  return sorted.find((i) => i.live_view && i.function_key?.startsWith('mxl')) ?? sorted[0] ?? null
}

export default function MediaWorkloads() {
  usePageTitle('Media Workloads')
  // fix-round 6 (PR #81, umbrella #385): retrofitted onto settleQuery — the
  // `isLoading`/`isError` names are kept at the destructure so every branch
  // below reads exactly as it did in fix-round 1-2, only now expressed
  // through the shared primitive.
  const { data, loading: isLoading, failed: isError } = settleQuery(useMediaWorkloadsGrouped())
  const visible = useDocumentVisible()
  const reducedMotion = usePrefersReducedMotion()

  // Deterministic workload order: sorted by slug, unassigned last.
  const workloads = useMemo(() => {
    const wls = data?.workloads ?? []
    return [...wls].sort((a, b) => {
      if (a.slug === 'unassigned') return 1
      if (b.slug === 'unassigned') return -1
      return a.slug.localeCompare(b.slug)
    })
  }, [data?.workloads])

  // The live-tile cap applies across the whole page, exactly as it did for the
  // instance grid: only the first N previews auto-churn, the rest hold a frame.
  const motionTiles = useMemo(() => {
    const set = new Set<string>()
    let n = 0
    for (const wl of workloads) {
      const rep = representativeInstance(wl)
      if (rep?.live_view && n < LIVE_TILE_CAP) {
        set.add(wl.slug)
        n += 1
      }
    }
    return set
  }, [workloads])

  // The 'unassigned' bucket, if the backend produced one this render. Looked
  // up once here rather than inside the JSX below because both the tile grid
  // (unchanged) and the new disposal-explanation panel need to agree on
  // exactly which workload that is.
  const unassignedWorkload = workloads.find((wl) => wl.slug === 'unassigned') ?? null

  // A `reason` token is only ever set on the fail-hard paths (not-configured,
  // unreachable, error) — for the BANNER, which names one specific failed
  // source. The generic `isError` banner just below already covers a failed
  // *console* fetch with its own honest, non-overclaiming text, so this
  // stays reason-scoped rather than duplicating that banner.
  const sourceUnreachable = Boolean(data?.degraded && data?.reason)
  // fix-round P1-1: `degraded` is the COMPLETENESS gate on its own — the
  // OTHER way it can be true, invalid workload:* tags excluding members from
  // `workloads` on an otherwise-successful read, carries no `reason` token
  // but is EQUALLY not evidence of absence (media_workloads.py: excluded,
  // not absent — those instances are real, just unresolvable to one group).
  // `reason` only ever selects WHICH honest explanation to show, never
  // whether one is owed.
  //
  // fix-round P2-3: `isError` extends the same gate to a SETTLED failed
  // refetch. TanStack Query retains the last-good `data` across a failed
  // background refetch, so `data?.degraded` alone would silently fall back
  // to a stale, previously-honest `false` and re-license an absence claim
  // the CURRENT read never established. A settled error always wins here,
  // regardless of what's retained.
  const cannotClaimNone = Boolean(isError || data?.degraded)

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <PageHeading>Media Workloads</PageHeading>
      <div className="flex items-start justify-end gap-4">
        {/* Pulled forward from future scope (umbrella #285 addendum): the
            operator creates a workload by naming a studio and working the
            flow. This is a real route, not a modal — the draft flow itself
            (design/plan/provision) lives on the page this navigates to,
            built by a sibling change; this entry point's whole job is to be
            reachable and honest about where it goes. */}
        <Link to="/media-workloads/new" className="btn btn-primary shrink-0">
          Create media workload
        </Link>
      </div>

      {!isLoading && isError && (
        <div className="panel mt-6 border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          Media Workloads could not be loaded right now. Retrying automatically.
        </div>
      )}

      {!isLoading && data && !data.configured && (
        <div className="panel mt-6 border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          Media Workloads is not configured for this environment (tenancy posture
          undeclared — set <span className="font-mono">DMF_CONSOLE_MEDIA_TENANCY</span>).
        </div>
      )}

      {!isLoading && sourceUnreachable && (!data?.workloads || data.workloads.length === 0) && (
        <div className="panel mt-6 border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          <p>{degradedReasonCopy(data?.reason)}</p>
          <details className="mt-1 text-xs text-amber-200/70">
            <summary className="cursor-pointer select-none opacity-80 hover:opacity-100">
              System details
            </summary>
            <p className="mt-1 pl-4 font-mono">{data?.reason}</p>
          </details>
        </div>
      )}

      {data?.configured && (
        <>
          {Array.isArray(data.scope) && (
            <p className="mt-6 text-xs text-muted">
              Scope: {data.scope.length > 0 ? data.scope.join(', ') : 'none'}
            </p>
          )}

          {workloads.length === 0 ? (
            <div className="panel mt-4 py-10 text-center text-sm text-muted">
              {isError
                ? 'Cannot confirm there are no Media Function instances — the last read attempt failed. Retrying automatically.'
                : sourceUnreachable
                ? 'Cannot confirm there are no Media Function instances — the source of truth is unreachable.'
                : cannotClaimNone
                ? INCOMPLETE_INVALID_TAGS_COPY
                : 'No Media Function instances in your scope.'}
            </div>
          ) : (
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {workloads.map((wl) => (
                <WorkloadEntryTile
                  key={wl.slug}
                  workload={wl}
                  active={visible}
                  motionAllowed={motionTiles.has(wl.slug) && !reducedMotion}
                />
              ))}
            </div>
          )}

          {/* Unassigned-group disposal explanation (umbrella #285 addendum,
              operator direction 2026-08-01: "the honest rendering exists, the
              action does not"). See UnassignedDisposalNote below for why this
              is prose and not a button. */}
          {unassignedWorkload && <UnassignedDisposalNote workload={unassignedWorkload} />}

          {/* Invalid instances section (ADR-0046 §2) */}
          {data.invalid_instances && data.invalid_instances.length > 0 && (
            <div className="panel mt-4 border border-red-500/20 bg-red-500/5">
              <div className="flex items-center gap-3 border-b border-red-500/20 px-4 py-3">
                <h2 className="text-lg font-semibold text-red-300">
                  Invalid workload assignments
                </h2>
                <span className="badge bg-red-500/20 text-xs text-red-300">
                  {data.invalid_instances.length} instance{data.invalid_instances.length !== 1 ? 's' : ''}
                </span>
              </div>
              <div className="p-4 text-sm">
                <p className="text-red-200/80 mb-3">
                  These services have more than one workload:* tag. Each service must
                  belong to exactly one workload. Fix the NetBox tags to resolve.
                </p>
                <ul className="space-y-1 font-mono text-xs">
                  {data.invalid_instances.map((inv) => (
                    <li key={inv.instance} className="text-red-200/70">
                      {inv.instance} ({inv.function_key ?? '?'}): conflicting workloads{' '}
                      {inv.conflicting_workloads.join(', ')}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/* ─── the square entry tile ─── */

function WorkloadEntryTile({
  workload,
  active,
  motionAllowed,
}: {
  workload: MediaWorkload
  active: boolean
  motionAllowed: boolean
}) {
  const rep = representativeInstance(workload)
  // Resting grammar only: the index page's grouped-inventory payload carries
  // no job overlay (launching/switching/tearingDown all live in the flow
  // page's local React state), so lifecycleBadge() always resolves the
  // resting branch here. See the file docstring for why that is a floor, not
  // a gap to fill by promoting reconcile_pending into the progressive form.
  const badge = lifecycleBadge({ lifecycle: workload.lifecycle })
  // A SEPARATE honest marker from the badge above, deliberately. Position
  // and member-convergence are different questions (workloadLifecycle.ts's
  // own distinction between "where it is" and "what it still needs") — this
  // answers "is something here still catching up", and it can be true no
  // matter what the resting badge says, including forever, for a member
  // whose pod will never start.
  const reconciling = workload.instances.some((i) => i.reconcile_pending)

  return (
    // Square control-surface tile, now the shared Tile.tsx container
    // (umbrella #347 Arc 4 WP-4): aspect-square is still the structural
    // commitment the skin pass depends on, owned by Tile's outer div. The
    // primary Link and everything below are unchanged from the pre-refactor
    // single-<Link> shape — Tile just gives a future actions affordance a
    // sibling slot instead of a spot nested inside the anchor.
    <Tile
      to={`/media-workloads/${encodeURIComponent(workload.slug)}`}
      ariaLabel={`Open ${workload.name} workload detail`}
    >
      {rep ? (
        <LivePreviewBox
          instance={rep}
          displayName={workload.name}
          active={active}
          motionAllowed={motionAllowed}
        />
      ) : (
        <div className="flex aspect-video w-full items-center justify-center rounded-md border border-white/10 bg-black/40 text-xs text-muted">
          No instances yet
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="truncate text-base font-semibold capitalize">{workload.name}</h2>
          <Badge
            tone={BADGE_GRAMMAR_TONE[badge.grammar]}
            icon={BADGE_GRAMMAR_ICON[badge.grammar]}
            label={badge.label}
            title={BADGE_TITLE[badge.grammar](badge.label)}
          />
          {workload.health === 'degraded' && <Badge tone="danger" icon={AlertCircle} label="degraded" />}
          {reconciling && (
            <Badge
              tone="warning"
              icon={AlertTriangle}
              label="reconciling"
              title="At least one member's requested and observed state disagree — waiting to converge"
            />
          )}
        </div>

        <p className="mt-auto truncate text-xs text-muted">
          {workload.instances.length} instance{workload.instances.length !== 1 ? 's' : ''}
          {workload.functions.length > 0 && ' · '}
          {workload.functions.map((f) => `${f.function_key}(${f.running}/${f.count})`).join(', ')}
        </p>
      </div>
    </Tile>
  )
}

/* ─── the Unassigned group's disposal explanation ─── */

/**
 * WHY THIS IS PROSE AND NOT A BUTTON (umbrella #285 addendum, operator
 * direction 2026-08-01: "the honest rendering exists, the action does not").
 *
 * The operator asked for a disposal (finalise) affordance on the Unassigned
 * group — instances with no workload:<slug> tag, the live case being a
 * NetBox record with no corresponding cluster object at all (an SoT-only
 * stray, record #17 on the live env). Scouting the backend for a route this
 * could call turned up none, and the absence is not an oversight to route
 * around:
 *
 *   - The console has no NetBox delete seam anywhere. Its one NetBox write is
 *     the lifecycle-tag flip in clear_for_deployment — by design, NetBox is
 *     the facility source of truth and the console does not edit its
 *     inventory, only the intent recorded against a member of it.
 *   - Teardown does not dispose the record either: the mxl role's finalise
 *     stage PATCHes the service back to lifecycle:bootstrapped and clears its
 *     monitoring stamps, deliberately PRESERVING the record and its
 *     workload:* tag. It also requires a running Helm release keyed to a
 *     catalog entry — which an SoT-only stray, having no cluster object, does
 *     not have. (An untagged instance that IS running does have one, and can
 *     be torn down the ordinary way; it is the record that outlives the
 *     teardown, which is the whole point of this note.)
 *   - The one code path that does delete an ipam.Service is dmf-runbooks'
 *     internal launch-rollback, undoing records a FAILED launch had just
 *     created a moment before. It is not operator-invocable, and presenting
 *     it as a general disposal route would be wrong on both counts: it is
 *     not reachable from here, and it is not what this situation needs.
 *
 * So the affordance the operator gets is the true one: a designed
 * explanation of what these entries are, why the console cannot remove them,
 * and what does. Rendering a "Dispose" button that the console cannot honour
 * would be the dead control umbrella #285 exists to eliminate; saying nothing
 * would be the silent version of the same lie.
 */
function UnassignedDisposalNote({ workload }: { workload: MediaWorkload }) {
  const count = workload.instances.length
  // Observed runtime, not requested intent (ADR-0037): only a probe-proven
  // 'running' counts as running, so 'unknown' never reads as idle.
  const noneRunning = workload.instances.every((i) => i.observed_state !== 'running')
  return (
    <div className="panel mt-4 border border-white/10 bg-white/5">
      <div className="border-b border-white/10 px-4 py-3">
        <h2 className="text-lg font-semibold">About the Unassigned group</h2>
      </div>
      <div className="space-y-2 p-4 text-sm text-muted">
        <p>
          {count === 1 ? 'This instance is' : `These ${count} instances are`} recorded
          in the facility source of truth without a workload assignment — no{' '}
          <span className="font-mono">workload:</span> tag naming which workload{' '}
          {count === 1 ? 'it belongs' : 'they belong'} to. That is the only thing this
          group means.
        </p>
        {/* Runtime is a SEPARATE question from assignment, and the two must not
            be welded together (GATE-B). An unassigned member can be running
            perfectly well — it is missing a tag, not a deployment — so the
            has-nothing-running clause is stated only when the members actually
            observe that way, and never as the definition of the group. */}
        <p>
          {noneRunning
            ? `Nothing is observed running for ${count === 1 ? 'it' : 'them'} right now — normal for a while after a teardown, and a leftover if nothing ever ran against ${count === 1 ? 'it' : 'them'} at all.`
            : `Some of what is recorded here is observed running. An unassigned instance is one the source of truth has not filed under a workload; it is not necessarily idle.`}
        </p>
        <p>
          This console cannot remove one of these records. It holds no seam to
          delete a service record from the facility source of truth — by
          design, the console changes what is recorded and what runs against a
          record, never the record's existence.
        </p>
        <p>
          What does remove one: deleting the service record in the facility
          source of truth directly. A teardown will not do this — teardown
          returns a record to recorded-but-not-running, it does not remove it.
        </p>
      </div>
    </div>
  )
}
