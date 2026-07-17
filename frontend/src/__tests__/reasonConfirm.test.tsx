/**
 * Armed-confirm + mandatory-reason flow (dmfdeploy/dmfdeploy#185 WP-E).
 *
 * The three AWX writes are operator-gated with the C5 quartet: nothing fires
 * on the first click; the write POSTs only after a non-empty reason is entered
 * and confirmed, and the reason rides in the body. Two layers:
 *   * the shared ReasonConfirm component (graduated friction in isolation);
 *   * the Catalog deploy surface end-to-end (arm → no request → confirm → POST
 *     carries the reason).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import ReasonConfirm from '../components/ReasonConfirm'
import Catalog from '../pages/Catalog'
import type { CatalogEntry, CatalogListResponse, UserIdentity } from '../api/types'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ReasonConfirm component', () => {
  it('keeps Confirm disabled until a non-empty reason is entered', () => {
    const onConfirm = vi.fn()
    render(
      <ReasonConfirm title="T" description="D" onConfirm={onConfirm} onCancel={() => {}} />,
    )
    const confirm = screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } })
    expect(confirm.disabled).toBe(true) // whitespace-only is still empty
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'planned run' } })
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)
    expect(onConfirm).toHaveBeenCalledWith('planned run') // trimmed reason
  })

  it('Cancel fires onCancel and never onConfirm', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(
      <ReasonConfirm title="T" description="D" onConfirm={onConfirm} onCancel={onCancel} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('extraField: an invalid value disables Confirm even with a valid reason', () => {
    render(
      <ReasonConfirm
        title="T"
        description="D"
        onConfirm={vi.fn()}
        onCancel={() => {}}
        extraField={{
          label: 'Extra',
          value: 'bad value',
          onChange: () => {},
          invalid: true,
          invalidHint: 'nope',
        }}
      />,
    )
    fireEvent.change(screen.getByPlaceholderText(/Reason \(required/), { target: { value: 'a reason' } })
    expect((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('nope')).toBeTruthy()
  })

  it('extraField: a valid (or absent) value leaves Confirm gated on reason alone', () => {
    render(
      <ReasonConfirm
        title="T"
        description="D"
        onConfirm={vi.fn()}
        onCancel={() => {}}
        extraField={{ label: 'Extra', value: 'fine', onChange: () => {}, invalid: false }}
      />,
    )
    fireEvent.change(screen.getByPlaceholderText(/Reason \(required/), { target: { value: 'a reason' } })
    expect((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(false)
  })
})

const OPERATOR: UserIdentity = {
  subject: 'ops',
  display_name: 'Ops',
  email: 'ops@dmf.example.com',
  role: 'operator',
  real_role: 'operator',
  view_as_active: false,
  groups: [],
  awx_configured: true,
  authentik_configured: false,
}

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    key: 'mxl-videotest-view',
    display_name: 'MXL video test view',
    summary: 'A shipped MXL pair',
    ebu_layer: null,
    ebu_vertical: null,
    ebu_media_function_type: null,
    ebu_lifecycle_owner: null,
    lifecycle: 'bootstrapped',
    provision_image: null,
    provision_netbox_service: null,
    configure_awx_job_template: 'dmf-configure',
    finalise_awx_job_template: 'dmf-finalise',
    dependencies: [],
    ingress_url: null,
    ...overrides,
  }
}

type DeployFetch = (url: string, init?: RequestInit) => Promise<Response>

function renderCatalog(deployFetch: DeployFetch) {
  const catalog: CatalogListResponse = { entries: [entry()] }
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = (typeof input === 'string' ? input : (input as Request).url).toString()
    if (url.endsWith('/api/me')) return json(OPERATOR)
    if (url.endsWith('/api/catalog') && (init?.method ?? 'GET') === 'GET') return json(catalog)
    if (url.endsWith('/deploy')) return deployFetch(url, init)
    return json({})
  })
  vi.stubGlobal('fetch', fetchMock)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Catalog />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('Catalog deploy — reason-gated flow', () => {
  it('arms a reason panel on Deploy and does not POST until confirmed with a reason', async () => {
    const deployFetch = vi.fn(
      async (_url: string, _init?: RequestInit) => json({ job_id: 1, status: 'launched', request_id: 'r1' }),
    )
    renderCatalog(deployFetch)

    const deployBtn = await screen.findByRole('button', { name: /Deploy/ })
    fireEvent.click(deployBtn)

    // Panel armed; nothing sent yet.
    const reasonBox = await screen.findByPlaceholderText(/Reason \(required/)
    expect(reasonBox).toBeTruthy()
    expect(deployFetch).not.toHaveBeenCalled()

    // Enter a reason and confirm → POST fires with the reason in the body,
    // no workload key (it was left empty — omitted, not sent as "").
    fireEvent.change(reasonBox, { target: { value: 'scheduled provision' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm deploy' }))

    await waitFor(() => expect(deployFetch).toHaveBeenCalledOnce())
    const [url, init] = deployFetch.mock.calls[0]
    expect(url).toContain('/api/catalog/mxl-videotest-view/deploy')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({ reason: 'scheduled provision' })
  })

  it('renders an optional workload field on the deploy panel', async () => {
    renderCatalog(vi.fn(async () => json({ job_id: 1, status: 'launched', request_id: 'r1' })))
    fireEvent.click(await screen.findByRole('button', { name: /Deploy/ }))
    expect(await screen.findByText('Workload (optional)')).toBeTruthy()
    expect(screen.getByPlaceholderText('e.g. studio-a')).toBeTruthy()
  })

  it('blocks Confirm with an inline hint on an invalid workload slug, valid reason notwithstanding', async () => {
    renderCatalog(vi.fn(async () => json({ job_id: 1, status: 'launched', request_id: 'r1' })))
    fireEvent.click(await screen.findByRole('button', { name: /Deploy/ }))
    fireEvent.change(await screen.findByPlaceholderText(/Reason \(required/), { target: { value: 'x' } })

    fireEvent.change(screen.getByPlaceholderText('e.g. studio-a'), { target: { value: 'Not Valid!' } })
    const confirm = screen.getByRole('button', { name: 'Confirm deploy' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    expect(screen.getByText(/Lowercase letters, numbers, and hyphens only/)).toBeTruthy()
  })

  it('sends the workload slug in the POST body when valid', async () => {
    const deployFetch = vi.fn(
      async (_url: string, _init?: RequestInit) => json({ job_id: 1, status: 'launched', request_id: 'r1' }),
    )
    renderCatalog(deployFetch)
    fireEvent.click(await screen.findByRole('button', { name: /Deploy/ }))
    fireEvent.change(await screen.findByPlaceholderText(/Reason \(required/), { target: { value: 'x' } })
    fireEvent.change(screen.getByPlaceholderText('e.g. studio-a'), { target: { value: 'studio-a' } })

    const confirm = screen.getByRole('button', { name: 'Confirm deploy' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)

    await waitFor(() => expect(deployFetch).toHaveBeenCalledOnce())
    const [, init] = deployFetch.mock.calls[0]
    expect(JSON.parse(init?.body as string)).toEqual({ reason: 'x', workload: 'studio-a' })
  })
})
