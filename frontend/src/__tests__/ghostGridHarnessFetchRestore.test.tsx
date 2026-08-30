/**
 * dmfdeploy/dmf-cms#126 review — regression coverage for a StrictMode-only
 * defect in GhostGridHarness.tsx's `window.fetch` stub/restore pair.
 *
 * React.StrictMode (enabled by main.tsx) double-invokes a `useState` lazy
 * initializer on mount, against the SAME hook state, specifically to
 * surface non-idempotent side effects. The harness's original fix-round
 * captured "the original fetch" into a `useRef` written by that
 * initializer — safe-looking, but the second invocation read
 * `window.fetch` AFTER the first invocation had already replaced it with
 * the specimen stub, so it captured the stub as "original". Unmounting the
 * harness then installed the stub as `window.fetch` PERMANENTLY, so every
 * fetch after leaving the dev route hit the specimen fixture.
 *
 * `sibling ghostGridHarness.test.tsx` never renders under
 * `<React.StrictMode>` (it renders `<App/>` directly, and App's own
 * StrictMode wrapper lives one level up in main.tsx, outside what
 * render(<App/>) exercises), so it could not have caught this — hence a
 * standalone test file that wraps the harness in StrictMode itself.
 */
import { render } from '@testing-library/react'
import React from 'react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import GhostGridHarness from '../pages/Dev/GhostGridHarness'

// The bug under test POISONS window.fetch globally on failure, so without
// this guard the first failing case would corrupt the baseline for every
// case that runs after it.
const TRUE_ORIGINAL = window.fetch
beforeEach(() => {
  window.fetch = TRUE_ORIGINAL
})
afterEach(() => {
  window.fetch = TRUE_ORIGINAL
})

function renderHarness(strict: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const tree = (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <GhostGridHarness />
      </MemoryRouter>
    </QueryClientProvider>
  )
  return render(strict ? <React.StrictMode>{tree}</React.StrictMode> : tree)
}

describe('GhostGridHarness — window.fetch restore on unmount', () => {
  it('restores the real window.fetch on unmount under StrictMode', () => {
    const realFetch = window.fetch

    const { unmount } = renderHarness(true)

    // While mounted the stub must be installed — proves this actually
    // exercises the override rather than passing vacuously.
    expect(window.fetch).not.toBe(realFetch)

    unmount()

    expect(window.fetch).toBe(realFetch)
  })

  it('restores the real window.fetch on unmount without StrictMode', () => {
    const realFetch = window.fetch

    const { unmount } = renderHarness(false)

    expect(window.fetch).not.toBe(realFetch)
    unmount()

    expect(window.fetch).toBe(realFetch)
  })
})
