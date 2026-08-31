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
 * either. Icon shape (lib/stageIcons.tsx) and the EBU label are the rail's
 * sole identity carriers now — both were already independently sufficient
 * (Art. 11 — "everything except hue survives greyscale"). None of the
 * measured figures from either abandoned design are reproduced here or
 * anywhere else; the surface they described no longer exists.
 *
 * VISUAL PARITY FIX ROUND (dmfdeploy/dmfdeploy#512, operator finding
 * against a live provision run). Two independent findings, both resolved
 * here:
 *
 * (1) THE UNSELECTED FILL READ TOO BRIGHT, AND DARKENING IT COLLIDES WITH
 * THE EDGE-CONTRAST CONSTRAINT. The old single `--color-rail-fill`
 * (#616161, Y=0.1195) was the fill AND the key's only edge (a clipped
 * shape carries no border, #483) — it cleared WCAG 1.4.11's 3:1 non-text
 * floor against `--color-bg` at exactly 3.19:1, so darkening that SAME
 * single layer fails the floor outright. Resolved by SPLITTING edge from
 * face, the same "two-tone sandwich" technique the focus ring already
 * used for its own outline: a separate `--color-rail-edge` token (since
 * retired — see point (4) below for how the edge's own design kept
 * evolving) initially kept the old #616161 value verbatim as a ~1px ring
 * (LifecycleStrip.tsx's `key-edge` layer, `inset-0`); `--color-rail-fill`
 * is REDEFINED, darker, as the face inset inside it (`key-fill`) — free to
 * be as dark as legibility against RAIL_INK still allows, since the 3:1
 * edge-contrast guarantee no longer lives on this token at all. Ring width
 * (1px, later 2px) and the edge's own colour-per-state (point (4)) both
 * moved after this point in the round; the SPLIT-INTO-TWO-LAYERS idea
 * itself, described here, is what survived unchanged. See index.css for
 * the current hex values and measured numbers.
 *
 * THE BACKDROP THAT 3:1 IS MEASURED AGAINST ALSO CHANGED, in the same fix
 * round (operator catch on review, don't miss this reading index.css's own
 * copy of this account): change 5 (Topbar.tsx) moved the rail's row
 * background from `bg-bg` to `bg-sidebar`, so `--color-rail-edge`'s real
 * contrast is against `--color-sidebar` (#101012), not `--color-bg`
 * (#0a0a0b) — 3.07:1 on a real render, not the 3.20 the old `--color-bg`
 * comparison would still suggest if left uncorrected. Still clears the
 * floor, with less headroom (0.07, was 0.20) — left there deliberately
 * rather than brightened, per the operator's explicit instruction for this
 * round: a hairline edge with real margin to spare reads as an outlined
 * chevron, the busier look this fix exists to avoid. `--color-sidebar` is
 * a DEPENDENCY this token does not control (Sidebar.tsx owns it) —
 * `railEdgeContrast.test.tsx` derives WHICH token to check from Topbar.tsx's
 * own rendered className rather than hardcoding `sidebar`, so it fails if
 * either the sidebar ground moves OR the rail's own row starts painting a
 * different token, not just the first of those a reviewer happens to
 * catch.
 *
 * (2) SELECTION WAS AN ACHROMATIC INVERT; IT IS NOW A SHARED OPAQUE FACE,
 * `--color-selected-face` (index.css), WITH DARK INK, ON BOTH SURFACES —
 * NOT AN ALPHA TINT. The round's FIRST attempt at fixing the achromatic
 * invert was Sidebar.tsx's own `bg-accent/20 text-accent` treatment,
 * copied onto the rail at a raised 0.55 alpha (0.20 measured 1.49:1
 * fill-vs-fill over the sidebar's own page background — a selection state
 * a sighted operator cannot see, while `aria-pressed` stays correct and
 * every test still passes — and 1.59:1 over the rail's own darker fill
 * from (1) above; both under WCAG 1.4.11's 3:1 state-change floor). That
 * attempt measured out at 0.55 correctly on ITS OWN state-change terms,
 * but real-render measurement then found two problems an alpha tint could
 * not resolve together: (a) light ink (`text-accent`) on that tint failed
 * TEXT contrast structurally — the rail's label measured 2.34:1 against
 * WCAG 1.4.3's 4.5:1 floor, because the same round's own darkened
 * unselected fill (1, above) put the achievable Y range for "clears 3:1
 * state-change" and "clears 4.5:1 against light ink" in disjoint,
 * non-overlapping intervals, not a tuning gap any alpha/hue choice could
 * close; (b) the sidebar's tint (composited over `--color-sidebar`,
 * #101012) and the rail's tint (composited over the darker
 * `--color-rail-fill`, #2c2c2e) rendered as two DIFFERENT pixels
 * (rgb(76,123,146) vs rgb(88,135,158), dE2000 4.63 — perceptible at a
 * glance) despite being "the same idea", the opposite of this round's own
 * stated goal.
 *
 * RULED OFF A RENDERED A/B/C COMPARISON, NOT PROSE (see
 * pages/Dev/SelectionOptionsHarness.tsx in this round's git history — a
 * throwaway decision aid, deleted before the PR): invert the ink instead
 * of tinting the fill. `--color-selected-face` (#58879e) is an OPAQUE
 * literal — not a Tailwind alpha modifier — painted directly as the SAME
 * value in both Sidebar.tsx and here, so there is no compositing left to
 * diverge and dE2000 between the two surfaces is exactly 0 by
 * construction. Dark ink (`--color-bg`, reused, no new ink token) clears
 * the interim attempt's text-contrast failure with real margin: 5.06:1
 * for the rail's label (floor 4.5), 5.06:1 for the sidebar's icon (floor
 * 3.0) — identical because it is the identical ink-vs-face pairing in
 * both places, by construction, not two independently-tuned numbers that
 * happen to agree. Rail state-change (selected vs `--color-rail-fill`)
 * measures 3.57:1; sidebar state-change (selected vs its own resting
 * `--color-sidebar` ground) measures 4.86:1 — both real-render figures,
 * both over the WCAG 1.4.11 3:1 floor. All measured on LifecycleStrip.tsx
 * and Sidebar.tsx's own real markup, not a stand-in.
 *
 * NOTE FOR A FUTURE READER OF ANY EARLIER ACCOUNT OF THIS ROUND: an
 * earlier draft of this reasoning wrongly attributed a 2.76:1
 * icon-contrast failure to the ALREADY-SHIPPED sidebar (`bg-accent/20
 * text-accent`). That number belongs to the never-shipped 0.55-alpha
 * interim attempt above, not the shipped design — the shipped sidebar's
 * icon was always legible (7.50:1); its real, shipped weakness was only
 * the 1.52:1 state-change floor violation (2, first paragraph) plus the
 * fact that the luminance component of that shift was itself just
 * 1.68:1, meaning the perceptible signal leaned on hue more than
 * brightness. See index.css's own `--color-selected-face` comment for the
 * fuller, corrected account.
 *
 * Selection is carried by the `key-fill` layer's own class swapping to
 * RAIL_SELECTED_FACE, a straight two-state swap (the SAME shape this rail
 * used before the alpha-tint detour, just different
 * token values), not an added third layer. RAIL_SELECTED_INK (`text-bg`)
 * is the ink half of that swap.
 *
 * Because both faces are OPAQUE literals now, there is no OKLab-vs-sRGB
 * blend-model question left for this design the way the retired
 * alpha-tint attempt had — that caveat applied only for as long as
 * compositing was actually happening, and no longer does.
 *
 * (3) RESTING INK, THE THIRD STATE — a follow-on ruling once (2) above
 * shipped. The operator's first instinct was `--color-text` at rest in
 * BOTH surfaces (the rail already rests there; the sidebar would move up
 * from `--color-muted`), reasoned as "selection darkens now, so the old
 * reason to keep resting dim — leaving headroom for a brightening step —
 * is gone." True as far as it goes, but it missed a SECOND consumer of
 * that same headroom: Sidebar.tsx's hover state is ink-only in effect
 * (`hover:text-text`, on top of a `hover:bg-panel/50` that measures
 * ~1.03:1 against `--color-sidebar` on the real render — fully opaque
 * `--color-panel` against `--color-sidebar` is already only 1.03:1, so no
 * alpha of it was ever going to work). Resting AT `--color-text` makes
 * `hover:text-text` a no-op, silently deleting the sidebar's only working
 * hover affordance as a side effect of a consistency ruling nobody had
 * asked to trade against it.
 *
 * `--color-resting-ink` (index.css, #b4b4b8, Y≈0.458) is the fix — a
 * genuine third value between `--color-muted` and `--color-text`, so hover
 * still has somewhere to go (brightening to `--color-text` on top of it).
 * See index.css's own docstring for the full measured figures.
 *
 * THE RAIL GAINS A HOVER STATE IT NEVER HAD, as a consequence of this same
 * ruling — "three distinct carriers [resting/hover/selected], identical in
 * both surfaces" only holds if both surfaces actually have all three.
 * `hover:text-text` on the interactive button variant (LifecycleStrip.tsx)
 * is new, additive, and applies only alongside RAIL_INK (never
 * RAIL_SELECTED_INK) — matching Sidebar.tsx's own pattern of gating hover
 * to the unselected branch only.
 *
 * THE HOVER-DELTA TRADE, STATED ONCE AND UPDATED, NOT LEFT STALE: at the
 * point (3) was ruled, moving resting ink up cost the sidebar's shipped
 * hover delta 2.28:1 (muted->text) down to 1.69:1 (this-token->text) — a
 * real, deliberate cost, recorded as a net loss at the time. Point (4)
 * below (the edge ruling) repays it: a hover EDGE adds a second carrier at
 * 5.06:1 (#616161->#e8e8ea) on top of the ink delta, so hover ends up
 * STRONGER than it was before this round touched anything, not weaker. An
 * earlier version of this comment described the 1.69 figure as the
 * standing cost — that stopped being accurate the moment (4) shipped, and
 * is corrected here rather than left for a future reader to rediscover.
 *
 * (4) THE CHEVRON EDGE, RULED SEPARATELY FROM (1)-(3), IN TWO PASSES. The
 * FIRST pass (rendered off an A/B/C-of-its-own board: fixed edge vs. two
 * "edge tracks ink" sub-variants) landed on a fourth option the board made
 * visible rather than any of the three rendered — kept `--color-rail-edge`
 * (#616161) at rest, brightened it to `--color-text` on hover, and dropped
 * it to the selected face's own colour (no ring) once selected. THE FINAL
 * PASS, after a live-environment complaint that the shipped (pre-#512)
 * selected face read "too bright," reasoned from that same instinct all
 * the way through: if a visible ring is undesirable when bright, it is
 * undesirable at REST too, not just when selected. Edge, final:
 *   - RESTING: the SAME token as the face, `RAIL_FILL` — no ring, expressed
 *     as a colour choice (edge = face), NOT a geometry change (edge =
 *     transparent). Geometry was deliberately avoided: making the edge
 *     transparent would let the band show through the 2px ring, so the
 *     key's PAINTED region would differ in size between resting and
 *     hover — which also moves whatever `contentOffsetStyle()` centres on.
 *     Holding the edge at the face's own colour keeps the painted
 *     silhouette's outer boundary constant across every state; only its
 *     colour changes.
 *   - HOVER: `RAIL_SELECTED_FACE` — THE SELECTED FILL COLOUR, not a bright
 *     accent and not `--color-text` (the first pass's choice, superseded).
 *     Operator-explicit, and deliberate for two reasons: it makes hover a
 *     PREVIEW of what selecting the key will look like, and it reserves
 *     accent hue for focus alone, which is what dissolves the hover/focus
 *     collision risk (below) rather than merely managing around it.
 *   - SELECTED: `RAIL_SELECTED_FACE`, unchanged from the first pass — the
 *     face alone already clears 3:1 against the band ground unaided
 *     (measured, not assumed — see the figures below), so the edge has no
 *     remaining boundary job once selected, same reasoning as hover.
 * The RESTING face, with no ring at all, measures only ~1.36:1 against the
 * band ground — READ THIS CORRECTLY, do not treat it as an oversight to
 * "fix" later: WCAG 1.4.11 requires 3:1 for visual information REQUIRED TO
 * IDENTIFY a component, and here it is not required — every key carries an
 * always-visible TEXT LABEL that identifies it on its own (6.74:1, clears
 * 1.4.3's text floor with margin). The silhouette is a nice-to-have once a
 * label already does the identifying job, not the thing 1.4.11 is
 * protecting. 1.36 is conformant BECAUSE of the label, not because 1.36
 * itself clears anything — a future reader restoring a resting ring
 * "for contrast" would be solving a problem that reasoning shows doesn't
 * exist.
 *
 * THE HOVER-TARGET BUG (caught before shipping, not after). Hover was
 * FIRST wired as a plain `hover:` class on the edge span itself — which
 * only fires `:hover` when the pointer is directly over THAT element's own
 * clipped hit-test region. Since `key-fill` (rendered after `key-edge`,
 * later in DOM order) visually and interactively covers most of the key's
 * area, hovering the LABEL or ICON hit `key-fill` (or the button's own
 * unclipped rect in the concave notch void), never `key-edge` — the
 * outline only responded when the pointer was precisely on the thin ring
 * itself, disconnected from the control a sighted or pointer user actually
 * perceives as "the key." Fixed two ways, both real fixes not redundant
 * belt-and-suspenders: `pointer-events-none` on the purely decorative
 * (`aria-hidden`) `key-edge`/`key-fill` layers, so the BUTTON is always the
 * pointer target regardless of which clipped layer visually sits where;
 * and `RAIL_EDGE_HOVER`/ink's own hover class both use `group-hover:`, not
 * `hover:`, keyed off the button's own `group` class — so both layers
 * repaint from the CONTAINER's hover state, not their own. Hover now fires
 * identically from the face, the label, the icon, or the outline itself,
 * verified on a real render with real pointer automation, not asserted
 * from the fix alone.
 *
 * HOVER AND FOCUS, VERIFIED NOT TO COLLIDE, TWICE ACROSS TWO EDGE DESIGNS.
 * Both are outline-shaped and both are now 2px, so colour and position are
 * the only remaining differentiators — checked, not assumed, with a real
 * Tab keypress (not `element.focus()`, which does not reliably produce
 * `:focus-visible`) and a real pointer hover, separately and together
 * (hover+focus-visible simultaneously is the actual case when a keyboard
 * user tabs onto a key their pointer already rests on). CORRECTION WHILE
 * VERIFYING THIS: the rail's own focus ring was never accent-coloured in
 * the first place — unlike Sidebar.tsx's tiles (`focus-visible:outline-
 * accent`), LifecycleStrip.tsx's ring has always used `outline-current`
 * (RAIL_INK/RAIL_SELECTED_INK — i.e. `--color-resting-ink` or `--color-
 * bg`, per whichever ink is active) plus the fixed `--color-bg`/`--color-
 * text` box-shadow sandwich (LifecycleStrip.tsx's own "FOCUS RING"
 * section) — confirmed on the real render (`outlineColor` reads
 * `rgb(10, 10, 11)`, `--color-bg`, on a selected+focused key), not
 * assumed from the class list. So the two never shared accent's hue to
 * begin with; what actually keeps them apart is POSITION (hover, on
 * `key-edge`, sits INSIDE the button following the clipped silhouette;
 * focus sits OUTSIDE it, in the inter-key gap) plus the fact that hover's
 * `--color-selected-face` teal is visibly distinct from either of the
 * focus ring's own neutral/ink colours regardless. Confirmed to read as
 * visually distinct in all three combinations on the real render, not
 * inferred from the colour values alone.
 *
 * A single shared fill/edge pair means the fill-vs-selected-face contrast
 * is identical, and adequate, on every key by construction — see
 * LifecycleStrip.tsx's own docstring for where that guarantee actually
 * lives (a render measurement, not something jsdom can assert).
 */
/** The hover-only outline colour, prefix baked in — same reasoning as
 *  RAIL_HOVER_INK's own comment (Tailwind's build-time scanner extracts
 *  literal, unbroken class-name tokens straight out of source TEXT; it
 *  does not evaluate JS, so the compound "group-hover:bg-selected-face"
 *  token has to exist as one literal SOMEWHERE, and this is the one place
 *  it's defined). `group-hover:`, not `hover:` — see the "HOVER TARGET
 *  BUG" account below for why a same-element `hover:` on this layer was
 *  wrong. Gated to the unselected case only, alongside RAIL_HOVER_INK — a
 *  selected key's edge is RAIL_SELECTED_FACE too, but unconditionally
 *  (no ring either way — see point (4) below). */
export const RAIL_EDGE_HOVER = 'group-hover:bg-selected-face'
export const RAIL_FILL = 'bg-rail-fill'
/** Resting ink, applied alongside RAIL_HOVER_INK on the same (non-selected)
 *  element only. See this module's own docstring, point (3), for the full
 *  derivation. */
export const RAIL_INK = 'text-resting-ink'
/** The hover-variant class WITH its `hover:` prefix already baked in, not
 *  a bare ink name meant to be templated with one — Tailwind's build-time
 *  class scanner extracts literal, unbroken class-name tokens straight out
 *  of source TEXT (it does not evaluate JS), so `` `hover:${X}` `` at a
 *  call site would never actually produce the contiguous string
 *  "hover:text-text" for the scanner to find in THAT file; it would only
 *  work by coincidence if some unrelated file happens to spell the same
 *  class literally elsewhere. Keeping the full compound string here, in
 *  the one place it's defined, is what makes every call site self-
 *  sufficient regardless of what any other file does. */
export const RAIL_HOVER_INK = 'hover:text-text'
/** The selected face and its ink — the SAME opaque literal and the SAME
 *  dark ink as Sidebar.tsx's own selected tile; see this module's own
 *  docstring above for the full derivation and the operator ruling (off a
 *  rendered comparison) that both surfaces must share the literal, not
 *  just the idea. */
export const RAIL_SELECTED_FACE = 'bg-selected-face'
export const RAIL_SELECTED_INK = 'text-bg'
