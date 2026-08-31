import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import LifecycleStrip, { CONTENT_OFFSET_PX, contentOffsetStyle } from '../pages/MediaWorkloads/LifecycleStrip'
import { FLOW_STEPS, type FlowStepId, type FlowStepState } from '../lib/workloadFlow'

/**
 * The rail's "never colour alone" contract (Constitution Art. 11, umbrella
 * #347 WO-D1 Acceptance Criterion 8).
 *
 * SHELL ROUND 2 REDESIGN (dmfdeploy#481/#482/#483, operator direction)
 * rewrote this file's fixtures and most of its assertions across several
 * fix rounds — see LifecycleStrip.tsx's own docstring for the full
 * account, points A/B/C. Per-fact status, stated plainly for the CURRENT
 * design:
 *   - IDENTITY (stage): an always-present icon PLUS the always-present EBU
 *     label — the rail's ONLY identity carriers now. Hue was tried as a
 *     fill, then as a bottom-edge line, measured at each stage, and
 *     removed entirely once the line measured imperceptible (dE2000
 *     0.85-1.17) for one pair under the two common CVDs — icon shape and
 *     label text were always independently sufficient (Art. 11 —
 *     "everything except hue survives greyscale").
 *   - LOCKED: visually IDENTICAL to an open key of the same stage — the
 *     Visual System doc §2 rejects any fill/edge distinction for stage
 *     STATE at all (identity and selection are the only two axes fill/edge
 *     may vary on). The only surviving non-colour cue is the
 *     `aria-describedby` reason text, which is words, not a glyph.
 *   - POSITION: REMOVED ENTIRELY (fix round). The backend-derived position
 *     can only ever be `provision`, `configure`, `operate` (off this
 *     five-key rail, dmfdeploy#414) or `unknown` — never design, plan or
 *     finalise (ADR-0046: finalise is never inferred from absence) — so a
 *     marker on this rail could only ever land on two of five keys, a
 *     coarse aggregate that hid real per-member divergence. `aria-
 *     current="step"` went with it: it announces a step in a gated
 *     sequence, contradicting the IA doc's #493 amendment that a stage is
 *     a PEER VIEW. This file now pins the ABSENCE of both.
 *   - SELECTION: the achromatic bg-text/text-bg inversion — the rail's
 *     ONLY state now that position is gone. See LifecycleStrip.tsx's own
 *     "SELECTION — WHICH GUARANTEE LIVES WHERE" section for exactly what
 *     this file can and cannot prove about its contrast on its own.
 * This file is a rendering test, not a visual/storybook one — it asserts on
 * the actual DOM nodes and attributes present for each fact, not on how
 * the page looks. The chevron geometry itself (notch/radius, gap, contrast)
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
  jobInFlight?: boolean
  onSelect?: (step: FlowStepId) => void
}) {
  render(
    <MemoryRouter>
      <LifecycleStrip
        steps={overrides.steps}
        activeChip={overrides.activeChip}
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
 *  colour class; the outer chip element itself stays transparent so the
 *  chevron notch/point actually shows the page behind it rather than a
 *  rectangular background masking the cutout. */
function fillLayer(chipEl: HTMLElement): HTMLElement {
  return chipEl.querySelector('[data-testid="key-fill"]') as HTMLElement
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
    renderRail({ steps, activeChip: 'configure' })

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
    renderRail({ steps, activeChip: 'finalise' })

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
    renderRail({ steps, activeChip: 'design', onSelect })

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
    renderRail({ steps, activeChip: 'design' })

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
    renderRail({ steps: lockedSteps, activeChip: 'design' })
    const lockedFill = fillLayer(chip('Provision')).className

    cleanup()

    const openSteps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'complete',
      provision: 'open',
      configure: 'open',
      finalise: 'open',
    }
    renderRail({ steps: openSteps, activeChip: 'design' })
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

// FIX ROUND (orchestrator/codex gate): the position tally and
// `aria-current="step"` are REMOVED, not restyled — verified against the
// backend (`_derive_workload_lifecycle`, src/dmf_cms/media_workloads.py):
// the derived position can only ever be provision/configure/operate/
// unknown, never design/plan/finalise, and dmfdeploy#414 already took
// Operate off this rail — so a marker here could only ever land on two of
// five keys, and `aria-current="step"` announces a step in a gated
// sequence, contradicting the IA doc's #493 amendment that a stage is a
// PEER VIEW. Selection is the rail's only state now.
//
// MUTATION-VERIFIED: reinstating `aria-current={isPosition ? 'step' :
// undefined}` on the button branch (the exact pre-removal line) makes the
// second assertion below fail — `expected null, received "step"` — naming
// the reinstated attribute directly. Checked by hand during this fix round
// (see the PR description for the actual failure output), then reverted.
describe('the rail carries no position marker of any kind — selection is its only state (fix round)', () => {
  it('no key, in any state, carries a position-tally element or aria-current', () => {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'complete',
      provision: 'current',
      configure: 'open',
      finalise: 'open',
    }
    renderRail({ steps, activeChip: 'design' })

    for (const id of FLOW_STEPS) {
      const el = chip(LabelFor(id))
      expect(el.querySelector('[data-testid="position-tally"]'), `${id} must carry no tally element`).toBeNull()
      expect(el.getAttribute('aria-current'), `${id} must carry no aria-current`).toBeNull()
    }
  })

  it('holds for the inert (job-in-flight) branch too, not just the interactive button', () => {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'complete',
      provision: 'current',
      configure: 'open',
      finalise: 'open',
    }
    renderRail({ steps, activeChip: 'design', jobInFlight: true })

    for (const id of FLOW_STEPS) {
      const el = chip(LabelFor(id))
      expect(el.querySelector('[data-testid="position-tally"]')).toBeNull()
      expect(el.getAttribute('aria-current')).toBeNull()
    }
  })

  it('holds regardless of which state each key is in — locked, open, current, record, complete all carry no marker', () => {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'record',
      plan: 'locked',
      provision: 'current',
      configure: 'open',
      finalise: 'complete',
    }
    renderRail({ steps, activeChip: null })

    for (const id of FLOW_STEPS) {
      expect(chip(LabelFor(id)).getAttribute('aria-current')).toBeNull()
    }
  })
})

describe('selection inverts fill and ink (bg-text/text-bg), and is aria-pressed', () => {
  it('the selected chip inverts; an unselected sibling does not', () => {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'complete',
      provision: 'current',
      configure: 'locked',
      finalise: 'locked',
    }
    renderRail({ steps, activeChip: 'design' })

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
})

// FIX ROUND (orchestrator/codex gate, redesign): the achromatic fill-invert
// alone was invisible as a selection cue when the fill varied per stage
// (2.82:1 / 2.04:1 / 1.49:1 fill-vs-fill on provision/configure/finalise,
// all under WCAG 1.4.11's 3:1 floor) — that defect is what the ring two
// prior fix rounds added existed to cover. The redesign removes the per-
// stage fill instead (see LifecycleStrip.tsx's own docstring): with ONE
// shared neutral fill token on every key, fill-vs-fill selection contrast
// measures 5.06:1 — uniform by construction — so the ring is gone too (the
// operator objected to its boxy look, and measurement supported removing
// it rather than keeping it as a silhouette-following shape).
//
// WHICH GUARANTEE LIVES WHERE, split honestly rather than conflated into
// one over-claiming test: jsdom cannot measure the real 5.06:1 contrast
// number (that lives in LifecycleStrip.tsx's own docstring and the PR
// description, render-measured) — what jsdom CAN prove, and what this test
// pins, is that selection is still marked by a genuinely DIFFERENT fill
// token, not merely a class that happens to still be there.
//
// MUTATION-VERIFIED: forcing `fillClass` to always resolve to `RAIL_FILL`
// regardless of `isSelected` (i.e. deleting the token swap) makes the
// assertion below fail — `expected 'absolute inset-0 bg-rail-fill' to
// contain 'bg-text'` — naming the missing selected-fill token directly.
// Checked by hand during this fix round (see the PR description for the
// actual failure output), then restored.
describe('selection is a genuinely different fill token, not a ring (redesign fix round)', () => {
  it.each(FLOW_STEPS)('%s: selected carries bg-text, unselected carries bg-rail-fill — never the same token', (id) => {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'complete',
      provision: 'complete',
      configure: 'complete',
      finalise: 'complete',
    }
    const sibling = FLOW_STEPS.find((s) => s !== id) as FlowStepId
    renderRail({ steps, activeChip: id })

    const selectedFill = fillLayer(chip(LabelFor(id)))
    // THE DISCRIMINATING ASSERTION.
    expect(selectedFill.className, `${id} (selected) must carry the achromatic selected-fill token`).toContain('bg-text')
    expect(selectedFill.className, `${id} (selected) must not still carry the neutral unselected token`).not.toContain('bg-rail-fill')

    const unselectedFill = fillLayer(chip(LabelFor(sibling)))
    expect(unselectedFill.className, `${LabelFor(sibling)} (not selected) must carry the neutral fill token`).toContain('bg-rail-fill')
    expect(unselectedFill.className, `${LabelFor(sibling)} (not selected) must not carry the selected token`).not.toContain('bg-text')
  })

  it('no rectangular selection ring is rendered any more — the operator objected to it, and measurement supported removing it', () => {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'complete',
      provision: 'complete',
      configure: 'complete',
      finalise: 'complete',
    }
    renderRail({ steps, activeChip: 'finalise' })
    expect(screen.queryByTestId('selection-ring')).toBeNull()
  })
})

// FIX ROUND (orchestrator/codex gate, redesign, operator ruling): hue is
// removed from the rail entirely, not just off the fill — the bottom-edge
// LINE a prior fix round added was itself measured and removed once dE2000
// showed it imperceptible (0.85-1.17) for one pair under the two common
// CVDs. Icon shape and the EBU label are the rail's sole identity carriers
// now. This describe block pins that ABSENCE, replacing the retired
// hue-line describe block outright.
//
// MUTATION-VERIFIED: reinstating a `bg-rail-design`-style class on the fill
// layer (the exact pre-removal per-stage token) makes the assertion below
// fail — naming a stage-hue class where none should exist. Checked by hand
// during this fix round, then reverted.
describe('no key carries any per-stage hue, anywhere — identity rests on icon and label alone (redesign, operator ruling)', () => {
  it('carries no bg-rail-<stage> class, no hue-line element, on any key in any state', () => {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'open',
      plan: 'locked',
      provision: 'current',
      configure: 'record',
      finalise: 'complete',
    }
    renderRail({ steps, activeChip: null })

    for (const id of FLOW_STEPS) {
      const el = chip(LabelFor(id))
      expect(el.querySelector('[data-testid="hue-line"]'), `${id} must carry no hue-line element`).toBeNull()
      expect(fillLayer(el).className, `${id} must carry no per-stage hue class`).not.toMatch(/\bbg-rail-(design|plan|provision|configure|finalise)\b/)
    }

    // Cyan (the action accent) never appears on the rail either — it would
    // make the promoted primary action ambiguous with "where you are".
    for (const id of FLOW_STEPS) {
      const el = chip(LabelFor(id))
      expect(el.className).not.toMatch(/\b(bg|text)-accent\b/)
      expect(fillLayer(el).className).not.toMatch(/\b(bg|text)-accent\b/)
    }
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
    renderRail({ steps, activeChip: 'provision' })

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
// the five keys and nothing else.
describe('the rail is exactly five keys, nothing adjacent that could read as a sixth', () => {
  it('renders exactly five <li> in the orchestration <ol>, and no link, group, status or "Operate" text anywhere in the nav', () => {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'complete',
      provision: 'open',
      configure: 'open',
      finalise: 'open',
    }
    renderRail({ steps, activeChip: 'provision' })

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
    renderRail({ steps, activeChip: 'provision', jobInFlight: true })

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
    renderRail({ steps, activeChip: 'design', jobInFlight: false })
    const provision = chip('Provision')
    expect(provision.tagName).toBe('BUTTON')
    expect(provision.getAttribute('aria-pressed')).toBe('false')
    expect(within(provision).queryByText('Selected')).toBeNull()
  })
})

// FIX ROUND (operator finding against a90bfd2's live render): the content
// group is centred by the flex button against the BOX, but a notched key's
// PAINTED shape isn't the box — the notch removes CONTENT_OFFSET_PX * 2 px
// of material from the left side only, which silently pushed the icon+
// label group left of the shape's own optical centre on every key except
// Design (LifecycleStrip.tsx's own "CONTENT RE-CENTRING" comment has the
// full measurement). jsdom computes no pixels and cannot render the
// shape()'d chevron at all (SUPPORTS_SHAPE_CURVE is always false there —
// see that constant's own comment), so the property this regressed can
// only be pinned by calling `contentOffsetStyle` directly with an explicit
// `shapeIsPainted` argument, exactly what exporting it as a parameter
// (rather than a module-level flag) was for.
describe('content re-centring on a notched key (fix round, contentOffsetStyle)', () => {
  it('is zero on a first key (no notch) regardless of whether the chevron is painted', () => {
    expect(contentOffsetStyle('first', true)).toEqual({})
    expect(contentOffsetStyle('first', false)).toEqual({})
  })

  it('shifts middle AND last keys right by CONTENT_OFFSET_PX when the chevron is painted — last is not mirrored, it carries the same left notch as middle', () => {
    expect(contentOffsetStyle('middle', true)).toEqual({ transform: `translateX(${CONTENT_OFFSET_PX}px)` })
    expect(contentOffsetStyle('last', true)).toEqual({ transform: `translateX(${CONTENT_OFFSET_PX}px)` })
  })

  it('applies no offset on any position when the chevron is NOT painted (border-radius fallback is a plain, un-notched rectangle)', () => {
    expect(contentOffsetStyle('middle', false)).toEqual({})
    expect(contentOffsetStyle('last', false)).toEqual({})
  })

  it('is exactly half the notch depth (12px), not an independently-tunable number', () => {
    // 6, not re-derived here from NOTCH_DEPTH (not exported — the constant
    // this pins is the one lifecycleStrip.tsx's own "CONTENT RE-CENTRING"
    // comment states as the measured, shipped figure).
    expect(CONTENT_OFFSET_PX).toBe(6)
  })

  // Render-level safety net, independent of the above: every call site in
  // the component threads SUPPORTS_SHAPE_CURVE through as the second
  // argument rather than hardcoding `true`. jsdom's SUPPORTS_SHAPE_CURVE
  // is always false (no `CSS` global), so if a call site ever stopped
  // passing it through, this is what would catch it — every key's content
  // span would start carrying a transform under jsdom, which should never
  // happen since jsdom never paints the chevron.
  it('never renders an inline transform on the content span in jsdom, on any key', () => {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'complete',
      provision: 'complete',
      configure: 'complete',
      finalise: 'complete',
    }
    renderRail({ steps, activeChip: 'configure' })

    for (const id of FLOW_STEPS) {
      const content = chip(LabelFor(id)).querySelector('[data-testid="key-content"]') as HTMLElement
      expect(content.style.transform, `${id}'s content span should carry no transform under jsdom`).toBe('')
    }
  })
})

// GATE FIX (codex round 3, P2): the tests above are genuinely discriminating
// for `contentOffsetStyle` itself, and the "no transform in jsdom" test
// above is a real safety net — but NEITHER observes the two call sites
// (LifecycleStrip.tsx:611,622) actually threading SUPPORTS_SHAPE_CURVE
// through rather than a hardcoded literal. A call site that changed to
// `contentOffsetStyle(position, false)` would keep every test above green
// (jsdom's own SUPPORTS_SHAPE_CURVE is false anyway) while silently
// un-fixing the off-centre defect the instant a real browser supports
// `shape()`. That gap can only be closed by making the "chevron IS
// painted" branch reachable from a RENDER, which means forcing
// SUPPORTS_SHAPE_CURVE — a module-level `const`, evaluated once at import
// — to resolve `true`. `globalThis.CSS` is stubbed BEFORE the module is
// (re-)imported, and `vi.resetModules()` plus a dynamic `import()` forces
// a fresh evaluation of that module-level probe against the stub, rather
// than reusing the file's already-evaluated top-of-file import (whose
// SUPPORTS_SHAPE_CURVE was fixed at `false` the moment this file first
// loaded and cannot be changed after the fact).
describe('the supported-browser call sites thread SUPPORTS_SHAPE_CURVE through to the render, not just to the helper (codex gate, round 3)', () => {
  afterEach(() => {
    // Never leak the stub into a later test — every other test in this
    // file relies on jsdom's real, CSS-global-less environment resolving
    // SUPPORTS_SHAPE_CURVE to false.
    Reflect.deleteProperty(globalThis, 'CSS')
  })

  it('renders translateX(6px) on middle and last keys, and no transform on first, when shape()/curve IS supported', async () => {
    Object.defineProperty(globalThis, 'CSS', {
      configurable: true,
      value: { supports: () => true } as unknown as typeof CSS,
    })
    vi.resetModules()
    const fresh = await import('../pages/MediaWorkloads/LifecycleStrip')
    const FreshLifecycleStrip = fresh.default

    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'complete',
      provision: 'complete',
      configure: 'complete',
      finalise: 'complete',
    }
    render(
      <MemoryRouter>
        <FreshLifecycleStrip steps={steps} activeChip={null} lockedReasons={LOCKED_REASONS} jobInFlight={false} onSelect={() => {}} />
      </MemoryRouter>,
    )

    const content = (label: string) => screen.getByLabelText(label).querySelector('[data-testid="key-content"]') as HTMLElement

    expect(content('Design').style.transform, 'Design has no notch and must stay untouched').toBe('')
    for (const label of ['Plan', 'Provision', 'Configure', 'Finalise & Review']) {
      expect(content(label).style.transform, `${label} must carry translateX(${fresh.CONTENT_OFFSET_PX}px) once the chevron is actually painted`).toBe(
        `translateX(${fresh.CONTENT_OFFSET_PX}px)`,
      )
    }
  })
})

// -----------------------------------------------------------------------
// NARROW-WIDTH FIX ROUND (dmf-cms#128). lkirc's review correctly flagged a
// narrow-width regression from the `justify-center`/`w-full` centring
// change; the actual mechanism (measured on a real render, see
// LifecycleStrip.tsx's own docstring) is that the `<ol>` — a flex ITEM of
// the `<nav>` above it — silently SHRINKS below its max-content width
// instead of the ancestor scrolling, collapsing every key until
// "Finalise & Review"'s label overflows its own key. jsdom computes no
// pixels and cannot lay out a flexbox at all (there is no narrower-than-390
// viewport to shrink against in the test environment, and no computed width
// to read back even if there were) — this describe block cannot pin "the
// key does not collapse below its content" as a measured fact, ONLY as a
// STRUCTURAL one: that the exact mechanism the fix relies on
// (`shrink-0`/`justify-center-safe` on the flex/grid classes,
// `max-[390px]:` on the stacking classes, the CSS-hook classes the
// `!important` notch-drop override in index.css targets) is actually
// present on the actual render. The pixel-level claims themselves — 166px
// keys holding at any width down to 390px, no overflow, the stacked layout
// fitting "Finalise & Review" unabbreviated below that — are real-browser
// facts, verified in the PR description, the same split this file's other
// describe blocks already draw (see the file's own opening docstring).
describe('the rail holds its width at narrow viewports instead of shrinking below its content (dmf-cms#128 fix round)', () => {
  function renderFiveOpen() {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'open',
      provision: 'open',
      configure: 'open',
      finalise: 'open',
    }
    renderRail({ steps, activeChip: 'design' })
  }

  // MUTATION-VERIFIED: dropping `shrink-0` from the `<ol>`'s className (the
  // exact regression this fix round found — see LifecycleStrip.tsx's own
  // "NARROW-WIDTH FIX ROUND" docstring for the measured 166px -> 78px
  // collapse this class prevents) makes this assertion fail —
  // `expected 'grid w-max grid-cols-5 items-center gap-[3px] max-[390px]:w-full max-[390px]:grid-cols-1 max-[390px]:gap-2' to contain 'shrink-0'`.
  // Checked by hand during this fix round, then restored.
  it('pins shrink-0 on the orchestration <ol> — without it, w-max is a preferred width the flex parent can shrink past, not a floor', () => {
    renderFiveOpen()
    const list = screen.getByRole('list')
    expect(list.className.split(' '), 'the <ol> must carry shrink-0, or the flex parent can shrink it below w-max').toContain('shrink-0')
    expect(list.className, 'w-max must still be present too — shrink-0 alone sets no preferred width to hold').toContain('w-max')
  })

  // MUTATION-VERIFIED: reverting the <nav> to plain `justify-center` (the
  // pre-fix class, and exactly what lkirc's review was reviewing) makes the
  // second assertion below fail — `expected [ 'flex', 'w-full',
  // 'flex-nowrap', 'items-center', 'justify-center' ] not to contain
  // 'justify-center'`. Checked by hand during this fix round, then restored.
  //
  // Split assertion deliberately: `justify-center-safe` CONTAINS the
  // substring `justify-center`, so a plain `.not.toContain('justify-center')`
  // on the raw string would pass even with the bug reintroduced — this
  // checks token membership on the split class list instead, the same trap
  // this file's own selection tests are careful about elsewhere with
  // fillClass tokens.
  it('pins justify-center-safe on the <nav>, not plain justify-center, now that the <ol> can genuinely overflow it', () => {
    renderFiveOpen()
    const nav = screen.getByRole('navigation', { name: 'Media workload lifecycle' })
    const tokens = nav.className.split(' ')
    expect(tokens, 'the <nav> must use safe centring — plain justify-center can push an overflowing <ol> into unreachable negative overflow').toContain(
      'justify-center-safe',
    )
    expect(tokens).not.toContain('justify-center')
  })

  // MUTATION-VERIFIED: dropping either max-[390px]: class from the <ol>
  // makes the corresponding assertion below fail, naming the missing class
  // directly (e.g. `expected [...] to contain 'max-[390px]:grid-cols-1'`).
  // Checked by hand during this fix round, then restored.
  it('pins the stacked-layout classes on the <ol> for the ~390px-and-below breakpoint, per the approved design\'s mobile treatment', () => {
    renderFiveOpen()
    const tokens = screen.getByRole('list').className.split(' ')
    expect(tokens, 'must switch to a single column (vertical stack) below 390px').toContain('max-[390px]:grid-cols-1')
    expect(tokens, 'must drop the max-content width constraint below 390px so the stack uses the full available width').toContain('max-[390px]:w-full')
  })

  // MUTATION-VERIFIED: removing `lifecycle-rail-chevron` from a key-fill
  // span's className makes this assertion fail for that key, naming it —
  // e.g. `Finalise & Review key-fill missing lifecycle-rail-chevron`.
  // Checked by hand during this fix round (removed it from the Design key
  // specifically, confirmed only Design's assertion failed), then restored.
  it('carries the CSS hook classes the narrow-width notch-drop override (index.css) targets, on every key', () => {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'complete',
      provision: 'complete',
      configure: 'complete',
      finalise: 'complete',
    }
    renderRail({ steps, activeChip: null })

    for (const id of FLOW_STEPS) {
      const el = chip(LabelFor(id))
      expect(fillLayer(el).className, `${LabelFor(id)} key-fill missing lifecycle-rail-chevron`).toContain('lifecycle-rail-chevron')
      const content = el.querySelector('[data-testid="key-content"]') as HTMLElement
      expect(content.className, `${LabelFor(id)} key-content missing lifecycle-rail-content`).toContain('lifecycle-rail-content')
    }
  })
})
