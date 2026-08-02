import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuthStore } from '../store/auth'
import { useTopbarMessageStore } from '../store/topbarMessage'
import { useSetViewAs, useClearViewAs, useFacilityDetail, useMediaWorkloadsGrouped } from '../api/hooks'
import NotificationBell from './NotificationBell'
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
function useBreadcrumbTrail(pathname: string): Crumb[] {
  const segments = pathname.split('/').filter(Boolean)
  const facilitySite = segments[0] === 'facilities' && segments[1] ? segments[1] : ''
  const workloadSlug =
    segments[0] === 'media-workloads' && segments[1] && segments[1] !== 'new' ? segments[1] : ''

  const facility = useFacilityDetail(facilitySite)
  const grouped = useMediaWorkloadsGrouped({ enabled: workloadSlug !== '' })
  const workload = grouped.data?.workloads.find((w) => w.slug === workloadSlug)

  const crumbs: Crumb[] = [{ label: 'Workspace', href: '/' }]
  if (segments.length === 0) return crumbs

  if (segments[0] === 'facilities') {
    crumbs.push({ label: 'Facilities', href: '/facilities' })
    if (segments[1]) {
      crumbs.push({ label: facility.data?.site.name || segments[1], href: `/facilities/${segments[1]}` })
    }
    return crumbs
  }

  if (segments[0] === 'media-workloads') {
    crumbs.push({ label: 'Media Workloads', href: '/media-workloads' })
    if (segments[1] === 'new') {
      crumbs.push({ label: 'Create media workload', href: '/media-workloads/new' })
    } else if (segments[1]) {
      const slug = segments[1]
      crumbs.push({ label: workload?.name || slug, href: `/media-workloads/${slug}` })
      if (segments[2] === 'operate') {
        crumbs.push({ label: 'Operate', href: `/media-workloads/${slug}/operate` })
      }
    }
    return crumbs
  }

  const label = STATIC_LABELS[segments[0]] ?? segments[0]
  crumbs.push({ label, href: `/${segments[0]}` })
  return crumbs
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
  const setViewAs = useSetViewAs()
  const clearViewAs = useClearViewAs()
  const { pathname } = useLocation()
  const crumbs = useBreadcrumbTrail(pathname)
  const transientMessage = useTopbarMessageStore((s) => s.message)

  if (!user) return null

  const role = user.role || 'viewer'
  const isAdmin = user.real_role === 'admin'

  return (
    <header className="h-14 border-b border-border bg-bg flex items-center justify-between px-4 z-20 shrink-0">
      {/* Brand */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 flex items-center justify-center shrink-0">
          <img src={logoSvg} alt="dmfdeploy" className="w-full h-full object-contain" />
        </div>
        <span className="font-bold tracking-tight text-text">
          <span className="sr-only">dmfdeploy</span>
          <span aria-hidden="true">
            dmf
            <span style={{ color: '#FFFF00' }}>d</span>
            <span style={{ color: '#00FFFF' }}>e</span>
            <span style={{ color: '#00FF00' }}>p</span>
            <span style={{ color: '#FF00FF' }}>l</span>
            <span style={{ color: '#FF0000' }}>o</span>
            <span style={{ color: '#0000FF' }}>y</span>
          </span>
        </span>
      </div>

      {/* Breadcrumb — the page-identity surface now that per-page heroes are
          retired (umbrella #347 WO-D1 spec C). Human display names when
          loaded, else the URL slug as an explicit, honest fallback. */}
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
        <div className="relative">
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-all hover:ring-2 cursor-pointer ${roleBadgeStyles[role] || 'bg-gray-900/40 text-gray-300'}`}
          >
            {getInitials(user.display_name)}
          </button>

          {menuOpen && (
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
    </header>
  )
}
