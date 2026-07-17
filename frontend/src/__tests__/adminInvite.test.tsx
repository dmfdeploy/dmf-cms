/**
 * Admin People panel invite flow (PR-D, dmfdeploy/dmfdeploy#243): the
 * "+ Invite new user" button + QR/enrollment-URL result, ported from the
 * retired Workspace AdminPanels Users panel onto pages/Admin.tsx's People
 * section — People is the human roster, so invitations (which mint human
 * enrollment links) belong there.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import Admin from '../pages/Admin'

const fetchMock = vi.fn()

function stubFetch() {
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = (typeof input === 'string' ? input : (input as Request).url).toString()
    const method = init?.method ?? 'GET'
    let body: unknown = {}
    if (url.endsWith('/api/admin/users')) body = { users: [] }
    else if (url.endsWith('/api/admin/groups')) body = { groups: [] }
    else if (url.endsWith('/api/admin/health')) body = {}
    else if (url.endsWith('/api/admin/invitations') && method === 'POST') {
      body = {
        enrollment_url: 'https://auth.dmf.example.com/if/flow/enrollment/?itoken=abc123',
        expires: '2026-07-24T00:00:00Z',
      }
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fetchMock)
}

function renderAdmin() {
  stubFetch()
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <Admin />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  fetchMock.mockReset()
})

describe('Admin People panel invite flow', () => {
  it('renders the invite button on the People panel', async () => {
    renderAdmin()
    expect(await screen.findByText('+ Invite new user')).toBeTruthy()
  })

  it('shows the enrollment URL and expiry after a successful invite', async () => {
    renderAdmin()
    const button = await screen.findByText('+ Invite new user')
    fireEvent.click(button)

    await waitFor(() => {
      expect(
        screen.getByDisplayValue('https://auth.dmf.example.com/if/flow/enrollment/?itoken=abc123'),
      ).toBeTruthy()
    })
    expect(screen.getByText(/Expires:/)).toBeTruthy()

    const postCalls = fetchMock.mock.calls.filter((call) => {
      const [url, init] = call as [RequestInfo | URL, RequestInit | undefined]
      return url.toString().endsWith('/api/admin/invitations') && (init?.method ?? 'GET') === 'POST'
    })
    expect(postCalls).toHaveLength(1)
  })

  it('closes the enrollment result when Close is clicked', async () => {
    renderAdmin()
    fireEvent.click(await screen.findByText('+ Invite new user'))
    await screen.findByText(/Expires:/)

    fireEvent.click(screen.getByText('Close'))
    expect(screen.queryByText(/Expires:/)).toBeNull()
  })
})
