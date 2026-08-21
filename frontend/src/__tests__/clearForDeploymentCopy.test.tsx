/**
 * dmfdeploy/dmfdeploy#411: the Clear for deployment confirm panel used to
 * tell the operator that "the platform's automation lane will deploy it" —
 * no such lane exists (zero AWX schedules registered anywhere, and the
 * drift playbook that could reconcile it has no job template, so nothing
 * runs it automatically). Pins the corrected copy verbatim and asserts the
 * retired claim is gone.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import ClearForDeployment from '../pages/MediaWorkloads/ClearForDeployment'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ClearForDeployment confirm panel copy', () => {
  it('states what actually happens — recorded intent, pending until Provision deploys it — and names no automation lane', () => {
    render(
      <ClearForDeployment instance="mxl-videotestsrc" onConfirm={vi.fn()} />,
    )
    fireEvent.click(screen.getByText('Clear for deployment'))

    expect(
      screen.getByText(
        "This records the intent to run in the facility source of truth. It shows as pending reconciliation until something deploys it — today, that's Provision. This action does not deploy anything itself.",
      ),
    ).toBeTruthy()
    expect(screen.queryByText(/automation lane/i)).toBeNull()
  })

  // umbrella #432 §C — the shared form-field primitive (components/FormField.tsx).
  it('renders the reason textarea through the shared .field primitive', () => {
    render(<ClearForDeployment instance="mxl-videotestsrc" onConfirm={vi.fn()} />)
    fireEvent.click(screen.getByText('Clear for deployment'))
    const textarea = screen.getByPlaceholderText(/Reason \(required/)
    expect(textarea.className.split(/\s+/)).toContain('field')
  })

  // umbrella #432, FIX ROUND (operator report: "too much small text").
  // Same scale bump as ReasonConfirm.tsx's own popover, in this separate
  // component that duplicates the same shell.
  it('raises the panel width floor and the title/field scale off the old dense defaults', () => {
    render(<ClearForDeployment instance="mxl-videotestsrc" onConfirm={vi.fn()} />)
    fireEvent.click(screen.getByText('Clear for deployment'))

    const title = screen.getByText('Clear mxl-videotestsrc for deployment?')
    const panel = title.parentElement as HTMLElement
    expect(panel.className).toMatch(/\bmin-w-80\b/)
    expect(panel.className).not.toMatch(/min-w-64/)
    expect(title.className).toMatch(/\btext-sm\b/)
    expect(title.className).not.toMatch(/text-xs/)

    const textarea = screen.getByPlaceholderText(/Reason \(required/)
    expect(textarea.className.split(/\s+/)).not.toContain('field-xs')
  })

  // umbrella #432, FIX ROUND (0.28.0 walk finding): same max-width cap as
  // ReasonConfirm.tsx's own popover, and the same honest limit — see that
  // test's own comment. jsdom cannot measure rendered width, so this pins
  // the class contract only, not the actual layout; the walk is what
  // verifies the layout.
  it('carries the same max-width utility as ReasonConfirm.tsx', () => {
    render(<ClearForDeployment instance="mxl-videotestsrc" onConfirm={vi.fn()} />)
    fireEvent.click(screen.getByText('Clear for deployment'))
    const panel = screen.getByText('Clear mxl-videotestsrc for deployment?').parentElement as HTMLElement
    expect(panel.className).toMatch(/\bmax-w-sm\b/)
  })
})
