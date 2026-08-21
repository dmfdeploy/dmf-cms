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
})
