import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import LifecycleStrip from '../pages/MediaWorkloads/LifecycleStrip'
import { FLOW_STEPS, type FlowStepId, type FlowStepState, type StageCompleteness } from '../lib/workloadFlow'

/**
 * The rail's "never colour alone" contract (Constitution Art. 11, umbrella
 * #347 WO-D1 Acceptance Criterion 8).
 *
 * FIX ROUND (dmf-cms#391 Pass 1, codex gate — P3): this docstring used to
 * say "every chip state carries text AND an icon/shape cue, so a viewer who
 * cannot distinguish the selected chip's fill (or the ring) still gets the
 * same information from the DOM" and "asserts on the actual icon + text
 * nodes present for each state" — both stale since the crosspoint-bus
 * redesign removed the per-state StateGlyph icon set and the selection ring
 * (see LifecycleStrip.tsx's own file docstring). A LATER pass of this same
 * fix round then claimed the contract "still holds" for every fact while,
 * in the same breath, admitting SELECTION has "no text/shape companion any
 * more" — an internal contradiction, not a resolved claim, and it is
 * corrected here rather than papered over a second time. Per-fact status,
 * stated plainly:
 *   - LOCKED: passes cleanly — a dashed border is a genuine SHAPE cue,
 *     independent of the key's fill, plus the key's own inert rendering.
 *   - POSITION: passes cleanly — the tally bar is a real shape (a bar,
 *     present or absent) for sighted users, `aria-current="step"` for
 *     assistive tech; never colour. dmfdeploy#414: the Operate-specific
 *     carrier this bullet used to also name (`aria-describedby` on the now-
 *     deleted Control group) is gone with the group itself — see
 *     LifecycleStrip.tsx's own docstring for why that carrier is no longer
 *     needed at all, not merely relocated.
 *   - SELECTION: an OPEN QUESTION, not a resolved pass — flagged to the
 *     operator directly, not quietly resolved in prose. For sighted users
 *     the only encoding left is the key's fill: a full inversion within the
 *     SAME neutral/grayscale token family (bg-text/text-bg vs. muted text
 *     on a faint or bordered face) — never a hue change, so this is not
 *     "colour" in WCAG SC 1.4.1's strict sense, and the solid-fill-vs-
 *     outline silhouette is a real visual difference, not nothing. But it
 *     is not reinforced by any SECOND, independent shape or icon cue the
 *     way LOCKED's dashed border or POSITION's tally bar are — narrower
 *     than this codebase's own historical bar for "never one signal alone"
 *     elsewhere. `aria-pressed` and the sr-only "Selected" node cover
 *     assistive tech, which is a genuinely separate axis, not a substitute
 *     for a sighted-only encoding. Whether fill-inversion alone is
 *     sufficient, or SELECTION needs a second cue (Pass 2's own scope — the
 *     key becoming its own disclosure — may be the natural place for one),
 *     is the operator's call, not this test file's to assert either way.
 * This file is a rendering test, not a visual/storybook one — it asserts on
 * the actual DOM nodes and attributes present for each fact, not on how
 * the page looks.
 */

const LOCKED_REASONS: Record<FlowStepId, string> = {
  design: 'design locked reason',
  plan: 'plan locked reason',
  provision: 'provision locked reason',
  configure: 'configure locked reason',
  finalise: 'finalise locked reason',
}

// umbrella dmf-cms#391 Pass 1: LifecycleStrip now requires a runningReadout
// prop (store/headerSlot.ts's RailRunningReadout) — a trustworthy 1-of-1
// default here so every existing test in this file that doesn't care about
// the readout doesn't have to know about it. Tests that DO care pass their
// own override.
const DEFAULT_RUNNING_READOUT = { running: 1, total: 1, trustworthy: true }

// dmfdeploy#449 Pass 2: LifecycleStrip now also requires a per-stage
// completeness map (the dot grammar). Defaults to all-'none' so the many
// tests in this file that predate the mark and care nothing about it render
// no dots at all and keep asserting exactly what they always did. Tests that
// DO care pass their own map.
const NO_COMPLETENESS: Record<FlowStepId, StageCompleteness> = {
  design: 'none',
  plan: 'none',
  provision: 'none',
  configure: 'none',
  finalise: 'none',
}

function renderRail(overrides: {
  steps: Record<FlowStepId, FlowStepState>
  activeChip: FlowStepId | null
  current: FlowStepId | null
  completeness?: Record<FlowStepId, StageCompleteness>
  jobOwnerLabel?: string | null
  jobInFlight?: boolean
  runningReadout?: { running: number; total: number; trustworthy: boolean }
  onSelect?: (step: FlowStepId) => void
}) {
  render(
    <MemoryRouter>
      <LifecycleStrip
        steps={overrides.steps}
        completeness={overrides.completeness ?? NO_COMPLETENESS}
        activeChip={overrides.activeChip}
        current={overrides.current}
        lockedReasons={LOCKED_REASONS}
        jobOwnerLabel={overrides.jobOwnerLabel ?? null}
        jobInFlight={overrides.jobInFlight ?? false}
        runningReadout={overrides.runningReadout ?? DEFAULT_RUNNING_READOUT}
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

/** umbrella dmf-cms#391: the tally bar is a decorative, aria-hidden child —
 *  queried structurally (data-testid) rather than by text, since it carries
 *  none. */
function hasTally(chipEl: HTMLElement): boolean {
  return chipEl.querySelector('[data-testid="position-tally"]') !== null
}

afterEach(cleanup)

// FIX ROUND (dmf-cms#391 Pass 1): the whole premise of this describe/it —
// a per-state "state word" (STATE_TEXT: Now/Ready/Done/Record/Locked) plus
// a per-state StateGlyph <svg> icon — was removed wholesale in the
// crosspoint-bus redesign. Every key now renders ONLY its own EBU label
// text (`<span className="text-xs font-semibold">{label}</span>`),
// regardless of state, and no icon at all. Rewritten to pin the NEW
// invariant instead of the deleted one: same four steps at four different
// states, but now asserting the label text (not a state word) and the
// absence of any <svg>.
describe('every non-locked, non-busy state renders its own EBU label as plain text, with no per-state icon or word', () => {
  it('renders only the EBU label text for complete/open/current/record, and no <svg> icon, regardless of state', () => {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'record',
      provision: 'open',
      configure: 'current',
      finalise: 'open',
    }
    renderRail({ steps, activeChip: 'configure', current: 'configure' })

    const expectations: FlowStepId[] = ['design', 'plan', 'provision', 'configure']
    for (const id of expectations) {
      const el = chip(LabelFor(id))
      // The EBU label is the only text this chip carries now — no
      // "Done"/"Ready"/"Now"/"Record" state word exists anywhere in the
      // markup any more, no matter what state the step is actually in.
      expect(within(el).getByText(LabelFor(id)), `${id} missing its EBU label text`).toBeTruthy()
      expect(el.querySelector('svg'), `${id} should carry no per-state icon`).toBeNull()
    }
  })
})

function LabelFor(id: FlowStepId): string {
  return { design: 'Design', plan: 'Plan', provision: 'Provision', configure: 'Configure', finalise: 'Finalise & Review' }[id]
}

// FIX ROUND (dmf-cms#391 Pass 1): the lock <svg> icon and the "Locked" text
// caption both went away in the crosspoint-bus redesign — a locked chip now
// shows ONLY its EBU label text plus a dashed border (the "i" toggle below
// is a disclosure control, not itself a state cue). The dashed border is
// therefore the sole surviving non-colour cue, so the describe title no
// longer claims a lock icon or "Locked" text exist. The LockedReasonToggle
// interaction block itself is untouched — that behavior wasn't part of the
// redesign and still works exactly as before.
// dmfdeploy#449 Pass 2 + dmfdeploy#405: a locked key now carries THREE
// independent non-colour cues (dashed border, padlock glyph, and the absence
// of a completeness dot) and is REACHABLE — the "i" disclosure toggle that
// used to be the only way to read a locked step's reason is gone, because the
// key itself is the disclosure now. The two tests that pinned that toggle (its
// aria-expanded round-trip, and the popover's viewport clamp for a trigger
// near the right edge) are deleted rather than adapted: the component they
// exercised no longer exists, and there is no popover left to place. What
// replaces them, and what actually matters to the operator, is pinned here and
// in workloadSetup.test.tsx — the key selects, and the reason mounts in the
// panel below.
describe('locked state carries non-colour cues, and the key itself is reachable (dmfdeploy#405)', () => {
  it('renders the dashed border, a padlock, and no completeness dot — and is a real button, not an inert div', () => {
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
    expect(provision.className).toContain('border-dashed')

    // The padlock is the one <svg> the rail draws, and only ever on a locked
    // key — the sibling test above pins that no NON-locked key carries one.
    expect(provision.querySelector('svg'), 'a locked key should carry the padlock glyph').not.toBeNull()

    // Padlock and dot are mutually exclusive: "locked" and "not started" are
    // different facts, and collapsing them into the same absence is exactly
    // what the padlock exists to prevent.
    expect(provision.querySelector('[data-testid="mark-complete"]')).toBeNull()
    expect(provision.querySelector('[data-testid="mark-partial"]')).toBeNull()

    // dmfdeploy#405, the behaviour change. This assertion is the exact
    // inverse of what this suite pinned before — the old test asserted
    // tagName === 'DIV' and was mutation-verified in that direction. Locked
    // is now reachable-but-read-only, so the key IS a button and clicking it
    // reports the selection upward.
    expect(provision.tagName).toBe('BUTTON')
    fireEvent.click(provision)
    expect(onSelect).toHaveBeenCalledWith('provision')

    // The reason is NOT rendered as visible chrome on the row — a
    // single-line rail has no room for it, which was true before #405 and is
    // still true. It reaches assistive tech as the key's DESCRIPTION, and
    // reaches sighted operators as the mounted panel's body once the key is
    // selected (workloadSetup.test.tsx pins that half).
    const describedBy = provision.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy as string)?.textContent).toContain('provision locked reason')
  })

  it('carries no opacity utility on the chip container itself', () => {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'complete',
      provision: 'locked',
      configure: 'locked',
      finalise: 'locked',
    }
    renderRail({ steps, activeChip: 'design', current: null })

    const provision = chip('Provision')
    // Structural only — proves the CONTAINER carries no opacity-N class,
    // nothing about the actual composited contrast that would result
    // (including from any opacity elsewhere in the chip's own subtree). The
    // test below is the one that pins the real number.
    expect(provision.className).not.toMatch(/\bopacity-\d+\b/)
    // FIX ROUND (codex gate, P3): this used to say "the dashed border +
    // lock glyph + 'Locked' text stay as the designed, non-colour cue" —
    // the glyph and the text are both gone (see the describe block's own
    // FIX ROUND comment above). The dashed border is the ONLY surviving
    // non-colour cue for locked now.
    expect(provision.className).toContain('border-dashed')
  })

  // FIX ROUND (dmf-cms#391 Pass 1): the "Locked" state-word text this test
  // used to query for is gone entirely — every key (locked or not) now
  // renders ONLY its EBU label inside a single
  // `<span className="text-xs font-semibold">{label}</span>`, per
  // LifecycleStrip.tsx's own docstring ("COLOUR TRACKS SELECTION..." /
  // "dark (locked)" section). That section documents this exact lesson
  // being learned the hard way TWICE already: opacifying this chip's text
  // silently composited it under the 4.5:1 AA floor, with no second,
  // dimmer-but-still-AA-safe text token to fall back to.
  //
  // FIX ROUND (codex gate, P2 — then corrected again, this prose itself
  // overstated the fix): an earlier pass of this fix round replaced the
  // composited-contrast assertion with a plain class-name string match ("no
  // opacity-N class present"), which cannot detect contrast lost through an
  // ANCESTOR's opacity (only the label span's own class). The real
  // composited-contrast assertion below (the SAME unmodified
  // effectiveContrastRatio helper the pre-redesign version of this test
  // used, pointed at the new leaf/root pair — label span and chip
  // container, one hop apart) DOES cover that ancestor case, by walking the
  // whole leaf-to-root subtree. Its ACTUAL remaining scope, stated
  // precisely rather than oversold: it detects opacity-CLASS regressions
  // within that subtree only — see effectiveContrastRatio's and
  // tailwindOpacity's own docstrings below for the honest limit. It does
  // NOT detect a changed text-colour utility (e.g. text-muted swapped for
  // something dimmer but still fully opaque), an inline `style="opacity:
  // ..."`, or CSS-file opacity — none of those touch the Tailwind
  // opacity-N class this helper actually parses, so a regression via any of
  // those routes would still pass silently. The class-name check stays too,
  // as a cheap, specific "how" alongside the real "does it still pass"
  // check, within that same known scope.
  it("a locked chip's own label composites to at least the 4.5:1 AA floor, and carries no opacity utility that could silently drop it", () => {
    const steps: Record<FlowStepId, FlowStepState> = {
      design: 'complete',
      plan: 'complete',
      provision: 'locked',
      configure: 'locked',
      finalise: 'locked',
    }
    renderRail({ steps, activeChip: 'design', current: null })

    const provision = chip('Provision')
    const label = within(provision).getByText('Provision')

    expect(label.className).not.toMatch(/\bopacity-\d+\b/)
    expect(effectiveContrastRatio(provision, label)).toBeGreaterThanOrEqual(4.5)
  })
})

// --- WCAG contrast helpers -------------------------------------------------
// src/index.css: --color-bg: #0a0a0b; --color-muted: #9a9aa2. Mirrored here
// because jsdom does not resolve CSS custom properties or compute actual
// paint colours — if either token changes, this drifts out of sync and the
// test below stops meaning what it says, same honest limit as any other
// hardcoded-token test in this suite.
//
// FIX ROUND (codex gate, P2): a prior pass of this fix round claimed
// effectiveContrastRatio's one call site was gone for good (the "Locked"
// state-word text it used to measure was removed) and left it dead behind a
// `void` reference purely to satisfy noUnusedLocals. That was premature —
// the helper is generic over ANY (root, leaf) pair, not specific to the old
// "Locked" text, and is now genuinely called again by the locked-chip
// opacity/contrast test above, pointed at the new single label span.
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

/**
 * Tailwind's opacity-N utility, or 1 (fully opaque) if the element carries
 * none. HONEST LIMIT (codex gate, P3): this greps `className` for the
 * literal `opacity-\d+` Tailwind utility ONLY — it has no way to see an
 * inline `style="opacity: ..."` attribute, a CSS-file rule targeting this
 * element by some other selector, or any other route to a lower rendered
 * alpha. If this component ever grows one of those instead of the Tailwind
 * utility, this test would go on reporting full opacity while the real
 * page renders dimmer text — the same class of gap every hardcoded-token
 * test in this file already accepts (see the BG/MUTED comment above).
 */
function tailwindOpacity(el: Element): number {
  const m = el.className.match(/\bopacity-(\d+)\b/)
  return m ? Number(m[1]) / 100 : 1
}

/**
 * The combined alpha a nested run of text actually renders at is the
 * product of every opacity between `leaf` and `root`, INCLUSIVE of both
 * ends — walks up from `leaf` via `parentElement` and stops the moment it
 * reaches `root` (never further, so nothing above `root` in the real page
 * is considered, however that ancestor chain continues). Bounded by
 * `tailwindOpacity`'s own honest limit above — this only ever sees
 * Tailwind's opacity-N class, nothing else that could lower a real
 * browser's rendered alpha.
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

// FIX ROUND (dmf-cms#391 Pass 1): the per-chip "Waiting" text override is
// gone entirely — a busy chip now shows ONLY its own EBU label, exactly
// like every other non-locked chip (see the top describe block in this
// file). The row-end run-count readout (store/headerSlot.ts's
// RailRunningReadout, tested in its own describe block below) is what now
// carries job-in-flight status for the row as a whole, instead of a
// per-chip text swap.
describe("a job in flight demotes every non-locked chip to inert, but its label text is untouched — no per-chip override text at all", () => {
  it('keeps each chip\'s own EBU label (never "Waiting") while busy, plus ONE shared reason note for the row', () => {
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
      // The chip's own label text still renders unchanged...
      expect(within(el).getByText(label), `${label} missing its own label text`).toBeTruthy()
      // ...and no "Waiting" override text was ever introduced in its place.
      expect(within(el).queryByText('Waiting', { exact: false }), `${label} unexpectedly shows Waiting text`).toBeNull()
      // FIX ROUND (codex gate, P2): within(el).queryByRole('button') only
      // ever searches el's DESCENDANTS (Testing Library's `within` never
      // considers the container itself a candidate) — it could never catch
      // el ITSELF regressing to a <button> while busy, which is the actual
      // inertness claim this test makes. tagName is the real discriminator.
      expect(el.tagName, `${label} chip root itself must not be a <button> while busy`).toBe('DIV')
      expect(within(el).queryByRole('button'), `${label} still interactive while busy`).toBeNull()
    }
    // ONE shared note for the whole row, not the same sentence repeated
    // under every chip (the old per-chip repetition said the identical
    // thing five times) — this part is unchanged by the redesign.
    // umbrella #432 G2: wording-only — the imperative tail is gone.
    expect(
      screen.getAllByText('A Configure job is in progress.').length,
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

  // FIX ROUND (dmf-cms#391 Pass 1): the visible "Position" text+icon caption
  // is gone — POSITION now renders as a tally bar (a thin illuminated strip
  // across the key's top edge, `data-testid="position-tally"`, aria-hidden
  // since it is a REDUNDANT visual cue whenever it renders at all: the
  // key's own aria-current="step" already carries the fact for assistive
  // tech, unconditionally, whether or not the bar itself is showing — see
  // the two tests right below this one for the operator's actual ruling on
  // when the bar itself renders. This test now pins the STRUCTURAL
  // presence/absence of that bar, not text content.
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
    // aria-current="step" is the unconditional accessible carrier of
    // POSITION — it does not depend on whether the tally bar itself
    // rendered (see the "converges" test below, where the bar is withheld
    // but this attribute is not).
    expect(provision.getAttribute('aria-current')).toBe('step')

    const design = chip('Design')
    expect(hasTally(design), 'Design (neither position nor selected) should carry no tally bar').toBe(false)
  })

  // NEW (dmf-cms#391 Pass 1, operator's ruling — pinned in both directions
  // per the work order): the tally is withheld exactly when the illuminated
  // (selected) key is ALSO the position — the inverted fill already says
  // "this is where you are" and a redundant bar under it would say nothing
  // new. The sibling test above already pins the "diverge -> bar renders"
  // half; this pins "converge -> no bar", so the rule is checked from both
  // sides rather than just inferred from one.
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
    expect(provision.className).toContain('bg-text') // still visibly selected
    expect(hasTally(provision), 'a converged selected+position key should carry no tally bar').toBe(false)
    // The ARIA carrier for POSITION is NOT conditional on the bar — a
    // screen-reader operator still gets the fact even though the bar (a
    // sighted-only affordance) is correctly withheld.
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
      jobOwnerLabel: 'Provision',
      jobInFlight: true,
    })

    const provision = chip('Provision')
    // FIX ROUND (codex gate, P2): within(provision).queryByRole('button')
    // only searches DESCENDANTS — it cannot detect provision ITSELF still
    // being a <button>, which is exactly the "demoted to inert <div>" claim
    // this test's own title makes. tagName is the real discriminator; the
    // queryByRole check stays as a secondary, belt-and-suspenders proof that
    // no button is reachable anywhere in the subtree either.
    expect(provision.tagName, 'demoted to inert — chip root itself must be a <div>').toBe('DIV')
    expect(within(provision).queryByRole('button')).toBeNull()
    expect(hasTally(provision)).toBe(true)
    // FIX ROUND (codex gate, P2): the interactive <button> branch's own
    // aria-current="step" was already pinned above (the two tests before
    // this one), but the INERT <div> branch — LifecycleStrip.tsx's
    // `aria-current={isPosition ? 'step' : undefined}` on that div — had no
    // test of its own. Position is unconditional on interactivity (see the
    // file docstring's own point on this), so a job-in-flight chip that is
    // also the position must still carry it.
    expect(provision.getAttribute('aria-current')).toBe('step')
  })

  // dmfdeploy#414: supersedes the three pre-#414 "Operate renders no
  // tally"/"Operate's position is exposed accessibly"/"...survives the busy
  // INERT rendering" tests that used to live here — all three pinned the
  // Control group's own tally/aria-describedby machinery, which is deleted
  // outright along with the group (LifecycleStrip.tsx's own docstring).
  // There is no longer an Operate carrier to test the presence OR absence
  // of; this proves the replacement fact instead — a workload off this rail
  // entirely (`current: null`, the `offFlow` case) leaves every one of the
  // five keys without a tally, because none of them IS the position.
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

// NEW (dmfdeploy#449 Pass 2, plan §3.2): the completeness grammar. Four
// states, two glyphs, one fill variation, one absence — and every distinction
// is shape, fill or absence, never hue (Constitution Art. 11), so the grammar
// survives greyscale. These are rendering assertions on the actual DOM nodes;
// the DERIVATION that decides which mark a stage gets is workloadFlow.test.ts's
// concern, not this file's.
describe('the completeness mark — filled dot, outline dot, no dot, padlock', () => {
  const OPEN_STEPS: Record<FlowStepId, FlowStepState> = {
    design: 'complete',
    plan: 'complete',
    provision: 'current',
    configure: 'open',
    finalise: 'open',
  }

  it('draws a filled dot for complete, an outline dot for partial, and nothing at all for not-started', () => {
    renderRail({
      steps: OPEN_STEPS,
      activeChip: 'provision',
      current: 'provision',
      completeness: {
        design: 'complete',
        plan: 'complete',
        provision: 'partial',
        configure: 'none',
        finalise: 'none',
      },
    })

    for (const id of ['design', 'plan'] as FlowStepId[]) {
      const el = chip(LabelFor(id))
      expect(el.querySelector('[data-testid="mark-complete"]'), `${id} should carry a filled dot`).not.toBeNull()
      expect(el.querySelector('[data-testid="mark-partial"]')).toBeNull()
    }

    const provision = chip('Provision')
    expect(provision.querySelector('[data-testid="mark-partial"]'), 'provision should carry an outline dot').not.toBeNull()
    expect(provision.querySelector('[data-testid="mark-complete"]')).toBeNull()

    for (const id of ['configure', 'finalise'] as FlowStepId[]) {
      const el = chip(LabelFor(id))
      expect(el.querySelector('[data-testid="mark-complete"]'), `${id} should carry no dot`).toBeNull()
      expect(el.querySelector('[data-testid="mark-partial"]'), `${id} should carry no dot`).toBeNull()
    }
  })

  // The mark is aria-hidden shape. Without a description carrier the repaint
  // would have added a fact only sighted operators can read — precisely the
  // gap this component's own docstring keeps auditing for. The key's
  // accessible NAME must stay the bare EBU label (every other test in this
  // file addresses keys by it), so the state rides aria-describedby instead.
  it('states each mark in the accessibility tree without disturbing the key\'s accessible name', () => {
    renderRail({
      steps: OPEN_STEPS,
      activeChip: 'provision',
      current: 'provision',
      completeness: {
        design: 'complete',
        plan: 'complete',
        provision: 'partial',
        configure: 'none',
        finalise: 'none',
      },
    })

    const expected: Record<string, string> = {
      design: 'Complete',
      plan: 'Complete',
      provision: 'Partially satisfied',
      configure: 'Not started',
      finalise: 'Not started',
    }
    for (const id of FLOW_STEPS) {
      const el = chip(LabelFor(id))
      // The name is still exactly the label — nothing appended.
      expect(el.getAttribute('aria-label'), `${id} accessible name must stay the bare label`).toBe(LabelFor(id))
      const describedBy = el.getAttribute('aria-describedby')
      expect(describedBy, `${id} should describe its own state`).toBeTruthy()
      expect(document.getElementById(describedBy as string)?.textContent).toBe(expected[id])
    }
  })

  // dmfdeploy#414 made the bare workload URL the workload's home, and there
  // NO key is selected — the rail rendered five identical dead chips, no
  // position, no progress, on the most-visited rail state. This is the fix,
  // and the reason completeness is a separate axis from selection at all.
  it('still reports progress on the workload home, where no key is selected and there is no position', () => {
    renderRail({
      steps: {
        design: 'complete',
        plan: 'complete',
        provision: 'complete',
        configure: 'open',
        finalise: 'open',
      },
      activeChip: null,
      current: null,
      completeness: {
        design: 'complete',
        plan: 'complete',
        provision: 'complete',
        configure: 'complete',
        finalise: 'complete',
      },
    })

    // Nothing is selected and nothing is the position...
    for (const id of FLOW_STEPS) {
      const el = chip(LabelFor(id))
      expect(el.getAttribute('aria-pressed'), `${id} must not read as selected`).toBe('false')
      expect(el.getAttribute('aria-current'), `${id} must not read as the position`).toBeNull()
      // ...yet the rail is no longer silent: every key states its progress.
      expect(el.querySelector('[data-testid="mark-complete"]'), `${id} should still report completeness`).not.toBeNull()
    }
  })

  // The mark inherits the key's own text colour (bg-current/border-current)
  // rather than introducing a colour axis of its own, which is what keeps the
  // grammar readable in greyscale and on the inverted (selected) key alike.
  it('carries no colour utility of its own — the mark inherits the key tone', () => {
    renderRail({
      steps: OPEN_STEPS,
      activeChip: 'design',
      current: 'provision',
      completeness: {
        design: 'complete',
        plan: 'partial',
        provision: 'none',
        configure: 'none',
        finalise: 'none',
      },
    })

    const filled = chip('Design').querySelector('[data-testid="mark-complete"]') as HTMLElement
    expect(filled.className).toContain('bg-current')
    const outline = chip('Plan').querySelector('[data-testid="mark-partial"]') as HTMLElement
    expect(outline.className).toContain('border-current')
    for (const el of [filled, outline]) {
      expect(el.className).not.toMatch(/\b(bg|text|border)-(red|green|amber|accent|ok|warning)\b/)
    }
  })
})

describe('colour now tracks SELECTION, not stage identity (Arc 4 rail-treatment ruling, umbrella #347)', () => {
  it('every non-selected chip is neutral — no fill, muted text', () => {
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

    // Cyan (the action accent) never appears on the rail — it would make
    // the promoted primary action ambiguous with "where you are".
    for (const id of ['design', 'plan', 'provision', 'configure', 'finalise'] as FlowStepId[]) {
      expect(chip(LabelFor(id)).className).not.toContain('accent')
    }
  })
})

// dmfdeploy#414: supersedes the pre-#414 "Control/Operate is structurally
// NOT a sixth item of the orchestration list" test (GATE-D1 P1.2) — that
// test proved Operate sat OUTSIDE the <ol> as a labelled sibling group.
// There is no sibling group left to prove anything about; this proves the
// stronger, current fact — nothing reads as a sixth key anywhere in the
// rail, structurally or by an accessible name.
describe('the rail is exactly five keys, nothing adjacent that could read as a sixth (dmfdeploy#414)', () => {
  it('renders exactly five <li> in the orchestration <ol>, and no link, group, or "Operate" text anywhere in the nav', () => {
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
    //
    // FIX ROUND (codex gate, P2 — same defect class as the other
    // within(...).queryByRole('button') fixes in this file, found in the
    // same sweep): querySelector('[role="button"]') only matches the
    // LITERAL role="button" attribute — a regression to a native <button>
    // element (which carries an IMPLICIT button role with no such
    // attribute at all) would pass this check silently. tagName closes
    // that gap directly on the chip root itself.
    expect(provision.tagName).toBe('DIV')
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

  // CONFIRMED unaffected by the dmf-cms#391 Pass 1 redesign: the sr-only
  // "Selected" node is orthogonal to the state-word/icon removals (it was
  // never a state word itself), so no changes were needed here — already
  // green before and after this fix round.
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

// dmfdeploy#414: the pre-#414 "the Operate link's aria-current tracks
// SELECTION, not just backend POSITION" describe block lived here — both of
// its tests exercised the Operate <Link>'s own aria-current repurposing,
// which no longer exists (LifecycleStrip.tsx no longer renders an Operate
// link at all). Nothing survives to replace it with: the five keys' own
// aria-current="step" behaviour (POSITION, unconditional on selection) is
// already covered above in "backend position and wizard selection are each
// their own signal", and SELECTION on the five keys is aria-pressed, not
// aria-current — there is no analogous "selected but not the position"
// aria-current case among them to pin.

// NEW (dmf-cms#391 Pass 1): the row-end run-count readout. `trustworthy` is
// a plain prop as far as LifecycleStrip itself is concerned (this file
// tests the component in isolation, via renderRail's own directly-supplied
// runningReadout — it never goes through store/headerSlot.ts's
// classifyWorkloadForHeaderSlot/buildHeaderSlotRail pipeline here). In
// production that value traces back to WorkloadLifecycleInput's
// membersDataTrustworthy (lib/workloadLifecycle.ts's
// isGroupedReadTrustworthy), but FIX ROUND (codex gate — P1 residual): it
// is no longer a simple threaded pass-through — buildHeaderSlotRail derives
// it from a module-private WeakMap keyed on the classified flow's own
// identity (see headerSlot.ts's TRUST side table docstring). Neither that
// freshness formula nor the WeakMap derivation is this file's concern —
// this file only pins that LifecycleStrip RENDERS what it is handed
// correctly; topbarBrand.test.tsx covers the derivation itself.
describe('the row-end run-count readout', () => {
  const READY_STEPS: Record<FlowStepId, FlowStepState> = {
    design: 'complete',
    plan: 'complete',
    provision: 'complete',
    configure: 'open',
    finalise: 'open',
  }

  // ART. 1 HARD RULE, pinned: an untrustworthy read must never print a
  // count — not the real one, not a stale one, not a guess. This is the
  // operator's own line from the work order, verbatim.
  it('prints no count when the underlying read is untrustworthy — an honest non-answer instead', () => {
    renderRail({
      steps: READY_STEPS,
      activeChip: 'design',
      current: 'design',
      runningReadout: { running: 3, total: 5, trustworthy: false },
    })

    // The real numbers must not leak into the DOM even though they were
    // passed in — trustworthy: false withholds them entirely, the same
    // fail-closed discipline as every other gate in this codebase.
    expect(screen.queryByText('3 of 5 running', { exact: false })).toBeNull()
    expect(screen.queryByText(/\d+ of \d+ running/i)).toBeNull()
    expect(screen.getByText('Count unavailable', { exact: false })).toBeTruthy()
  })

  it('prints the trustworthy count, green LED, when at least one instance is running', () => {
    renderRail({
      steps: READY_STEPS,
      activeChip: 'design',
      current: 'design',
      runningReadout: { running: 2, total: 4, trustworthy: true },
    })

    expect(screen.getByText('2 of 4 running', { exact: false })).toBeTruthy()
  })

  it('prints the trustworthy count, grey (not red or green) LED, when nothing is running', () => {
    renderRail({
      steps: READY_STEPS,
      activeChip: 'design',
      current: 'design',
      runningReadout: { running: 0, total: 4, trustworthy: true },
    })

    expect(screen.getByText('0 of 4 running', { exact: false })).toBeTruthy()
  })

  // A job this session started is a fact LifecycleStrip already has
  // directly (jobInFlight/jobOwnerLabel) — it takes priority over the
  // trustworthy count even when trustworthy is also true, and renders the
  // job label WITHOUT a fabricated elapsed duration (no start-timestamp
  // fact exists anywhere in this data model — see the file docstring on
  // RunningReadout).
  it('shows the job label instead of a count while a job is in flight, with no invented elapsed time', () => {
    renderRail({
      steps: READY_STEPS,
      activeChip: 'design',
      current: 'design',
      jobOwnerLabel: 'Configure',
      jobInFlight: true,
      runningReadout: { running: 2, total: 4, trustworthy: true },
    })

    // "Configure" also appears as a plain step-key label elsewhere in the
    // row, so this must scope to the readout itself rather than
    // screen.getByText, which would ambiguously match both.
    const readout = screen.getByTestId('running-readout')
    expect(within(readout).queryByText('2 of 4 running', { exact: false })).toBeNull()
    expect(within(readout).getByText('Configure', { exact: false })).toBeTruthy()
  })
})
