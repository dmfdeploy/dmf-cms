/**
 * testUtils/domAssertions.ts's `assertNoInteractiveDescendant` (codex rounds
 * 2-3, umbrella dmfdeploy/dmfdeploy#347 WP-4). Round 1's inline check in the
 * two Tile call-site tests only rejected `button`/`a`/`[role="button"]` —
 * narrower than Tile.tsx's own contract ("no interactive element / anything
 * with an interactive role"). This file proves the broader set the helper
 * now checks actually catches what that narrower check would have missed,
 * rather than just asserting the claim.
 */
import { describe, expect, it } from 'vitest'
import { assertNoInteractiveDescendant } from './testUtils/domAssertions'

function elementWith(html: string): HTMLDivElement {
  const div = document.createElement('div')
  div.innerHTML = html
  return div
}

describe('assertNoInteractiveDescendant', () => {
  // Each of these would have PASSED round 1's button/a/[role="button"]-only
  // check — that's the exact gap codex named.
  it.each([
    ['a native <input>', '<input type="text" />'],
    ['a native <select>', '<select><option>x</option></select>'],
    ['a native <textarea>', '<textarea></textarea>'],
    ['an explicit [tabindex]', '<span tabindex="0">focusable</span>'],
    ['a non-button ARIA widget role (checkbox)', '<span role="checkbox">x</span>'],
    ['a non-button ARIA widget role (menuitem)', '<span role="menuitem">x</span>'],
  ])('flags %s as an interactive descendant', (_label, html) => {
    expect(() => assertNoInteractiveDescendant(elementWith(html))).toThrow()
  })

  // The two round-1 cases stay caught too — broadening the set didn't drop
  // coverage of what was already checked.
  it.each([
    ['a <button>', '<button type="button">x</button>'],
    ['an <a>', '<a href="/x">x</a>'],
  ])('still flags %s (round 1 coverage retained)', (_label, html) => {
    expect(() => assertNoInteractiveDescendant(elementWith(html))).toThrow()
  })

  it('passes for genuinely non-interactive content', () => {
    expect(() =>
      assertNoInteractiveDescendant(elementWith('<p>plain text</p><span class="badge">degraded</span>')),
    ).not.toThrow()
  })

  // codex round 3: [role="x"] is an EXACT match and misses ARIA's
  // space-separated fallback role lists — this is the real bug, not just a
  // coverage gap, so it gets its own discriminating case rather than
  // folding into the it.each above.
  it('flags a space-separated fallback role list via token match, not exact match', () => {
    expect(() =>
      assertNoInteractiveDescendant(elementWith('<span role="menuitemcheckbox menuitem">x</span>')),
    ).toThrow()
  })

  // codex round 3: the concretely-named additions to the role list, plus
  // contenteditable — a real, common way to make something interactively
  // editable without [tabindex].
  it.each([
    ['role=menuitemcheckbox', '<span role="menuitemcheckbox">x</span>'],
    ['role=listbox', '<span role="listbox">x</span>'],
    ['role=treeitem', '<span role="treeitem">x</span>'],
    ['contenteditable (bare attribute)', '<div contenteditable>x</div>'],
    ['contenteditable="true"', '<div contenteditable="true">x</div>'],
  ])('flags %s as an interactive descendant', (_label, html) => {
    expect(() => assertNoInteractiveDescendant(elementWith(html))).toThrow()
  })

  // contenteditable="false" explicitly opts OUT — must NOT be flagged, or
  // the check would punish the exact pattern used to mark a region as
  // deliberately non-editable.
  it('does not flag contenteditable="false"', () => {
    expect(() =>
      assertNoInteractiveDescendant(elementWith('<div contenteditable="false">x</div>')),
    ).not.toThrow()
  })
})
