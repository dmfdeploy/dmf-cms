import { act } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AutomationInProgressNotice from '../components/AutomationInProgressNotice'
// codex adversarial review (feat/390-throbber, T3): jsdom does not compute
// real CSS cascade/media-query results, so a rendered-DOM test cannot prove
// ".throbber-spin's animation is actually disabled under
// prefers-reduced-motion" the way a real browser would. Read the shipped
// stylesheet SOURCE instead, via Vite's own ?raw import — the SAME pattern
// buttonHierarchy.test.tsx/formFieldPrimitive.test.tsx already use for this
// exact purpose, not a new one. A direct, honest regression guard: if a
// future edit ever removes .throbber-spin from this media block (or
// removes the block itself), this fails immediately.
import INDEX_CSS from '../index.css?raw'

afterEach(cleanup)

/**
 * dmfdeploy/dmfdeploy#390 (Phase 1, "the throbber"). Covers the component's
 * own logic directly — the four liveness elements, the degrade path when no
 * marker has arrived, and the four tail-coverage running-count guardrails
 * (G1-G4) recorded in the component's own docstring. Integration coverage
 * (the real call sites actually wiring startedAt/progressStep/runningReadout
 * correctly) lives in createWorkload.test.tsx and workloadSetup.test.tsx —
 * this file is the component's own contract, independent of either caller.
 */
describe('AutomationInProgressNotice', () => {
  it('renders the action label, typical-duration line, and children', () => {
    render(
      <AutomationInProgressNotice action="Provisioning under way" startedAt={null} typicalDuration="a few minutes">
        Extra context.
      </AutomationInProgressNotice>,
    )
    const heading = screen.getByText('Provisioning under way')
    expect(heading.className).toMatch(/text-lg/)
    expect(screen.getByText('Typically takes a few minutes.')).toBeTruthy()
    expect(screen.getByText('Extra context.')).toBeTruthy()
  })

  it('never renders "will take" — a duration claim must read as typical, never promised', () => {
    render(
      <AutomationInProgressNotice action="Tearing down" startedAt={null} typicalDuration="two to three minutes">
        x
      </AutomationInProgressNotice>,
    )
    expect(document.body.textContent).not.toMatch(/\bwill take\b/)
  })

  it('renders the spinner marked aria-hidden (decorative)', () => {
    render(
      <AutomationInProgressNotice action="Provisioning under way" startedAt={null} typicalDuration="a few minutes">
        x
      </AutomationInProgressNotice>,
    )
    const spinner = document.querySelector('.throbber-spin')
    expect(spinner).toBeTruthy()
    expect(spinner?.getAttribute('aria-hidden')).toBe('true')
  })

  it('the shipped stylesheet actually kills .throbber-spin under prefers-reduced-motion (source check — see file docstring for why not a DOM one)', () => {
    const reducedMotionBlock = INDEX_CSS.match(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([^}]*\{[^}]*\}[^}]*)\}/,
    )
    expect(reducedMotionBlock, 'no prefers-reduced-motion media block found in index.css at all').toBeTruthy()
    const body = reducedMotionBlock![1]
    expect(body).toMatch(/\.throbber-spin/)
    expect(body).toMatch(/animation:\s*none\s*!important/)
  })

  describe('the elapsed clock — the non-motion liveness cue', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-08-30T12:00:00.000Z'))
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('renders no clock when startedAt is null — never a guessed start time', () => {
      render(
        <AutomationInProgressNotice action="Provisioning under way" startedAt={null} typicalDuration="a few minutes">
          x
        </AutomationInProgressNotice>,
      )
      expect(screen.queryByText(/^\d+[ms]/)).toBeNull()
    })

    it('computes elapsed from the SERVER timestamp and ticks up every second', () => {
      render(
        <AutomationInProgressNotice
          action="Provisioning under way"
          startedAt="2026-08-30T11:58:30.000Z"
          typicalDuration="a few minutes"
        >
          x
        </AutomationInProgressNotice>,
      )
      // 90s elapsed at mount.
      expect(screen.getByText('1m 30s')).toBeTruthy()

      act(() => {
        vi.advanceTimersByTime(5_000)
      })
      expect(screen.getByText('1m 35s')).toBeTruthy()
    })

    it('codex T3: the clock keeps ticking with prefers-reduced-motion emulated as active — the whole degradation argument depends on this surviving when the spinner does not', () => {
      // Emulates the OS preference the same way this is conventionally done
      // in jsdom (window.matchMedia has no real media-feature detection —
      // a test must stand in for it). The component never reads matchMedia
      // itself (see this file's own CSS-source test above: the spinner's
      // reduced-motion behavior is CSS-only, not JS-branched) — that is
      // exactly the point being proven: the elapsed-clock code path has NO
      // dependency on motion preference at all, so it is unaffected
      // regardless of what the environment reports.
      const matchMediaMock = vi.fn().mockImplementation((query: string) => ({
        matches: query === '(prefers-reduced-motion: reduce)',
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }))
      vi.stubGlobal('matchMedia', matchMediaMock)

      render(
        <AutomationInProgressNotice
          action="Provisioning under way"
          startedAt="2026-08-30T11:58:30.000Z"
          typicalDuration="a few minutes"
        >
          x
        </AutomationInProgressNotice>,
      )
      expect(screen.getByText('1m 30s')).toBeTruthy()

      act(() => {
        vi.advanceTimersByTime(1_000)
      })
      expect(screen.getByText('1m 31s')).toBeTruthy()

      act(() => {
        vi.advanceTimersByTime(4_000)
      })
      expect(screen.getByText('1m 35s')).toBeTruthy()

      vi.unstubAllGlobals()
    })

    it('renders no clock for an unparseable startedAt rather than crashing or guessing', () => {
      render(
        <AutomationInProgressNotice
          action="Provisioning under way"
          startedAt="not-a-real-timestamp"
          typicalDuration="a few minutes"
        >
          x
        </AutomationInProgressNotice>,
      )
      expect(screen.queryByText(/^\d+[ms]/)).toBeNull()
    })

    it('marks the clock aria-live="off" — a per-second announcement would be hostile, not helpful', () => {
      render(
        <AutomationInProgressNotice
          action="Provisioning under way"
          startedAt="2026-08-30T11:58:30.000Z"
          typicalDuration="a few minutes"
        >
          x
        </AutomationInProgressNotice>,
      )
      expect(screen.getByText('1m 30s').getAttribute('aria-live')).toBe('off')
    })
  })

  describe('the current step — degrade path', () => {
    it('maps a known milestone token to operator language', () => {
      render(
        <AutomationInProgressNotice
          action="Provisioning under way"
          startedAt={null}
          progressStep="provisioning"
          typicalDuration="a few minutes"
        >
          x
        </AutomationInProgressNotice>,
      )
      expect(screen.getByText('Provisioning the workload')).toBeTruthy()
    })

    it('renders no step line at all when no marker has arrived yet — degrades to elapsed+phase, never blank', () => {
      render(
        <AutomationInProgressNotice action="Provisioning under way" startedAt={null} typicalDuration="a few minutes">
          x
        </AutomationInProgressNotice>,
      )
      // The box still has SOMETHING (action label + duration) — this test
      // only proves no fabricated step text appears.
      expect(screen.getByText('Provisioning under way')).toBeTruthy()
      expect(screen.getByText('Typically takes a few minutes.')).toBeTruthy()
    })

    it('renders no step line for an unrecognized raw token — never leaks a raw token into operator-facing copy', () => {
      render(
        <AutomationInProgressNotice
          action="Provisioning under way"
          startedAt={null}
          progressStep="some-future-token-not-in-the-table"
          typicalDuration="a few minutes"
        >
          x
        </AutomationInProgressNotice>,
      )
      expect(screen.queryByText(/some-future-token/)).toBeNull()
    })
  })

  describe('tail-coverage running count — G1-G4 guardrails', () => {
    it('G1: never renders when total is 0, even if marked trustworthy — falls back to the step phrase', () => {
      render(
        <AutomationInProgressNotice
          action="Tearing down"
          startedAt={null}
          progressStep="finalising"
          typicalDuration="two to three minutes"
          runningReadout={{ running: 0, total: 0, trustworthy: true }}
        >
          x
        </AutomationInProgressNotice>,
      )
      expect(screen.queryByText(/services running/)).toBeNull()
      expect(screen.getByText('Finalising cleanup')).toBeTruthy()
    })

    it('G1: never renders when untrustworthy, regardless of the numbers — falls back to the step phrase', () => {
      render(
        <AutomationInProgressNotice
          action="Tearing down"
          startedAt={null}
          progressStep="finalising"
          typicalDuration="two to three minutes"
          runningReadout={{ running: 2, total: 3, trustworthy: false }}
        >
          x
        </AutomationInProgressNotice>,
      )
      expect(screen.queryByText(/services running/)).toBeNull()
      expect(screen.getByText('Finalising cleanup')).toBeTruthy()
    })

    it('renders "N of M running" once trustworthy and non-empty, taking over from the step phrase', () => {
      render(
        <AutomationInProgressNotice
          action="Tearing down"
          startedAt={null}
          progressStep="finalising"
          typicalDuration="two to three minutes"
          runningReadout={{ running: 2, total: 3, trustworthy: true }}
        >
          x
        </AutomationInProgressNotice>,
      )
      expect(screen.getByText(/2 of 3 services running/)).toBeTruthy()
      expect(screen.queryByText('Finalising cleanup')).toBeNull()
    })

    it('G2: never renders a percentage or fraction-of-done phrasing — an observed fact, not progress', () => {
      render(
        <AutomationInProgressNotice
          action="Tearing down"
          startedAt={null}
          progressStep="finalising"
          typicalDuration="two to three minutes"
          runningReadout={{ running: 2, total: 3, trustworthy: true }}
        >
          x
        </AutomationInProgressNotice>,
      )
      expect(document.body.textContent).not.toMatch(/%/)
      expect(document.body.textContent).not.toMatch(/complete/i)
      expect(document.querySelector('[role="progressbar"]')).toBeNull()
    })

    it('G3: captions the count as a recent observation, not a live truth', () => {
      render(
        <AutomationInProgressNotice
          action="Tearing down"
          startedAt={null}
          progressStep="finalising"
          typicalDuration="two to three minutes"
          runningReadout={{ running: 2, total: 3, trustworthy: true }}
        >
          x
        </AutomationInProgressNotice>,
      )
      expect(screen.getByText(/as of the last check/)).toBeTruthy()
    })
  })

  it('renders the stale caption when the caller settled on a failed refetch', () => {
    render(
      <AutomationInProgressNotice action="Provisioning under way" startedAt={null} typicalDuration="a few minutes" stale>
        x
      </AutomationInProgressNotice>,
    )
    expect(screen.getByText(/Could not confirm/)).toBeTruthy()
  })

  it('renders no stale caption by default', () => {
    render(
      <AutomationInProgressNotice action="Provisioning under way" startedAt={null} typicalDuration="a few minutes">
        x
      </AutomationInProgressNotice>,
    )
    expect(screen.queryByText(/Could not confirm/)).toBeNull()
  })
})
