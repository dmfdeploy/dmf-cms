import type { FlowStepId } from './workloadFlow'

/**
 * Stage identity colours as Tailwind utility classes (umbrella
 * dmfdeploy/dmfdeploy#347 Arc 4 WP-2 — relocated out of
 * pages/MediaWorkloads/LifecycleStrip.tsx, which used to own these as
 * local bg-[#hex] literals). The hex values themselves now live once, as
 * --color-stage-NAME / --color-stage-NAME-fg tokens in index.css; this
 * module is the single place that turns them into class names, so no
 * component reaches for a bg-[#hex] literal directly.
 *
 * COLOUR IS STAGE IDENTITY, NEVER STATE (Constitution Art. 11) — each
 * value below is fixed regardless of open/complete/locked/current; see
 * LifecycleStrip.tsx for how state is layered on top via icon + text.
 *
 * Named for STAGES, not EBU: the EBU taxonomy vocabulary is leaving
 * default level in WP-3, and this module must not reintroduce it as
 * vocabulary that leaks back into default-level UI.
 */
export const STAGE_FILL: Record<FlowStepId, string> = {
  design: 'bg-stage-design text-stage-design-fg',
  plan: 'bg-stage-plan text-stage-plan-fg',
  provision: 'bg-stage-provision text-stage-provision-fg',
  configure: 'bg-stage-configure text-stage-configure-fg',
  finalise: 'bg-stage-finalise text-stage-finalise-fg',
}

/** The Control vertical's own identity colour, for Operate. */
export const CONTROL_FILL = 'bg-stage-control text-stage-control-fg'

/**
 * The lifecycle RAIL's own neutral fill + ink (dmfdeploy#481/#482/#483,
 * redesign fix round). ONE shared token pair for all five keys — hue no
 * longer lives on the fill at all (see index.css's own token comment for
 * why: with five separately-hued fills, the light-zone stages could not
 * simultaneously clear 4.5:1 against one ink AND 3:1 against the
 * achromatic selected fill, a structural conflict two prior fix rounds
 * fought and could not tune around). A single shared fill means selection's
 * fill-invert contrast is identical, and adequate, on every key by
 * construction — see LifecycleStrip.tsx's own docstring for the measured
 * number and where that guarantee actually lives (a render measurement,
 * not something jsdom can assert).
 */
export const RAIL_FILL = 'bg-rail-fill'
export const RAIL_INK = 'text-text'

/**
 * The lifecycle RAIL's identity hues (dmfdeploy#481/#482/#483) — now a
 * bottom-edge LINE, tally-style, not a fill (redesign fix round; the
 * tally itself keeps the top edge — two different facts do not share an
 * edge). A SEPARATE, muted palette from STAGE_FILL above, which stays
 * retired (Arc 4 WP-2, unused by LifecycleStrip.tsx today). See index.css's
 * --color-rail-* token block for the values, the small-area dE2000
 * measurement, and the honest "reinforcing cue only" read that measurement
 * produced.
 *
 * No `fg` here, unlike STAGE_FILL/the old RAIL_FILL shape — a decorative
 * line carries no text of its own, so there is nothing to pair an ink
 * against.
 */
export const RAIL_LINE: Record<FlowStepId, string> = {
  design: 'bg-rail-design',
  plan: 'bg-rail-plan',
  provision: 'bg-rail-provision',
  configure: 'bg-rail-configure',
  finalise: 'bg-rail-finalise',
}
