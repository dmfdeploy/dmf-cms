/**
 * Arc 4 WP-3 spec B: Provision's Deploy control promotes into the header
 * row ONLY when exactly one catalog entry is eligible at runtime — never
 * from counting `.btn-primary` in source, which two eligible entries would
 * already disprove (both would render one). An App/Shell integration test
 * on purpose (same reasoning as railRouteContract.test.tsx): the promotion
 * mechanism is a portal from a stage component into a DOM node Topbar
 * publishes (store/headerActionSlot.ts) — a WorkloadDetail-only render
 * (workloadDetailStageWedge.test.tsx and friends) never mounts Topbar, so
 * the portal target never exists there and every one of THOSE tests
 * exercises PromotedAction's inline fallback instead, unchanged. This file
 * is what actually proves the promoted path.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import App from '../App'
import ProvisionStage from '../pages/MediaWorkloads/stages/ProvisionStage'
import { useSetHeaderActionSlotNode } from '../store/headerActionSlot'
import { useTopbarMessageStore } from '../store/topbarMessage'
import type { StageActionId } from '../lib/workloadLifecycle'
import type { CatalogEntry, MediaWorkload, MediaWorkloadsGroupedResponse, UserIdentity } from '../api/types'

function identity(overrides: Partial<UserIdentity> = {}): UserIdentity {
  return {
    subject: 'ops',
    display_name: 'Ops',
    email: 'ops@dmf.example.com',
    role: 'engineer',
    real_role: 'engineer',
    view_as_active: false,
    groups: [],
    awx_configured: true,
    authentik_configured: true,
    ...overrides,
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function catalogEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    key: 'crosspoint',
    display_name: 'MXL Crosspoint',
    summary: 'Routes media flows between sources and viewers.',
    ebu_layer: null,
    ebu_vertical: null,
    ebu_media_function_type: null,
    ebu_lifecycle_owner: null,
    lifecycle: 'bootstrapped',
    provision_image: null,
    provision_netbox_service: null,
    configure_awx_job_template: 'deploy-crosspoint',
    finalise_awx_job_template: 'teardown-crosspoint',
    dependencies: [],
    ingress_url: null,
    ...overrides,
  }
}

function workload(functionKeys: string[] = ['crosspoint']): MediaWorkload {
  return {
    slug: 'studio-a',
    name: 'studio-a',
    lifecycle: 'provision',
    health: 'ok',
    instances: [],
    functions: functionKeys.map((function_key) => ({
      function_key,
      count: 0,
      running: 0,
      reconcile_pending: 0,
    })),
  }
}

function stubFetch(entries: CatalogEntry[], deployHandler?: () => Response | Promise<Response>) {
  const grouped: MediaWorkloadsGroupedResponse = {
    configured: true,
    degraded: false,
    scope: [],
    // Every entry passed in must be one of the workload's OWN functions —
    // ProvisionStage joins catalog entries through functionKeys, exactly as
    // production does, so a two-entry eligibility test needs a two-function
    // workload or the second entry is silently filtered out before it ever
    // reaches the eligibility count.
    workloads: [workload(entries.map((e) => e.key))],
    invalid_instances: [],
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = (typeof input === 'string' ? input : (input as Request).url).toString()
      if (url.endsWith('/api/me')) return json(identity())
      if (url.endsWith('/api/media-workloads/grouped')) return json(grouped)
      if (url.endsWith('/api/catalog')) return json({ entries })
      if (url.endsWith('/api/facility/summary')) return json({ site_count: 0, device_count: 0, sites: [] })
      if (url.match(/\/api\/catalog\/crosspoint\/deploy$/) && deployHandler) return deployHandler()
      return json({})
    }),
  )
}

function renderAppAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function headerRow(): HTMLElement {
  return screen.getByTestId('header-slot-row')
}

function provisionSection(): HTMLElement {
  return screen.getByRole('heading', { name: 'Provision', level: 2 }).closest('[data-step-state]') as HTMLElement
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  useTopbarMessageStore.setState({ message: null })
})

describe('exactly one eligible deploy entry promotes into the header', () => {
  it('mounts the Deploy button in the header row, and the body says where it went', async () => {
    stubFetch([catalogEntry()])
    renderAppAt('/media-workloads/studio-a')

    await screen.findByRole('navigation', { name: 'Media workload lifecycle' })
    const provision = provisionSection()

    // The button is NOT inline in the body...
    await waitFor(() => {
      expect(within(provision).queryByRole('button', { name: /Deploy/ })).toBeNull()
    })
    expect(within(provision).getByText(/Deploy is available from the header above/)).toBeTruthy()

    // ...it's in the header row instead, styled with the same primary
    // (cyan) accent class every other primary control in this console uses.
    const headerDeploy = within(headerRow()).getByRole('button', { name: /Deploy/ })
    expect(headerDeploy.className).toContain('btn-primary')
  })
})

describe('two eligible deploy entries: neither promotes', () => {
  it('renders both Deploy buttons inline, and the header carries no Deploy button', async () => {
    stubFetch([catalogEntry(), catalogEntry({ key: 'viewer', display_name: 'MXL Viewer' })])
    renderAppAt('/media-workloads/studio-a')

    await screen.findByRole('navigation', { name: 'Media workload lifecycle' })
    const provision = provisionSection()

    const inlineButtons = await within(provision).findAllByRole('button', { name: /Deploy/ })
    expect(inlineButtons).toHaveLength(2)
    expect(within(provision).queryByText(/available from the header above/)).toBeNull()
    expect(within(headerRow()).queryByRole('button', { name: /Deploy/ })).toBeNull()
  })
})

describe('the promoted control carries the WHOLE loop, including persistent failure', () => {
  it('arms, confirms, and keeps a refused deploy legible in the header popover past the transient echo', async () => {
    stubFetch([catalogEntry()], () => json({ error: 'reason-required' }, 400))
    renderAppAt('/media-workloads/studio-a')

    await screen.findByRole('navigation', { name: 'Media workload lifecycle' })
    const header = headerRow()

    fireEvent.click(await within(header).findByRole('button', { name: /Deploy/ }))
    const reasonBox = await within(header).findByPlaceholderText(/Reason \(required/)
    fireEvent.change(reasonBox, { target: { value: 'scheduled' } })
    fireEvent.click(within(header).getByRole('button', { name: 'Confirm deploy' }))

    // The failure renders IN THE HEADER — the point of the action — not
    // just in the body, and not only in the topbar's transient echo.
    expect(await within(header).findByText(/nothing was changed/)).toBeTruthy()
    expect(within(header).getByRole('button', { name: 'Confirm deploy' })).toBeTruthy()

    // The topbar's own transient echo is a separate, self-expiring surface
    // (store/topbarMessage.ts) — simulating its expiry must not touch the
    // header popover's own persistent error.
    act(() => {
      useTopbarMessageStore.setState({ message: null })
    })
    expect(within(header).getByText(/nothing was changed/)).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// FIX ROUND (gate CHANGES-NEEDED, P1): the promoted panel was invisible when
// armed and fell back into the page body while pending. Two distinct bugs,
// two distinct tests below.
// ---------------------------------------------------------------------------

describe('FIX ROUND P1b: the promoted control stays in the header WHILE the write is pending', () => {
  it('does not fall back into the page body between Confirm and the mutation settling', async () => {
    // A HELD promise, not a same-tick rejection: the earlier version of
    // this suite's "carries the WHOLE loop" test above used a deploy
    // handler that rejects essentially synchronously, so by the time its
    // `await within(header).findByText(...)` ran, `busy` had already
    // flipped back to false and the panel had already re-settled into the
    // header on its own — the test never actually observed the PENDING
    // window where eligibleDeployEntries computes to [] purely because
    // THIS entry's own onJobStart just fired. Gating the response open is
    // what makes "still pending" an OBSERVED state rather than a timing
    // accident this suite was accidentally too fast to catch.
    let releaseDeploy: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      releaseDeploy = resolve
    })
    stubFetch([catalogEntry()], async () => {
      await gate
      return json({ error: 'reason-required' }, 400)
    })
    renderAppAt('/media-workloads/studio-a')

    await screen.findByRole('navigation', { name: 'Media workload lifecycle' })
    const header = headerRow()

    fireEvent.click(await within(header).findByRole('button', { name: /Deploy/ }))
    const reasonBox = await within(header).findByPlaceholderText(/Reason \(required/)
    fireEvent.change(reasonBox, { target: { value: 'scheduled' } })
    fireEvent.click(within(header).getByRole('button', { name: 'Confirm deploy' }))

    // Mid-flight: the mutation is deliberately held open, so `busy` is true
    // right now purely because of THIS entry's own deploy — not a
    // different entry's, not clear-for-deployment's. The panel (and its
    // Confirm button, now showing the pending label) must still be inside
    // the header, and must NOT have re-appeared in the page body.
    await waitFor(() => {
      expect(within(header).getByRole('button', { name: 'Launching…' })).toBeTruthy()
    })
    const provision = provisionSection()
    expect(within(provision).queryByPlaceholderText(/Reason \(required/)).toBeNull()
    expect(within(provision).queryByRole('button', { name: 'Launching…' })).toBeNull()

    // And it settles cleanly: the latch releases once the write is no
    // longer this entry's own pending mutation, and the (now failed, per
    // B2) outcome still renders in the SAME header popover.
    releaseDeploy!()
    await waitFor(() => expect(within(header).getByText(/nothing was changed/)).toBeTruthy())
  })
})

describe('FIX ROUND P1a: the armed panel is anchored to stay inside the viewport', () => {
  it('positions relative to the header row, not to its own mount span (which collapses to zero width when its only child is the out-of-flow panel)', async () => {
    stubFetch([catalogEntry()])
    renderAppAt('/media-workloads/studio-a')

    await screen.findByRole('navigation', { name: 'Media workload lifecycle' })
    const header = headerRow()

    // jsdom does not compute real layout, so this cannot assert an actual
    // bounding box — see the fix commit message for a real-browser
    // (dev-login seam) geometry check confirming the on-screen result.
    // What jsdom CAN prove, and what the actual bug was: the panel's
    // POSITIONING ANCESTOR. `right-4`/`top-full` are meaningless unless
    // resolved against a containing block with real width — that has to be
    // the row itself (`relative` here now), not the tiny mount span (which
    // must NOT be `relative`, or the panel would silently re-adopt it as
    // its containing block again).
    expect(header.className).toContain('relative')

    fireEvent.click(await within(header).findByRole('button', { name: /Deploy/ }))
    const panel = (await within(header).findByPlaceholderText(/Reason \(required/)).closest(
      'div.absolute',
    ) as HTMLElement
    expect(panel, 'the armed panel must be the element carrying the positioning classes').toBeTruthy()
    expect(panel.className).toContain('right-4')
    expect(panel.className).not.toContain('left-0')

    // The mount span itself — the panel's DOM parent — must not carry its
    // own `relative`, or CSS would resolve `right-4` against ITS box
    // (collapsed to ~0 width) instead of the row's.
    const mountSpan = panel.parentElement as HTMLElement
    expect(mountSpan.className).not.toContain('relative')
  })
})

// ---------------------------------------------------------------------------
// FIX ROUND (P3 round 3, P2-3 — two independent reviewers, same lines): the
// P1b latch above only covers the PENDING window. On REJECTION,
// deployMutation.isPending flips false in ProvisionStage's own render
// before WorkloadDetail (the parent) has re-derived its `actions` prop to
// include 'deploy' again — that only happens once ProvisionStage's own
// passive onBusyChange effect fires and the parent re-renders, one commit
// later. In the render between those two things, the P1b-only latch
// (keyed to isPending alone) has already released, so the still-armed,
// now-erroring panel falls back to the page body for exactly that one
// committed render before snapping back once the parent catches up.
//
// Racing a real WorkloadDetail for that one-commit window would mean
// racing `waitFor`'s poll against a transient frame it could step right
// over — not a reliable regression guard. This drives ProvisionStage
// directly instead, with a controlled `actions` prop whose `onBusyChange`
// deliberately never feeds back into it: the parent's busy-clear simply
// never arrives. That turns the one-commit race into a PERSISTENT,
// deterministic condition — if the fix still depends on the parent
// catching up, this never recovers, no timing required.
// ---------------------------------------------------------------------------

function ActionSlotProbe() {
  const setNode = useSetHeaderActionSlotNode()
  return <span data-testid="action-slot" ref={setNode} />
}

function ProvisionStageHarness({ workload }: { workload: MediaWorkload }) {
  const [actions, setActions] = useState<StageActionId[]>(['deploy'])
  return (
    <ProvisionStage
      workload={workload}
      state="available"
      actions={actions}
      // Deliberately a no-op — see the block comment above. A real
      // WorkloadDetail eventually calls back with `false` and recomputes
      // `actions` to include 'deploy' again; this harness models that
      // catch-up NEVER happening.
      onBusyChange={() => {}}
      onJobStart={() => setActions((prev) => prev.filter((a) => a !== 'deploy'))}
    />
  )
}

describe('FIX ROUND P2-3: the promoted panel stays in the header through a settled rejection, not just the pending window', () => {
  it('does not fall back to the page body once the deploy mutation settles to an error, even while the parent still withholds \'deploy\' from actions', async () => {
    stubFetch([catalogEntry()], () => json({ error: 'reason-required' }, 400))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ProvisionStageHarness workload={workload(['crosspoint'])} />
          <ActionSlotProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    )

    const slot = screen.getByTestId('action-slot')
    fireEvent.click(await within(slot).findByRole('button', { name: /Deploy/ }))
    const reasonBox = await within(slot).findByPlaceholderText(/Reason \(required/)
    fireEvent.change(reasonBox, { target: { value: 'scheduled' } })
    fireEvent.click(within(slot).getByRole('button', { name: 'Confirm deploy' }))

    // The rejection settles — deployMutation.isPending goes false — while
    // `actions` (this harness's stand-in for the parent) never adds
    // 'deploy' back. The P1b-only latch, keyed to isPending alone, has
    // nothing left to hold onto at this point; the fix must still hold the
    // panel here.
    expect(await within(slot).findByText(/nothing was changed/)).toBeTruthy()
    expect(within(slot).getByRole('button', { name: 'Confirm deploy' })).toBeTruthy()

    // And not ALSO duplicated inline in the body — the panel has exactly
    // one home at a time (this harness renders ProvisionStage directly, not
    // through the wizard's FlowStep wrapper, so there is no separate
    // step-card element to scope into — a document-wide count is the
    // right check here).
    expect(screen.getAllByPlaceholderText(/Reason \(required/)).toHaveLength(1)
  })
})
