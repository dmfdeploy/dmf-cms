/**
 * Review finding on PR #144: `requestedLabel[state] ?? requestedLabel.unknown`
 * (and the sibling requestedBadge / observedBadge / REQUESTED_ICON lookups in
 * ProvisionStage.tsx and WorkloadTile.tsx) resolve inherited `Object.prototype`
 * properties — `constructor`, `__proto__`, `toString`, … — instead of falling
 * back to `unknown`: the fallback never fires because the inherited value is
 * truthy, so React can be asked to render a function as a component/child.
 * `requested_state` is a NetBox lifecycle-tag suffix passed through by the
 * backend — untrusted from this layer's point of view.
 *
 * `lookupState` (stateBadges.ts, own-property guard) is the fix. This file
 * pins (a) the helper's behaviour directly against every poisonous key, and
 * (b) that a member whose `requested_state` IS `'constructor'` still renders
 * the `unknown` label in ProvisionStage's default instance list — no React
 * error/warning about rendering a function.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import ProvisionStage from '../pages/MediaWorkloads/stages/ProvisionStage'
import { lookupState, requestedLabel } from '../pages/MediaWorkloads/stateBadges'
import type { MediaWorkload, MediaWorkloadInstance } from '../api/types'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

type Member = MediaWorkloadInstance & { workload_assignment: string }

function member(overrides: Partial<Member>): Member {
  return {
    instance: 'mxl-a',
    netbox_id: 1,
    function_key: 'crosspoint',
    live_view: false,
    requested_state: 'bootstrapped',
    observed_state: 'unknown',
    reconcile_pending: false,
    placement: { node: null, ports: [], protocol: null },
    workload_assignment: 'studio-a',
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('review finding PR #144: state-map lookups must be own-property, never prototype-poisonable', () => {
  it.each([['constructor'], ['__proto__'], ['toString'], [null], [undefined]])(
    'lookupState(requestedLabel, %s) falls back to "unknown"',
    (state) => {
      expect(lookupState(requestedLabel, state as string | null | undefined)).toBe('unknown')
    },
  )

  it('ProvisionStage renders the "unknown" label — not a rendered function — for a poisoned requested_state', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = (typeof input === 'string' ? input : (input as Request).url).toString()
        if (url.endsWith('/api/catalog')) return json({ entries: [] })
        if (url.endsWith('/api/me')) return json({ subject: 'ops', role: 'operator' })
        return json({})
      }),
    )
    const workload: MediaWorkload = {
      slug: 'studio-a',
      name: 'studio-a',
      lifecycle: 'provision',
      health: 'ok',
      instances: [member({ instance: 'mxl-a', requested_state: 'constructor' })],
      functions: [{ function_key: 'crosspoint', count: 1, running: 0, reconcile_pending: 0 }],
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ProvisionStage
            workload={workload}
            state="active"
            actions={['deploy', 'clear-for-deployment']}
            onBusyChange={vi.fn()}
            onJobStart={vi.fn()}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    )

    const list = screen.getByRole('heading', {
      level: 3,
      name: /^Media Function Instances — \d+ of \d+ provisioned$/,
    }).nextElementSibling as HTMLElement
    expect(within(list).getByText('unknown')).toBeTruthy()

    // The exact failure mode this fix closes: a function value (Object.prototype.constructor)
    // reaching React as a component or child logs a console.error. None may occur.
    expect(errorSpy).not.toHaveBeenCalled()
  })
})
