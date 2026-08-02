import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import LifecycleStrip from '../pages/MediaWorkloads/LifecycleStrip'
import type { FlowStepId, FlowStepState } from '../lib/workloadFlow'

/**
 * The rail's "never colour alone" contract (Constitution Art. 11, umbrella
 * #347 WO-D1 Acceptance Criterion 8): every chip state carries text AND an
 * icon/shape cue, so a viewer who cannot distinguish the EBU identity
 * colours (or the selection ring) still gets the same information from the
 * DOM. This is a rendering test, not a visual/storybook one — it asserts on
 * the actual icon + text nodes present for each state.
 */

const LOCKED_REASONS: Record<FlowStepId, string> = {
  design: 'design locked reason',
  plan: 'plan locked reason',
  provision: 'provision locked reason',
  configure: 'configure locked reason',
  finalise: 'finalise locked reason',
}

function renderRail(overrides: {
  steps: Record<FlowStepId, FlowStepState>
  activeStep: FlowStepId
  current: FlowStepId | null
  offFlow?: boolean
  jobOwnerLabel?: string | null
  jobInFlight?: boolean
}) {
  render(
    <MemoryRouter>
      <LifecycleStrip
        steps={overrides.steps}
        activeStep={overrides.activeStep}
        current={overrides.current}
        offFlow={overrides.offFlow ?? false}
        lockedReasons={LOCKED_REASONS}
        jobOwnerLabel={overrides.jobOwnerLabel ?? null}
        jobInFlight={overrides.jobInFlight ?? false}
        onSelect={() => {}}
        slug="studio-a"
      />
    </MemoryRouter>,
  )
}

function chip(label: string): HTMLElement {
  // Interactive (button) or inert (div/a) — either way it carries the
  // explicit aria-label set on the chip itself.
  return screen.getByLabelText(label)
}

afterEach(cleanup)

describe('every non-locked, non-busy state carries an icon and a distinct text label', () => {
  it('renders a state-specific icon plus its own text for complete/open/current/record', () => {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'record',
      provision: 'open',
      configure: 'current',
      finalise: 'open',
    }
    renderRail({ steps, activeStep: 'configure', current: 'configure' })

    const expectations: Array<[FlowStepId, string]> = [
      ['design', 'Done'],
      ['plan', 'Record'],
      ['provision', 'Ready'],
      ['configure', 'Now'],
    ]
    for (const [id, text] of expectations) {
      const el = chip(LabelFor(id))
      expect(within(el).getByText(text), `${id} missing its state text`).toBeTruthy()
      expect(el.querySelector('svg'), `${id} missing an icon`).toBeTruthy()
    }
  })
})

function LabelFor(id: FlowStepId): string {
  return { design: 'Design', plan: 'Plan', provision: 'Provision', configure: 'Configure', finalise: 'Finalise & Review' }[id]
}

describe('locked state carries a lock icon, "Locked" text, and a dashed-border shape cue — never colour alone', () => {
  it('renders all three for a locked chip', () => {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'complete',
      provision: 'locked',
      configure: 'locked',
      finalise: 'locked',
    }
    renderRail({ steps, activeStep: 'design', current: null })

    const provision = chip('Provision')
    expect(within(provision).getByText('Locked')).toBeTruthy()
    expect(provision.className).toContain('border-dashed')
    expect(provision.querySelector('svg')).toBeTruthy()
    // The reason is rendered as its own text node beside the chip, not
    // folded into a colour-coded badge.
    expect(screen.getByText('provision locked reason')).toBeTruthy()

    // A locked chip is inert — no button role, so colour+shape+text is all
    // a screen reader or a colour-blind operator has, and all three agree.
    expect(within(provision).queryByRole('button')).toBeNull()
  })
})

describe('a job in flight overrides every non-locked chip\'s text to "Waiting", not just its colour', () => {
  it('shows "Waiting" text and the stated reason on every non-locked chip', () => {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'complete',
      provision: 'complete',
      configure: 'current',
      finalise: 'open',
    }
    renderRail({
      steps,
      activeStep: 'configure',
      current: 'configure',
      jobOwnerLabel: 'Configure',
      jobInFlight: true,
    })

    for (const label of ['Design', 'Plan', 'Provision', 'Configure', 'Finalise & Review']) {
      const el = chip(label)
      expect(within(el).getByText('Waiting'), `${label} missing Waiting text`).toBeTruthy()
      expect(within(el).queryByRole('button'), `${label} still interactive while busy`).toBeNull()
    }
    expect(
      screen.getAllByText('A Configure job is in progress — wait for its outcome.').length,
    ).toBeGreaterThan(0)
  })
})

describe('the Current-position and Selected text markers survive the busy non-interactive rendering (GATE-D1 acceptance note 8)', () => {
  it('keeps both markers when a job in flight demotes every chip from <button> to inert <div>', () => {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'complete',
      provision: 'current',
      configure: 'open',
      finalise: 'open',
    }
    // Selected (Design) and position (Provision) are deliberately DIFFERENT
    // chips here, so both markers have to survive independently.
    renderRail({
      steps,
      activeStep: 'design',
      current: 'provision',
      jobOwnerLabel: 'Provision',
      jobInFlight: true,
    })

    const design = chip('Design')
    expect(within(design).queryByRole('button')).toBeNull() // demoted to inert
    expect(within(design.parentElement as HTMLElement).getByText('Selected')).toBeTruthy()

    const provision = chip('Provision')
    expect(within(provision).queryByRole('button')).toBeNull()
    expect(within(provision.parentElement as HTMLElement).getByText('Current position')).toBeTruthy()
  })
})

describe('backend position and wizard selection are each their own text+icon marker', () => {
  it('current position gets its own "Current position" text+icon, independent of selection', () => {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'complete',
      provision: 'current',
      configure: 'locked',
      finalise: 'locked',
    }
    // Selected step (Design) differs from the backend position (Provision)
    // — both must be independently legible.
    renderRail({ steps, activeStep: 'design', current: 'provision' })

    const provision = chip('Provision')
    expect(within(provision.parentElement as HTMLElement).getByText('Current position')).toBeTruthy()
    expect(
      (provision.parentElement as HTMLElement).querySelectorAll('svg').length,
    ).toBeGreaterThan(1) // the chip's own state icon + the position marker's icon

    const design = chip('Design')
    expect(design.getAttribute('aria-pressed')).toBe('true')
    expect(provision.getAttribute('aria-pressed')).toBe('false')
  })

  it('the Operate/Control chip carries its own "Current position" marker when off-flow', () => {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'complete',
      provision: 'complete',
      configure: 'open',
      finalise: 'open',
    }
    renderRail({ steps, activeStep: 'finalise', current: null, offFlow: true })

    const operate = screen.getByRole('link', { name: 'Operate' })
    expect(within(operate.parentElement as HTMLElement).getByText('Current position')).toBeTruthy()
  })
})

describe('Control/Operate is structurally NOT a sixth item of the orchestration list (GATE-D1 P1.2)', () => {
  it('renders exactly five <li> in the orchestration <ol>, and Operate outside it entirely', () => {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'complete',
      provision: 'open',
      configure: 'open',
      finalise: 'open',
    }
    renderRail({ steps, activeStep: 'provision', current: 'provision' })

    const list = screen.getByRole('list')
    expect(list.tagName).toBe('OL')
    expect(list.querySelectorAll(':scope > li')).toHaveLength(5)

    const operate = screen.getByRole('link', { name: 'Operate' })
    // Not a descendant of the ordered list at all — a sibling group, not a
    // sixth ordinal item wearing a divider.
    expect(list.contains(operate)).toBe(false)
    expect(operate.closest('[role="group"]')?.getAttribute('aria-label')).toBe('Control')
  })
})
