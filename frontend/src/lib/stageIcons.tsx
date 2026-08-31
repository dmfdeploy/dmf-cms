import type { FlowStepId } from './workloadFlow'

/**
 * The lifecycle rail's per-stage IDENTITY icon set (dmfdeploy#482).
 *
 * PROVENANCE, FIX ROUND (operator ruling 2026-08-31, superseding the
 * dmfdeploy#482-era set below): the set this file originally recorded
 * (pencil / puzzle / cloud-upload / sliders / circled-check, all
 * `lucide-react`) was itself a RECONSTRUCTION — the operator's reference
 * image had shown an icon set since before dmfdeploy#449, but no repo, plan,
 * issue, or agent-transcript archive search ever turned up the actual
 * decision (confirmed absent per #482's own body at the time), so #482
 * picked the closest available `lucide-react` glyphs by name. That
 * reconstruction got two stages wrong. An archived session transcript later
 * recovered the ACTUAL decision, verbatim:
 *
 *   "USE THIS ICON SET for the five stages:
 *      Design            - pencil. The universal make something glyph. Do
 *                          not get clever.
 *      Plan              - MAP PIN. Not a puzzle piece (unguessable cold)
 *                          and not a calendar (implies time; wrong). Plan in
 *                          this product resolves WHICH FACILITY the
 *                          workload runs on, so a location pin is both the
 *                          most legible option and the most semantically
 *                          accurate one.
 *      Provision         - STACKED BLOCKS / rack. Not a cloud - that
 *                          misstates the architecture (self-managed
 *                          Kubernetes on owned hardware). Blocks read as
 *                          allocating instances.
 *      Configure         - SLIDERS.
 *      Finalise & Review - CIRCLED CHECK."
 *
 * Design, Configure (by name — see below for why the actual glyph also
 * changed) and Finalise & Review were already right. Plan (puzzle) and
 * Provision (cloud-upload) were not — a puzzle piece is unguessable cold
 * and a cloud misstates an architecture that is self-managed Kubernetes on
 * owned hardware, not a managed cloud service.
 *
 * WHY INLINE SVG, NOT A SECOND ROUND OF `lucide-react` NAME-MATCHING. The
 * SAME recovered transcript also named a real collision risk: "Stacked
 * blocks and sliders are both horizontal lines — the same flaw that sank an
 * earlier icon set," solved in the original artifact by weight and rhythm,
 * not shape ("blocks are three chunky bars with a graduated opacity,
 * sliders are two thin rules broken by large solid knobs at different
 * x-positions"). Rather than re-solve that with a `lucide-react` pick from
 * name alone (exactly the failure mode that produced the wrong Plan/
 * Provision glyphs the first time), the operator's later ruling was to use
 * the recovered artifact's OWN exact SVG symbols verbatim — they already
 * carry that weight-and-rhythm solution, confirmed by direct rendered
 * side-by-side comparison rather than re-derived (see the PR description
 * for the comparison screenshot). This also means Configure's own glyph
 * changed from `lucide-react`'s `Sliders` (`sliders-vertical`: three
 * roughly-vertical rules, cross-bar knobs) to the recovered artifact's
 * version (two horizontal rules, round knobs at different x) — narrower
 * than the original transcript quote implied on its own, and exactly what
 * made the graduated-opacity blocks glyph a safe, non-colliding pairing
 * next to it.
 *
 * `viewBox="0 0 16 16"`, `fill="currentColor"` throughout (filled
 * silhouettes, not `lucide-react`'s 1.5px stroke outlines) — inherits the
 * key's ink exactly the same way the outline icons did (`currentColor`
 * either way), so the existing ink/contrast guarantees and the selection
 * fill-invert both carry over unchanged; confirmed by render, not assumed
 * (see the PR description). This incidentally closes dmfdeploy#507 (filled
 * icon forms) for the rail's five stage icons specifically — the recovered
 * artifact's own reasoning ("solid silhouettes survive 16px; 1.5px stroke
 * sets die there") is exactly #507's complaint, and these five are drawn
 * filled with no new dependency. It does NOT close #507 more broadly: every
 * other `lucide-react` icon in the app (nav, actions, status) is still the
 * stroked set — #507 is a larger, separate change the operator has
 * explicitly deferred, and this file does not start it.
 *
 * `i-lock` and `i-done` existed in the recovered artifact too but are
 * DELIBERATELY NOT reproduced here: no padlock (Information Architecture
 * doc's 2026-08-30 #493 amendment — see LifecycleStrip.tsx's own docstring,
 * point B) and no completeness tick (the badge slot is reserved but empty
 * until dmfdeploy#495/ADR-0046 lands). Five symbols only, matching the five
 * rail keys, nothing else recovered from that artifact.
 *
 * EVERY KEY RENDERS ITS OWN ICON UNCONDITIONALLY — including a locked key
 * and a key with nothing actionable (Information Architecture doc's
 * 2026-08-30 #493 amendment; Visual System doc §2a). No key is ever
 * iconless. LifecycleStrip.tsx marks every icon `aria-hidden` — decorative
 * next to the always-visible EBU label, never announced twice.
 */

export interface StageIconProps {
  className?: string
  'aria-hidden'?: boolean | 'true' | 'false'
}

export type StageIcon = (props: StageIconProps) => React.JSX.Element

function Design({ className, ...rest }: StageIconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className} {...rest}>
      <path d="M11.06 1.62a1.4 1.4 0 0 1 1.98 0l1.34 1.34a1.4 1.4 0 0 1 0 1.98l-.83.83-3.32-3.32.83-.83Zm-1.71 1.71 3.32 3.32-6.6 6.6a1 1 0 0 1-.45.26l-3.2.86a.5.5 0 0 1-.61-.61l.86-3.2a1 1 0 0 1 .26-.45l6.42-6.78Z" />
    </svg>
  )
}

// Map pin — Plan resolves WHICH FACILITY a workload runs on, not a schedule
// (a calendar) or an unguessable abstraction (a puzzle piece); see the
// provenance comment above for the recovered decision's own reasoning.
function Plan({ className, ...rest }: StageIconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className} {...rest}>
      <path
        fillRule="evenodd"
        d="M8 1.3a5.2 5.2 0 0 0-5.2 5.2c0 3.83 4.35 8.02 4.54 8.2a.95.95 0 0 0 1.32 0c.19-.18 4.54-4.37 4.54-8.2A5.2 5.2 0 0 0 8 1.3Zm0 7.2a2 2 0 1 1 0-4 2 2 0 0 1 0 4Z"
      />
    </svg>
  )
}

// Stacked blocks, graduated opacity (1 / .82 / .55) — the "weight" half of
// the weight-and-rhythm pairing with Configure's sliders below, from the
// recovered artifact verbatim. Reads as allocating instances onto owned
// hardware; deliberately not a cloud glyph (see provenance comment above).
function Provision({ className, ...rest }: StageIconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className} {...rest}>
      <rect x="2" y="2.1" width="12" height="3.5" rx="1.25" />
      <rect x="2" y="6.25" width="12" height="3.5" rx="1.25" opacity="0.82" />
      <rect x="2" y="10.4" width="12" height="3.5" rx="1.25" opacity="0.55" />
    </svg>
  )
}

// Two thin rules (opacity .7) broken by two large SOLID knobs at different
// x-positions (cx 10.6 and 5.4) — the "rhythm" half of the pairing with
// Provision's blocks above. Solid knobs against thin rules is what keeps
// this from collapsing into the same silhouette as the blocks glyph at
// rail size; confirmed side by side, not just by this description (see the
// PR description).
function Configure({ className, ...rest }: StageIconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className} {...rest}>
      <rect x="1.6" y="4.35" width="12.8" height="1.5" rx="0.75" opacity="0.7" />
      <rect x="1.6" y="10.15" width="12.8" height="1.5" rx="0.75" opacity="0.7" />
      <circle cx="10.6" cy="5.1" r="2.75" />
      <circle cx="5.4" cy="10.9" r="2.75" />
    </svg>
  )
}

function Finalise({ className, ...rest }: StageIconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className} {...rest}>
      <path
        fillRule="evenodd"
        d="M8 .9a7.1 7.1 0 1 0 0 14.2A7.1 7.1 0 0 0 8 .9Zm3.71 5.28-4.4 4.62a.95.95 0 0 1-1.38.01L3.62 8.55a.95.95 0 1 1 1.36-1.33l1.62 1.66 3.72-3.9a.95.95 0 1 1 1.39 1.3Z"
      />
    </svg>
  )
}

export const STAGE_ICON: Record<FlowStepId, StageIcon> = {
  design: Design,
  plan: Plan,
  provision: Provision,
  configure: Configure,
  finalise: Finalise,
}
