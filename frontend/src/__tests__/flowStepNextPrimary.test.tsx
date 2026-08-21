/**
 * umbrella #432 §D1: FlowStep's `nextPrimary` prop, in isolation — the
 * component's own contract (Next renders `btn-primary` when true,
 * `btn-secondary` when false), independent of any particular caller's
 * reasoning about WHEN each should apply. That reasoning (Provision is the
 * only step that ever owns a top-level promoted action of its own) is
 * pinned where it's actually computed instead — createWorkload.test.tsx
 * (the draft wizard) and workloadSetup.test.tsx (the real wizard).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import FlowStep from '../pages/MediaWorkloads/FlowStep'

function renderStep(nextPrimary: boolean) {
  render(
    <FlowStep
      number={1}
      label="Design"
      state="open"
      canPrevious={false}
      canNext={true}
      onPrevious={() => {}}
      onNext={() => {}}
      nextPrimary={nextPrimary}
      previousReason="This is the first step."
      nextReason=""
    >
      <div>body</div>
    </FlowStep>,
  )
}

afterEach(cleanup)

describe('FlowStep nextPrimary', () => {
  it('renders Next as btn-primary when true', () => {
    renderStep(true)
    const next = screen.getByRole('button', { name: 'Next →' })
    expect(next.className.split(/\s+/)).toContain('btn-primary')
    expect(next.className.split(/\s+/)).not.toContain('btn-secondary')
  })

  it('renders Next as btn-secondary when false', () => {
    renderStep(false)
    const next = screen.getByRole('button', { name: 'Next →' })
    expect(next.className.split(/\s+/)).toContain('btn-secondary')
    expect(next.className.split(/\s+/)).not.toContain('btn-primary')
  })

  it('never renders Previous as primary, regardless of nextPrimary', () => {
    render(
      <FlowStep
        number={2}
        label="Plan"
        state="open"
        canPrevious={true}
        canNext={false}
        onPrevious={() => {}}
        onNext={() => {}}
        nextPrimary={true}
        previousReason=""
        nextReason="This is the last step."
      >
        <div>body</div>
      </FlowStep>,
    )
    const previous = screen.getByRole('button', { name: '← Previous' })
    expect(previous.className.split(/\s+/)).toContain('btn-secondary')
    expect(previous.className.split(/\s+/)).not.toContain('btn-primary')
  })
})
