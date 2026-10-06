/**
 * AppShell — shared navigation wrapper used by all app pages.
 */
import { NavLink } from 'react-router-dom'
import { supabase } from '../lib/supabase'

const NAV_LINKS = [
  { to: '/dashboard',     label: 'Dashboard' },
  { to: '/import',        label: 'Import' },
  { to: '/held-deals',    label: 'Held Deals' },
  { to: '/hubspot-to-albi', label: 'HubSpot to Albi', nested: true },
  { to: '/configuration', label: 'Configuration' },
]

export default function AppShell({ session, isAdmin, companyName, children }) {
  async function handleSignOut() {
    await supabase.auth.signOut()
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b border-gray-200 bg-white">
        <div className="flex flex-wrap items-center gap-x-4 px-4 sm:px-6">
          <div className="order-1 flex shrink-0 items-center py-3 md:mr-2">
            <span className="font-semibold text-gray-900 text-sm">HubSpot Importer</span>
          </div>

          {/* Nav links */}
          <nav aria-label="Primary" className="order-3 w-full overflow-x-auto md:order-2 md:w-auto md:flex-1">
            <div className="flex min-w-max items-stretch gap-1">
              {NAV_LINKS.map(link => (
                <NavLink
                  key={link.to}
                  to={link.to}
                  end={!link.nested}
                  className={({ isActive }) => `whitespace-nowrap border-b-2 px-3 py-3 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 md:py-4 ${
                    isActive
                      ? 'border-brand-600 text-brand-600'
                      : 'border-transparent text-gray-500 hover:text-gray-800'
                  }`}
                >
                  {link.label}
                </NavLink>
              ))}
              {isAdmin && (
                <NavLink
                  to="/admin"
                  className={({ isActive }) => `whitespace-nowrap border-b-2 px-3 py-3 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 md:py-4 ${
                    isActive
                      ? 'border-brand-600 text-brand-600'
                      : 'border-transparent text-gray-500 hover:text-gray-800'
                  }`}
                >
                  Admin
                </NavLink>
              )}
            </div>
          </nav>

          {/* User info */}
          <div className="order-2 ml-auto flex min-w-0 items-center gap-3 py-2 md:order-3 md:gap-4">
            <div className="min-w-0 text-right">
              <p className="max-w-32 truncate text-xs text-gray-600 sm:max-w-48" title={session?.user?.email}>{session?.user?.email}</p>
              {companyName && (
                <p className="max-w-32 truncate text-xs text-gray-500 sm:max-w-48" title={companyName}>{companyName}</p>
              )}
            </div>
            <button
              type="button"
              onClick={handleSignOut}
              className="shrink-0 rounded px-1.5 py-1 text-xs text-gray-500 transition-colors hover:text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main>{children}</main>
    </div>
  )
}
