import { useEffect, useMemo, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import MediaWorkloads from '../MediaWorkloads'
import Facility from '../Facility'
import type {
  FacilitySummary,
  MediaWorkload,
  MediaWorkloadInstance,
  MediaWorkloadsGroupedResponse,
} from '../../api/types'

/**
 * dmfdeploy/dmfdeploy#498 — the ghost-grid inspection harness. DEV-ONLY,
 * reached through devHarnessRoute.ts's isGhostGridHarnessRoute gate (see
 * that file for why this bypasses App.tsx's auth flow entirely, following
 * pages/Dev/LifecycleRailHarness.tsx's exact precedent).
 *
 * WHY THIS RENDERS THE REAL PAGE COMPONENTS, NOT A STAND-IN. #498's own
 * verification requirement is explicit: jsdom computes no pixels, and the
 * question this harness exists to answer ("does a real render of THIS page
 * scroll, or clip a tile, or read as broken") is about MediaWorkloads.tsx
 * and Facility/index.tsx themselves — their empty-state copy, their real
 * CanvasGrid mount, their real Tile — not a hand-rolled approximation of
 * them. The dev server has no backend, so `window.fetch` is stubbed per
 * specimen with a minimal, real-shaped fixture (the same technique
 * mediaWorkloadsGrid.test.tsx's own mkFetch/mkListFetch already use under
 * Vitest, just installed at runtime in a real browser instead of under a
 * test).
 *
 * WHY THIS DOESN'T STACK EVERY SPECIMEN ON ONE SCROLLABLE PAGE, UNLIKE
 * LifecycleRailHarness/ThrobberHarness. Ghost cells work by measuring the
 * REAL scrolling ancestor's actual clientHeight/scrollHeight
 * (components/CanvasGrid.tsx) — "does adding one more ghost row create a
 * scrollbar" is a question about ONE page's own overflow, not about a
 * stack of unrelated fixtures. Stacking three full-height specimens
 * vertically inside one shared scroll container would answer that question
 * about the STACK, not about any one specimen (the second and third would
 * always measure "no slack left", since the ones above already fill the
 * screen). This harness instead renders exactly ONE specimen at a time,
 * full height — resizing the actual browser window to a target viewport
 * and switching specimens with the buttons below is what actually answers
 * #498's "1280x720 / 1440x900, N tiles, scrollbar or not" questions for
 * real.
 *
 * Record BOTH the browser's viewport size (shown live, top right) AND its
 * zoom level with any screenshot taken here — #498's own verification
 * requirement — zoom is not reliably readable from script, so that part
 * stays a manual note.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/**
 * A minimal, real-shaped instance. `live_view: false` deliberately — see
 * LivePreviewBox.tsx's own `liveEligible` gate: a non-live instance never
 * enables the status query at all, so this fixture needs no
 * `/mxl/status` stub and never starts a polling timer, keeping the
 * harness's stubbed fetch surface to exactly one endpoint.
 */
function fixtureInstance(instance: string): MediaWorkloadInstance & { workload_assignment: string } {
  return {
    instance,
    netbox_id: 1,
    function_key: 'mxl-videotest-view',
    live_view: false,
    requested_state: 'active',
    observed_state: 'running',
    reconcile_pending: false,
    placement: { node: 'node-1', ports: [9000], protocol: 'tcp' },
    workload_assignment: 'ok',
  }
}

function fixtureWorkload(slug: string, name: string, overrides: Partial<MediaWorkload> = {}): MediaWorkload {
  return {
    slug,
    name,
    lifecycle: 'operate',
    health: 'ok',
    instances: [fixtureInstance(`${slug}-a`)],
    functions: [],
    ...overrides,
  }
}

function groupedFetch(workloads: MediaWorkload[]): typeof window.fetch {
  const response: MediaWorkloadsGroupedResponse = {
    configured: true,
    degraded: false,
    scope: [],
    workloads,
    invalid_instances: [],
  }
  return (async (input: RequestInfo | URL) => {
    const url = (typeof input === 'string' ? input : (input as Request).url).toString()
    if (url.endsWith('/api/media-workloads/grouped')) return jsonResponse(response)
    // Anything else (e.g. a stray /api/catalog call from a future edit to
    // the list page) gets a harmless empty object rather than a thrown
    // "unrouted fetch" — this harness is about the ghost grid, not a
    // regression net for every endpoint these pages might ever call.
    return jsonResponse({})
  }) as typeof window.fetch
}

function facilityFetch(summary: FacilitySummary): typeof window.fetch {
  return (async (input: RequestInfo | URL) => {
    const url = (typeof input === 'string' ? input : (input as Request).url).toString()
    if (url.endsWith('/api/facility/summary')) return jsonResponse(summary)
    return jsonResponse({})
  }) as typeof window.fetch
}

interface Specimen {
  id: string
  label: string
  page: 'media-workloads' | 'facilities'
  fetchImpl: typeof window.fetch
}

const TWO_WORKLOADS = groupedFetch([
  fixtureWorkload('studio-a', 'Studio A'),
  fixtureWorkload('studio-b', 'Studio B', { lifecycle: 'configure', health: 'degraded' }),
])

const EIGHT_WORKLOADS = groupedFetch(
  Array.from({ length: 8 }, (_, i) => fixtureWorkload(`studio-${i + 1}`, `Studio ${i + 1}`)),
)

const ZERO_WORKLOADS = groupedFetch([])

const ONE_FACILITY = facilityFetch({
  reason: '',
  site_count: 1,
  device_count: 12,
  sites: [{ name: 'DMF Lab', slug: 'dmf-lab', device_count: 12 }],
})

const SPECIMENS: Specimen[] = [
  {
    id: 'workloads-zero',
    label: '0 workloads — healthy empty (operator ruling: highest-stakes screen)',
    page: 'media-workloads',
    fetchImpl: ZERO_WORKLOADS,
  },
  {
    id: 'workloads-two',
    label: '2 workloads — the named scrollbar check (1280x720 / 1440x900)',
    page: 'media-workloads',
    fetchImpl: TWO_WORKLOADS,
  },
  {
    id: 'workloads-many',
    label: '8 workloads — the long-list check (must scroll, nothing clipped)',
    page: 'media-workloads',
    fetchImpl: EIGHT_WORKLOADS,
  },
  {
    id: 'facilities-one',
    label: 'Facilities — 1 (always exactly one, this console\'s only shape)',
    page: 'facilities',
    fetchImpl: ONE_FACILITY,
  },
]

/**
 * Mounts ONE specimen's real page in its own QueryClient, so switching
 * specimens never shows a stale cached response left over from the
 * previous one. The fetch stub itself is installed by the CALLER
 * (GhostGridHarness, below) before this component's key ever changes — see
 * that component's own docstring for why the swap has to happen there,
 * synchronously in the click handler, rather than in an effect on this
 * component.
 */
function SpecimenStage({ specimen }: { specimen: Specimen }) {
  const queryClient = useMemo(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }), [])

  return (
    <QueryClientProvider client={queryClient}>
      {specimen.page === 'facilities' ? <Facility /> : <MediaWorkloads />}
    </QueryClientProvider>
  )
}

function useViewportSize() {
  const [size, setSize] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }))
  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return size
}

// The default specimen shown on first mount — "two workloads", the
// acceptance criteria's own named hard case.
const DEFAULT_SPECIMEN = SPECIMENS[1]

// The TRUE original `window.fetch`, captured ONCE at module evaluation —
// before this module ever gets a chance to install a specimen stub.
//
// FIX ROUND (dmfdeploy/dmf-cms#126 review): an earlier version captured this
// per-render, inside the component, via a `useRef` written by the same
// `useState` lazy initializer that installs the stub below. That looked
// safe — `useRef` hands back the SAME object on every render of a given
// component instance, so a write from one render is visible to the next —
// but it missed what React StrictMode's double-invoked mount render is FOR:
// it calls a `useState` lazy initializer twice against that same hook
// state specifically to surface non-idempotent side effects like this one.
// Verified empirically (a throwaway probe rendering a minimal component
// under `<React.StrictMode>` and inspecting `useRef` identity across both
// calls): the ref object IS the same instance both times, and `.current`
// from the first call IS visible to the second — so the first call
// correctly captured the real fetch and installed the stub, then the
// SECOND call read `window.fetch` again — already the stub — and
// overwrote the captured "original" with it. Unmount then restored the
// stub permanently. A module-scope capture sidesteps hook/render semantics
// entirely: this line runs exactly once, at import time, before any
// specimen has ever been installed, so there is no second call to race.
const TRUE_ORIGINAL_FETCH = window.fetch

export default function GhostGridHarness() {
  const [activeId, setActiveId] = useState(DEFAULT_SPECIMEN.id)
  const specimen = SPECIMENS.find((s) => s.id === activeId) ?? SPECIMENS[0]
  const { w, h } = useViewportSize()

  // Installed synchronously during THIS component's first render — before
  // ANY descendant (SpecimenStage, and inside it MediaWorkloads/Facility)
  // even exists, let alone mounts its own effects. A `useEffect` here would
  // be too late: a mounting CHILD's effects — react-query's own
  // fetch-triggering effect among them — fire BEFORE their PARENT's, so a
  // stub installed in an ordinary effect on this component would lose that
  // race and let the child's first fetch reach the real, backend-less dev
  // server. The lazy `useState` initializer instead runs synchronously,
  // top-down, as part of calling this function component — closing the
  // race entirely. (React StrictMode, which main.tsx enables, invokes this
  // initializer twice on mount — see `TRUE_ORIGINAL_FETCH` above for why the
  // original is captured at module scope rather than here.) `window.fetch`
  // is restored once, on this component's own unmount (navigating away from
  // the dev route entirely) — never per specimen switch, see
  // `selectSpecimen` below for why that would be the wrong place for it.
  useState(() => {
    window.fetch = DEFAULT_SPECIMEN.fetchImpl
    return null
  })
  // Reinstalls the stub on setup, not just the lazy initializer above. Needed
  // because this effect's cleanup unconditionally restores the true fetch —
  // and React StrictMode simulates a full unmount+remount of every effect
  // right after the real mount commits. Without a setup body here, that
  // simulated cycle would fire this cleanup (wiping the stub back to the
  // true fetch) and then re-run setup with nothing to reinstall it, leaving
  // the REAL fetch in place for the rest of the mounted session — exactly
  // the kind of gap the empty-bodied version of this effect had, previously
  // hidden by the `TRUE_ORIGINAL_FETCH` capture bug fixed above (that bug
  // made the old cleanup's "restore" a no-op, since it was restoring the
  // stub to itself). The reassignment here is otherwise harmless on the
  // real first mount, where `window.fetch` is already this same stub.
  useEffect(() => {
    window.fetch = DEFAULT_SPECIMEN.fetchImpl
    return () => {
      window.fetch = TRUE_ORIGINAL_FETCH
    }
  }, [])

  /**
   * Switching specimens remounts the whole SpecimenStage subtree below
   * (`key={specimen.id}`) — a FRESH MediaWorkloads/Facility instance mounts
   * and fires its own fetch-triggering effect all over again. Reassigning
   * `window.fetch` HERE, synchronously inside the click handler, BEFORE
   * calling `setActiveId`, guarantees it is already correct before React
   * even starts that update's render/commit/effects — no ordering to
   * reason about at all.
   *
   * FIX ROUND (found by this file's own end-to-end test): an earlier
   * version left this swap to a `useState` lazy initializer + `useEffect`
   * cleanup pair ON SpecimenStage itself, one instance per specimen — but
   * the OLD instance's cleanup (restoring what IT captured as "original")
   * runs in the COMMIT phase, which happens AFTER the NEW instance's render
   * phase (where its own lazy initializer already reassigned
   * `window.fetch`) — so the old instance's restore fired LAST and clobbered
   * the new specimen's stub with something stale. Doing the swap here,
   * synchronously and only once per switch, has no such ordering to get
   * wrong.
   */
  function selectSpecimen(next: Specimen) {
    window.fetch = next.fetchImpl
    setActiveId(next.id)
  }

  return (
    <div data-testid="ghost-grid-harness" className="flex h-screen flex-col bg-bg text-text">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-panel px-4 py-2 text-xs">
        <span className="font-semibold text-muted">Ghost grid harness — dmfdeploy/dmfdeploy#498</span>
        {SPECIMENS.map((s) => (
          <button
            key={s.id}
            type="button"
            data-testid={`ghost-grid-specimen-button-${s.id}`}
            onClick={() => selectSpecimen(s)}
            className={
              s.id === activeId
                ? 'rounded bg-accent px-2 py-1 text-bg'
                : 'rounded bg-white/5 px-2 py-1 text-muted hover:bg-white/10'
            }
          >
            {s.label}
          </button>
        ))}
        <span className="ml-auto font-mono text-muted" data-testid="ghost-grid-viewport-size">
          {w}×{h} CSS px — record browser zoom separately, it isn&apos;t script-readable
        </span>
      </div>
      <SpecimenStage key={specimen.id} specimen={specimen} />
    </div>
  )
}
