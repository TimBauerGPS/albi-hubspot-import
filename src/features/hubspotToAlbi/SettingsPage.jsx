import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import {
  estimateH2AActivities,
  getH2ASettings,
  runH2APreflight,
  runH2ASync,
  saveH2ASettings,
} from '../../lib/hubspotToAlbi'
import CredentialFields from './CredentialFields'
import OptionMappingForm from './OptionMappingForm'
import PreflightChecklist from './PreflightChecklist'
import { presentDryRunTotals } from './dryRunTotals.js'

const ACTIVITY_TYPES = ['meetings', 'calls', 'emails', 'communications', 'notes']
const EMPTY_OPTIONS = Object.freeze({})
const ACTIVITY_LABELS = { meetings: 'Meetings', calls: 'Calls', emails: 'Emails', communications: 'Communications', notes: 'Notes' }
const REQUIRED_IDENTITIES = [
  'default_contact_type:default',
  'default_organization_type:default',
  ...ACTIVITY_TYPES.map(type => `activity_type:${type}`),
]
const buttonPrimary = 'rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50'
const buttonSecondary = 'rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 transition hover:border-brand-300 hover:bg-brand-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-50'
const inputClass = 'mt-1.5 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 disabled:cursor-not-allowed disabled:bg-gray-50'

function SetupCard({ number, title, description, complete, completeLabel = 'Verified', savedOnly = false, children }) {
  return (
    <li className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
      <div className="flex flex-col gap-3 border-b border-gray-100 px-5 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-6">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-brand-600">Step {number}</p>
          <h2 className="mt-1 text-lg font-semibold tracking-tight text-gray-900">{title}</h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-gray-500">{description}</p>
        </div>
        <span className={`shrink-0 text-xs font-semibold ${complete ? savedOnly ? 'text-brand-700' : 'text-green-700' : 'text-gray-500'}`}>
          {complete ? completeLabel : 'Pending'}
        </span>
      </div>
      <div className="px-5 pb-5 sm:px-6 sm:pb-6">{children}</div>
    </li>
  )
}

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function pacificToday() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${value.year}-${value.month}-${value.day}`
}

function hasRequiredMappings(settings) {
  const identities = new Set((settings?.optionMappings ?? []).map(mapping => `${mapping.mappingKind}:${mapping.sourceKey}`))
  return settings?.config?.option_confirmation_status === 'confirmed' && REQUIRED_IDENTITIES.every(identity => identities.has(identity))
}

function readinessItems({ credentialsReady, connectionReady, dateReady, mappingsReady, dryRunReady, live }) {
  return [
    { label: 'Credentials', ready: credentialsReady, status: credentialsReady ? 'Saved' : 'Pending', verified: false },
    { label: 'Connection', ready: connectionReady, status: connectionReady ? 'Verified' : 'Pending', verified: connectionReady },
    { label: 'Start date', ready: dateReady, status: dateReady ? 'Saved' : 'Pending', verified: false },
    { label: 'Mappings', ready: mappingsReady, status: mappingsReady ? 'Confirmed' : 'Pending', verified: mappingsReady },
    { label: 'Dry run', ready: dryRunReady, status: dryRunReady ? 'Completed' : 'Pending', verified: dryRunReady },
    { label: 'Live', ready: live, status: live ? 'Active' : 'Pending', verified: live },
  ]
}

export default function SettingsPage() {
  const {
    session,
    companyId,
    companyName,
    isAdmin,
    tenantRevision,
    completeTenantTransition,
  } = useOutletContext()
  const [settings, setSettings] = useState(null)
  const [startDate, setStartDate] = useState('')
  const [notificationRecipients, setNotificationRecipients] = useState('')
  const [backfillDate, setBackfillDate] = useState('')
  const [estimate, setEstimate] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')
  const [busyAction, setBusyAction] = useState('')
  const [initialRetryToken, setInitialRetryToken] = useState(0)
  const [mappingResetRevision, setMappingResetRevision] = useState(0)
  const requestRevision = useRef(0)
  const mutationControllers = useRef(new Set())
  const tenantKey = `${companyId ?? 'none'}:${tenantRevision}`
  const tenantKeyRef = useRef(tenantKey)
  tenantKeyRef.current = tenantKey

  const applySettings = useCallback(value => {
    setSettings(value)
    setStartDate(value?.config?.selected_start_date ?? '')
    setNotificationRecipients((value?.config?.notification_recipients ?? []).join('\n'))
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const currentRequest = ++requestRevision.current
    setSettings(null)
    setStartDate('')
    setNotificationRecipients('')
    setBackfillDate('')
    setEstimate(null)
    setLoadError('')
    setActionError('')
    setNotice('')
    setLoading(true)

    if (!companyId) {
      setLoading(false)
      setLoadError('Select a company to load HubSpot to Albi settings.')
      completeTenantTransition(tenantRevision)
      return () => controller.abort()
    }

    getH2ASettings(session, companyId, { signal: controller.signal })
      .then(value => {
        if (requestRevision.current === currentRequest && tenantKeyRef.current === tenantKey) applySettings(value)
      })
      .catch(cause => {
        if (cause?.name !== 'AbortError' && requestRevision.current === currentRequest && tenantKeyRef.current === tenantKey) {
          setLoadError(cause.message)
        }
      })
      .finally(() => {
        if (requestRevision.current === currentRequest && tenantKeyRef.current === tenantKey) {
          setLoading(false)
          completeTenantTransition(tenantRevision)
        }
      })

    return () => controller.abort()
  }, [applySettings, companyId, completeTenantTransition, initialRetryToken, session, tenantKey, tenantRevision])

  useEffect(() => () => {
    for (const controller of mutationControllers.current) controller.abort()
    mutationControllers.current.clear()
  }, [tenantKey])

  const perform = useCallback(async (action, operation, successMessage) => {
    const controller = new AbortController()
    const startedFor = tenantKey
    mutationControllers.current.add(controller)
    setBusyAction(action)
    setActionError('')
    setNotice('')
    try {
      const result = await operation(controller.signal)
      if (tenantKeyRef.current !== startedFor) return null
      if (result?.config) applySettings(result)
      if (successMessage) setNotice(successMessage)
      return result
    } catch (cause) {
      if (cause?.name !== 'AbortError' && tenantKeyRef.current === startedFor) setActionError(cause.message)
      return null
    } finally {
      mutationControllers.current.delete(controller)
      if (tenantKeyRef.current === startedFor) setBusyAction('')
    }
  }, [applySettings, tenantKey])

  const refreshSettings = useCallback(async (signal) => {
    const latest = await getH2ASettings(session, companyId, { signal })
    if (tenantKeyRef.current === tenantKey) applySettings(latest)
    return latest
  }, [applySettings, companyId, session, tenantKey])

  const credentialsReady = Boolean(settings?.hubspotTokenMask && settings?.albiApiKeyMask)
  const connectionReady = settings?.preflight?.status === 'valid'
  const dateReady = validDate(startDate) && startDate === settings?.config?.selected_start_date
  const mappingsReady = hasRequiredMappings(settings)
  const dryRunReady = Boolean(settings?.dryRunReviewReady)
  const sampleDryRunReady = Boolean(settings?.lastCompletedSampleDryRun)
  const live = settings?.config?.state === 'live'
  const locked = Boolean(settings?.config?.initial_start_locked_at)
  const busy = Boolean(busyAction)
  const disabledReason = 'This page is read-only for members. Ask a company admin to make changes.'
  const items = readinessItems({ credentialsReady, connectionReady, dateReady, mappingsReady, dryRunReady, live })
  const nextAction = !isAdmin
    ? 'Ask a company admin to continue setup.'
    : !credentialsReady ? 'Save both credentials.'
      : !connectionReady ? 'Run the connection check.'
        : !dateReady ? 'Save the Pacific start date.'
          : !mappingsReady ? 'Confirm all seven required mappings.'
            : !sampleDryRunReady ? 'Queue and review a sample dry run.'
              : !dryRunReady ? 'Queue and review the full dry run.'
              : !live ? 'Confirm live activation.' : 'Monitor sync operations on Overview.'
  const canEnterDryRun = isAdmin && !busy && credentialsReady && connectionReady && dateReady && mappingsReady && !live
  const canActivate = isAdmin && !busy && connectionReady && mappingsReady && dryRunReady && settings?.config?.state === 'dry_run'
  const options = settings?.preflight?.details?.options ?? EMPTY_OPTIONS
  const completedDryRunTotals = presentDryRunTotals(settings?.lastCompletedDryRun?.totals)
  const completedSampleDryRunTotals = presentDryRunTotals(settings?.lastCompletedSampleDryRun?.totals)

  async function saveCredentials(update) {
    const result = await perform('credentials', signal => saveH2ASettings(session, companyId, { action: 'replace_credentials', ...update }, { signal }),
      'Credentials saved. Run the connection check again.')
    if (result) setMappingResetRevision(value => value + 1)
    return Boolean(result)
  }

  async function runPreflight() {
    const result = await perform('preflight', async signal => {
      await runH2APreflight(session, companyId, { signal })
      return refreshSettings(signal)
    }, 'Connection check complete. Review the capability list below.')
    if (result) setMappingResetRevision(value => value + 1)
  }

  async function saveDate() {
    await perform('date', signal => saveH2ASettings(session, companyId, { action: 'save_start_date', startDate }, { signal }),
      'Start date saved. It remains editable until the first dry run.')
  }

  async function requestEstimate() {
    await perform('estimate', async signal => {
      const value = await estimateH2AActivities(session, companyId, startDate, { signal })
      if (tenantKeyRef.current === tenantKey) setEstimate(value)
      return value
    }, 'Estimate refreshed. No settings or sync records were changed.')
  }

  async function confirmMappings(optionMappings) {
    const result = await perform('mappings', signal => saveH2ASettings(session, companyId, { action: 'confirm_option_mappings', optionMappings }, { signal }),
      'Mappings confirmed with the current tenant option IDs.')
    if (result) setMappingResetRevision(value => value + 1)
  }

  async function saveRecipients() {
    const recipients = notificationRecipients.split(/[\n,]/).map(value => value.trim()).filter(Boolean)
    await perform('notifications', signal => saveH2ASettings(session, companyId, {
      action: 'save_notification_recipients', notificationRecipients: recipients,
    }, { signal }), 'Additional notification recipients saved.')
  }

  async function queueDryRun({ enter = false, dryRunScope = 'sample' } = {}) {
    await perform('dry-run', async signal => {
      let current = settings
      if (enter) {
        current = await saveH2ASettings(session, companyId, { action: 'enter_dry_run' }, { signal })
        if (tenantKeyRef.current === tenantKey) applySettings(current)
      }
      await runH2ASync(session, companyId, 'dry_run', { signal, dryRunScope })
      return current
    }, dryRunScope === 'sample'
      ? 'Sample dry run queued. Refresh readiness after it completes, then review it on Overview.'
      : 'Full dry run queued. Refresh readiness after it completes, then review it on Overview.')
  }

  async function activateLive() {
    await perform('activate', signal => saveH2ASettings(session, companyId, { action: 'activate_live' }, { signal }),
      'Live sync activated. The selected initial date remains fixed.')
  }

  async function disableLive() {
    await perform('disable', signal => saveH2ASettings(session, companyId, { action: 'disable' }, { signal }),
      'Live sync disabled. The initial date and review history are preserved.')
  }

  async function requestBackfill() {
    await perform('backfill', signal => saveH2ASettings(session, companyId, { action: 'request_earlier_backfill', startDate: backfillDate }, { signal }),
      'Earlier backfill requested. This does not move the live cursor or the fixed initial date.')
  }

  async function refreshReadiness() {
    if (busyAction) return
    await perform('readiness-refresh', signal => getH2ASettings(session, companyId, { signal }),
      'Readiness refreshed. Mapping drafts and keyboard position were preserved.')
  }

  if (loading) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white px-5 py-10 text-center" role="status" aria-live="polite">
        <span className="mx-auto block h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-brand-600" aria-hidden="true" />
        <p className="mt-3 text-sm text-gray-600">Loading settings for {companyName || 'this company'}…</p>
      </div>
    )
  }

  if (loadError || !settings) {
    return (
      <div className="rounded-xl border border-red-200 bg-white px-5 py-8" role="alert">
        <h2 className="text-base font-semibold text-gray-900">Settings could not be loaded</h2>
        <p className="mt-1 text-sm text-red-700">{loadError || 'HubSpot to Albi settings are unavailable.'}</p>
        <button type="button" onClick={() => setInitialRetryToken(value => value + 1)} className={`${buttonSecondary} mt-4`}>Try again</button>
      </div>
    )
  }

  return (
    <section aria-labelledby="h2a-settings-title" aria-busy={busyAction === 'readiness-refresh'}>
      <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-brand-600">Setup runway</p>
          <h1 id="h2a-settings-title" className="mt-1 text-xl font-semibold tracking-tight text-gray-900">Settings for {settings.companyName || companyName}</h1>
          <p className="mt-1 text-sm text-gray-500">Follow the checklist in order. Green means verified, not merely saved.</p>
        </div>
        {!isAdmin && <span className="text-sm font-semibold text-gray-600">Read-only member view</span>}
      </div>

      <div className="rounded-xl border border-slate-200 bg-slate-900 px-4 py-4 text-white shadow-sm sm:px-5">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-blue-200">Readiness checklist</p>
            <p className="mt-1 text-sm text-slate-200"><span className="font-semibold text-white">Next safe action:</span> {nextAction}</p>
          </div>
          <span className="text-xs font-semibold text-slate-300">{items.filter(item => item.ready).length} of 6 ready</span>
        </div>
        <ol className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-slate-700 sm:grid-cols-3 lg:grid-cols-6">
          {items.map((item, index) => (
            <li key={item.label} className="bg-slate-800 px-3 py-2.5">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">0{index + 1}</p>
              <p className="mt-0.5 text-sm font-semibold">{item.label}</p>
              <p className={`mt-1 text-xs ${item.verified ? 'text-green-300' : item.ready ? 'text-blue-200' : 'text-slate-400'}`}>{item.status}</p>
            </li>
          ))}
        </ol>
      </div>

      <div className="mt-4 min-h-6" aria-live="polite" aria-atomic="true">
        {notice && <p className="border-l-2 border-green-500 bg-green-50 px-3 py-2 text-sm text-green-800">{notice}</p>}
        {actionError && <p className="border-l-2 border-red-500 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">{actionError}</p>}
      </div>

      {!isAdmin && (
        <div className="mb-4 border-l-2 border-gray-400 bg-gray-100 px-4 py-3 text-sm text-gray-700">
          {disabledReason} You can still inspect readiness, masks, capabilities, mappings, and run status.
        </div>
      )}

      <ol className="space-y-4">
        <SetupCard number="01" title="Secure credentials" complete={credentialsReady} completeLabel="Saved" savedOnly description="Store one HubSpot private-app token and one company-scoped Guardian Albi API key. Only server-generated masks return to this page.">
          <CredentialFields
            hubspotTokenMask={settings.hubspotTokenMask}
            albiApiKeyMask={settings.albiApiKeyMask}
            isAdmin={isAdmin}
            busy={busyAction === 'credentials'}
            onSave={saveCredentials}
            disabledReason={disabledReason}
          />
        </SetupCard>

        <SetupCard number="02" title="Verify the connection" complete={connectionReady} description="Check authentication, required read/write capabilities, and the current tenant’s Albi option lists without creating records.">
          <PreflightChecklist
            preflight={settings.preflight}
            credentialsReady={credentialsReady}
            isAdmin={isAdmin}
            busy={busyAction === 'preflight'}
            onRun={runPreflight}
            disabledReason={disabledReason}
          />
        </SetupCard>

        <SetupCard number="03" title="Choose the activity horizon" complete={dateReady} completeLabel="Saved" savedOnly description="Set the first eligible HubSpot activity date, then preview the size of the range before locking it.">
          <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
            <div>
              <label htmlFor="h2a-start-date" className="block text-sm font-medium text-gray-800">Sync activities starting from</label>
              <input
                id="h2a-start-date"
                type="date"
                required
                max={pacificToday()}
                value={startDate}
                onChange={event => { setStartDate(event.target.value); setEstimate(null) }}
                disabled={!isAdmin || busy || locked}
                aria-describedby="h2a-date-help"
                className={inputClass}
              />
              <p id="h2a-date-help" className="mt-2 text-xs leading-5 text-gray-500">
                The date begins at midnight America/Los_Angeles. Inclusion uses each activity’s HubSpot occurrence time, not its entry date. The first dry run fixes this initial date.
              </p>
              {!locked && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" onClick={saveDate} disabled={!isAdmin || busy || !validDate(startDate) || dateReady} className={buttonSecondary}>
                    {busyAction === 'date' ? 'Saving…' : 'Save start date'}
                  </button>
                  <button type="button" onClick={requestEstimate} disabled={!isAdmin || busy || !validDate(startDate)} className={buttonPrimary}>
                    {busyAction === 'estimate' ? 'Estimating…' : 'Estimate activity range'}
                  </button>
                </div>
              )}
              {locked && <p className="mt-3 text-sm font-semibold text-gray-800">Initial date fixed on first dry run.</p>}
            </div>

            <div className="border-l-2 border-gray-200 pl-4">
              <p className="text-sm font-semibold text-gray-900">Read-only estimate</p>
              {estimate ? (
                <>
                  <p className="mt-1 text-3xl font-bold tracking-tight text-gray-900">{estimate.total?.toLocaleString?.() ?? estimate.total}</p>
                  <p className="text-xs text-gray-500">eligible activities across five object types</p>
                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
                    {ACTIVITY_TYPES.map(type => (
                      <div key={type}>
                        <dt className="text-xs text-gray-500">{ACTIVITY_LABELS[type]}</dt>
                        <dd className="text-sm font-semibold text-gray-900">{estimate.byObjectType?.[type] ?? 0}</dd>
                      </div>
                    ))}
                  </dl>
                  {estimate.capped && <p className="mt-3 border-l-2 border-amber-400 bg-amber-50 px-3 py-2 text-xs text-amber-900">Lower-bound estimate: one or more counts reached the preview cap. Plan for a larger range.</p>}
                </>
              ) : <p className="mt-2 text-sm leading-6 text-gray-500">Request an estimate to see meetings, calls, emails, communications, and notes before the dry run.</p>}
            </div>
          </div>

          {locked && isAdmin && (
            <div className="mt-5 border-t border-gray-200 pt-5">
              <h3 className="text-sm font-semibold text-gray-900">Need older activity?</h3>
              <p className="mt-1 text-xs leading-5 text-gray-500">Requesting an earlier date creates separate backfill windows. It does not move the live cursor or change the fixed initial date.</p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
                <div>
                  <label htmlFor="h2a-backfill-date" className="block text-sm font-medium text-gray-800">Earlier backfill start date</label>
                  <input id="h2a-backfill-date" type="date" max={settings.config.selected_start_date} value={backfillDate} onChange={event => setBackfillDate(event.target.value)} disabled={busy} aria-describedby="h2a-backfill-help" className={inputClass} />
                </div>
                <button type="button" onClick={requestBackfill} disabled={busy || !validDate(backfillDate) || backfillDate >= settings.config.selected_start_date} className={buttonSecondary}>
                  {busyAction === 'backfill' ? 'Requesting…' : 'Request earlier backfill'}
                </button>
              </div>
              <p id="h2a-backfill-help" className="mt-2 text-xs text-gray-500">Must be earlier than {settings.config.selected_start_date}; it creates five separately checkpointed activity windows.</p>
            </div>
          )}
        </SetupCard>

        <SetupCard number="04" title="Confirm tenant-specific mappings" complete={mappingsReady} description="Map HubSpot activity categories and creation defaults to exact Albi option IDs for this company.">
          <OptionMappingForm
            options={options}
            mappings={settings.optionMappings}
            confirmationStatus={settings.config.option_confirmation_status}
            resetKey={`${tenantKey}:${mappingResetRevision}`}
            isAdmin={isAdmin}
            busy={busyAction === 'mappings'}
            onConfirm={confirmMappings}
            disabledReason={disabledReason}
          />

          <details className="mt-6 border-t border-gray-200 pt-5">
            <summary className="cursor-pointer text-sm font-semibold text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">Advanced · notification recipients</summary>
            <div className="mt-4 max-w-2xl">
              <label htmlFor="h2a-notification-recipients" className="block text-sm font-medium text-gray-800">Additional recipients</label>
              <textarea
                id="h2a-notification-recipients"
                rows={4}
                value={notificationRecipients}
                onChange={event => setNotificationRecipients(event.target.value)}
                disabled={!isAdmin || busy}
                aria-describedby="h2a-notification-help"
                className={inputClass}
                placeholder={'ops@example.com\nowner@example.com'}
              />
              <p id="h2a-notification-help" className="mt-2 text-xs leading-5 text-gray-500">Up to 20 addresses, one per line or comma-separated. Company admins are always notified automatically; these are additional tenant recipients.</p>
              <button type="button" onClick={saveRecipients} disabled={!isAdmin || busy} className={`${buttonSecondary} mt-3`}>
                {busyAction === 'notifications' ? 'Saving…' : 'Save notification recipients'}
              </button>
            </div>
          </details>
        </SetupCard>

        <SetupCard number="05" title="Dry run, review, then activate" complete={live} description="Lock the initial date with a dry run, wait for completion, review operational results, then explicitly enable live writes.">
          <div className="mt-5 grid gap-5 lg:grid-cols-2">
            <div>
              <p className="text-sm font-semibold text-gray-900">Dry run</p>
              <p className="mt-1 text-sm leading-6 text-gray-500">Start with a quick sample of up to 10 from each activity type. Dry runs never create Albi records, consume delivery keys, or move live cursors.</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {settings.config.state !== 'dry_run' && !live && (
                  <button type="button" onClick={() => queueDryRun({ enter: true, dryRunScope: 'sample' })} disabled={!canEnterDryRun} className={buttonPrimary}>
                    {busyAction === 'dry-run' ? 'Queueing…' : 'Run sample dry run'}
                  </button>
                )}
                {settings.config.state === 'dry_run' && !dryRunReady && !sampleDryRunReady && (
                  <button type="button" onClick={() => queueDryRun({ dryRunScope: 'sample' })} disabled={!isAdmin || busy} className={buttonPrimary}>
                    {busyAction === 'dry-run' ? 'Queueing…' : 'Retry sample dry run'}
                  </button>
                )}
                {settings.config.state === 'dry_run' && !dryRunReady && sampleDryRunReady && (<>
                  <button type="button" onClick={() => queueDryRun({ dryRunScope: 'sample' })} disabled={!isAdmin || busy} className={buttonSecondary}>
                    {busyAction === 'dry-run' ? 'Queueing…' : 'Run sample again'}
                  </button>
                  <button type="button" onClick={() => queueDryRun({ dryRunScope: 'full' })} disabled={!isAdmin || busy} className={buttonPrimary}>
                    {busyAction === 'dry-run' ? 'Queueing…' : 'Run full dry run'}
                  </button>
                </>)}
                {settings.config.state === 'dry_run' && (
                  <button
                    type="button"
                    onClick={refreshReadiness}
                    disabled={busy && busyAction !== 'readiness-refresh'}
                    aria-disabled={busyAction === 'readiness-refresh'}
                    aria-busy={busyAction === 'readiness-refresh'}
                    className={`${buttonSecondary} ${busyAction === 'readiness-refresh' ? 'cursor-wait opacity-70' : ''}`}
                  >{busyAction === 'readiness-refresh' ? 'Refreshing readiness…' : 'Refresh readiness'}</button>
                )}
              </div>
              {sampleDryRunReady && !dryRunReady && (
                <div className="mt-4 rounded-lg border border-brand-200 bg-brand-50 px-3 py-3">
                  <p className="text-sm font-semibold text-brand-950">Sample completed successfully</p>
                  <p className="mt-1 text-xs text-brand-800">Finished {settings.lastCompletedSampleDryRun?.finishedAt ? new Date(settings.lastCompletedSampleDryRun.finishedAt).toLocaleString() : 'recently'}. Review it on Overview before running the full history.</p>
                  {completedSampleDryRunTotals.length > 0 && (
                    <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                      {completedSampleDryRunTotals.map(total => (
                        <div key={total.key} className="flex gap-1 text-xs">
                          <dt className="text-brand-800">{total.label}</dt>
                          <dd className="font-semibold tabular-nums text-brand-950">{total.value.toLocaleString()}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </div>
              )}
              {!canEnterDryRun && !locked && <p className="mt-2 text-xs text-gray-500">Complete credentials, connection, saved start date, and seven confirmed mappings first.</p>}
            </div>

            <div className="border-l-2 border-gray-200 pl-4">
              <p className="text-sm font-semibold text-gray-900">Review and live activation</p>
              {dryRunReady ? (
                <div className="mt-2">
                  <p className="text-sm text-green-800">Completed dry run ready for review.</p>
                  <p className="mt-1 text-xs text-gray-500">Finished {settings.lastCompletedDryRun?.finishedAt ? new Date(settings.lastCompletedDryRun.finishedAt).toLocaleString() : 'recently'}.</p>
                  {completedDryRunTotals.length > 0 ? (
                    <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 border-y border-gray-200 py-3 sm:grid-cols-3">
                      {completedDryRunTotals.map(total => (
                        <div key={total.key}>
                          <dt className="text-xs text-gray-500">{total.label}</dt>
                          <dd className="mt-0.5 text-sm font-semibold tabular-nums text-gray-900">{total.value.toLocaleString()}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : (
                    <p className="mt-3 border-y border-gray-200 py-3 text-xs text-gray-600">No outcome totals were reported for this completed dry run.</p>
                  )}
                  <p className="mt-2 text-xs leading-5 text-gray-600">
                    {completedDryRunTotals.length > 0
                      ? 'Activating confirms the admin reviewed the completed dry-run totals shown above.'
                      : 'Activating confirms the admin reviewed this completed dry run, which reported no outcome totals.'}
                    {' '}Detailed per-record review is not available yet; it will live on Overview in a later release.
                  </p>
                  <Link to="/hubspot-to-albi" className="mt-3 inline-flex text-sm font-semibold text-brand-700 underline decoration-brand-200 underline-offset-4 hover:decoration-brand-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">Open Overview</Link>
                </div>
              ) : <p className="mt-2 text-sm leading-6 text-gray-500">Live activation remains blocked until a dry-run run created after the date lock finishes successfully.</p>}

              <div className="mt-4 flex flex-wrap gap-2">
                {!live ? (
                  <button type="button" onClick={activateLive} disabled={!canActivate} title={!canActivate ? 'Complete and review a dry run before live activation.' : undefined} className={buttonPrimary}>
                    {busyAction === 'activate' ? 'Activating…' : 'I reviewed this completed dry run — activate live'}
                  </button>
                ) : (
                  <button type="button" onClick={disableLive} disabled={!isAdmin || busy} className={buttonSecondary}>
                    {busyAction === 'disable' ? 'Disabling…' : 'Disable live sync'}
                  </button>
                )}
              </div>
              {!isAdmin && <p className="mt-2 text-xs text-gray-500">{disabledReason}</p>}
            </div>
          </div>
        </SetupCard>
      </ol>
    </section>
  )
}
