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
 * The set below is deliberately BOUNDED, not an attempt at exhaustive ARIA
 * coverage (codex's own framing: "bounded and stated beats silently
 * partial"). Native interactive tags cover everything HTML itself makes
 * focusable/actionable by default; `[tabindex]` catches anything made
 * focusable by hand; the ARIA role list covers the widget roles a future
 * actions-shaped addition to `children` would plausibly reach for. If a
 * future contribution needs a role outside this list, extending the list
 * here is a one-line, reviewable change — not a reason to leave the check
 * narrower than the contract it's supposed to enforce.
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
  'checkbox',
  'radio',
  'switch',
  'tab',
  'textbox',
  'combobox',
  'slider',
  'spinbutton',
  'option',
]

const INTERACTIVE_SELECTOR = [
  ...INTERACTIVE_TAGS,
  '[tabindex]',
  ...INTERACTIVE_ARIA_ROLES.map((role) => `[role="${role}"]`),
].join(', ')

/** Asserts `el` contains no interactive descendant per the bounded set
 *  above. Use on a Tile's primary `<Link>` element to pin the `children`
 *  side of the no-nested-interactive contract (the `actions` slot side is
 *  covered separately, in tile.test.tsx, since it's allowed to be
 *  interactive — just not nested inside the Link). */
export function assertNoInteractiveDescendant(el: Element) {
  expect(el.querySelector(INTERACTIVE_SELECTOR)).toBeNull()
}
