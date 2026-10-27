import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Settings from '../pages/Settings'
import type { UserIdentity } from '../api/types'

const ENDPOINT = '/api/setup-requests/born-inventory-secretid-issue'
const REQUEST_ID = 'a'.repeat(32)

function identity(overrides: Partial<UserIdentity> = {}): UserIdentity {
  return {
    subject: 'ops',
    display_name: 'Ops Operator',
    email: 'ops@dmf.example.com',
    role: 'operator',
    real_role: 'operator',
    view_as_active: false,
    groups: [],
    awx_configured: true,
    authentik_configured: true,
    ...overrides,
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function renderSettings() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Settings />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Settings: setup receipt request', () => {
  it('sends only the reason and shows the opaque receipt result', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        calls.push({ url, init })
        if (url === '/api/me') return json(identity())
        if (url === ENDPOINT) {
          return json(
            {
              request_id: REQUEST_ID,
              action: 'born-inventory-secretid-issue',
              expires_at: Math.floor(Date.now() / 1000) + 900,
            },
            201,
          )
        }
        throw new Error(`unexpected API request: ${url}`)
      }),
    )

    renderSettings()
    expect(await screen.findByText('Bootstrap inventory setup')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Reason'), {
      target: { value: 'Initial inventory setup' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create setup receipt' }))

    expect(await screen.findByText(REQUEST_ID)).toBeTruthy()
    expect(screen.getByText(/Expires:/)).toBeTruthy()
    const request = calls.find((call) => call.url === ENDPOINT)
    expect(request?.init?.method).toBe('POST')
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      reason: 'Initial inventory setup',
    })
    expect(screen.queryByText(/secret.?id|token/i)).toBeNull()
  })

  it('hides the request action from viewers and break-glass accounts', async () => {
    for (const user of [
      identity({ role: 'viewer', real_role: 'viewer' }),
      identity({ role: 'engineer', real_role: 'engineer', groups: ['break-glass'] }),
    ]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          if (String(input) === '/api/me') return json(user)
          throw new Error(`unexpected API request: ${String(input)}`)
        }),
      )
      const view = renderSettings()
      await screen.findByText(user.display_name)
      expect(screen.queryByText('Bootstrap inventory setup')).toBeNull()
      view.unmount()
      vi.unstubAllGlobals()
    }
  })

  it('shows a storage error without presenting a request id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === '/api/me') return json(identity())
        if (String(input) === ENDPOINT) {
          return json({ error: 'setup request could not be recorded' }, 503)
        }
        throw new Error(`unexpected API request: ${String(input)}`)
      }),
    )
    renderSettings()
    fireEvent.change(await screen.findByLabelText('Reason'), {
      target: { value: 'Initial inventory setup' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create setup receipt' }))

    expect((await screen.findByRole('alert')).textContent).toContain(
      'setup request could not be recorded',
    )
    expect(screen.queryByText(REQUEST_ID)).toBeNull()
  })
})
