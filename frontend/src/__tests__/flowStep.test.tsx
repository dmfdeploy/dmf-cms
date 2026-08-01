import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import FlowStep from '../pages/MediaWorkloads/FlowStep'
import type { FlowStepState } from '../lib/workloadFlow'

/**
 * FlowStep's disclosure contract, unit-tested (umbrella #285, GATE-B item 4).
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE PAGE TESTS. The page tests
 * asserted "a locked step renders no BUTTON", which is weaker than the
 * invariant actually claimed in FlowStep's docstring — that a locked step
 * renders no BODY AT ALL, so nothing inside it is reachable by a keyboard or
 * a screen reader. A mutant that made a locked step render its children
 * survived the page tests, because the particular stage panels those tests
 * mount happen to contain no button when they carry no action. The gap was
 * real: "no button in this fixture" is a property of the fixture, not of the
 * component.
 *
 * These tests mount FlowStep directly with an unmistakable SENTINEL child,
 * so the assertion is about the subtree's existence rather than about what
 * any particular stage happens to render into it.
 */

const SENTINEL = 'flow-step-body-sentinel'

function renderStep({
  state,
  pinned,
  startExpanded,
}: {
  state: FlowStepState
  pinned?: boolean
  startExpanded?: boolean
}) {
  render(
    <FlowStep
      number={3}
      label="Provision"
      state={state}
      pinned={pinned}
      startExpanded={startExpanded}
      lockedReason="Locked because the step before it has not finished."
    >
      <div data-testid={SENTINEL}>
        <button type="button">Dangerous action</button>
      </div>
    </FlowStep>,
  )
}

afterEach(cleanup)

describe('a locked step renders no body subtree at all', () => {
  it('omits the children entirely — not merely visually hidden', () => {
    renderStep({ state: 'locked' })
    // THE discriminating assertion: the subtree is absent from the DOM.
    expect(screen.queryByTestId(SENTINEL)).toBeNull()
    // And therefore nothing inside it is reachable.
    expect(screen.queryByRole('button', { name: 'Dangerous action' })).toBeNull()
    // The reason IS rendered — a lock without a stated reason would be a
    // disabled button wearing prose (Art. 8).
    expect(screen.getByText(/Locked because the step before it has not finished/)).toBeTruthy()
  })

  it('offers no control that could expand a locked step', () => {
    renderStep({ state: 'locked' })
    // No Review affordance: the gate is not a fold the operator can defeat.
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Hide' })).toBeNull()
  })

  it('stays closed even when a fragment link asks for it to start expanded', () => {
    // startExpanded is how the Operate page's #configure link lands the
    // operator on the Configure step. It must never become a way to open a
    // step the gate closed — a crafted URL is untrusted input.
    renderStep({ state: 'locked', startExpanded: true })
    expect(screen.queryByTestId(SENTINEL)).toBeNull()
  })

  it('stays closed even if a caller wrongly pins a locked step', () => {
    // Defence in depth: `pinned` governs disclosure, `state` governs
    // reachability, and reachability wins. A caller bug must not be able to
    // render the body of a step the classifier locked.
    renderStep({ state: 'locked', pinned: true })
    expect(screen.queryByTestId(SENTINEL)).toBeNull()
  })
})

describe('an openable step renders its body when it should', () => {
  it('renders the body immediately when pinned', () => {
    renderStep({ state: 'current', pinned: true })
    expect(screen.getByTestId(SENTINEL)).toBeTruthy()
    // Pinned is not collapsible — the thing you are being asked to do must
    // not be foldable away.
    expect(screen.queryByRole('button', { name: 'Hide' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull()
  })

  it('folds a non-pinned openable step but reveals it on Review', () => {
    renderStep({ state: 'open' })
    expect(screen.queryByTestId(SENTINEL)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    expect(screen.getByTestId(SENTINEL)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    expect(screen.queryByTestId(SENTINEL)).toBeNull()
  })

  it('keeps a completed step reviewable', () => {
    // Operator direction: completed stages remain reviewable.
    renderStep({ state: 'complete' })
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    expect(screen.getByTestId(SENTINEL)).toBeTruthy()
  })

  it('keeps a record step reviewable on an unreadable position', () => {
    renderStep({ state: 'record' })
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    expect(screen.getByTestId(SENTINEL)).toBeTruthy()
  })

  it('starts a fragment-targeted step expanded', () => {
    renderStep({ state: 'open', startExpanded: true })
    expect(screen.getByTestId(SENTINEL)).toBeTruthy()
  })
})
