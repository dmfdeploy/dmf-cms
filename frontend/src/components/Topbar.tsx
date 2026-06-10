import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuthStore } from '../store/auth'
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

export default function Topbar() {
  const user = useAuthStore((state) => state.user)
  const [menuOpen, setMenuOpen] = useState(false)

  if (!user) return null

  const role = user.role || 'viewer'

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

      {/* Right side: notifications, avatar */}
      <div className="flex items-center gap-5">
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
