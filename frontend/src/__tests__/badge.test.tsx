/**
 * Shared Badge component (umbrella dmfdeploy/dmfdeploy#347 Arc 4 WP-4,
 * Art. 11: colour is never the only signal — colour plus shape/icon plus
 * text plus position, legible with colour stripped; a hover-only `title=`
 * tooltip does not satisfy it).
 *
 * `tone`, `icon` and `label` are all required props at the type level, so a
 * caller cannot compile a colour-only badge — but a type constraint alone
 * doesn't prove the icon actually reaches the DOM. This file's second test
 * is the discriminating one: it was run once with Badge's icon render line
 * commented out to confirm it goes red (mutation-verified by hand, not just
 * asserted against the type system), then restored.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { AlertCircle, CheckCircle2 } from 'lucide-react'
import Badge from '../components/Badge'

afterEach(() => cleanup())

describe('Badge', () => {
  it('renders the label text', () => {
    render(<Badge tone="info" icon={CheckCircle2} label="configured" />)
    expect(screen.getByText('configured')).toBeTruthy()
  })

  // The discriminating case (Art. 11): tone/colour is never sufficient on
  // its own — an icon must render alongside the label every time, for every
  // tone. Lucide icons render as <svg>, so its presence is the DOM-level
  // proof an icon actually reached the page, not just that a prop was typed.
  it.each([
    ['neutral', 'unknown'],
    ['info', 'configured'],
    ['progress', 'provisioning'],
    ['warning', 'reconciling'],
    ['danger', 'degraded'],
  ] as const)('tone=%s always renders an icon alongside the label, never colour alone', (tone, label) => {
    const { container } = render(<Badge tone={tone} icon={AlertCircle} label={label} />)
    const badge = screen.getByText(label).closest('span')
    expect(badge).toBeTruthy()
    expect(badge?.querySelector('svg')).toBeTruthy()
    // The icon is decorative — the label alone carries the accessible name —
    // so it must be hidden from assistive tech, not double-announced.
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('title is supplementary, not a substitute for the always-visible icon+label', () => {
    render(<Badge tone="warning" icon={AlertCircle} label="reconciling" title="extra detail on hover/focus" />)
    const badge = screen.getByText('reconciling').closest('span')
    expect(badge?.getAttribute('title')).toBe('extra detail on hover/focus')
    // The icon is present regardless of whether title is set at all.
    expect(badge?.querySelector('svg')).toBeTruthy()
  })

  it('omitting title renders no title attribute — nothing depends on hover alone', () => {
    render(<Badge tone="info" icon={CheckCircle2} label="planned" />)
    const badge = screen.getByText('planned').closest('span')
    expect(badge?.hasAttribute('title')).toBe(false)
  })
})
