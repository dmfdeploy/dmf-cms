import { useEffect, useRef, useState, type FocusEvent } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuthStore } from '../store/auth'
import { useTopbarMessageStore } from '../store/topbarMessage'
import { useHeaderSlotContent, useShowHeaderSlotRow, deriveWorkloadSlugFromPath } from '../store/headerSlot'
import { useSetViewAs, useClearViewAs, useFacilityDetail, useMediaWorkloadsGrouped } from '../api/hooks'
import NotificationBell from './NotificationBell'
import LifecycleStrip from '../pages/MediaWorkloads/LifecycleStrip'
import { workloadHomePath, workloadSetupPath } from '../lib/routes'
import logoSvg from '../assets/dmfdeploy-icon-white.svg'

/**
 * Static path-segment -> human label, for every route this breadcrumb can
 * land on that ISN'T a dynamic slug (umbrella #347 WO-D1 spec C: page
 * identity moved off the retired per-page hero and onto this trail).
 */
const STATIC_LABELS: Record<string, string> = {
  facilities: 'Facilities',
  activity: 'Activity',
  catalog: 'Catalog',
  monitoring: 'Monitoring',
  'media-workloads': 'Media Workloads',
  admin: 'Admin',
  settings: 'Settings',
}

interface Crumb {
  label: string
  href: string
}

interface BreadcrumbTrail {
  crumbs: Crumb[]
  /**
   * The workload slug parsed from the URL — store/headerSlot.ts's
   * `deriveWorkloadSlugFromPath`, not a second copy of that rule.
   * dmfdeploy#414: the old `…/:slug/operate` shape is gone (that route is
   * now a compatibility redirect to the bare slug, handled entirely in
   * App.tsx — it never reaches this breadcrumb as its own shape).
   */
  workloadSlug: string
}

/**
 * Builds the breadcrumb trail from the URL alone, resolving the two dynamic
 * segments (a facility site slug, a workload slug) to their human display
 * name ONLY once that data is actually loaded — otherwise the slug itself is
 * the explicit, honest fallback (spec C). Both queries are scoped to the
 * route that actually needs them (`enabled`/empty-site-guard) so this never
 * turns into background polling on pages that have nothing to do with
 * either: the whole point of a breadcrumb is to describe where you are, not
 * to keep fetching once you've left.
 */
function useBreadcrumbTrail(pathname: string): BreadcrumbTrail {
  const segments = pathname.split('/').filter(Boolean)
  const facilitySite = segments[0] === 'facilities' && segments[1] ? segments[1] : ''
  const workloadSlug = deriveWorkloadSlugFromPath(pathname)

  const facility = useFacilityDetail(facilitySite)
  const grouped = useMediaWorkloadsGrouped({ enabled: workloadSlug !== '' })
  const workload = grouped.data?.workloads.find((w) => w.slug === workloadSlug)

  // Arc 4 WP-2 operator ruling (umbrella #347): the seed "Workspace" crumb
  // is removed entirely, not just at root — home stays reachable via the
  // sidebar, and the Workspace/home route instead carries its identity via
  // the wordmark (below).
  const crumbs: Crumb[] = []
  if (segments.length === 0) return { crumbs, workloadSlug }

  if (segments[0] === 'facilities') {
    crumbs.push({ label: 'Facilities', href: '/facilities' })
    if (segments[1]) {
      crumbs.push({ label: facility.data?.site.name || segments[1], href: `/facilities/${segments[1]}` })
    }
    return { crumbs, workloadSlug }
  }

  if (segments[0] === 'media-workloads') {
    crumbs.push({ label: 'Media Workloads', href: '/media-workloads' })
    if (segments[1] === 'new') {
      crumbs.push({ label: 'Create media workload', href: '/media-workloads/new' })
    } else if (segments[1]) {
      const slug = segments[1]
      // dmfdeploy#414 H5: the workload crumb always links HOME (the bare
      // slug is the workload's canonical identity) — never to whatever
      // route the operator happens to be on. On the home route itself this
      // crumb is also the LAST one, so it renders as the current-page label
      // rather than a link (see the render loop below); its `href` is only
      // ever followed from a route that isn't home, i.e. from Setup.
      crumbs.push({ label: workload?.name || slug, href: workloadHomePath(slug) })
      // dmfdeploy#414 H5: replaces the deleted Operate special-case crumb.
      // The old `…/:slug/operate` shape no longer reaches this function at
      // all (it is a compatibility redirect in App.tsx, resolved before any
      // route the breadcrumb reads settles) — so there is no equivalent
      // branch to keep for it, only this one new branch for Setup.
      if (segments[2] === 'setup') {
        crumbs.push({ label: 'Setup', href: workloadSetupPath(slug) })
      }
    }
    return { crumbs, workloadSlug }
  }

  const label = STATIC_LABELS[segments[0]] ?? segments[0]
  crumbs.push({ label, href: `/${segments[0]}` })
  return { crumbs, workloadSlug }
}

const roleBadgeStyles: Record<string, string> = {
  viewer: 'bg-blue-900/40 text-blue-300',
  operator: 'bg-green-900/40 text-green-300',
  engineer: 'bg-purple-900/40 text-purple-300',
  admin: 'bg-indigo-900/40 text-indigo-300',
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  }
  return name.slice(0, 2).toUpperCase()
}

const VIEW_AS_ROLES = ['viewer', 'operator', 'engineer'] as const

export default function Topbar() {
  const user = useAuthStore((state) => state.user)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const setViewAs = useSetViewAs()
  const clearViewAs = useClearViewAs()
  const { pathname } = useLocation()
  const { crumbs } = useBreadcrumbTrail(pathname)
  const transientMessage = useTopbarMessageStore((s) => s.message)
  const slotContent = useHeaderSlotContent()

  // Dismiss the personal menu on an outside click or Escape (umbrella #432
  // §B) — same pattern as NotificationBell's dropdown for the mousedown
  // case: a ref-containment check, removed on unmount. Both handlers read
  // `menuRef.current` fresh AT EVENT TIME (the ref object itself is stable
  // across renders — only `.current` changes), so they stay correct
  // regardless of when the wrapper div actually mounts. Before this, the
  // menu could only be closed by clicking the avatar button a second time.
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false)
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  // Keyboard-only dismissal path: a tab out of the panel (or out of the
  // document entirely, where relatedTarget is null) closes it. Wired as
  // React's own onBlur prop on the wrapper below, NOT a manual
  // addEventListener('focusout', …) in a mount-only effect — that first
  // attempt (fix-round 1) captured `menuRef.current` in a local const at
  // effect-run time. Topbar renders `null` until the auth store populates
  // (see the early return below), so on the normal initial-load path the
  // wrapper div does not exist yet when the `[]`-effect runs: the captured
  // reference was null, `wrapper?.addEventListener(...)` silently no-opped
  // via optional chaining, and the effect never re-ran to rebind once the
  // wrapper actually mounted — focus-out dismissal was dead in production.
  // React's onBlur IS the bubbling native focusout (React 17+), delegated,
  // and bound/unbound WITH the element itself, so this bug class cannot
  // recur here. `event.currentTarget` is the wrapper, read fresh at event
  // time — never a value captured at some earlier moment. focusout bubbles,
  // so this also fires when focus merely moves BETWEEN items inside the
  // panel, hence the containment check on relatedTarget rather than closing
  // unconditionally.
  const handleFocusOut = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null
    if (!next || !event.currentTarget.contains(next)) {
      setMenuOpen(false)
    }
  }

  // Header slot (Arc 4 WP-2): present only on workload-detail routes and
  // only once something is actually registered into it. The condition
  // itself (`workloadSlug` route-derived agreeing with `slotContent.slug`
  // registration-derived, so a stale registration from a route the operator
  // has since left can never leak onto this one) lives in
  // useShowHeaderSlotRow (store/headerSlot.ts, umbrella #515) rather than
  // inlined here — this file's history already has one example of two
  // independent copies of the same route-shape test drifting apart (see
  // headerSlot.ts's own FIX ROUND note), and keeping the rule in one
  // exported place costs nothing even with a single caller.
  //
  // Called ABOVE the `!user` early return, deliberately: this component's
  // own auth store starts null and populates after mount (umbrella #432 §B
  // fixed a real production bug that shared exactly this shape — a hook
  // called only on SOME renders of the same mounted instance is a Rules-of-
  // Hooks violation the moment `user` flips from null to populated, not a
  // style preference). Every hook this component calls lives before the
  // early return for that reason; this one is no exception.
  const showSlotRow = useShowHeaderSlotRow()

  if (!user) return null

  const role = user.role || 'viewer'
  const isAdmin = user.real_role === 'admin'

  // The wordmark renders on the Workspace/home route only — elsewhere the
  // logo glyph carries the brand alone (Arc 4 WP-2 operator ruling,
  // umbrella #347). Exactly one accessible brand name must exist at a
  // time: the glyph is decorative (alt="") whenever the visible wordmark
  // is also on screen, and named when it stands alone, so a screen reader
  // never hits "dmfdeploy" twice.
  const isHome = pathname === '/'

  return (
    // FIX ROUND (orchestrator/codex gate, dmfdeploy#481): the header-slot
    // row is now a SIBLING of <header>, not nested inside it — see the
    // block below for why. React needs one root; a Fragment costs nothing
    // Shell.tsx's own flex-col layout doesn't already provide (it stacks
    // direct children exactly the same way regardless of whether they
    // arrive as two children of one wrapper or two top-level elements from
    // this component).
    <>
    <header className="bg-bg z-20 shrink-0 flex flex-col">
      <div className="h-14 border-b border-border flex items-center justify-between px-4">
        {/* Brand */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 flex items-center justify-center shrink-0">
            <img
              src={logoSvg}
              alt={isHome ? '' : 'dmfdeploy'}
              className="w-full h-full object-contain"
            />
          </div>
          {isHome && <span className="font-bold tracking-tight text-text">dmfdeploy</span>}
        </div>

        {/* Breadcrumb — the page-identity surface now that per-page heroes are
            retired (umbrella #347 WO-D1 spec C). Human display names when
            loaded, else the URL slug as an explicit, honest fallback. Empty
            at root (the Workspace seed crumb is retired) — the trail then
            renders nothing, not a stray separator. */}
        <nav aria-label="Breadcrumb" className="min-w-0 flex-1 px-4">
          <ol className="flex items-center gap-1.5 truncate text-sm">
            {crumbs.map((crumb, i) => {
              const isLast = i === crumbs.length - 1
              return (
                <li key={crumb.href} className="flex min-w-0 items-center gap-1.5">
                  {i > 0 && (
                    <span aria-hidden="true" className="text-muted/40">
                      /
                    </span>
                  )}
                  {isLast ? (
                    <span aria-current="page" className="truncate font-medium text-text">
                      {crumb.label}
                    </span>
                  ) : (
                    <Link to={crumb.href} className="truncate text-muted hover:text-text hover:underline">
                      {crumb.label}
                    </Link>
                  )}
                </li>
              )
            })}
          </ol>
        </nav>

        {/* Supplemental transient-message surface (GATE-D1 P2.4): NOT where
            job success/failure lives — that stays anchored at the acting
            stage (Constitution Art. 2). This is a single shared announcer
            for brief echoes of job lifecycle moments (started / terminal),
            producers push via store/topbarMessage.ts; it self-expires. */}
        <div
          aria-live="polite"
          role="status"
          className="min-w-0 shrink truncate px-2 text-xs text-muted"
        >
          {transientMessage?.text ?? ''}
        </div>

        {/* Right side: view-as chip, notifications, avatar */}
        <div className="flex items-center gap-5">
          {/* View-as active chip */}
          {user.view_as_active && (
            <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium bg-amber-900/40 text-amber-300 border border-amber-700/40">
              Viewing as {user.role}
              <button
                onClick={() => clearViewAs.mutate()}
                className="underline hover:no-underline cursor-pointer"
              >
                Reset
              </button>
            </span>
          )}

          {/* Notification bell */}
          <NotificationBell />

          {/* Avatar — clickable dropdown */}
          <div className="relative" ref={menuRef} onBlur={handleFocusOut}>
            <button
              onClick={() => setMenuOpen(!menuOpen)}
              aria-expanded={menuOpen}
              className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-all hover:ring-2 cursor-pointer ${roleBadgeStyles[role] || 'bg-gray-900/40 text-gray-300'}`}
            >
              {getInitials(user.display_name)}
            </button>

            {menuOpen && (
              // This is a disclosure (identity + a couple of buttons/links), not
              // a menu — role="menu" is deliberately absent. WAI-ARIA's `menu`
              // role requires menuitem/menuitemcheckbox/menuitemradio children
              // (the first child here is a plain identity block) and commits to
              // a keyboard contract (arrow-key roving tabindex) this panel does
              // not implement; NotificationBell's dropdown, the pattern this
              // follows, uses no role either. For the same reason the trigger
              // button above carries no aria-haspopup at all — WAI-ARIA treats
              // aria-haspopup="true" as EQUIVALENT to aria-haspopup="menu", so
              // it would make the exact promise this comment says the panel
              // doesn't keep. Do not re-add either without also building the
              // menu keyboard model.
              <div className="absolute right-0 mt-2 w-48 bg-panel border border-border rounded-lg shadow-lg overflow-hidden z-50">
                <div className="px-4 py-3 border-b border-border">
                  <p className="text-sm font-medium text-text">{user.display_name}</p>
                  <p className="text-xs text-muted">{user.email}</p>
                </div>
                {isAdmin && (
                  <div className="border-b border-border">
                    <p className="px-4 pt-2 pb-1 text-xs text-muted uppercase tracking-wide">View as</p>
                    {VIEW_AS_ROLES.map((r) => (
                      <button
                        key={r}
                        onClick={() => { setViewAs.mutate(r); setMenuOpen(false) }}
                        className={`w-full text-left block px-4 py-2 text-sm transition-colors cursor-pointer ${
                          user.view_as_active && user.role === r
                            ? 'bg-amber-900/30 text-amber-300'
                            : 'text-text hover:bg-bg'
                        }`}
                      >
                        {r}
                      </button>
                    ))}
                  </div>
                )}
                <Link
                  to="/settings"
                  onClick={() => setMenuOpen(false)}
                  className="block px-4 py-3 text-sm text-text hover:bg-bg transition-colors"
                >
                  Settings
                </Link>
                <a
                  href="/auth/logout"
                  className="block px-4 py-3 text-sm text-text hover:bg-bg transition-colors border-t border-border"
                >
                  Logout
                </a>
              </div>
            )}
          </div>
        </div>
      </div>

    </header>

      {/* Header slot (Arc 4 WP-2), workload-detail routes only, a single
          non-wrapping row that scrolls horizontally at narrow widths rather
          than wrapping to a third line. dmfdeploy#414 renamed both
          registrants — WorkloadSetup.tsx (formerly WorkloadDetail.tsx) and
          WorkloadHome.tsx (formerly Operate.tsx) — register a rail MODEL
          here (store/headerSlot.ts) — this file is the only place that
          turns it into pixels, via the same LifecycleStrip component the
          page used to render inline. Reshaping that component's own layout
          to fit a single row is WP-3's job, not this one's.

          FIX ROUND (orchestrator/codex gate, dmfdeploy#481): moved from
          <header>'s own row 2 to a SIBLING of <header>, not merely a
          cosmetic reshuffle. `<header>` here is a direct child of a plain
          `<div>` (Shell.tsx) — no article/aside/main/nav/section ancestor —
          so it maps to the implicit ARIA `banner` landmark (confirmed on
          the live tree, not assumed: `Shell.tsx`'s root renders `<Topbar />`
          directly, `Topbar.tsx` itself renders nothing but `<header>` as
          this component's first root, and `banner` is exactly HTML's role
          mapping for a `<header>` in that ancestry). `banner` is for
          site-oriented content repeated across pages (logo, nav, search) —
          this row is route-specific (`showSlotRow` gates it to
          workload-detail routes only) and does not belong inside it. Before
          this fix a screen-reader user found a per-workload lifecycle rail
          announced inside "banner"; see railBannerLandmark.test.tsx for the
          regression pin (mutation-verified: reverting this row to a child
          of <header> makes that test fail on the banner-containment
          assertion specifically, not an incidental symptom).

          RETIRED (umbrella #518, operator ruling: "redeploy matches
          creation" — Deploy no longer promotes into this row at all). This
          paragraph and the two after it used to justify a promoted-action
          mount point that lived here — a portal (components/PromotedAction.tsx,
          store/headerActionSlot.ts) that ProvisionStage.tsx's own entry
          control relocated its pixels into. Provision's Deploy control now
          always renders inline in the stage body, the same way it always
          has on first deploy (CreateWorkload.tsx) — see ProvisionStage.tsx's
          own comment for why. Both files above are deleted, not left
          unused; this row now hosts only the rail. */}
      {showSlotRow && slotContent && (
        <div
          data-testid="header-slot-row"
          // FIX ROUND (umbrella #515, gate P1): this row is back in NORMAL
          // FLOW — `relative z-20 flex flex-nowrap shrink-0`, no `fixed`, no
          // `inset-x-0`/`top-14`. A first attempt made this row `position:
          // fixed` (offsetting `<main>` by a matching constant in
          // Shell.tsx) to stop it displacing `<Sidebar/>`; that broke below
          // ~390px, where LifecycleStrip wraps to a 5-key column and this
          // row's real height stops matching the constant Shell.tsx assumed
          // — see Shell.tsx's own comment for the measured failure and why
          // the fix inverts which element leaves the flow instead.
          // `<Sidebar/>` is the fixed element now (Sidebar.tsx's own
          // comment), so this row can be a plain flow child again: at ANY
          // width, its real rendered height (one line or five stacked keys)
          // is exactly what it reserves for whatever comes after it in
          // Topbar's own Fragment — nothing to keep in sync elsewhere.
          //
          // `relative` (for `z-20` to take effect at all) + `shrink-0`
          // (this row must not be compressed if the flex-col column ever
          // runs short, matching `<header>`'s own `shrink-0`) — this is the
          // row's original, pre-#515 shape, restored rather than reinvented.
          // LifecycleStrip's own `justify-center-safe` still centres
          // against the PAGE, not the content column: this row is a
          // top-level sibling of `<header>` in Topbar's own Fragment, never
          // nested inside anything `<Sidebar/>`-offset, so it spans the
          // full viewport width the same way `<header>` itself always has —
          // page-width centring falls out of where this row sits in the
          // tree, not from any position/inset property on the row itself.
          // `z-20` unchanged in value, matching `<header>`'s own — see
          // Sidebar.tsx's own comment for why its `z-30` still beats this
          // row's `z-20` wherever the two genuinely overlap (the row's full
          // width crossing the sidebar's 64px column).
          //
          // VISUAL PARITY FIX ROUND (dmfdeploy/dmfdeploy#512, operator
          // finding against a live provision run): `bg-sidebar` (not
          // `bg-bg`) matches Sidebar.tsx's own token exactly, so the two
          // read as one surface where they visually meet — unaffected by
          // the positioning change above, still true, still why this token
          // and not another.
          className="relative z-20 flex flex-nowrap shrink-0 items-center gap-3 bg-sidebar px-4 py-2"
        >
          <div className="min-w-0 flex-1 overflow-x-auto">
            <LifecycleStrip {...slotContent.rail} />
          </div>
        </div>
      )}
    </>
  )
}
