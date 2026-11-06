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
import { APIError, apiCall } from '../api/client'
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

  // umbrella #571, #741: without a testIdPrefix the reason field is
  // reason-input and Confirm carries no test id.
  it('without testIdPrefix, the reason field is reason-input and Confirm has no test id', () => {
    render(<ReasonConfirm title="T" description="D" onConfirm={vi.fn()} onCancel={() => {}} />)
    expect(screen.getByTestId('reason-input')).toBe(screen.getByRole('textbox'))
    expect(screen.getByRole('button', { name: 'Confirm' }).getAttribute('data-testid')).toBeNull()
  })

  // umbrella #741: testIdPrefix names both ids from one action name.
  it('testIdPrefix names the Confirm button and the reason field', () => {
    render(
      <ReasonConfirm title="T" description="D" onConfirm={vi.fn()} onCancel={() => {}} testIdPrefix="teardown" />,
    )
    expect(screen.getByTestId('confirm-teardown')).toBe(screen.getByRole('button', { name: 'Confirm' }))
    expect(screen.getByTestId('reason-teardown')).toBe(screen.getByRole('textbox'))
    expect(screen.queryByTestId('reason-input')).toBeNull()
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

// umbrella #432 ("too much small text on those
// provision / switch / teardown / delete action"). Same hierarchy, one step
// up in scale — see this component's own docstring for the full reasoning.
describe('ReasonConfirm popover type scale (umbrella #432, FIX ROUND)', () => {
  it('raises the panel width floor and the title/description/field scale off the old dense defaults', () => {
    render(<ReasonConfirm title="T" description="D" onConfirm={vi.fn()} onCancel={() => {}} />)

    const title = screen.getByText('T')
    const panel = title.parentElement as HTMLElement
    expect(panel.className).toMatch(/\bmin-w-80\b/)
    expect(panel.className).not.toMatch(/min-w-64/)
    expect(title.className).toMatch(/\btext-sm\b/)
    expect(title.className).not.toMatch(/text-xs/)

    const description = screen.getByText('D')
    expect(description.className).toMatch(/\btext-sm\b/)

    // Off density="xs" onto the field primitive's own base size.
    const textarea = screen.getByPlaceholderText(/Reason \(required/)
    expect(textarea.className.split(/\s+/)).not.toContain('field-xs')
  })

  // umbrella #432: min-w-80 is a floor, not
  // a ceiling — measured live at 1988px wide with a 1954px unwrapped
  // description line, because the panel is a bare block inside a wide stage
  // row with nothing else to constrain it. THE HONEST LIMIT OF THIS TEST:
  // jsdom cannot measure rendered width, so this pins the CLASS CONTRACT
  // (the panel carries a max-width utility) — it cannot pin, and does not
  // claim to pin, that the rendered panel is actually narrow. The real
  // verification for that is the walk, not this suite.
  it('carries a max-width utility, capping the floor min-w-80 leaves open', () => {
    render(<ReasonConfirm title="T" description="D" onConfirm={vi.fn()} onCancel={() => {}} />)
    const panel = screen.getByText('T').parentElement as HTMLElement
    expect(panel.className).toMatch(/\bmax-w-sm\b/)
  })
})

// umbrella #432 §C — the shared form-field primitive (components/FormField.tsx).
// ReasonConfirm's own reason textarea, and both extraField shapes (free-text
// input and select), used to each hand-roll `border-white/10 bg-black/20` —
// now all three render through the one primitive.
describe('ReasonConfirm renders through the shared .field primitive', () => {
  it('renders the reason textarea through .field', () => {
    render(<ReasonConfirm title="T" description="D" onConfirm={vi.fn()} onCancel={() => {}} />)
    const textarea = screen.getByPlaceholderText(/Reason \(required/)
    expect(textarea.className.split(/\s+/)).toContain('field')
  })

  it('renders a free-text extraField through .field', () => {
    render(
      <ReasonConfirm
        title="T"
        description="D"
        onConfirm={vi.fn()}
        onCancel={() => {}}
        extraField={{ label: 'Extra', placeholder: 'e.g. studio-a', value: '', onChange: () => {} }}
      />,
    )
    const input = screen.getByPlaceholderText('e.g. studio-a')
    expect(input.className.split(/\s+/)).toContain('field')
  })

  it('renders a select extraField through .field', () => {
    render(
      <ReasonConfirm
        title="T"
        description="D"
        onConfirm={vi.fn()}
        onCancel={() => {}}
        extraField={{
          label: 'Extra',
          value: '',
          onChange: () => {},
          options: [{ value: 'a', label: 'A' }],
        }}
      />,
    )
    const select = screen.getByRole('combobox')
    expect(select.className.split(/\s+/)).toContain('field')
  })
})

describe('ReasonConfirm variant="danger" (umbrella #347, delete-permanently)', () => {
  // The exact extraField shape FinaliseStage wires for typed-slug
  // confirmation: invalid whenever the typed text doesn't equal the slug,
  // INCLUDING when it's empty — Confirm must never be reachable on an
  // untouched field.
  function typedSlugField(value: string, slug = 'studio-a') {
    return {
      label: 'Type the workload slug to confirm',
      placeholder: slug,
      value,
      onChange: () => {},
      invalid: value !== slug,
      invalidHint: `Type "${slug}" exactly to confirm — this cannot be undone.`,
    }
  }

  it('renders the destructive badge text (Art. 11: colour is never the only signal)', () => {
    render(
      <ReasonConfirm
        variant="danger"
        title="Delete studio-a permanently?"
        description="D"
        onConfirm={vi.fn()}
        onCancel={() => {}}
        extraField={typedSlugField('')}
      />,
    )
    expect(screen.getByText(/Destructive — cannot be undone/)).toBeTruthy()
  })

  it('keeps Confirm disabled on an EMPTY typed-slug field, even with a valid reason', () => {
    // Discriminates the empty-vs-mismatch distinction: a mutant using
    // `value.length > 0 && value !== slug` (mismatch-only) would leave
    // Confirm enabled here since the field is empty.
    render(
      <ReasonConfirm
        variant="danger"
        title="Delete studio-a permanently?"
        description="D"
        confirmLabel="Delete permanently"
        onConfirm={vi.fn()}
        onCancel={() => {}}
        extraField={typedSlugField('')}
      />,
    )
    fireEvent.change(screen.getByPlaceholderText(/Reason \(required/), { target: { value: 'confirmed clean' } })
    expect((screen.getByRole('button', { name: 'Delete permanently' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('keeps Confirm disabled while the typed slug is a near-miss, and enables it only on an exact match', () => {
    const onConfirm = vi.fn()
    const { rerender } = render(
      <ReasonConfirm
        variant="danger"
        title="Delete studio-a permanently?"
        description="D"
        confirmLabel="Delete permanently"
        onConfirm={onConfirm}
        onCancel={() => {}}
        extraField={typedSlugField('studio-a-x')}
      />,
    )
    fireEvent.change(screen.getByPlaceholderText(/Reason \(required/), { target: { value: 'confirmed clean' } })
    expect((screen.getByRole('button', { name: 'Delete permanently' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/Type "studio-a" exactly to confirm/)).toBeTruthy()

    rerender(
      <ReasonConfirm
        variant="danger"
        title="Delete studio-a permanently?"
        description="D"
        confirmLabel="Delete permanently"
        onConfirm={onConfirm}
        onCancel={() => {}}
        extraField={typedSlugField('studio-a')}
      />,
    )
    const confirm = screen.getByRole('button', { name: 'Delete permanently' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)
    expect(onConfirm).toHaveBeenCalledWith('confirmed clean')
  })

  it('pending/error states render the same as the warning variant', () => {
    render(
      <ReasonConfirm
        variant="danger"
        title="Delete studio-a permanently?"
        description="D"
        confirmLabel="Delete permanently"
        pendingLabel="Deleting…"
        pending
        error={new APIError(400, JSON.stringify({ error: 'boom' }), 'boom')}
        onConfirm={vi.fn()}
        onCancel={() => {}}
        extraField={typedSlugField('studio-a')}
      />,
    )
    expect(screen.getByText('Deleting…')).toBeTruthy()
    expect(screen.getByText(/nothing was changed/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Deleting…' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it.each([
    ['a lost connection', new TypeError('Failed to fetch')],
    ['an unparseable body', new SyntaxError('Unexpected token < in JSON at position 0')],
  ])('says the outcome is unknown, not "nothing was changed", after %s', (_name, error) => {
    render(
      <ReasonConfirm title="T" description="D" error={error} onConfirm={vi.fn()} onCancel={() => {}} />,
    )
    expect(screen.getByText(/could not confirm the result, so the action may have run/)).toBeTruthy()
    expect(screen.queryByText(/nothing was changed/)).toBeNull()
  })

  it.each([
    ['a 5xx with a JSON body', 502, { error: 'bad-gateway' }, false],
    ['a 5xx that names its upstream', 502, { error: 'upstream-error', upstream: 'AWX' }, false],
    ['a 4xx that names its upstream', 404, { error: 'upstream-error', upstream: 'NetBox' }, false],
    ['a 4xx from the console', 409, { error: 'already-active' }, true],
  ])('through the real client, %s', async (_name, status, body, refused) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })),
    )
    const error = await apiCall('/api/x').catch((e: unknown) => e)
    render(<ReasonConfirm title="T" description="D" error={error} onConfirm={vi.fn()} onCancel={() => {}} />)
    expect(!!screen.queryByText(/nothing was changed/)).toBe(refused)
    expect(!!screen.queryByText(/could not confirm the result/)).toBe(!refused)
  })

  it('an APIError whose body cannot be parsed reads as unknown', () => {
    render(
      <ReasonConfirm
        title="T"
        description="D"
        error={new APIError(400, 'not json', 'bad')}
        onConfirm={vi.fn()}
        onCancel={() => {}}
      />,
    )
    expect(screen.queryByText(/nothing was changed/)).toBeNull()
    expect(screen.getByText(/could not confirm the result/)).toBeTruthy()
  })

  it('an unparseable body from the real client reads as unknown, a refusal as nothing changed', async () => {
    const refusedBody = new Response(JSON.stringify({ error: 'forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    })
    const garbled = new Response('<html>bad gateway</html>', { status: 502 })
    const caught: unknown[] = []
    for (const response of [garbled, refusedBody]) {
      vi.stubGlobal('fetch', vi.fn(async () => response))
      await apiCall('/api/x').catch((e: unknown) => caught.push(e))
    }
    expect(caught[0]).toBeInstanceOf(SyntaxError)
    expect(caught[1]).toBeInstanceOf(APIError)
    for (const error of caught) {
      const { unmount } = render(
        <ReasonConfirm title="T" description="D" error={error} onConfirm={vi.fn()} onCancel={() => {}} />,
      )
      const refused = error instanceof APIError
      expect(!!screen.queryByText(/nothing was changed/)).toBe(refused)
      expect(!!screen.queryByText(/could not confirm the result/)).toBe(!refused)
      unmount()
    }
  })

  it('the default (omitted) variant is unaffected — no destructive badge, unchanged styling', () => {
    render(<ReasonConfirm title="T" description="D" onConfirm={vi.fn()} onCancel={() => {}} />)
    expect(screen.queryByText(/Destructive — cannot be undone/)).toBeNull()
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

describe('ReasonConfirm capacity refusal', () => {
  it('shows the budget shortfall and the finalise-then-retry step for a capacity refusal', () => {
    const body = JSON.stringify({
      error: 'capacity-preflight-refused',
      kind: 'no-fit',
      report: { shortfall_cpu_m: 1500, shortfall_mem_b: 2 * 1024 ** 3 },
    })
    render(
      <ReasonConfirm
        title="T"
        description="D"
        error={new APIError(409, body, 'capacity-preflight-refused')}
        onConfirm={vi.fn()}
        onCancel={() => {}}
      />,
    )
    expect(screen.getByText(/CPU short by 1500m, memory short by 2048Mi/)).toBeTruthy()
    expect(screen.getByText(/Finalise a running workload/)).toBeTruthy()
    expect(screen.queryByText(/Check your access/)).toBeNull()
  })

  it.each([
    ['a 502', 502, { error: 'capacity-preflight-refused', kind: 'no-fit' }],
    ['a 409 that names its upstream', 409, { error: 'capacity-preflight-refused', kind: 'no-fit', upstream: 'AWX' }],
  ])('shows the unknown-result text, not the capacity copy, for %s', (_name, status, body) => {
    render(
      <ReasonConfirm
        title="T"
        description="D"
        error={new APIError(status, JSON.stringify(body), 'capacity-preflight-refused')}
        onConfirm={vi.fn()}
        onCancel={() => {}}
      />,
    )
    expect(screen.getByText(/could not confirm the result, so the action may have run/)).toBeTruthy()
    expect(screen.queryByText(/nothing was changed/i)).toBeNull()
    expect(screen.queryByText(/Finalise a running workload/)).toBeNull()
  })

  it.each(['budget-unavailable', 'multi-node-unsupported', 'missing-budget', 'invalid-budget'])(
    'does not advise finalising a workload for the %s refusal',
    (kind) => {
      render(
        <ReasonConfirm
          title="T"
          description="D"
          error={new APIError(409, JSON.stringify({ error: 'capacity-preflight-refused', kind }), 'capacity-preflight-refused')}
          onConfirm={vi.fn()}
          onCancel={() => {}}
        />,
      )
      expect(screen.getByText(/could not confirm the facility has room/)).toBeTruthy()
      expect(screen.queryByText(/Finalise a running workload/)).toBeNull()
    },
  )

  it('keeps the generic message for other errors', () => {
    render(
      <ReasonConfirm
        title="T"
        description="D"
        error={new APIError(403, JSON.stringify({ error: 'forbidden' }), 'forbidden')}
        onConfirm={vi.fn()}
        onCancel={() => {}}
      />,
    )
    expect(screen.getByText(/Check your access, then retry/)).toBeTruthy()
  })
})
