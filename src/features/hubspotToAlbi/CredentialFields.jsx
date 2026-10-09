import { useState } from 'react'

const inputClass = 'mt-1.5 w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 font-mono text-sm text-gray-900 shadow-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-500'

export default function CredentialFields({
  hubspotTokenMask,
  albiApiKeyMask,
  isAdmin,
  busy,
  onSave,
  disabledReason,
}) {
  const [hubspotToken, setHubspotToken] = useState('')
  const [albiApiKey, setAlbiApiKey] = useState('')
  const hasBothCredentials = Boolean(hubspotTokenMask && albiApiKeyMask)
  const canSubmit = isAdmin && !busy && (hasBothCredentials
    ? Boolean(hubspotToken.trim() || albiApiKey.trim())
    : Boolean(hubspotToken.trim() && albiApiKey.trim()))

  async function handleSubmit(event) {
    event.preventDefault()
    if (!canSubmit) return
    const update = {}
    if (hubspotToken.trim()) update.hubspotToken = hubspotToken.trim()
    if (albiApiKey.trim()) update.albiApiKey = albiApiKey.trim()
    const saved = await onSave(update)
    if (saved) {
      setHubspotToken('')
      setAlbiApiKey('')
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-5">
      <div className="grid gap-5 md:grid-cols-2">
        <div>
          <label htmlFor="h2a-hubspot-token" className="block text-sm font-medium text-gray-800">HubSpot private-app token</label>
          <p id="h2a-hubspot-mask" className="mt-1 text-xs text-gray-500">
            Saved value: <code className="font-mono text-gray-700">{hubspotTokenMask || 'Not saved'}</code>
          </p>
          <input
            id="h2a-hubspot-token"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={hubspotToken}
            onChange={event => setHubspotToken(event.target.value)}
            disabled={!isAdmin || busy}
            aria-describedby="h2a-hubspot-mask h2a-credential-help"
            placeholder={hubspotTokenMask ? 'Leave blank to keep current token' : 'Enter HubSpot token'}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="h2a-albi-key" className="block text-sm font-medium text-gray-800">Guardian Albi API key</label>
          <p id="h2a-albi-mask" className="mt-1 text-xs text-gray-500">
            Saved value: <code className="font-mono text-gray-700">{albiApiKeyMask || 'Not saved'}</code>
          </p>
          <input
            id="h2a-albi-key"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={albiApiKey}
            onChange={event => setAlbiApiKey(event.target.value)}
            disabled={!isAdmin || busy}
            aria-describedby="h2a-albi-mask h2a-credential-help"
            placeholder={albiApiKeyMask ? 'Leave blank to keep current key' : 'Enter Guardian Albi API key'}
            className={inputClass}
          />
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-3 border-l-2 border-amber-400 bg-amber-50 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
        <p id="h2a-credential-help" className="text-xs leading-5 text-amber-900">
          The Guardian Albi key is company-scoped. Replacing either credential disables sync and requires another connection check and mapping confirmation. Saved secrets are never placed in these fields.
        </p>
        <button
          type="submit"
          disabled={!canSubmit}
          className="shrink-0 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Saving…' : hasBothCredentials ? 'Replace credentials' : 'Save credentials'}
        </button>
      </div>
      {!isAdmin && <p className="mt-2 text-xs text-gray-500">{disabledReason}</p>}
    </form>
  )
}
