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
 * The lifecycle RAIL's own identity hues (dmfdeploy#481/#482/#483) — a
 * SEPARATE, muted palette from STAGE_FILL above, which stays retired
 * (Arc 4 WP-2, unused by LifecycleStrip.tsx today). See index.css's
 * --color-rail-* token block for the values and how they were picked
 * (CVD-simulated, each paired with the one ink — light or dark — that
 * actually clears 4.5:1 against it).
 *
 * Unlike STAGE_FILL, `fg` is exposed as its own key rather than folded into
 * one class string: LifecycleStrip applies `bg` to the key's clipped fill
 * layer and `fg` to a SEPARATE, unclipped content layer stacked on top of
 * it (the icon + label), not to the same element — see that file's own
 * docstring for why the fill and the content live in different layers.
 */
export const RAIL_FILL: Record<FlowStepId, { bg: string; fg: string }> = {
  design: { bg: 'bg-rail-design', fg: 'text-rail-design-fg' },
  plan: { bg: 'bg-rail-plan', fg: 'text-rail-plan-fg' },
  provision: { bg: 'bg-rail-provision', fg: 'text-rail-provision-fg' },
  configure: { bg: 'bg-rail-configure', fg: 'text-rail-configure-fg' },
  finalise: { bg: 'bg-rail-finalise', fg: 'text-rail-finalise-fg' },
}
