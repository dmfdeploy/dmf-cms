import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuthStore } from '../store/auth'
import { useSetViewAs, useClearViewAs } from '../api/hooks'
import NotificationBell from './NotificationBell'
import logoSvg from '../assets/dmfdeploy-icon-white.svg'

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
        <span className="font-bold tracking-tight text-text">dmfdeploy</span>
      </div>

      {/* Center spacer */}
      <div className="flex-1"></div>

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
