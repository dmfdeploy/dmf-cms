/**
 * Admin Users roster: People / Machine-identities split + break-glass badge
 * (PR-C, dmfdeploy/dmfdeploy#243). The single flat Users table is split into
 * two sections keyed on user_type, and the platform-seeded break-glass admin
 * gets a distinct amber warning badge (ADR-0028 C4/D8). Fetch is stubbed with
 * a mixed roster; the Groups/Health hooks get empty stubs so the page renders.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import Admin from '../pages/Admin'
import type { AdminUser } from '../api/types'

function user(overrides: Partial<AdminUser> = {}): AdminUser {
  return {
    username: 'someone',
    display_name: 'Some One',
    email: 'someone@dmf.example.com',
    role: 'viewer',
    last_login: null,
    is_active: true,
    user_type: 'human',
    is_break_glass: false,
    ...overrides,
  }
}

const ROSTER: AdminUser[] = [
  user({ username: 'akadmin', display_name: 'Emergency Admin', role: 'admin', user_type: 'human', is_break_glass: true }),
  user({ username: 'alice', display_name: 'Alice Human', role: 'operator', user_type: 'human' }),
  user({ username: 'awx-svc', display_name: 'AWX Service', role: 'engineer', user_type: 'machine' }),
]

const fetchMock = vi.fn()

function stubFetch(users: AdminUser[]) {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = (typeof input === 'string' ? input : (input as Request).url).toString()
    let body: unknown = {}
    if (url.endsWith('/api/admin/users')) body = { users }
    else if (url.endsWith('/api/admin/groups')) body = { groups: [] }
    else if (url.endsWith('/api/admin/health')) body = {}
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fetchMock)
}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

async function renderAdmin(users: AdminUser[]) {
  stubFetch(users)
  render(
    <QueryClientProvider client={client()}>
      <MemoryRouter>
        <Admin />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  // wait for the roster to resolve
  await screen.findByText('alice')
}

/** The panel (section) whose heading matches, as a scoping root. */
function panelFor(heading: string): HTMLElement {
  const h = screen.getByRole('heading', { name: heading })
  // heading -> panel header div -> panel div
  return h.closest('.panel') as HTMLElement
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  fetchMock.mockReset()
})

describe('Admin Users roster', () => {
  it('splits humans into People and machines into Machine identities', async () => {
    await renderAdmin(ROSTER)

    const people = within(panelFor('People'))
    expect(people.getByText('alice')).toBeTruthy()
    expect(people.getByText('akadmin')).toBeTruthy()
    expect(people.queryByText('awx-svc')).toBeNull()

    const machines = within(panelFor('Machine identities'))
    expect(machines.getByText('awx-svc')).toBeTruthy()
    expect(machines.queryByText('alice')).toBeNull()
  })

  it('marks the break-glass identity with an amber warning badge and only that one', async () => {
    await renderAdmin(ROSTER)

    const badges = screen.getAllByText('Break-glass')
    expect(badges).toHaveLength(1)

    const badge = badges[0]
    expect(badge.getAttribute('title')).toContain('ADR-0028 C4')
    expect(badge.className).toContain('amber')

    // the badge sits on the akadmin row, not on a routine user
    const akadminRow = screen.getByText('akadmin').closest('tr') as HTMLElement
    expect(within(akadminRow).getByText('Break-glass')).toBeTruthy()
    const aliceRow = screen.getByText('alice').closest('tr') as HTMLElement
    expect(within(aliceRow).queryByText('Break-glass')).toBeNull()
  })

  it('shows an empty-state per section when a partition is empty', async () => {
    await renderAdmin([user({ username: 'alice', user_type: 'human' })])

    expect(within(panelFor('Machine identities')).getByText('No machine identities')).toBeTruthy()
  })
})
