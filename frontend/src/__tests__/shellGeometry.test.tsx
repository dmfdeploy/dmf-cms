/**
 * dmfdeploy/dmfdeploy#610. The shell owns scroll, focus and the overlay
 * layer. These cases cover what jsdom can see: the containing block, the
 * route-change reset, the skip link, the reserved rail row and the modal's
 * portal and backdrop rule. Geometry itself (overlap, stacking, clipping) is
 * checked in a real browser by e2e/shell-defects.spec.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import Shell from '../components/Shell'
import InstanceLiveModal from '../pages/MediaWorkloads/InstanceLiveModal'
import { useAuthStore } from '../store/auth'
import type { MediaWorkloadInstance, UserIdentity } from '../api/types'

function identity(): UserIdentity {
  return {
    subject: 'ops',
    display_name: 'Ops',
    email: 'ops@dmf.example.com',
    role: 'engineer',
    real_role: 'engineer',
    view_as_active: false,
    groups: [],
    awx_configured: true,
    authentik_configured: true,
  }
}

function renderShellAt(path: string) {
  useAuthStore.getState().setUser(identity())
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })),
  )
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<Shell />}>
            <Route path="/" element={<><h1>Workspace</h1><Link to="/other">go</Link></>} />
            <Route path="/other" element={<h1>Other page</h1>} />
            <Route path="/media-workloads/:slug" element={<h1>Workload</h1>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  useAuthStore.getState().setUser(null)
})

describe('Shell owns the scroll container', () => {
  it('makes <main> the containing block and the scroll container', () => {
    renderShellAt('/')
    const main = screen.getByRole('main')
    expect(main.className).toMatch(/\brelative\b/)
    expect(main.className).toMatch(/\boverflow-y-auto\b/)
    expect(main.id).toBe('main-content')
  })
})

describe('Shell on a route change', () => {
  it('leaves focus alone on first load', () => {
    renderShellAt('/')
    expect(screen.getByRole('main').contains(document.activeElement)).toBe(false)
  })

  it('resets the scroll of <main> and focuses the new page heading', () => {
    renderShellAt('/')
    const main = screen.getByRole('main')
    const scrollTo = vi.fn()
    main.scrollTo = scrollTo as unknown as typeof main.scrollTo
    act(() => {
      fireEvent.click(screen.getByRole('link', { name: 'go' }))
    })
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'instant' })
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Other page' }))
  })
})

describe('skip link', () => {
  it('is the first link in the document and moves focus to the page heading', () => {
    renderShellAt('/')
    const skip = screen.getByRole('link', { name: 'Skip to main content' })
    expect(document.querySelector('a')).toBe(skip)
    fireEvent.click(skip)
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Workspace' }))
  })
})

describe('header-slot space', () => {
  it('is held on a workload route before the rail registers', () => {
    renderShellAt('/media-workloads/studio-a')
    expect(screen.getByTestId('header-slot-reserve')).toBeTruthy()
    expect(screen.queryByTestId('header-slot-row')).toBeNull()
  })

  it('is not held on other routes', () => {
    renderShellAt('/')
    expect(screen.queryByTestId('header-slot-reserve')).toBeNull()
  })
})

describe('InstanceLiveModal overlay layer', () => {
  const instance = {
    instance: 'mxl-a',
    live_view: false,
    placement: { node: 'node-a' },
  } as unknown as MediaWorkloadInstance

  function renderModal(onClose: () => void) {
    render(
      <main data-testid="host">
        <InstanceLiveModal instance={instance} displayName="Viewer" onClose={onClose} unavailable />
      </main>,
    )
    return screen.getByTestId('instance-live-modal')
  }

  it('renders outside the component tree it was opened from', () => {
    renderModal(() => {})
    expect(screen.getByTestId('instance-live-modal').closest('[data-testid="host"]')).toBeNull()
    expect(screen.getByTestId('instance-live-modal').parentElement).toBe(document.body)
  })

  it('closes on a press and release that both land on the backdrop', () => {
    const onClose = vi.fn()
    const dialog = renderModal(onClose)
    fireEvent.mouseDown(dialog)
    fireEvent.click(dialog)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('stays open when the press started inside the panel and ended on the backdrop', () => {
    const onClose = vi.fn()
    const dialog = renderModal(onClose)
    fireEvent.mouseDown(dialog.firstElementChild!)
    fireEvent.click(dialog)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('stays open on a click inside the panel', () => {
    const onClose = vi.fn()
    const dialog = renderModal(onClose)
    const panel = dialog.firstElementChild!
    fireEvent.mouseDown(panel)
    fireEvent.click(panel)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('caps the panel to the viewport and scrolls inside it', () => {
    const dialog = renderModal(() => {})
    const panel = dialog.firstElementChild!
    expect(panel.className).toMatch(/\bmax-h-full\b/)
    expect(panel.className).toMatch(/\boverflow-y-auto\b/)
  })
})
