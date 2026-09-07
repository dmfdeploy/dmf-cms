/**
 * dmfdeploy/dmfdeploy#555: Workspace's Activity panel folds its three
 * explanatory header paragraphs behind a closed native <details> whose
 * <summary> is the ⓘ icon with a visually-hidden accessible name — while
 * Activity → History renders the SAME component with the same paragraphs
 * inline. Both sites render one shared fragment, so the text is byte-for-
 * byte identical; only its disclosure differs. These two tests are the
 * discriminator between the render sites: mutate Workspace's
 * `explainer="disclosure"` away and (a) fails; force History onto the
 * disclosure and (b) fails.
 *
 * Honest limit: jsdom applies no user-agent stylesheet to a closed
 * <details>, so "hidden" cannot be observed as a pixel or as an
 * accessibility-tree exclusion here — the structural facts (inside a
 * <details>, `open === false`, summary named "About this record", no
 * title= tooltip) are what is pinned. The 1920×1080 real-browser render is
 * what verifies the closed state actually hides the text.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import Workspace from '../pages/Workspace'
import HistoryLane from '../pages/Activity/HistoryLane'
import type { AuditEventsResponse, UserIdentity, WorkspaceHealth } from '../api/types'

const STOPGAP = /First implementation of this lane/

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const HEALTH: WorkspaceHealth = { configured: true, reachable: true, reason: '', watchdog_firing: true, alerts: [] }

const IDENTITY: UserIdentity = {
  subject: 'ops',
  display_name: 'Ops',
  email: 'ops@dmf.example.com',
  role: 'operator',
  real_role: 'operator',
  view_as_active: false,
  groups: [],
  awx_configured: true,
  authentik_configured: true,
}

const AUDIT: AuditEventsResponse = {
  reason: '',
  window: { known: true, seconds: 604800, reason: '' },
  capped: false,
  excluded: [],
  events: [],
}

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = (typeof input === 'string' ? input : (input as Request).url).toString()
      if (url.endsWith('/api/me')) return json(IDENTITY)
      if (url.endsWith('/api/workspace/health')) return json(HEALTH)
      if (url.endsWith('/api/audit/events')) return json(AUDIT)
      if (url.endsWith('/api/changes/jobs')) return json({ jobs: [], reason: '' })
      if (url.endsWith('/api/changes/commits')) return json({ repos: [], reason: '' })
      if (url.endsWith('/api/changes/pulls')) return json({ pulls: [], reason: '' })
      return json({})
    }),
  )
}

function renderWithQuery(ui: React.ReactElement) {
  stubFetch()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('dmfdeploy/dmfdeploy#555: the Activity explainer is a disclosure on Workspace, inline on History', () => {
  it('(a) Workspace: the stopgap sentence sits inside a CLOSED <details> whose summary is named "About this record"', async () => {
    renderWithQuery(<Workspace />)
    const stopgap = await screen.findByText(STOPGAP)

    const details = stopgap.closest('details')
    expect(details).not.toBeNull()
    expect((details as HTMLDetailsElement).open).toBe(false)

    const summary = (details as HTMLDetailsElement).querySelector('summary') as HTMLElement
    expect(summary).not.toBeNull()
    // Accessible name per accname: the summary's text content — the icon is
    // aria-hidden, so the visually-hidden span IS the whole name. (aria-query
    // maps <summary> to no role in this toolchain, so getByRole can't reach
    // it.) A title= tooltip is exactly what Arc 4 WP-4 rules out.
    expect(summary.textContent?.trim()).toBe('About this record')
    expect(summary.hasAttribute('title')).toBe(false)
    expect(summary.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')

    // All three paragraphs travel together — the shared fragment, not just
    // the stopgap one.
    const first = screen.getByText(/Deploys, teardowns, source switches, and automatic rollbacks/)
    expect(first.closest('details')).toBe(details)

    // The heading itself is NOT inside the disclosure and keeps its name.
    const heading = screen.getByRole('heading', { level: 2, name: 'Activity' })
    expect(heading.closest('details')).toBeNull()
  })

  it('(b) History: the same stopgap sentence is present and NOT inside any <details>', async () => {
    renderWithQuery(<HistoryLane />)
    const stopgap = await screen.findByText(STOPGAP)
    expect(stopgap.closest('details')).toBeNull()
    expect(screen.queryByText('About this record')).toBeNull()
  })

  it('renders byte-for-byte the same paragraph text at both sites (one shared fragment)', async () => {
    renderWithQuery(<Workspace />)
    const onWorkspace = (await screen.findByText(STOPGAP)).textContent
    cleanup()
    renderWithQuery(<HistoryLane />)
    const onHistory = (await screen.findByText(STOPGAP)).textContent
    expect(onWorkspace).toBe(onHistory)
  })
})
