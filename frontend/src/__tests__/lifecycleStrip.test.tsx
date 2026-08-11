import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import LifecycleStrip from '../pages/MediaWorkloads/LifecycleStrip'
import type { FlowStepId, FlowStepState } from '../lib/workloadFlow'

/**
 * The rail's "never colour alone" contract (Constitution Art. 11, umbrella
 * #347 WO-D1 Acceptance Criterion 8, carried forward through the Arc 4
 * WP-3 rail-treatment ruling): every chip state carries text AND an
 * icon/shape cue, so a viewer who cannot distinguish the selected chip's
 * fill (or the ring) still gets the same information from the DOM. This is
 * a rendering test, not a visual/storybook one — it asserts on the actual
 * icon + text nodes present for each state.
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
  activeChip: FlowStepId | 'operate' | null
  current: FlowStepId | null
  offFlow?: boolean
  jobOwnerLabel?: string | null
  jobInFlight?: boolean
}) {
  render(
    <MemoryRouter>
      <LifecycleStrip
        steps={overrides.steps}
        activeChip={overrides.activeChip}
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
    renderRail({ steps, activeChip: 'configure', current: 'configure' })

    const expectations: Array<[FlowStepId, string]> = [
      ['design', 'Done'],
      ['plan', 'Record'],
      ['provision', 'Ready'],
      ['configure', 'Now'],
    ]
    for (const [id, text] of expectations) {
      const el = chip(LabelFor(id))
      expect(within(el).getByText(text, { exact: false }), `${id} missing its state text`).toBeTruthy()
      expect(el.querySelector('svg'), `${id} missing an icon`).toBeTruthy()
    }
  })
})

function LabelFor(id: FlowStepId): string {
  return { design: 'Design', plan: 'Plan', provision: 'Provision', configure: 'Configure', finalise: 'Finalise & Review' }[id]
}

describe('locked state carries a lock icon, "Locked" text, and a dashed-border shape cue — never colour alone', () => {
  it('renders all three for a locked chip, with its reason behind a keyboard/tap-operable toggle, not a permanent caption', () => {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'complete',
      provision: 'locked',
      configure: 'locked',
      finalise: 'locked',
    }
    renderRail({ steps, activeChip: 'design', current: null })

    const provision = chip('Provision')
    expect(within(provision).getByText('Locked', { exact: false })).toBeTruthy()
    expect(provision.className).toContain('border-dashed')
    expect(provision.querySelector('svg')).toBeTruthy()

    // A locked chip is inert — no button role, so colour+shape+text is all
    // a screen reader or a colour-blind operator has, and all three agree.
    expect(within(provision).queryByRole('button')).toBeNull()

    // The reason is NOT a permanent caption (would not fit a single-line
    // row) — it is not in the DOM at all until the toggle is activated,
    // and it is a real, keyboard-operable button, not a title= tooltip.
    expect(screen.queryByText('provision locked reason')).toBeNull()
    const toggle = screen.getByRole('button', { name: 'Why Provision is locked' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(screen.getByText('provision locked reason')).toBeTruthy()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })

  // FIX ROUND (WP-3 spec B gate, P2-5): a locked chip's own opacity used to
  // stack on top of the inner state-word span's identical opacity — two
  // multipliers compounding well under the 4.5:1 AA floor for text
  // (measured: ~3.96:1 from the chip's own opacity alone, ~2.50:1 once the
  // inner span's stacks on it). jsdom cannot compute an actual contrast
  // ratio, so this pins the structural fact the fix rests on: a locked
  // chip's OWN opacity is gone, leaving it at the same muted-text treatment
  // every inactive chip already uses — the inner state-word span's own
  // opacity-70 is unchanged (that one was never the compounding half).
  it('does not dim a locked chip a second time on top of the state word\'s own opacity', () => {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'complete',
      provision: 'locked',
      configure: 'locked',
      finalise: 'locked',
    }
    renderRail({ steps, activeChip: 'design', current: null })

    const provision = chip('Provision')
    expect(provision.className).not.toMatch(/\bopacity-\d+\b/)
    // The dashed border + lock glyph + "Locked" text stay as the designed,
    // non-colour cue — this fix removes the SECOND opacity multiplier, not
    // the chip's other distinguishing treatment.
    expect(provision.className).toContain('border-dashed')
  })
})

describe('a job in flight overrides every non-locked chip\'s text to "Waiting", not just its colour', () => {
  it('shows "Waiting" text on every non-locked chip and ONE shared reason note for the row', () => {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'complete',
      provision: 'complete',
      configure: 'current',
      finalise: 'open',
    }
    renderRail({
      steps,
      activeChip: 'configure',
      current: 'configure',
      jobOwnerLabel: 'Configure',
      jobInFlight: true,
    })

    for (const label of ['Design', 'Plan', 'Provision', 'Configure', 'Finalise & Review']) {
      const el = chip(label)
      expect(within(el).getByText('Waiting', { exact: false }), `${label} missing Waiting text`).toBeTruthy()
      expect(within(el).queryByRole('button'), `${label} still interactive while busy`).toBeNull()
    }
    // ONE shared note for the whole row, not the same sentence repeated
    // under every chip (the old per-chip repetition said the identical
    // thing five times).
    expect(
      screen.getAllByText('A Configure job is in progress — wait for its outcome.').length,
    ).toBe(1)
  })
})

describe('backend position and wizard selection are each their own signal', () => {
  it('the selected chip is inverted (bg-text/text-bg) and aria-pressed, independent of position', () => {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'complete',
      provision: 'current',
      configure: 'locked',
      finalise: 'locked',
    }
    // Selected step (Design) differs from the backend position (Provision)
    // — both must be independently legible.
    renderRail({ steps, activeChip: 'design', current: 'provision' })

    const design = chip('Design')
    expect(design.getAttribute('aria-pressed')).toBe('true')
    expect(design.className).toContain('bg-text')
    expect(design.className).toContain('text-bg')

    const provision = chip('Provision')
    expect(provision.getAttribute('aria-pressed')).toBe('false')
    expect(provision.className).not.toContain('bg-text')
    expect(provision.className).toContain('text-muted')
  })

  it('the backend position gets its own same-line "Position" text+icon marker, even on a chip that is not selected', () => {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'complete',
      provision: 'current',
      configure: 'locked',
      finalise: 'locked',
    }
    renderRail({ steps, activeChip: 'design', current: 'provision' })

    const provision = chip('Provision')
    expect(within(provision).getByText('Position')).toBeTruthy()
    expect(provision.querySelectorAll('svg').length).toBeGreaterThan(1) // state icon + position icon

    const design = chip('Design')
    expect(within(design).queryByText('Position')).toBeNull()
  })

  it('the Position marker survives the busy non-interactive rendering (chip demoted from <button> to inert <div>)', () => {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'complete',
      provision: 'current',
      configure: 'open',
      finalise: 'open',
    }
    renderRail({
      steps,
      activeChip: 'design',
      current: 'provision',
      jobOwnerLabel: 'Provision',
      jobInFlight: true,
    })

    const provision = chip('Provision')
    expect(within(provision).queryByRole('button')).toBeNull() // demoted to inert
    expect(within(provision).getByText('Position')).toBeTruthy()
  })

  it('the Operate/Control chip carries its own "Position" marker when off-flow, and is inverted when selected', () => {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'complete',
      provision: 'complete',
      configure: 'open',
      finalise: 'open',
    }
    renderRail({ steps, activeChip: 'operate', current: null, offFlow: true })

    const operate = screen.getByRole('link', { name: 'Operate' })
    expect(within(operate.parentElement as HTMLElement).getByText('Position')).toBeTruthy()
    expect(operate.className).toContain('bg-text')
  })
})

describe('colour now tracks SELECTION, not stage identity (Arc 4 rail-treatment ruling, umbrella #347)', () => {
  it('every non-selected chip (including Operate) is neutral — no fill, muted text', () => {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'open',
      plan: 'open',
      provision: 'open',
      configure: 'open',
      finalise: 'open',
    }
    renderRail({ steps, activeChip: 'design', current: null })

    for (const id of ['plan', 'provision', 'configure', 'finalise'] as FlowStepId[]) {
      const el = chip(LabelFor(id))
      expect(el.className, `${id} should be neutral`).toContain('text-muted')
      expect(el.className, `${id} should carry no inverted fill`).not.toContain('bg-text')
    }
    const operate = screen.getByRole('link', { name: 'Operate' })
    expect(operate.className).toContain('text-muted')
    expect(operate.className).not.toContain('bg-text')

    // Cyan (the action accent) never appears on the rail — it would make
    // the promoted primary action ambiguous with "where you are".
    for (const id of ['design', 'plan', 'provision', 'configure', 'finalise'] as FlowStepId[]) {
      expect(chip(LabelFor(id)).className).not.toContain('accent')
    }
    expect(operate.className).not.toContain('accent')
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
    renderRail({ steps, activeChip: 'provision', current: 'provision' })

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

// ---------------------------------------------------------------------------
// FIX ROUND (WP-3 spec B gate, P3-6): a job-in-flight chip can still be the
// selected one, and before this fix nothing but its fill colour said so —
// every non-locked chip's text collapses to the identical "· Waiting" during
// a job, so a screen-reader/colour-blind operator had no way to tell the
// chip they're actually on apart from a merely-suppressed sibling.
// ---------------------------------------------------------------------------

describe('a job-in-flight chip that is also the SELECTED one still carries that in the accessibility tree', () => {
  it('exposes aria-pressed on the selected chip during a job, and omits it on an unselected sibling', () => {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'complete',
      provision: 'current',
      configure: 'locked',
      finalise: 'locked',
    }
    renderRail({ steps, activeChip: 'provision', current: 'provision', jobInFlight: true })

    const provision = chip('Provision')
    // Still inert — this must NOT reintroduce a button role (the whole
    // rest of this suite's "job in flight -> nothing is reachable" pins
    // rely on that absence).
    expect(provision.closest('li')?.querySelector('[role="button"]')).toBeNull()
    expect(provision.getAttribute('aria-pressed')).toBe('true')

    // Design is complete, not selected, also inert during the job — it
    // gets the explicit false, same as the interactive button variant
    // already sets for every unselected chip, not an absent attribute.
    const design = chip('Design')
    expect(design.getAttribute('aria-pressed')).toBe('false')
  })

  it('never sets aria-pressed on a locked chip — it is never the selected one', () => {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'complete',
      provision: 'locked',
      configure: 'locked',
      finalise: 'locked',
    }
    renderRail({ steps, activeChip: 'design', current: null, jobInFlight: false })
    expect(chip('Provision').getAttribute('aria-pressed')).toBeNull()
  })
})

describe('the Operate link\'s aria-current tracks SELECTION, not just backend POSITION', () => {
  it('carries aria-current when Operate is the selected chip, even for a workload not actually at Operate', () => {
    // offFlow: false — the workload's own position is NOT Operate — but
    // activeChip: 'operate' — the operator is looking at /operate anyway
    // (reachable by direct navigation; Operate.tsx always passes
    // activeChip: 'operate' regardless of position). Before this fix,
    // aria-current was keyed to offFlow alone, so this exact, reachable
    // case rendered the inverted "selected" fill with NO aria-current at
    // all.
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'complete',
      provision: 'current',
      configure: 'locked',
      finalise: 'locked',
    }
    renderRail({ steps, activeChip: 'operate', current: 'provision', offFlow: false })

    const operate = screen.getByRole('link', { name: 'Operate' })
    expect(operate.getAttribute('aria-current')).toBe('page')
    expect(operate.className).toContain('bg-text')
  })

  it('carries no aria-current when a flow chip, not Operate, is selected — even if the workload IS at Operate', () => {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'complete',
      provision: 'complete',
      configure: 'complete',
      finalise: 'open',
    }
    renderRail({ steps, activeChip: 'design', current: null, offFlow: true })

    const operate = screen.getByRole('link', { name: 'Operate' })
    expect(operate.getAttribute('aria-current')).toBeNull()
    // The POSITION fact survives independently — the same-line "Position"
    // badge, unconditional on offFlow, not on aria-current.
    expect(within(operate.closest('[role="group"]') as HTMLElement).getByText('Position')).toBeTruthy()
  })
})
