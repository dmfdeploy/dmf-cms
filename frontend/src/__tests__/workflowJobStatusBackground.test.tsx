/**
 * The Activity jobs lane polls a launched workflow job by id. These tests pin
 * that the status keeps updating while the tab is hidden, that coming back to
 * the tab refreshes a job that is still running, and that a settled job stops
 * being polled.
 *
 * jsdom and TanStack Query: the query core reads `document.visibilityState`
 * and listens for `visibilitychange` on `window`. jsdom reports `visible` by
 * default, so the hidden state is simulated by redefining
 * `document.visibilityState`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import JobsLane from '../pages/Activity/JobsLane'
import { useWorkflowJobStatus } from '../api/hooks'
import { settleQuery } from '../lib/queryState'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// The same QueryClient defaults as main.tsx, except retry: retries are off so
// a failed read never hides behind one.
function newQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })
}

function setTabHidden(hidden: boolean) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  })
  document.dispatchEvent(new Event('visibilitychange', { bubbles: true }))
}

interface Server {
  status: string
  jobReads: number
}

function stubServer(initial: Partial<Server> = {}): Server {
  const server: Server = { status: 'running', jobReads: 0, ...initial }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = (typeof input === 'string' ? input : (input as Request).url).toString()
      if (url.endsWith('/api/me')) {
        return json({
          subject: 'ops', display_name: 'Ops', email: 'o@x', role: 'engineer', real_role: 'engineer',
          groups: [], awx_configured: true,
        })
      }
      if (url.endsWith('/api/workflows')) {
        return json({ templates: [{ id: 1, name: 'day0-bootstrap', description: 'Bootstrap a facility', type: 'job' }] })
      }
      if (url.endsWith('/launch')) return json({ job_id: 55, status: 'launched', request_id: 'req-1' })
      if (url.endsWith('/api/workflows/jobs/55')) {
        server.jobReads += 1
        return json({
          job_id: 55, status: server.status, name: 'day0-bootstrap', url: '', elapsed: 3.2,
          failed: server.status === 'failed',
        })
      }
      return json({})
    }),
  )
  return server
}

function JobProbe() {
  const { data } = settleQuery(useWorkflowJobStatus(55))
  return <div data-testid="probe">{data ? data.status : 'none'}</div>
}

function renderProbe() {
  render(
    <QueryClientProvider client={newQueryClient()}>
      <JobProbe />
    </QueryClientProvider>,
  )
}

async function launchOnJobsLane() {
  render(
    <QueryClientProvider client={newQueryClient()}>
      <MemoryRouter>
        <JobsLane />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  fireEvent.click(await screen.findByRole('button', { name: /Launch/ }))
  fireEvent.change(await screen.findByPlaceholderText(/Reason \(required/), { target: { value: 'scheduled' } })
  fireEvent.click(screen.getByRole('button', { name: 'Confirm launch' }))
}

afterEach(() => {
  cleanup()
  // Remove the own-property override so jsdom's `visible` default applies.
  delete (document as { visibilityState?: unknown }).visibilityState
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('useWorkflowJobStatus: a hidden tab does not delay the job outcome', () => {
  it('the Jobs lane shows the outcome while the tab stays hidden', async () => {
    const server = stubServer({ status: 'running' })
    await launchOnJobsLane()
    await screen.findAllByText(/⟳ Running/)

    setTabHidden(true)
    server.status = 'successful'

    // The poll interval is 5 s; the outcome has to arrive without the tab
    // returning. The job shows on its card and in the Active Jobs panel.
    expect((await screen.findAllByText('Successful', {}, { timeout: 8000 })).length).toBeGreaterThan(0)
  }, 20_000)

  it('becoming visible again fetches the outcome faster than the next 5 s tick', async () => {
    const server = stubServer({ status: 'running' })
    renderProbe()
    await screen.findByText('running')
    const reads = server.jobReads

    setTabHidden(true)
    server.status = 'successful'
    setTabHidden(false)

    await screen.findByText('successful', {}, { timeout: 1500 })
    expect(server.jobReads).toBeGreaterThan(reads)
  }, 20_000)

  it('a settled job is not polled again, and returning to the tab does not refetch it', async () => {
    const server = stubServer({ status: 'successful' })
    renderProbe()
    await screen.findByText('successful')
    const reads = server.jobReads

    setTabHidden(true)
    setTabHidden(false)
    // Longer than one 5 s poll interval: a poll that kept running would read again.
    await new Promise((resolve) => setTimeout(resolve, 5600))

    expect(server.jobReads).toBe(reads)
  }, 20_000)
})
