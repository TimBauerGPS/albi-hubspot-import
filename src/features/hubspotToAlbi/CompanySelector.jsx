import { useEffect, useRef, useState } from 'react'
import { getH2ACompanyOptions } from '../../lib/hubspotToAlbi'

export default function CompanySelector({
  session,
  isSuperAdmin,
  value,
  currentCompany,
  onChange,
  disabled = false,
}) {
  const [companies, setCompanies] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [reloadKey, setReloadKey] = useState(0)
  const requestId = useRef(0)

  useEffect(() => {
    if (!isSuperAdmin) return undefined

    const controller = new AbortController()
    const currentRequest = ++requestId.current
    setLoading(true)
    setError(null)

    getH2ACompanyOptions(session, { signal: controller.signal })
      .then(options => {
        if (currentRequest !== requestId.current) return
        setCompanies(options)
      })
      .catch(requestError => {
        if (requestError?.name === 'AbortError' || currentRequest !== requestId.current) return
        setCompanies([])
        setError(requestError.message)
      })
      .finally(() => {
        if (currentRequest === requestId.current) setLoading(false)
      })

    return () => {
      if (requestId.current === currentRequest) requestId.current += 1
      controller.abort()
    }
  }, [isSuperAdmin, reloadKey, session])

  useEffect(() => {
    if (isSuperAdmin && !value && companies.length) onChange(companies[0])
  }, [companies, isSuperAdmin, onChange, value])

  if (!isSuperAdmin) return null

  const selectedCompany = companies.find(company => company.id === value) ?? currentCompany
  const options = selectedCompany?.id && !companies.some(company => company.id === selectedCompany.id)
    ? [selectedCompany, ...companies]
    : companies

  return (
    <div className="w-full sm:w-72">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor="h2a-company" className="block text-xs font-medium text-gray-700">
          Company context
        </label>
        {loading && (
          <span className="text-xs text-gray-500" role="status">Loading companies…</span>
        )}
      </div>
      <select
        id="h2a-company"
        value={value ?? ''}
        onChange={event => {
          const company = options.find(option => option.id === event.target.value)
          if (company) onChange(company)
        }}
        disabled={disabled || loading || options.length === 0}
        className="mt-1 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-500"
      >
        {!value && <option value="">Select a company</option>}
        {options.map(company => (
          <option key={company.id} value={company.id}>{company.name}</option>
        ))}
      </select>
      {error && (
        <div className="mt-1.5 flex items-center justify-between gap-3 text-xs text-red-700" role="alert">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setReloadKey(key => key + 1)}
            className="shrink-0 font-medium underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            Retry
          </button>
        </div>
      )}
      {!loading && !error && options.length === 0 && (
        <p className="mt-1.5 text-xs text-gray-500">No companies are available.</p>
      )}
    </div>
  )
}
