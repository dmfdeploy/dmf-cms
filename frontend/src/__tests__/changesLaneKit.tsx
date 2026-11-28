/**
 * Shared helpers for the commits and pull request panels' tests
 * (dmfdeploy/dmfdeploy#1025). They render the real History lane from a fetch
 * mock and read back what one panel shows, top to bottom, as a list of strings.
 * The expected strings are written out in full here, not imported from the
 * source, so a copy change in the source fails the tests.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { expect, vi } from 'vitest'
import HistoryLane from '../pages/Activity/HistoryLane'

export type Kind = 'commits' | 'pulls'

export const NOUN: Record<Kind, string> = { commits: 'commits', pulls: 'pull requests' }
export const HEADING: Record<Kind, string> = { commits: 'Recent Commits', pulls: 'Pull Requests' }

const EMPTY_AUDIT_EVENTS = {
  reason: '',
  window: { known: false, seconds: null, reason: 'unavailable' },
  capped: false,
  excluded: [],
  events: [],
}

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

export interface Served {
  commits: unknown
  pulls: unknown
  /** Answer the Forgejo routes with an HTTP 500 instead of the payloads. */
  failing?: boolean
}

export function serve(served: Served) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = (typeof input === 'string' ? input : (input as Request).url).toString()
      if (url.endsWith('/api/changes/jobs')) return json({ jobs: [], reason: 'awx-unconfigured' })
      if (url.endsWith('/api/audit/events')) return json(EMPTY_AUDIT_EVENTS)
      if (url.endsWith('/api/changes/commits') || url.endsWith('/api/changes/pulls')) {
        if (served.failing) return json({ error: 'boom' }, 500)
        return json(url.endsWith('/commits') ? served.commits : served.pulls)
      }
      return json({})
    }),
  )
}

export function renderLane(served: Served) {
  serve(served)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <HistoryLane />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { queryClient, ...view }
}

export function panelOf(kind: Kind): HTMLElement {
  const heading = screen.getByRole('heading', { name: HEADING[kind] })
  return heading.closest('.panel') as HTMLElement
}

export async function settled(kind: Kind): Promise<HTMLElement> {
  await waitFor(() => {
    expect(screen.queryByText(/^Loading (commits|PRs)\.\.\.$/)).toBeNull()
  })
  return panelOf(kind)
}

/** What the panel shows, top to bottom: notice and empty texts, `ROW` per row. */
export function laneOf(panel: HTMLElement): string[] {
  const items = within(panel).queryAllByTestId(/^forgejo-(notice|empty|row)$/)
  return items.map((el) => (el.dataset.testid === 'forgejo-row' ? 'ROW' : (el.textContent ?? '').trim()))
}

const OFF_PULLS = 'Pull requests are turned off for these repositories'

/** Turn a lane token from the table into the text the panel must show. */
export function textFor(token: string, kind: Kind): string {
  const noun = NOUN[kind]
  const [name, arg] = token.split(':')
  switch (name) {
    case 'READFAIL':
      return `Recent ${noun} could not be read from source control. Retrying automatically.`
    case 'UNREACH':
      return `Source control is unreachable — recent ${noun} cannot be read right now. Retrying automatically.`
    case 'PARTIAL':
      return `Some repositories could not be read — recent ${noun} may be incomplete. Retrying automatically.`
    case 'ALLOFF':
      return OFF_PULLS
    case 'SOMEOFF':
      return 'Pull requests are turned off for some repositories, so this list leaves them out.'
    case 'SKIPPED': {
      const n = Number(arg)
      return `${n} more ${n === 1 ? 'repository was' : 'repositories were'} not read, so this list may be incomplete.`
    }
    case 'INCOMPLETE':
      return 'The repository list may be incomplete, so some repositories were not read.'
    case 'LOADERR':
      return `Recent ${noun} could not be loaded. Retrying automatically.`
    case 'UNCONF':
      return 'Source control is not configured in this environment — an administrator can connect it to show recent commits and pull requests here.'
    case 'EMPTY':
      return `No recent ${noun}`
    default:
      throw new Error(`unknown lane token ${token}`)
  }
}

/** Expand a table "Lane shows" cell into the exact list `laneOf` returns. */
export function expectedLane(tokens: string[], kind: Kind, rowCount: number): string[] {
  return tokens.flatMap((token) =>
    token === 'ROWS' ? Array.from({ length: rowCount }, () => 'ROW') : [textFor(token, kind)],
  )
}

export function rowCountOf(kind: Kind, payload: Record<string, unknown>): number {
  const rows = (kind === 'pulls' ? payload.pulls : payload.repos) as unknown[] | undefined
  return rows?.length ?? 0
}
