/**
 * dmfdeploy/dmfdeploy#411, the path that was never covered: the console
 * persists a clear response's `reconcile.expectation` verbatim into its own
 * Activity audit record (store/activity.ts) and renders it in the History
 * lane — across reloads, since the store is localStorage-backed. The old
 * string told the operator "the platform's automation lane converges it";
 * no such lane exists. This drives the REAL click path — WorkloadDetail's
 * Provision stage, mocked at the HTTP boundary with the exact JSON shape
 * the fixed backend now returns (pinned in test_media_workloads.py's
 * test_clear_reconcile_expectation_names_no_nonexistent_actor) — through to
 * a separately rendered History lane, exactly as an operator would
 * experience it (click now, read Activity later). Neither
 * ClearForDeployment.tsx's own copy pin nor the backend's own string pin
 * would have caught a defect in the wiring BETWEEN them; this is that seam.
 *
 * fix-round 1 (dmfdeploy/dmfdeploy#411 gate): the first version of this test
 * only unmounted-and-remounted a React tree, never touching localStorage or
 * the in-memory zustand singleton, while its own prose claimed "a fresh page
 * load" — it wasn't one. This version forces the store's REAL
 * `persist.rehydrate()` — the exact read (storage.getItem -> JSON.parse ->
 * merge -> set) a real page load runs on store creation — so a write-time
 * serialization bug or a read-time merge bug would surface here even though
 * memory, populated straight from the mutation's own response object, never
 * touched either path (see the in-test comment for why this doesn't need to
 * wipe memory first: this project's persist wrapper re-persists on every
 * `setState`, which defeated the first attempt at that). It also now
 * asserts on actor/role, not just reconcile_expectation, since the record's
 * whole point is C5 accountability, not only honest copy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import WorkloadDetail from '../pages/MediaWorkloads/WorkloadDetail'
import HistoryLane from '../pages/Activity/HistoryLane'
import HeaderSlotProbe from './testUtils/HeaderSlotProbe'
import { useActivityStore } from '../store/activity'
import type { CatalogEntry, MediaWorkload, MediaWorkloadsGroupedResponse } from '../api/types'

// The exact string the fixed backend returns — kept identical to the pytest
// pin so a drift between the two shows up as a failure on at least one
// side, not a silent divergence.
const HONEST_EXPECTATION =
  "Desired state recorded in the facility source of truth. It shows as pending reconciliation until something deploys it — today, that's Provision."

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function bootstrappedWorkload(): MediaWorkload {
  return {
    slug: 'studio-a',
    name: 'studio-a',
    lifecycle: 'provision',
    health: 'ok',
    instances: [
      {
        instance: 'crosspoint-1',
        netbox_id: 1,
        function_key: 'crosspoint',
        requested_state: 'bootstrapped',
        observed_state: 'unknown',
        reconcile_pending: false,
        placement: { node: 'node-1', ports: [], protocol: null },
        workload_assignment: 'ok',
      },
    ],
    functions: [{ function_key: 'crosspoint', count: 1, running: 0, reconcile_pending: 0 }],
  }
}

function catalogEntry(): CatalogEntry {
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
  }
}

function mkFetch() {
  const grouped: MediaWorkloadsGroupedResponse = {
    configured: true,
    degraded: false,
    scope: [],
    workloads: [bootstrappedWorkload()],
    invalid_instances: [],
  }
  const clearCalls: Array<{ init?: RequestInit }> = []

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = (typeof input === 'string' ? input : (input as Request).url).toString()
      if (url.endsWith('/api/me')) {
        return json({
          subject: 'ops',
          display_name: 'Ops',
          email: 'ops@dmf.example.com',
          role: 'engineer',
          real_role: 'engineer',
          view_as_active: false,
          groups: [],
          awx_configured: true,
          authentik_configured: true,
        })
      }
      if (url.endsWith('/api/catalog')) return json({ entries: [catalogEntry()] })
      if (url.endsWith('/api/media-workloads/grouped')) return json(grouped)
      if (url.match(/\/api\/media-workloads\/[^/]+\/clear$/)) {
        clearCalls.push({ init })
        // The real backend's post-fix contract, verbatim.
        return json({
          instance: 'crosspoint-1',
          requested_state: 'active',
          previous_state: 'bootstrapped',
          request_id: 'req-411-e2e',
          actor: 'ops',
          role: 'engineer',
          reason: 'ready for demo',
          reconcile: { expectation: HONEST_EXPECTATION, watch: '/api/media-workloads' },
        })
      }
      return json({})
    }),
  )
  return { clearCalls }
}

function renderDetail() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/media-workloads/studio-a']}>
        <Routes>
          <Route path="/media-workloads/:slug" element={<WorkloadDetail />} />
        </Routes>
        <HeaderSlotProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function renderHistory() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <HistoryLane />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  window.localStorage.clear()
  useActivityStore.setState({ records: [] })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Clear for deployment -> Activity: the audit record is honest end to end', () => {
  it('a real clear response round-trips through localStorage rehydration with the honest actor + expectation intact', async () => {
    const { clearCalls } = mkFetch()
    renderDetail()

    const provision = await screen.findByRole('heading', { name: 'Provision', level: 2 })
    const provisionSection = provision.closest('[data-step-state]') as HTMLElement

    fireEvent.click(await within(provisionSection).findByRole('button', { name: 'Clear for deployment' }))
    fireEvent.change(within(provisionSection).getByPlaceholderText(/Reason \(required/), {
      target: { value: 'ready for demo' },
    })
    fireEvent.click(within(provisionSection).getByRole('button', { name: 'Confirm' }))

    await waitFor(() => expect(clearCalls).toHaveLength(1))

    // The in-memory store now holds exactly what the backend said — not a
    // locally-fabricated summary of it — including the C5 actor/role the
    // record exists to make accountable, not just the copy.
    await waitFor(() => {
      const record = useActivityStore.getState().records.find((r) => r.request_id === 'req-411-e2e')
      expect(record).toMatchObject({
        actor: 'ops',
        role: 'engineer',
        reason: 'ready for demo',
        reconcile_expectation: HONEST_EXPECTATION,
      })
    })
    // localStorage got the same write — the persist middleware's real
    // serialization, not an assumption that it matches memory.
    const persisted = JSON.parse(window.localStorage.getItem('dmf-console-activity') as string)
    const persistedRecord = persisted.state.records.find(
      (r: { request_id: string }) => r.request_id === 'req-411-e2e',
    )
    expect(persistedRecord.reconcile_expectation).toBe(HONEST_EXPECTATION)
    expect(persistedRecord.actor).toBe('ops')

    // Force the SAME read `persist.rehydrate()` performs on every real page
    // load — proving the READ path independently of the write path already
    // having populated memory. (An earlier version of this test tried to
    // first wipe memory via `setState({records: []})` to "simulate the tab
    // closing" — but this project's persist wrapper re-persists on EVERY
    // setState call (`api.setState` is wrapped to call `setItem()`
    // unconditionally), so that wipe silently emptied localStorage too,
    // and the "rehydrate" that followed just read back the empty state it
    // had itself written a moment earlier. There is no store API that
    // clears memory without also re-persisting the clear.) This relies
    // instead on what the default `merge` actually does —
    // `{...currentState, ...persistedState}` — so whatever key IS present
    // in the parsed JSON always wins over whatever memory already held,
    // regardless of memory's prior state. A bug in the write-time
    // serialization (e.g. `JSON.stringify` silently dropping a field) or
    // the read-time parse/merge would surface here even though memory,
    // populated straight from the mutation's own response object, never
    // touched either.
    await useActivityStore.persist.rehydrate()
    const rehydrated = useActivityStore.getState().records.find((r) => r.request_id === 'req-411-e2e')
    expect(rehydrated).toMatchObject({
      actor: 'ops',
      role: 'engineer',
      reconcile_expectation: HONEST_EXPECTATION,
    })

    // Now read it back the way an operator actually would, from the
    // rehydrated store: navigate away, open Activity.
    cleanup()
    renderHistory()

    expect(await screen.findByText(HONEST_EXPECTATION)).toBeTruthy()
    expect(screen.queryByText(/automation lane/i)).toBeNull()
  })
})
