import { afterEach, describe, expect, it, vi } from 'vitest'
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

  // FIX ROUND (P3 round 3): the test above only ever pinned that the
  // CHIP-level opacity class was gone — it said nothing about the inner
  // state-word span, which carried the SAME opacity-70 independently and
  // was still under AA on its own (~3.95:1, see below). A comment right
  // here used to claim that span "was never the compounding half" and was
  // therefore fine; that was true of round 2's specific defect and false of
  // AA. This test computes the actual WCAG contrast ratio the state word's
  // rendered className composites to against the real design tokens
  // (src/index.css --color-muted / --color-bg — jsdom does not resolve CSS
  // custom properties or paint anything, so the token values are mirrored
  // here rather than read from a stylesheet) and pins that value, not the
  // presence or absence of any one class — so a *different* opacity
  // utility landing on this span in a future round still gets caught.
  it('the state word text composites to at least the 4.5:1 AA floor at its actual rendered opacity', () => {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'complete',
      provision: 'locked',
      configure: 'locked',
      finalise: 'locked',
    }
    renderRail({ steps, activeChip: 'design', current: null })

    const provision = chip('Provision')
    const stateWord = within(provision).getByText('Locked', { exact: false })

    expect(effectiveContrastRatio(provision, stateWord)).toBeGreaterThanOrEqual(4.5)
  })
})

// FIX ROUND (P3 round 3, P2-4): the popover escaped Topbar's clipping
// ancestor via position:fixed (P2-2 above), but `left: rect.left` with no
// viewport clamp still let a chip near the right edge place most of the
// popover's fixed 192px (w-48) width off-screen. Closing on scroll/resize
// (already tested elsewhere in this file) only handles the popover moving
// out of place after opening — it says nothing about a bad INITIAL
// placement, which is what this pins: a mocked near-right-edge trigger
// rect, and the rendered note's own inline left must still fit.
describe('the locked-reason popover stays inside the viewport for a trigger near the right edge', () => {
  it('clamps left instead of placing straight off the trigger\'s own rect.left', () => {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'complete',
      provision: 'locked',
      configure: 'locked',
      finalise: 'locked',
    }
    renderRail({ steps, activeChip: 'design', current: null })

    const toggle = screen.getByRole('button', { name: 'Why Provision is locked' })
    // jsdom's default viewport is 1024x768 — this rect models a trigger
    // sitting almost at the right edge, where an unclamped popover would
    // extend well past window.innerWidth.
    vi.spyOn(toggle, 'getBoundingClientRect').mockReturnValue({
      left: 1000,
      right: 1020,
      top: 40,
      bottom: 60,
      width: 20,
      height: 20,
      x: 1000,
      y: 40,
      toJSON: () => {},
    })
    fireEvent.click(toggle)

    const note = screen.getByRole('note')
    const left = Number(note.style.left.replace('px', ''))
    const POPOVER_WIDTH_PX = 192 // w-48, mirrored from LifecycleStrip.tsx
    expect(left + POPOVER_WIDTH_PX).toBeLessThanOrEqual(window.innerWidth)
  })
})

// --- WCAG contrast helpers -------------------------------------------------
// src/index.css: --color-bg: #0a0a0b; --color-muted: #9a9aa2. Mirrored here
// because jsdom does not resolve CSS custom properties or compute actual
// paint colours — if either token changes, this drifts out of sync and the
// test below stops meaning what it says, same honest limit as any other
// hardcoded-token test in this suite.
const BG: readonly [number, number, number] = [0x0a, 0x0a, 0x0b]
const MUTED: readonly [number, number, number] = [0x9a, 0x9a, 0xa2]

function srgbToLinear(channel: number): number {
  const c = channel / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function relativeLuminance([r, g, b]: readonly [number, number, number]): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
}

function wcagContrastRatio(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

function compositeOnBg(fg: readonly [number, number, number], alpha: number): [number, number, number] {
  return [0, 1, 2].map((i) => fg[i] * alpha + BG[i] * (1 - alpha)) as [number, number, number]
}

/** Tailwind's opacity-N utility, or 1 (fully opaque) if the element carries none. */
function tailwindOpacity(el: Element): number {
  const m = el.className.match(/\bopacity-(\d+)\b/)
  return m ? Number(m[1]) / 100 : 1
}

/**
 * The combined alpha a nested run of text actually renders at is the
 * product of every ancestor-inclusive opacity between it and `root` — walks
 * up from `leaf` and stops at (and includes) `root`, so it only accounts
 * for opacity within the subtree under test, not anything above it in the
 * page.
 */
function effectiveContrastRatio(root: Element, leaf: Element): number {
  let alpha = 1
  let node: Element | null = leaf
  while (node) {
    alpha *= tailwindOpacity(node)
    if (node === root) break
    node = node.parentElement
  }
  return wcagContrastRatio(compositeOnBg(MUTED, alpha), BG)
}

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
// FIX ROUND (WP-3 spec B gate, P3-6; corrected P3 round 3): a job-in-flight
// chip can still be the selected one, and before this fix nothing but its
// fill colour said so — every non-locked chip's text collapses to the
// identical "· Waiting" during a job, so a screen-reader/colour-blind
// operator had no way to tell the chip they're actually on apart from a
// merely-suppressed sibling. The first attempt exposed this via
// aria-pressed on the chip's inert <div> — invalid per WAI-ARIA 1.2
// (aria-pressed is defined only for role="button"), so a user agent is not
// required to expose it, and the tests below only ever proved the attribute
// was present in markup, not that it was an exposed accessibility property.
// Corrected to a visually-hidden "Selected" text node — reachable text,
// not a state attribute with no widget role to attach to.
// ---------------------------------------------------------------------------

describe('a job-in-flight chip that is also the SELECTED one still carries that in the accessibility tree', () => {
  it('exposes reachable "Selected" text on the selected chip during a job, and omits it on an unselected sibling', () => {
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
    // Not aria-pressed — that state has no valid role to attach to on a
    // non-button, so a user agent could legitimately ignore it.
    expect(provision.getAttribute('aria-pressed')).toBeNull()
    expect(within(provision).getByText('Selected')).toBeTruthy()

    // Design is complete, not selected, also inert during the job — no
    // "Selected" text renders for it.
    const design = chip('Design')
    expect(within(design).queryByText('Selected')).toBeNull()
  })

  it('never renders "Selected" text on a locked chip outside a job — it is never the selected one', () => {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'complete',
      provision: 'locked',
      configure: 'locked',
      finalise: 'locked',
    }
    renderRail({ steps, activeChip: 'design', current: null, jobInFlight: false })
    const provision = chip('Provision')
    expect(within(provision).queryByText('Selected')).toBeNull()
    expect(provision.getAttribute('aria-pressed')).toBeNull()
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
