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
 * redesign fix round). ONE shared token pair for all five keys — hue does
 * not live anywhere on the rail any more.
 *
 * FULL ACCOUNT, so a future reader does not have to reconstruct it from
 * git blame: hue started as five per-stage FILL colours; a fix round found
 * those could not simultaneously clear 4.5:1 against one ink AND 3:1
 * against the achromatic selected fill for the light-zone stages (a
 * structural conflict, not a tuning gap). The next round moved hue to a
 * bottom-edge LINE instead, keeping one shared neutral fill — but small-
 * area colour is the worst case for hue discrimination, and a real dE2000
 * measurement on that line found plan/provision imperceptible (dE00
 * 0.85-1.17) under the two common CVDs. The operator's ruling from that
 * measurement: a cue that fails for roughly 1 in 12 males is not an
 * identity channel, and removed hue from the rail entirely rather than
 * keep paying for a line that could not do the job the fill couldn't
 * either. Icon shape (lib/stageIcons.ts) and the EBU label are the rail's
 * sole identity carriers now — both were already independently sufficient
 * (Art. 11 — "everything except hue survives greyscale"). None of the
 * measured figures from either abandoned design are reproduced here or
 * anywhere else; the surface they described no longer exists.
 *
 * A single shared fill means selection's fill-invert contrast is
 * identical, and adequate, on every key by construction — see
 * LifecycleStrip.tsx's own docstring for the measured number and where
 * that guarantee actually lives (a render measurement, not something
 * jsdom can assert).
 */
export const RAIL_FILL = 'bg-rail-fill'
export const RAIL_INK = 'text-text'
