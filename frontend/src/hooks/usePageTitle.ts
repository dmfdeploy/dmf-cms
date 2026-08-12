import { useEffect } from 'react'

/**
 * Sets `document.title` for the mounted route (WP-4 stage 2, umbrella #385
 * finding 4: `document.title` was identical — "dmfdeploy" — on every route,
 * so a recording with the tab strip visible never said where the viewer
 * was).
 *
 * Call this UNCONDITIONALLY near the top of a page component, before any
 * early return — hooks must run in the same order every render, and a page
 * with a loading/error branch still owes the tab an honest title while it's
 * in that state, not a stale title left over from wherever the operator
 * navigated from. Pass the best name available at each render (a route
 * param/slug before data loads, the resolved human name once it has) — the
 * title simply updates again when a better one becomes available.
 *
 * `title` empty/undefined falls back to the bare product name, so a page
 * that has genuinely nothing to say yet (e.g. before a slug param resolves)
 * never renders a dangling separator.
 */
export function usePageTitle(title: string | null | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} · DMF Console` : 'DMF Console'
  }, [title])
}
