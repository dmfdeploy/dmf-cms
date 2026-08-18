import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import FlowStep from '../pages/MediaWorkloads/FlowStep'
import type { FlowStepState } from '../lib/workloadFlow'

/**
 * FlowStep's contract as the wizard's single mounted panel (umbrella #347
 * WO-D1, GATE-B item 4's successor). The S1/Arc-B accordion this component
 * used to be (pinned/expand/collapse) is gone — the wizard mounts exactly
 * one step at a time, chosen by WorkloadSetup (the guided-flow route,
 * dmfdeploy#414 — formerly WorkloadDetail.tsx), and this component's whole
 * remaining job is: render that step's chrome + body, and render
 * Previous/Next per whatever WorkloadSetup decided is navigable.
 *
 * WHY THE LOCKED GUARD STILL GETS ITS OWN TESTS. WorkloadSetup's selection
 * logic never chooses a locked step (isStepOpenable gates it), so this guard
 * should never fire in practice — but it is defence in depth, the same
 * property the old accordion pinned: a caller bug must not be able to reach
 * a control the gate closed. These tests mount FlowStep directly with an
 * unmistakable SENTINEL child, so the assertion is about the subtree's
 * existence rather than about what any particular stage happens to render.
 */

const SENTINEL = 'flow-step-body-sentinel'

function renderStep({
  state,
  isCurrentPosition = false,
  canPrevious = false,
  canNext = false,
  onPrevious = () => {},
  onNext = () => {},
}: {
  state: FlowStepState
  isCurrentPosition?: boolean
  canPrevious?: boolean
  canNext?: boolean
  onPrevious?: () => void
  onNext?: () => void
}) {
  render(
    <FlowStep
      number={3}
      label="Provision"
      state={state}
      isCurrentPosition={isCurrentPosition}
      lockedReason="Locked because the step before it has not finished."
      canPrevious={canPrevious}
      canNext={canNext}
      onPrevious={onPrevious}
      onNext={onNext}
      previousReason="This step is locked."
      nextReason="This step is locked."
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
})

describe('an openable step always renders its body — no fold to defeat', () => {
  it('renders the body for every non-locked state, immediately', () => {
    for (const state of ['current', 'open', 'complete', 'record'] as const) {
      cleanup()
      renderStep({ state })
      expect(screen.getByTestId(SENTINEL), state).toBeTruthy()
    }
  })
})

describe('backend position is a distinct marker from mere selection', () => {
  it('shows "the workload is here now" only when isCurrentPosition is true', () => {
    renderStep({ state: 'open', isCurrentPosition: true })
    expect(screen.getByText('The workload is here now')).toBeTruthy()
  })

  it('says nothing about position when this mounted step is not it', () => {
    renderStep({ state: 'open', isCurrentPosition: false })
    expect(screen.queryByText('The workload is here now')).toBeNull()
  })
})

describe('Previous/Next are navigation-only, never a disabled control', () => {
  it('renders a real button and fires the callback when enabled', () => {
    const onPrevious = vi.fn()
    const onNext = vi.fn()
    renderStep({ state: 'open', canPrevious: true, canNext: true, onPrevious, onNext })

    fireEvent.click(screen.getByRole('button', { name: '← Previous' }))
    expect(onPrevious).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Next →' }))
    expect(onNext).toHaveBeenCalledTimes(1)
  })

  it('renders inert text naming the reason when disabled, never a disabled button', () => {
    renderStep({ state: 'open', canPrevious: false, canNext: false })
    expect(screen.queryByRole('button', { name: '← Previous' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Next →' })).toBeNull()
    expect(screen.getAllByText('This step is locked.')).toHaveLength(2)
  })
})
