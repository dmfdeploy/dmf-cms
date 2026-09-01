import { Link, useLocation } from 'react-router-dom'
import { useCurrentUser } from '../api/hooks'
import { settleQuery } from '../lib/queryState'

interface NavItem {
  label: string
  path: string
  icon: string
  /** Primary rails are always present; secondaries are role-gated (IA §3). */
  section: 'rail' | 'secondary'
  onlyRoles?: string[]
  /** Grants visibility by OIDC group membership, OR-ed with onlyRoles. */
  onlyGroups?: string[]
}

// The 4-rail IA spine + role-gated secondaries (IA 2026-06-23 §3/§7, #174
// WP1). Nav visibility is cosmetic — the backend enforces the same boundary
// on every endpoint. Licenses/Users/Site settings are named-deferred (no
// pages yet); Workflow + Changes are interim entries until WP3 merges them
// into Activity. "Settings (own prefs)" is NOT a rail secondary — it lives in
// the Topbar avatar menu only (IA §3 placement clarification, #185 WP-E); the
// rail slot is reserved for facility-level Site settings, which appears only
// once that admin-gated page exists.
// S1 IA cut (umbrella #285): Catalog, Monitoring and Activity are HIDDEN from
// the sidebar, not deleted — their routes stay registered in App.tsx and remain
// reachable by URL, so this is one line each to reverse.
//
// Their content did not vanish, it MOVED, which is the whole point of the cut:
//   Catalog   -> workload detail: Design (template + composition),
//               Provision (deploy + clear-for-deployment), and
//               Finalise & Review (teardown — Catalog owned that too)
//   Activity  -> workload detail, Provision stage (job progress/outcome) and
//               Finalise & Review (job log + outcome marker)
//   Monitoring -> expert lane only; the operator-facing health answer is
//               Workspace → Problems, which is where it already lived
// Hiding Activity was gated on the Provision/Finalise work EXISTING before
// this ships — not on commit order. The hide lands in the first commit of
// this branch and the rail in a later one, so within the branch the hide
// precedes its replacement; the gate is that no release carries one without
// the other, because the deploy/switch feedback loop must never go dark.
const allNavItems: NavItem[] = [
  { label: 'Workspace', path: '/', icon: 'grid', section: 'rail' },
  { label: 'Facilities', path: '/facilities', icon: 'sites', section: 'rail' },
  // Surface gate per ADR-0037 §5: engineer+admin role (the #173 v1 gate) OR
  // the media-engineers tenancy group — first frontend groups[] consumer.
  { label: 'Media Workloads', path: '/media-workloads', icon: 'media', section: 'rail', onlyRoles: ['engineer', 'admin'], onlyGroups: ['media-engineers'] },
  { label: 'Admin', path: '/admin', icon: 'shield', section: 'secondary', onlyRoles: ['admin'] },
]

const icons: Record<string, React.ReactNode> = {
  home: (
    <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" fill="currentColor" />
  ),
  // Workspace: 4-cell app-grid (IA §3) — launcher-into-operations, not a
  // blank SaaS canvas. Four cells, not nine (umbrella #286, operator
  // direction 2026-08-01): lucide's LayoutGrid geometry, drawn inline like
  // every other glyph here rather than pulled in as a component.
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="2" fill="none" strokeLinejoin="round" />
      <rect x="14" y="3" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="2" fill="none" strokeLinejoin="round" />
      <rect x="14" y="14" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="2" fill="none" strokeLinejoin="round" />
      <rect x="3" y="14" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="2" fill="none" strokeLinejoin="round" />
    </>
  ),
  // Media Workloads: display + speaker — lucide's MonitorSpeaker geometry,
  // the closest single bundled glyph to the operator's camera/mic/display
  // composite (umbrella #286, 2026-08-01). Bundled and inline, so no new
  // dependency and nothing for CSP to fetch.
  media: (
    <>
      <path d="M5.5 20H8" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M17 9h.01" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="12" y="4" width="10" height="16" rx="2" stroke="currentColor" strokeWidth="2" fill="none" strokeLinejoin="round" />
      <path d="M8 6H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h4" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="17" cy="15" r="1" stroke="currentColor" strokeWidth="2" fill="none" />
    </>
  ),
  sites: (
    <path d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  ),
  monitor: (
    <path d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  ),
  flows: (
    <path d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  ),
  mxl: (
    <path d="M2 12h3l2-5 4 10 3-7 2 4h6" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  ),
  inventory: (
    <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  ),
  alerts: (
    <path d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  ),
  automation: (
    <path d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  ),
  catalog: (
    <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  ),
  reports: (
    <path d="M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  ),
  settings: (
    <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M12 15a3 3 0 100-6 3 3 0 000 6z" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  ),
  shield: (
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  ),
  warning: (
    <path d="M12 9v4m0 4h.01M10.29 3.86l-8.13 14.09A1.5 1.5 0 003.5 20h17a1.5 1.5 0 001.34-2.05L13.71 3.86a1.5 1.5 0 00-2.42 0z" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  ),
}

function renderItem(item: NavItem, pathname: string) {
  const isActive =
    item.path === '/'
      ? pathname === '/'
      : pathname === item.path || pathname.startsWith(`${item.path}/`)
  return (
    <Link
      key={item.label}
      to={item.path}
      aria-label={item.label}
      // VISUAL PARITY FIX ROUND (dmfdeploy/dmfdeploy#512, operator ruling
      // off a rendered A/B/C comparison — see lib/stagePalette.ts's own
      // docstring for the full account). This tile's selected state was
      // `bg-accent/20 text-accent` (1.49:1 fill-vs-fill against this
      // tile's own resting state — under WCAG 1.4.11's 3:1 state-change
      // floor, i.e. a selection a sighted operator cannot see, while
      // isActive and every test stayed correct throughout); an interim
      // attempt raised that to `bg-accent/55`, which fixed the
      // state-change number but failed a DIFFERENT check nobody had run
      // yet (icon-vs-tile text/icon contrast) and rendered a visibly
      // different colour than the lifecycle rail's own matching attempt
      // (dE2000 4.63 between them — see stagePalette.ts). Both retired.
      // `bg-selected-face text-bg`: an OPAQUE shared literal
      // (--color-selected-face, index.css) — the SAME value the rail's
      // own selected key now paints, not merely "the same idea" — with
      // dark ink, so dE2000 between this tile and the rail's selected key
      // is exactly 0 by construction, and both clear every contrast floor
      // with real margin (measured, not estimated — see stagePalette.ts).
      //
      // RESTING/HOVER, FOLLOW-ON RULING: `text-muted` (was the resting ink)
      // -> `text-resting-ink` (--color-resting-ink, #b4b4b8, shared with
      // the rail's own resting label/icon — same "one token, both
      // consumers" reasoning as the selected face). The operator's first
      // instinct here was `--color-text` at rest in both surfaces, but
      // that leaves `hover:text-text` nowhere to brighten TO — it becomes
      // a no-op, and `hover:bg-panel/50` measures ~1.03:1 against
      // --color-sidebar even fully opaque (real render), so it was never
      // doing anything either. Dropped outright rather than left as dead
      // decoration. `text-resting-ink` restores a real (if softer than
      // shipped) hover delta by leaving headroom above rest for
      // `hover:text-text` to spend — see index.css's own
      // `--color-resting-ink` comment for the measured figures and the
      // stated trade.
      className={`group relative flex h-10 w-10 mx-auto items-center justify-center rounded-lg outline-offset-2 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
        isActive ? 'bg-selected-face text-bg' : 'text-resting-ink hover:text-text'
      }`}
    >
      <svg className="w-5 h-5 shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        {icons[item.icon]}
      </svg>
      {/* Tooltip/label — shown on hover AND keyboard focus, never a
          reflow: it's an absolutely-positioned overlay, not a sibling that
          pushes layout (umbrella #347 WO-D1 spec C: "no expand/reflow on
          either"). Always in the DOM (not display:none) so it participates
          in the link's accessible name/text content like any label would;
          opacity is what gates visibility. */}
      <span
        role="tooltip"
        className="pointer-events-none absolute left-full z-30 ml-2 whitespace-nowrap rounded bg-panel px-2 py-1 text-xs text-text opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
      >
        {item.label}
      </span>
    </Link>
  )
}

export default function Sidebar() {
  // Permanently icon-only (umbrella #347 WO-D1 spec C, operator direction
  // 2026-08-02) — no expand/collapse state left at all. It used to stay
  // expanded with visible labels (umbrella #285: hover-then-read was
  // unreadable in a screen recording); this round goes the other way on the
  // same complaint, because the topbar breadcrumb now carries page identity
  // and the rail's job narrows to navigation alone. Labels survive as a
  // hover/focus tooltip per item, not gone — just no longer competing with
  // the breadcrumb for the same job.
  const location = useLocation()
  // fix-round 6 (PR #81, umbrella #385 codex sweep): `user` alone drove the
  // role gate below — `undefined` covers BOTH "still loading" and "the read
  // failed with nothing ever retained", so a role/tenancy read that failed
  // on first load silently narrowed this nav to viewer-only with no signal
  // anything was wrong (Admin/Media Workloads just... weren't there). A
  // settled failed refetch with a role already retained is unaffected —
  // `user` stays the last-confirmed value either way (Art. 5).
  const { data: user, failed: userFailed } = settleQuery(useCurrentUser())

  const role = user?.role || 'viewer'
  const groups = user?.groups || []
  const navItems = allNavItems.filter((item) => {
    if (!item.onlyRoles && !item.onlyGroups) return true
    return (
      (item.onlyRoles?.includes(role) ?? false) ||
      (item.onlyGroups?.some((g) => groups.includes(g)) ?? false)
    )
  })
  const rails = navItems.filter((item) => item.section === 'rail')
  const secondaries = navItems.filter((item) => item.section === 'secondary')

  return (
    // No overflow-hidden here (operator review, PR #70): it is vestigial
    // from the retired expanded/collapsed transition (compare b49174a's
    // `w-56 <-> w-16` animated width, where clipping the label span mid-
    // transition was the point). Nothing in this permanently-fixed w-16
    // rail needs clipping any more — the one thing that DID get clipped by
    // it was each tooltip's own escape past the rail's edge, which is the
    // rail's only visible label for the icon-only nav. `w-16` alone still
    // holds the fixed-width layout (umbrella #515, gate P1: `shrink-0` used
    // to sit alongside it here too, dropped once this element left flow
    // entirely — see that fix round's own comment below); overflow was
    // never load-bearing for the width either.
    //
    // FIX ROUND (umbrella #515, gate P1): `<aside>` is now the element
    // positioned OUT of flow, not Topbar's header-slot row (Shell.tsx's own
    // comment has the full account of why that inversion was necessary —
    // the row's real height varies by width/wrap in a way a fixed offset
    // elsewhere can't track, but this element's position must NOT depend on
    // the row at all). `fixed left-0 top-14 bottom-0`: anchored to the
    // header's own `h-14` bottom edge and the viewport's own bottom,
    // independent of whether the row exists or how tall it is — this is
    // what actually makes "the sidebar does not move" true unconditionally,
    // rather than true only once some other element's height is measured
    // correctly. `shrink-0` is dropped: it only ever mattered for a flex
    // item, and a `fixed` element isn't part of any flex layout — same
    // "no longer load-bearing" retirement this file already did once for
    // `overflow-hidden` above, not an oversight.
    //
    // `z-30` still beats the row's own `z-20` (Topbar.tsx) with the SAME
    // numeric values the gate-P1 fix round's first attempt already used —
    // NOT "the same way it always has": before ANY #515 work, this element
    // carried no z-index at all (`position: static`, `z-index: auto`),
    // which loses to any explicit value, and the row's `z-20` painted OVER
    // it the instant they ever shared a vertical band — that backwards
    // stacking WAS the #515 bug. What changed between the fix round's two
    // attempts is only WHICH element left flow (Topbar.tsx's own comment):
    // this element was `relative z-30` while the row was `fixed z-20`; now
    // this element is `fixed z-30` while the row is `relative z-20` — the
    // z-index VALUES never moved, only which of the two carries `fixed`.
    // Either way, both sides are explicitly positioned (never one of them
    // left at `auto`), so 30 beats 20 wherever the two genuinely overlap,
    // which is the row's own full-page-width span crossing this element's
    // 64px column. The tooltip's own `z-30` below is scoped to ITS OWN
    // stacking context once a descendant compares under a real ancestor
    // z-index — it never compares against this element's siblings, so the
    // two `z-30`s don't collide. Verified live, not inferred from the
    // values alone — see the WO report's `elementFromPoint` proof.
    <aside className="fixed left-0 top-14 bottom-0 z-30 flex w-16 flex-col border-r border-border bg-sidebar">
      {/* umbrella #486: this landmark had no accessible name — a screen
          reader user got "navigation" here AND for Topbar.tsx's own
          `<nav aria-label="Breadcrumb">`, with nothing to tell the two
          apart. "Console navigation", not "Primary" (the conventional
          pairing with "Breadcrumb", and the first name tried): the
          Glossary and the IA doc both use the phrase "the console's
          primary navigation" already, but for a DIFFERENT landmark — the
          lifecycle rail (LifecycleStrip.tsx's own `<nav aria-label="Media
          workload lifecycle">`), not this one (umbrella #414, Glossary
          entry on the lifecycle stage names). Naming THIS nav "Primary"
          would collide with vocabulary the product has already spoken for
          elsewhere, not reuse it correctly. "Console" instead — genuine
          product self-reference, not invented: shown to the operator
          verbatim on the loading/redirect screens (App.tsx) and in
          AdminPanels.tsx's own copy ("...underpin DMF Console"), and it's
          the one term here that names the WHOLE APP's nav without
          contesting a name already claimed by a more specific surface.
          Checked there is no name coming from elsewhere first: neither
          this `<nav>` nor the `<aside>` around it carried aria-label or
          aria-labelledby before this change, and there is no visually-
          hidden heading anywhere in this file. */}
      <nav aria-label="Console navigation" className="flex flex-1 flex-col gap-1 py-4 px-2">
        {rails.map((item) => renderItem(item, location.pathname))}
        {secondaries.length > 0 && <div className="border-t border-border my-2 mx-2" />}
        {secondaries.map((item) => renderItem(item, location.pathname))}
        {/* Role/tenancy read failed and nothing was ever retained (see
            settleQuery note above) — the nav above is silently narrowed to
            viewer-only, so say so rather than leaving it unexplained. */}
        {userFailed && !user && (
          <div
            role="status"
            className="group relative mt-auto flex h-10 w-10 mx-auto items-center justify-center rounded-lg text-amber-400"
          >
            <svg className="w-5 h-5 shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              {icons.warning}
            </svg>
            <span
              role="tooltip"
              className="pointer-events-none absolute left-full z-30 ml-2 whitespace-nowrap rounded bg-panel px-2 py-1 text-xs text-text opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
            >
              Could not confirm your role — Admin/Media Workloads may be hidden. Reload the page to try again.
            </span>
          </div>
        )}
      </nav>
    </aside>
  )
}
