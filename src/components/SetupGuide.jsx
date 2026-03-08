/**
 * SetupGuide — collapsible step-by-step guide for HubSpot Private App setup.
 * Shows by default for new users with no API key, collapsible once key is saved.
 */
import { useState } from 'react'

const REQUIRED_SCOPES = [
  { scope: 'crm.objects.deals.read', label: 'CRM → Deals → Read' },
  { scope: 'crm.objects.deals.write', label: 'CRM → Deals → Write' },
  { scope: 'crm.objects.contacts.read', label: 'CRM → Contacts → Read' },
  { scope: 'crm.objects.contacts.write', label: 'CRM → Contacts → Write' },
  { scope: 'crm.objects.companies.read', label: 'CRM → Companies → Read' },
  { scope: 'crm.objects.companies.write', label: 'CRM → Companies → Write' },
  { scope: 'crm.schemas.deals.read', label: 'CRM → Schemas → Deals → Read' },
  { scope: 'crm.schemas.deals.write', label: 'CRM → Schemas → Deals → Write (for auto-creating properties)' },
]

function Step({ number, title, children }) {
  return (
    <div className="flex gap-4">
      <div className="flex-shrink-0 w-6 h-6 rounded-full bg-brand-600 text-white text-xs font-bold flex items-center justify-center mt-0.5">
        {number}
      </div>
      <div>
        <p className="text-sm font-semibold text-gray-800">{title}</p>
        <div className="mt-1 text-sm text-gray-600 space-y-1">{children}</div>
      </div>
    </div>
  )
}

function NavPath({ steps }) {
  return (
    <p className="text-xs text-gray-500 font-medium bg-gray-100 rounded px-2 py-1 inline-block font-mono">
      {steps.join(' → ')}
    </p>
  )
}

export default function SetupGuide({ defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className="bg-blue-50 border border-blue-200 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-5 py-4 text-left"
      >
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-blue-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="text-sm font-semibold text-blue-900">How to set up your HubSpot Private App</span>
        </div>
        <svg
          className={`w-4 h-4 text-blue-400 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="px-5 pb-5 space-y-5 border-t border-blue-200 pt-4">

          <Step number={1} title="Open HubSpot Settings">
            <p>Log into your HubSpot account. Click the gear icon in the top navigation.</p>
          </Step>

          <Step number={2} title="Navigate to Private Apps">
            <NavPath steps={['Settings', 'Integrations', 'Private Apps']} />
            <p className="mt-1">Click <strong>Create a private app</strong>.</p>
          </Step>

          <Step number={3} title="Name your app">
            <p>Give it a recognizable name like <em>Albi Deal Importer</em>. The description is optional.</p>
          </Step>

          <Step number={4} title="Add required scopes">
            <p>Click the <strong>Scopes</strong> tab. Search for and enable each of the following:</p>
            <div className="mt-2 space-y-1">
              {REQUIRED_SCOPES.map(s => (
                <div key={s.scope} className="flex items-center gap-2">
                  <code className="text-xs font-mono bg-white border border-blue-200 rounded px-1.5 py-0.5 text-blue-800">
                    {s.scope}
                  </code>
                  <span className="text-xs text-gray-500">({s.label})</span>
                </div>
              ))}
            </div>
            <p className="mt-2 text-xs text-gray-500">
              The <code className="font-mono">crm.schemas.deals.write</code> scope is optional — it allows
              this tool to auto-create missing deal properties for you.
            </p>
          </Step>

          <Step number={5} title="Create the app and copy your token">
            <p>Click <strong>Create app</strong> at the top right. HubSpot will show you a confirmation screen.</p>
            <p>Click <strong>Continue creating</strong>, then copy the <strong>Access token</strong> shown.</p>
            <div className="mt-2 bg-yellow-50 border border-yellow-200 rounded px-3 py-2">
              <p className="text-xs text-yellow-800 font-medium">
                This token is shown only once — copy it immediately and paste it into the API Key field above.
              </p>
            </div>
          </Step>

          <Step number={6} title="Finding an existing token">
            <p>If you already created a Private App, you can retrieve the token from:</p>
            <NavPath steps={['Settings', 'Integrations', 'Private Apps', '[Your App]', 'Auth']} />
            <p className="mt-1">Click <strong>Show token</strong> to reveal it again.</p>
          </Step>

          <Step number={7} title="Adding scopes to an existing app">
            <p>If the config check shows missing scopes:</p>
            <NavPath steps={['Settings', 'Integrations', 'Private Apps', '[Your App]', 'Scopes']} />
            <p className="mt-1">Check the required scope, then click <strong>Save changes</strong>. The token stays the same.</p>
          </Step>
        </div>
      )}
    </div>
  )
}
