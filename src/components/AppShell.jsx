/**
 * AppShell — shared navigation wrapper used by Import and Dashboard pages.
 */
import { useNavigate, useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'

const NAV_LINKS = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/import', label: 'Import' },
  { to: '/configuration', label: 'Configuration' },
]

export default function AppShell({ session, children }) {
  const navigate = useNavigate()
  const location = useLocation()

  async function handleSignOut() {
    await supabase.auth.signOut()
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b border-gray-200 px-6 py-0 flex items-stretch">
        <div className="flex items-center mr-6">
          <span className="font-semibold text-gray-900 text-sm">HubSpot Importer</span>
        </div>

        {/* Nav links */}
        <div className="flex items-stretch gap-1">
          {NAV_LINKS.map(link => {
            const active = location.pathname === link.to
            return (
              <button
                key={link.to}
                onClick={() => navigate(link.to)}
                className={`px-3 py-4 text-sm font-medium border-b-2 transition-colors ${
                  active
                    ? 'border-brand-600 text-brand-600'
                    : 'border-transparent text-gray-500 hover:text-gray-800'
                }`}
              >
                {link.label}
              </button>
            )
          })}
        </div>

        <div className="ml-auto flex items-center gap-4">
          <span className="text-xs text-gray-400">{session?.user?.email}</span>
          <button
            onClick={handleSignOut}
            className="text-xs text-gray-400 hover:text-gray-700 transition-colors"
          >
            Sign out
          </button>
        </div>
      </nav>

      <main>{children}</main>
    </div>
  )
}
