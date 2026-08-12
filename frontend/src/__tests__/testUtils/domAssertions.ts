import { expect } from 'vitest'

/**
 * Shared assertion for Tile.tsx's contract (codex round 2 P2-1, umbrella
 * dmfdeploy/dmfdeploy#347 WP-4): `children` renders inside Tile's primary
 * `<Link>`, so it must never contain an interactive element — anything
 * needing its own click/keyboard target belongs in `actions`, a true
 * sibling of the Link. Round 1's inline check only rejected
 * `button`/`a`/`[role="button"]`; codex correctly named that narrower than
 * what Tile.tsx's own JSDoc promises ("no interactive element / anything
 * with an interactive role"). This is the single, broader check both real
 * call sites (MediaWorkloads' WorkloadEntryTile, Facility's site tile) share
 * — one definition of "interactive", not two inline copies that could drift
 * apart.
 *
 * The set below is deliberately BOUNDED, not an attempt at exhaustive ARIA/
 * HTML coverage (codex's own framing: "bounded and stated beats silently
 * partial"). Native interactive tags cover everything HTML itself makes
 * focusable/actionable by default; `[tabindex]` and `[contenteditable]`
 * catch anything made focusable/editable by hand; the ARIA role list covers
 * the widget roles a future actions-shaped addition to `children` would
 * plausibly reach for. If a future contribution needs a role or tag outside
 * this list, extending it here is a one-line, reviewable change — not a
 * reason to leave the check narrower than what it actually covers.
 *
 * Deliberately EXCLUDED, stated rather than silently absent (codex round 3):
 * `<details>` (its own toggle affordance is `<summary>`, already covered —
 * `<details>` itself is inert without it), `<iframe>`/`<embed>` (embedded
 * content; any interactivity lives in a different document, not this DOM),
 * `<label>` (inert on its own; interactive only via the control it
 * references, which is itself already covered), `img[usemap]` (inert
 * without `<area>` children, which are themselves already covered), and
 * `[role="gridcell"]` (only interactive within an editable grid — context-
 * dependent, not universally interactive the way the roles below are).
 */
const INTERACTIVE_TAGS = [
  'button',
  'a',
  'input',
  'select',
  'textarea',
  'summary',
  'area',
  'audio[controls]',
  'video[controls]',
]

const INTERACTIVE_ARIA_ROLES = [
  'button',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'slider',
  'spinbutton',
  'scrollbar',
  'option',
  'treeitem',
]

const INTERACTIVE_SELECTOR = [
  ...INTERACTIVE_TAGS,
  '[tabindex]',
  // contenteditable="false" explicitly opts OUT of editability — only a
  // present, non-"false" value (including the bare attribute, whose value
  // defaults to "true" per the HTML spec) counts as interactive.
  '[contenteditable]:not([contenteditable="false"])',
  // `~=` (token match), not `=` (exact match): ARIA permits a space-
  // separated fallback role list (e.g. role="menuitemcheckbox menuitem"),
  // and `[role="x"]` would silently miss every one of those.
  ...INTERACTIVE_ARIA_ROLES.map((role) => `[role~="${role}"]`),
].join(', ')

/** Asserts `el` contains no interactive descendant per the bounded set
 *  above. Use on a Tile's primary `<Link>` element to pin the `children`
 *  side of the no-nested-interactive contract (the `actions` slot side is
 *  covered separately, in tile.test.tsx, since it's allowed to be
 *  interactive — just not nested inside the Link). */
export function assertNoInteractiveDescendant(el: Element) {
  expect(el.querySelector(INTERACTIVE_SELECTOR)).toBeNull()
}
