import { useEffect, useState } from 'react'

/**
 * Live-view polling bounds for the Media Workloads tile grid (WP-C).
 *
 * Codex P2: live polling must be cheap and bounded — it runs only in grid view,
 * only while the tab is visible, and only for the first LIVE_TILE_CAP tiles that
 * actually resolve a sidecar. Tiles beyond the cap show their last frame plus an
 * explicit Refresh affordance. The fast 200ms cadence exists only inside the one
 * open modal.
 *
 * Codex P3: prefers-reduced-motion pauses the automatic thumbnail churn while
 * keeping the explicit Refresh and Open-preview affordances working.
 */

// How many concurrently-live thumbnail tiles auto-refresh at once.
export const LIVE_TILE_CAP = 6

// Tile cadences.
export const STATUS_POLL_MS = 2000
export const PREVIEW_TICK_MS = 1500

// Modal cadences (the single open detail view is allowed to be lively). Both
// the preview image AND the flow stats / head index tick at 200ms so the modal
// reads as genuinely live — matching the retired MXL Flows page cadence. This
// fast rate is bounded to the one open modal (codex P2).
export const MODAL_STATUS_POLL_MS = 200
export const MODAL_PREVIEW_TICK_MS = 200

/**
 * True when the user has asked the platform to reduce motion. Defaults to
 * false when matchMedia is unavailable (e.g. jsdom without a mock), so the
 * live behaviour is the tested default and reduced-motion is opt-in.
 */
export function usePrefersReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)'
  const [reduced, setReduced] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false
    }
    return window.matchMedia(query).matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return
    }
    const mql = window.matchMedia(query)
    const onChange = () => setReduced(mql.matches)
    onChange()
    // Safari <14 only supports addListener/removeListener.
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    }
    mql.addListener(onChange)
    return () => mql.removeListener(onChange)
  }, [])

  return reduced
}

/**
 * True while the document is visible. Live polling pauses entirely when the tab
 * is hidden so a backgrounded console never hammers NetBox or a sidecar.
 */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState<boolean>(() => {
    if (typeof document === 'undefined') return true
    return document.visibilityState !== 'hidden'
  })

  useEffect(() => {
    if (typeof document === 'undefined') return
    const onChange = () => setVisible(document.visibilityState !== 'hidden')
    onChange()
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])

  return visible
}
