import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useCurrentUser } from '../api/hooks'

interface NavItem {
  label: string
  path: string
  icon: string
  onlyRoles?: string[]
  excludeRoles?: string[]
}

const allNavItems: NavItem[] = [
  { label: 'Overview', path: '/', icon: 'home' },
  { label: 'Monitoring', path: '/monitoring', icon: 'monitor' },
  { label: 'MXL Flows', path: '/mxl-flows', icon: 'mxl' },
  // v1 gating (plan #173 WP2): visible to engineer+admin; nav visibility is
  // cosmetic — the backend enforces the same boundary on every endpoint.
  { label: 'Media Workloads', path: '/media-workloads', icon: 'inventory', onlyRoles: ['engineer', 'admin'] },
  { label: 'Facilities', path: '/facility', icon: 'flows' },
  { label: 'Workflow', path: '/workflows', icon: 'automation' },
  { label: 'Catalog', path: '/catalog', icon: 'catalog' },
  { label: 'Changes', path: '/changes', icon: 'reports' },
  { label: 'Admin', path: '/admin', icon: 'shield', onlyRoles: ['admin'] },
]

const icons: Record<string, React.ReactNode> = {
  home: (
    <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" fill="currentColor" />
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
}

export default function Sidebar() {
  const [expanded, setExpanded] = useState(false)
  const location = useLocation()
  const { data: user } = useCurrentUser()

  const navItems = allNavItems.filter((item) => {
    if (item.onlyRoles) return item.onlyRoles.includes(user?.role || 'viewer')
    if (item.excludeRoles) return !item.excludeRoles.includes(user?.role || 'viewer')
    return true
  })

  return (
    <aside
      className={`flex flex-col bg-sidebar border-r border-border shrink-0 transition-all duration-200 overflow-hidden ${
        expanded ? 'w-56' : 'w-16'
      }`}
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
    >
      <nav className="flex flex-col py-4 px-2 gap-1 flex-1">
        {navItems.map((item) => {
          const isActive = location.pathname === item.path
          return (
            <Link
              key={item.label}
              to={item.path}
              className={`flex items-center rounded-lg transition-colors ${
                isActive
                  ? 'bg-accent/20 text-accent'
                  : 'text-muted hover:text-text hover:bg-panel/50'
              } ${expanded ? 'px-3 py-2.5 gap-3' : 'w-10 h-10 justify-center mx-auto'}`}
            >
              <svg className="w-5 h-5 shrink-0" viewBox="0 0 24 24" fill="none">
                {icons[item.icon]}
              </svg>
              <span
                className={`text-sm font-medium truncate transition-opacity duration-200 ${
                  expanded ? 'opacity-100' : 'opacity-0 w-0'
                }`}
              >
                {item.label}
              </span>
            </Link>
          )
        })}
      </nav>

    </aside>
  )
}
