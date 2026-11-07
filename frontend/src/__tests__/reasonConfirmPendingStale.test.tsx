/**
 * dmfdeploy/dmfdeploy#863: once a request is sent, ReasonConfirm must not tell
 * the operator to confirm again when the inventory goes stale. The pre-submit
 * guidance returns after the request settles.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import ReasonConfirm from '../components/ReasonConfirm'
import { InventoryWritesBlockedProvider } from '../lib/inventoryFreshness'

afterEach(cleanup)

const GUIDANCE = /Confirm again after the next successful read/

function panel(blocked: boolean, pending: boolean) {
  return (
    <InventoryWritesBlockedProvider value={blocked}>
      <ReasonConfirm title="T" description="D" pending={pending} onConfirm={() => {}} onCancel={() => {}} />
    </InventoryWritesBlockedProvider>
  )
}

describe('ReasonConfirm inventory guidance while pending (#863)', () => {
  it('hides the confirm-again guidance while pending and restores it after settle', () => {
    const view = render(panel(false, false))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'go' } })
    view.rerender(panel(false, true))
    expect(screen.queryByText(GUIDANCE)).toBeNull()
    // Inventory goes stale while the request is in flight.
    view.rerender(panel(true, true))
    expect(screen.queryByText(GUIDANCE)).toBeNull()
    expect(screen.queryByText(/cannot be sent right now/)).toBeNull()
    // The request settles with the inventory still stale.
    view.rerender(panel(true, false))
    expect(screen.getByText(GUIDANCE)).toBeTruthy()
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('go')
  })
})
