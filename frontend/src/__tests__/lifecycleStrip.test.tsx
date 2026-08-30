import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import LifecycleStrip from '../pages/MediaWorkloads/LifecycleStrip'
import { FLOW_STEPS, type FlowStepId, type FlowStepState } from '../lib/workloadFlow'

/**
 * The rail's "never colour alone" contract (Constitution Art. 11, umbrella
 * #347 WO-D1 Acceptance Criterion 8).
 *
 * SHELL ROUND 2 (dmfdeploy#481/#482/#483) rewrote this file's fixtures and
 * most of its assertions — see LifecycleStrip.tsx's own docstring for the
 * full account of what changed. Per-fact status, stated plainly for the
 * CURRENT design:
 *   - IDENTITY (stage): a permanent hue (RAIL_FILL) PLUS an always-present
 *     icon PLUS the always-present EBU label — three independent carriers,
 *     two of which (icon, label) are pure shape/text and survive greyscale
 *     and total colour-blindness alike, not merely CVD.
 *   - LOCKED: a genuinely NEW state as of this round. Pass 2's dashed
 *     border and padlock icon are BOTH GONE — the Visual System doc §2
 *     rejects any fill/edge distinction for stage STATE at all (identity
 *     and selection are the only two axes fill/edge may vary on). A locked
 *     key is now visually IDENTICAL to an open key of the same stage; the
 *     only surviving non-colour cue is the `aria-describedby` reason text,
 *     which is words, not a glyph — see LifecycleStrip.tsx's own docstring.
 *   - POSITION: passes cleanly — the tally bar is a real shape (a bar,
 *     present or absent) for sighted users, `aria-current="step"` for
 *     assistive tech; never colour.
 *   - SELECTION: the achromatic bg-text/text-bg inversion, unchanged from
 *     every prior pass.
 * This file is a rendering test, not a visual/storybook one — it asserts on
 * the actual DOM nodes and attributes present for each fact, not on how
 * the page looks. The chevron geometry itself (notch depth, gap, contrast)
 * is NOT this file's concern — jsdom computes no pixels; that is what
 * pages/Dev/LifecycleRailHarness.tsx plus a real-browser measurement pass
 * exist for (see the PR description).
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
  activeChip: FlowStepId | null
  current: FlowStepId | null
  jobInFlight?: boolean
  onSelect?: (step: FlowStepId) => void
}) {
  render(
    <MemoryRouter>
      <LifecycleStrip
        steps={overrides.steps}
        activeChip={overrides.activeChip}
        current={overrides.current}
        lockedReasons={LOCKED_REASONS}
        jobInFlight={overrides.jobInFlight ?? false}
        onSelect={overrides.onSelect ?? (() => {})}
      />
    </MemoryRouter>,
  )
}

function chip(label: string): HTMLElement {
  // Interactive (button) or inert (div/a) — either way it carries the
  // explicit aria-label set on the chip itself.
  return screen.getByLabelText(label)
}

/** The chip's clipped fill layer (SHELL ROUND 2) — carries the fill/edge
 *  colour classes and the position tally; the outer chip element itself
 *  stays transparent so the chevron notch/point actually shows the page
 *  behind it rather than a rectangular background masking the cutout. */
function fillLayer(chipEl: HTMLElement): HTMLElement {
  return chipEl.querySelector('[data-testid="key-fill"]') as HTMLElement
}

/** umbrella dmf-cms#391: the tally bar is a decorative, aria-hidden child —
 *  queried structurally (data-testid) rather than by text, since it carries
 *  none. */
function hasTally(chipEl: HTMLElement): boolean {
  return chipEl.querySelector('[data-testid="position-tally"]') !== null
}

function LabelFor(id: FlowStepId): string {
  return { design: 'Design', plan: 'Plan', provision: 'Provision', configure: 'Configure', finalise: 'Finalise & Review' }[id]
}

afterEach(cleanup)

// SHELL ROUND 2 (dmfdeploy#482): every key now renders its own identity
// icon UNCONDITIONALLY — the exact opposite of Pass 1's "no per-state icon
// at all" invariant this describe block used to pin. Rewritten to pin the
// new invariant: one <svg> per key, aria-hidden, alongside the unchanged
// bare EBU label text.
describe('every key renders its own identity icon plus its bare EBU label, regardless of state', () => {
  it('renders the EBU label text and exactly one aria-hidden <svg> icon for every state', () => {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'record',
      provision: 'open',
      configure: 'current',
      finalise: 'locked',
    }
    renderRail({ steps, activeChip: 'configure', current: 'configure' })

    for (const id of FLOW_STEPS) {
      const el = chip(LabelFor(id))
      // The EBU label is still the only VISIBLE text this chip carries — no
      // "Done"/"Ready"/"Now"/"Record" state word exists anywhere in the
      // markup, no matter what state the step is actually in.
      expect(within(el).getByText(LabelFor(id)), `${id} missing its EBU label text`).toBeTruthy()
      const icons = el.querySelectorAll('svg')
      expect(icons.length, `${id} should carry exactly one identity icon`).toBe(1)
      expect(icons[0].getAttribute('aria-hidden'), `${id}'s icon must be aria-hidden`).toBe('true')
    }
  })

  // dmfdeploy#482's own constraint: the icon must never fold into the
  // key's accessible NAME — every test in this suite addresses keys by the
  // bare label, and an icon-derived name addition would break that suite
  // wholesale.
  it('keeps the accessible name exactly the bare EBU label on every key', () => {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'complete',
      provision: 'locked',
      configure: 'open',
      finalise: 'current',
    }
    renderRail({ steps, activeChip: 'finalise', current: 'finalise' })

    for (const id of FLOW_STEPS) {
      expect(chip(LabelFor(id)).getAttribute('aria-label')).toBe(LabelFor(id))
    }
  })
})

// SHELL ROUND 2: the padlock icon, the dashed border, and the "Locked" text
// caption are ALL gone (LifecycleStrip.tsx's own docstring — the Visual
// System doc §2 rejects any fill/edge distinction for stage STATE, locked
// included). What survives from dmfdeploy#405 unchanged: a locked key is
// still REACHABLE, still a real <button>, still selects on click and still
// mounts its reason via aria-describedby — none of that behaviour moved,
// only its visual presentation did.
describe('locked state is reachable, and its only surviving non-colour cue is the description text (dmfdeploy#405, Shell Round 2)', () => {
  it('is a real button, identical in fill/icon to an open key of the same stage, and reports its reason via aria-describedby', () => {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'complete',
      provision: 'locked',
      configure: 'locked',
      finalise: 'locked',
    }
    const onSelect = vi.fn()
    renderRail({ steps, activeChip: 'design', current: null, onSelect })

    const provision = chip('Provision')
    expect(provision.tagName).toBe('BUTTON')

    // No padlock — every key's <svg> is its stage identity icon, never a
    // lock glyph (dmfdeploy#482, IA doc #493 amendment).
    expect(provision.querySelectorAll('svg').length).toBe(1)

    // dmfdeploy#405, the behaviour change, unchanged by this round.
    fireEvent.click(provision)
    expect(onSelect).toHaveBeenCalledWith('provision')

    // The reason is NOT visible chrome on the row — it reaches assistive
    // tech as the key's DESCRIPTION.
    const describedBy = provision.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy as string)?.textContent).toContain('provision locked reason')
  })

  it('carries no aria-describedby at all when not locked — the description exists only to state the locked reason', () => {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'open',
      provision: 'current',
      configure: 'locked',
      finalise: 'locked',
    }
    renderRail({ steps, activeChip: 'design', current: 'provision' })

    for (const id of ['design', 'plan', 'provision'] as FlowStepId[]) {
      expect(chip(LabelFor(id)).getAttribute('aria-describedby'), `${id} should carry no description`).toBeNull()
    }
  })

  it('renders the SAME fill class as an open key of the same stage — locked carries no distinct fill/edge treatment', () => {
    const lockedSteps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'complete',
      provision: 'locked',
      configure: 'open',
      finalise: 'open',
    }
    renderRail({ steps: lockedSteps, activeChip: 'design', current: null })
    const lockedFill = fillLayer(chip('Provision')).className

    cleanup()

    const openSteps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'complete',
      provision: 'open',
      configure: 'open',
      finalise: 'open',
    }
    renderRail({ steps: openSteps, activeChip: 'design', current: null })
    const openFill = fillLayer(chip('Provision')).className

    expect(lockedFill).toBe(openFill)
  })
})

// SHELL ROUND 2 (dmfdeploy#481, folding in dmfdeploy#499's acceptance
// criteria): the shared "A <stage> job is in progress." note that used to
// follow the <ol> is deleted outright, not relocated — the band now
// carries zero status text while a job is in flight. What survives
// unchanged: jobInFlight still demotes every key to an inert <div>, and the
// per-key EBU label is still untouched by it.
describe('a job in flight demotes every chip to inert, and the band states no status text about it', () => {
  it('keeps each chip a plain inert <div> with its own EBU label, and mounts no in-progress note anywhere in the nav', () => {
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
      jobInFlight: true,
    })

    for (const label of ['Design', 'Plan', 'Provision', 'Configure', 'Finalise & Review']) {
      const el = chip(label)
      expect(within(el).getByText(label), `${label} missing its own label text`).toBeTruthy()
      expect(el.tagName, `${label} chip root itself must not be a <button> while busy`).toBe('DIV')
      expect(within(el).queryByRole('button'), `${label} still interactive while busy`).toBeNull()
    }

    // dmfdeploy#481/#499: zero status text in the band, full stop — no
    // "job is in progress" sentence anywhere, and no role="status" node at
    // all (the readout it used to share a row with is gone too).
    const nav = screen.getByRole('navigation', { name: 'Media workload lifecycle' })
    expect(within(nav).queryByText(/job is in progress/i)).toBeNull()
    expect(within(nav).queryByRole('status')).toBeNull()
  })
})

describe('backend position and wizard selection are each their own signal', () => {
  it('the selected chip inverts its fill and ink (bg-text/text-bg) and is aria-pressed, independent of position', () => {
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
    // Ink lives on the chip element itself; fill lives on its clipped
    // layer (see this file's own fillLayer() helper docstring) — SHELL
    // ROUND 2's chevron shape needs the outer chip to stay unfilled so the
    // notch/point cutout is actually visible, not masked by a rectangular
    // background.
    expect(design.className).toContain('text-bg')
    expect(fillLayer(design).className).toContain('bg-text')

    const provision = chip('Provision')
    expect(provision.getAttribute('aria-pressed')).toBe('false')
    expect(provision.className).not.toContain('text-bg')
    expect(fillLayer(provision).className).not.toContain('bg-text')
  })

  it('the backend position gets its own tally bar, even on a chip that is not selected', () => {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'complete',
      provision: 'current',
      configure: 'locked',
      finalise: 'locked',
    }
    renderRail({ steps, activeChip: 'design', current: 'provision' })

    const provision = chip('Provision')
    expect(hasTally(provision), 'Provision (position, not selected) should carry a tally bar').toBe(true)
    expect(provision.getAttribute('aria-current')).toBe('step')

    const design = chip('Design')
    expect(hasTally(design), 'Design (neither position nor selected) should carry no tally bar').toBe(false)
  })

  it('withholds the tally bar when the selected chip IS the position — the fill alone already says so', () => {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'complete',
      provision: 'current',
      configure: 'locked',
      finalise: 'locked',
    }
    // Selected AND position both land on Provision this time.
    renderRail({ steps, activeChip: 'provision', current: 'provision' })

    const provision = chip('Provision')
    expect(fillLayer(provision).className).toContain('bg-text') // still visibly selected
    expect(hasTally(provision), 'a converged selected+position key should carry no tally bar').toBe(false)
    expect(provision.getAttribute('aria-current')).toBe('step')
  })

  it('the tally bar survives the busy non-interactive rendering (chip demoted from <button> to inert <div>)', () => {
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
      jobInFlight: true,
    })

    const provision = chip('Provision')
    expect(provision.tagName, 'demoted to inert — chip root itself must be a <div>').toBe('DIV')
    expect(within(provision).queryByRole('button')).toBeNull()
    expect(hasTally(provision)).toBe(true)
    expect(provision.getAttribute('aria-current')).toBe('step')
  })

  it('an off-flow workload (current: null) carries no tally on any of the five keys — there is no sixth key for it to land on instead', () => {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'complete',
      provision: 'complete',
      configure: 'open',
      finalise: 'open',
    }
    renderRail({ steps, activeChip: 'finalise', current: null })

    for (const id of ['design', 'plan', 'provision', 'configure', 'finalise'] as FlowStepId[]) {
      expect(hasTally(chip(LabelFor(id))), `${id} should carry no tally — current is null`).toBe(false)
    }
  })
})

// SHELL ROUND 2 (dmfdeploy#482): colour now tracks STAGE IDENTITY again
// (RAIL_FILL, permanent per stage), not "selected vs not" the way Arc 4
// WP-2's neutral-everywhere ruling had it — see LifecycleStrip.tsx's own
// docstring for the full reasoning. This replaces the retired
// "colour now tracks SELECTION, not stage identity" describe block outright
// (that ruling itself is what this round supersedes, deliberately, per the
// Visual System design doc).
describe('colour carries stage IDENTITY, permanently, independent of selection (Visual System doc §2/§4)', () => {
  it('every non-selected chip carries its own stage hue — never the achromatic inverted fill, never the action accent', () => {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'open',
      plan: 'open',
      provision: 'open',
      configure: 'open',
      finalise: 'open',
    }
    renderRail({ steps, activeChip: 'design', current: null })

    const expectedFill: Record<FlowStepId, string> = {
      design: 'bg-rail-design',
      plan: 'bg-rail-plan',
      provision: 'bg-rail-provision',
      configure: 'bg-rail-configure',
      finalise: 'bg-rail-finalise',
    }
    for (const id of ['plan', 'provision', 'configure', 'finalise'] as FlowStepId[]) {
      const el = chip(LabelFor(id))
      expect(fillLayer(el).className, `${id} should carry its own stage hue`).toContain(expectedFill[id])
      expect(fillLayer(el).className, `${id} should carry no inverted fill`).not.toContain('bg-text')
    }

    // Cyan (the action accent) never appears on the rail AS A FILL/INK — it
    // would make the promoted primary action ambiguous with "where you
    // are". `focus-visible:outline-accent` is a deliberate, unrelated
    // exception (this file's own fillLayer() helper docstring / the
    // component's "FOCUS RING" section): the keyboard focus ring uses the
    // same accent token every other interactive control in this console
    // does, which is not the fill/selection channel this check is about.
    for (const id of FLOW_STEPS) {
      expect(chip(LabelFor(id)).className).not.toMatch(/\b(bg|text)-accent\b/)
      expect(fillLayer(chip(LabelFor(id))).className).not.toMatch(/\b(bg|text)-accent\b/)
    }
  })

  it('each stage keeps its OWN hue regardless of state — open, locked, current and record all fill identically for the same stage', () => {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'open',
      plan: 'locked',
      provision: 'current',
      configure: 'record',
      finalise: 'complete',
    }
    renderRail({ steps, activeChip: null, current: 'provision' })

    expect(fillLayer(chip('Design')).className).toContain('bg-rail-design')
    expect(fillLayer(chip('Plan')).className).toContain('bg-rail-plan')
    expect(fillLayer(chip('Provision')).className).toContain('bg-rail-provision')
    expect(fillLayer(chip('Configure')).className).toContain('bg-rail-configure')
    expect(fillLayer(chip('Finalise & Review')).className).toContain('bg-rail-finalise')
  })
})

// SHELL ROUND 2 (dmfdeploy#481): the reserved-but-empty badge slot (Visual
// System doc §5 — "badge-ready, no counts this round"). Renders no number
// until the ADR-0046 actionable-item derivation (dmfdeploy#495) exists.
describe('the badge slot is reserved but renders no count this round', () => {
  it('mounts an empty, aria-hidden badge slot on every key, with no digits anywhere in the row', () => {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'complete',
      provision: 'current',
      configure: 'open',
      finalise: 'open',
    }
    renderRail({ steps, activeChip: 'provision', current: 'provision' })

    for (const id of FLOW_STEPS) {
      const el = chip(LabelFor(id))
      const slot = el.querySelector('[data-testid="badge-slot"]')
      expect(slot, `${id} should carry a reserved badge slot`).not.toBeNull()
      expect(slot?.getAttribute('aria-hidden')).toBe('true')
      expect(slot?.textContent).toBe('')
    }
    const nav = screen.getByRole('navigation', { name: 'Media workload lifecycle' })
    expect(within(nav).queryByText(/^\d+$/)).toBeNull()
  })
})

// dmfdeploy#414: the rail is exactly five keys, nothing adjacent that could
// read as a sixth. SHELL ROUND 2 adds no new sixth element either (no
// readout, no separate status line) — this proves the row is STILL exactly
// the five keys and nothing else, unchanged by any of the three issues.
describe('the rail is exactly five keys, nothing adjacent that could read as a sixth', () => {
  it('renders exactly five <li> in the orchestration <ol>, and no link, group, status or "Operate" text anywhere in the nav', () => {
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

    const nav = screen.getByRole('navigation', { name: 'Media workload lifecycle' })
    expect(within(nav).queryByRole('link')).toBeNull()
    expect(within(nav).queryByRole('group')).toBeNull()
    expect(within(nav).queryByRole('status')).toBeNull()
    expect(within(nav).queryByText('Operate')).toBeNull()
    expect(within(nav).queryByLabelText('Control')).toBeNull()
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
// not a state attribute with no widget role to attach to. Unchanged by
// Shell Round 2.
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
    expect(provision.tagName).toBe('DIV')
    expect(provision.closest('li')?.querySelector('[role="button"]')).toBeNull()
    expect(provision.getAttribute('aria-pressed')).toBeNull()
    expect(within(provision).getByText('Selected')).toBeTruthy()

    const design = chip('Design')
    expect(within(design).queryByText('Selected')).toBeNull()
  })

  it('carries its NOT-selected state via real aria-pressed on a locked, non-busy chip — never the sr-only "Selected" text reserved for the job-in-flight branch', () => {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'complete',
      provision: 'locked',
      configure: 'locked',
      finalise: 'locked',
    }
    renderRail({ steps, activeChip: 'design', current: null, jobInFlight: false })
    const provision = chip('Provision')
    expect(provision.tagName).toBe('BUTTON')
    expect(provision.getAttribute('aria-pressed')).toBe('false')
    expect(within(provision).queryByText('Selected')).toBeNull()
  })
})
