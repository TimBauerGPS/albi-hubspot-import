import { useEffect, useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import {
  createDeal,
  updateDeal,
  associateDeal,
  syncHubspotData,
  fetchPipelinesAndOwners,
} from '../lib/hubspot'
import { processBatched, withRetry } from '../lib/rateLimiter'
import CSVUploader from '../components/CSVUploader'
import ImportProgress from '../components/ImportProgress'
import AppShell from '../components/AppShell'

// ── In-memory cache lookup helpers ────────────────────────────────────────────
// All three search functions that previously called Netlify (and in turn HubSpot)
// are replaced by simple Map lookups against data prefetched at the start of each
// import run. This eliminates 2–3 HubSpot API calls per row, cutting rate-limit
// pressure by ~70% and cutting import time roughly in half.

/**
 * Find an existing HubSpot deal by Albi project_id.
 * Returns the cached deal row or null.
 */
function findCachedDeal(cachedDeals, projectId) {
  return cachedDeals.get(projectId) ?? null
}

/**
 * Find a HubSpot contact by name split from the referrer string.
 * Matches on last name first, then narrows by first name (exact then initial).
 * Returns { hubspot_id, company_hubspot_id } or null.
 */
function findCachedContact(contactsByLastName, firstName, lastName) {
  const candidates = contactsByLastName.get(lastName.toLowerCase().trim()) ?? []
  if (candidates.length === 0) return null
  if (!firstName) return candidates[0]

  const fn = firstName.toLowerCase().trim()
  // Exact first name match
  const exact = candidates.find(c => (c.first_name || '').toLowerCase() === fn)
  if (exact) return exact
  // First-initial match (e.g. "J. Smith" vs "John Smith")
  const initial = candidates.find(c => (c.first_name || '').toLowerCase().startsWith(fn[0]))
  if (initial) return initial

  return candidates[0] // fall back to first contact with matching last name
}

/**
 * Find a HubSpot company by exact name (case-insensitive).
 * Returns the HubSpot company ID or null.
 */
function findCachedCompany(cachedCompanies, name) {
  return cachedCompanies.get(name.toLowerCase().trim()) ?? null
}

// ── CSV error download ─────────────────────────────────────────────────────────

function downloadErrorCSV(rows, rowStatuses) {
  const errorRows = rows
    .map((row, idx) => ({ row, status: rowStatuses[idx] }))
    .filter(({ status }) => status?.action === 'error')

  if (errorRows.length === 0) return

  const headers = ['Job ID', 'Deal Name', 'Status', 'Estimated Revenue', 'Error']
  const csvRows = errorRows.map(({ row, status }) => [
    row.name,
    row.dealName,
    row.status,
    row.estimatedRevenue,
    status.error || '',
  ])

  const csv = [headers, ...csvRows]
    .map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
    .join('\n')

  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `import-errors-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function Import({ session }) {
  const navigate = useNavigate()
  const [userConfig, setUserConfig] = useState(null)
  const [configStatus, setConfigStatus] = useState(null)
  const [loadingConfig, setLoadingConfig] = useState(true)
  const [lastSyncAt, setLastSyncAt] = useState(null)

  // Sync gate state
  const [cacheStatus, setCacheStatus] = useState('checking') // 'checking' | 'empty' | 'ready'
  const [syncQueued, setSyncQueued] = useState(false)
  const [syncError, setSyncError] = useState(null)

  // Import state
  const [importFile, setImportFile] = useState(null)
  const [isRunning, setIsRunning] = useState(false)
  const [completed, setCompleted] = useState(0)
  const [rowStatuses, setRowStatuses] = useState({})
  const [summary, setSummary] = useState(null)
  const [importId, setImportId] = useState(null)
  const [isDone, setIsDone] = useState(false)

  // Stop import
  const stopRequestedRef = useRef(false)
  const [stopRequested, setStopRequested] = useState(false)

  useEffect(() => {
    loadUserConfig()
  }, [session])

  async function loadUserConfig() {
    const { data } = await supabase
      .from('hs_user_config')
      .select('*')
      .eq('user_id', session.user.id)
      .maybeSingle()
    setUserConfig(data)
    setConfigStatus(data?.config_status ?? 'unchecked')

    if (data?.config_status === 'valid') {
      const [{ count }, { data: latestSync }] = await Promise.all([
        supabase
          .from('hs_cached_contacts')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', session.user.id),
        supabase
          .from('hs_cached_contacts')
          .select('synced_at')
          .eq('user_id', session.user.id)
          .order('synced_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ])
      setCacheStatus((count ?? 0) > 0 ? 'ready' : 'empty')
      setLastSyncAt(latestSync?.synced_at ?? null)
    } else {
      setCacheStatus('ready')
    }

    setLoadingConfig(false)
  }

  async function handleQueueSync() {
    setSyncQueued(true)
    setSyncError(null)
    try {
      await syncHubspotData(session, () => {})
      setCacheStatus('ready')
      setLastSyncAt(new Date().toISOString())
    } catch (err) {
      setSyncError(err.message)
      setSyncQueued(false)
    }
  }

  function handleStopImport() {
    stopRequestedRef.current = true
    setStopRequested(true)
  }

  function updateRowStatus(idx, update) {
    setRowStatuses(prev => ({ ...prev, [idx]: { ...prev[idx], ...update } }))
  }

  // 24-hour sync staleness check
  const syncAgeMs = lastSyncAt ? Date.now() - new Date(lastSyncAt).getTime() : null
  const needsResync = syncAgeMs !== null && syncAgeMs > 24 * 60 * 60 * 1000

  async function runImport(parseResult) {
    const { rows, filename } = parseResult
    setImportFile(parseResult)
    setIsRunning(true)
    setCompleted(0)
    setRowStatuses({})
    setSummary(null)
    setIsDone(false)
    stopRequestedRef.current = false
    setStopRequested(false)

    // ── Fetch pipeline/stage/owner metadata (label → ID maps) ────────────────
    let pipelineLabelToId = {}
    let stagesByPipeline = {}
    let ownerNameToId = {}
    try {
      const { pipelines, owners } = await fetchPipelinesAndOwners(session)
      for (const p of pipelines) {
        const pKey = p.label.toLowerCase().trim()
        pipelineLabelToId[pKey] = p.id
        stagesByPipeline[pKey] = {}
        for (const s of p.stages) {
          stagesByPipeline[pKey][s.label.toLowerCase().trim()] = s.id
        }
      }
      for (const o of owners) {
        if (o.name)  ownerNameToId[o.name.toLowerCase().trim()]  = o.id
        if (o.email) ownerNameToId[o.email.toLowerCase().trim()] = o.id
      }
    } catch (err) {
      console.warn('Could not fetch pipeline/owner metadata:', err.message)
    }

    // ── Prefetch all three Supabase cache tables into memory ──────────────────
    // Eliminates 2-3 Netlify/HubSpot API calls per row (contact search, company
    // search, deal search) and replaces them with O(1) in-memory Map lookups.
    // Supabase queries are ~10ms vs ~300-500ms per Netlify→HubSpot roundtrip.
    let cachedDeals = new Map()           // project_id → cached deal row
    let contactsByLastName = new Map()    // lowercase lastName → [contacts]
    let cachedCompanies = new Map()       // lowercase company name → hubspot_id

    try {
      const [
        { data: dealRows },
        { data: contactRows },
        { data: companyRows },
      ] = await Promise.all([
        supabase
          .from('hs_cached_deals')
          .select('hubspot_id, project_id, deal_stage, total_estimates, accrual_revenue')
          .eq('user_id', session.user.id),
        supabase
          .from('hs_cached_contacts')
          .select('hubspot_id, first_name, last_name, company_hubspot_id')
          .eq('user_id', session.user.id),
        supabase
          .from('hs_cached_companies')
          .select('hubspot_id, name')
          .eq('user_id', session.user.id),
      ])

      for (const d of dealRows ?? []) {
        if (d.project_id) cachedDeals.set(d.project_id, d)
      }
      for (const c of contactRows ?? []) {
        const key = (c.last_name || '').toLowerCase().trim()
        if (!contactsByLastName.has(key)) contactsByLastName.set(key, [])
        contactsByLastName.get(key).push(c)
      }
      for (const c of companyRows ?? []) {
        if (c.name) cachedCompanies.set(c.name.toLowerCase().trim(), c.hubspot_id)
      }
    } catch (err) {
      console.warn('Could not prefetch cache tables — import will proceed without local lookup cache:', err.message)
    }

    let created = 0
    let updated = 0
    let skipped = 0
    let errors  = 0
    let heldCount = 0

    // ── Load unresolved held deals queue ──────────────────────────────────────
    const { data: heldQueue } = await supabase
      .from('hs_held_deals')
      .select('*')
      .eq('user_id', session.user.id)
      .is('resolved_at', null)
    const heldQueueMap = new Map((heldQueue || []).map(h => [h.job_id, h]))
    const currentCsvJobIds = new Set(rows.map(r => r.name))

    // Create the import batch record
    const { data: importRecord, error: importErr } = await supabase
      .from('hs_imports')
      .insert({
        user_id: session.user.id,
        filename,
        total_rows: rows.length,
        status: 'processing',
      })
      .select('id')
      .single()

    const batchImportId = importRecord?.id
    setImportId(batchImportId)
    if (importErr) console.error('Failed to create import record:', importErr)

    // ── Main import loop ──────────────────────────────────────────────────────
    await processBatched(rows, async (row, idx) => {
      if (stopRequestedRef.current) return

      updateRowStatus(idx, { action: 'processing' })

      let hubspotDealId = null
      let action = 'error'
      let errorMsg = null

      try {
        // ── Build HubSpot properties ──────────────────────────────────────────
        const properties = {
          dealname: row.dealName,
          project_id: row.name,
          total_estimates: String(row.estimatedRevenue),
          accrual_revenue: String(row.accrualRevenue),
        }

        const pKey = (row.pipeline || '').toLowerCase().trim()
        const sKey = (row.status  || '').toLowerCase().trim()
        const pipelineId = pipelineLabelToId[pKey]
        if (pipelineId) {
          properties.pipeline = pipelineId
          const stageId = stagesByPipeline[pKey]?.[sKey]
          if (stageId) properties.dealstage = stageId
        }

        const ownerKey = (row.salesPerson || '').toLowerCase().trim()
        const ownerId = ownerNameToId[ownerKey]
        if (ownerId) properties.hubspot_owner_id = ownerId

        // ── Resolve referrer → contact/company via in-memory cache ────────────
        // Zero HubSpot API calls — pure Map lookups against prefetched data.
        // Runs for ALL paths (create/update/skip) to enable retroactive linking.
        let resolvedContactId = null
        let resolvedCompanyId = null
        if (row.referrer && !row.isGoogleLead) {
          const parts = row.referrer.trim().split(/\s+/)
          const lastName  = parts.length > 1 ? parts[parts.length - 1] : parts[0]
          const firstName = parts.length > 1 ? parts.slice(0, -1).join(' ') : ''

          const contact = findCachedContact(contactsByLastName, firstName, lastName)
          if (contact) {
            resolvedContactId = contact.hubspot_id
            resolvedCompanyId = contact.company_hubspot_id || null
          } else {
            const companyId = findCachedCompany(cachedCompanies, row.referrer)
            resolvedCompanyId = companyId || null
          }
        }

        // ── Look up existing deal via in-memory cache — zero HubSpot calls ───
        const cachedDeal = findCachedDeal(cachedDeals, row.name)

        if (cachedDeal) {
          // ── Duplicate detection ───────────────────────────────────────────
          const expectedStageId = stagesByPipeline[pKey]?.[sKey] ?? ''
          const unchanged =
            (cachedDeal.deal_stage || '') === expectedStageId &&
            Math.abs((cachedDeal.total_estimates ?? 0) - row.estimatedRevenue) < 0.01 &&
            Math.abs((cachedDeal.accrual_revenue  ?? 0) - row.accrualRevenue)  < 0.01

          if (unchanged) {
            hubspotDealId = cachedDeal.hubspot_id
            action = 'skipped'
            skipped++
          } else {
            await withRetry(() => updateDeal(cachedDeal.hubspot_id, properties, session))
            hubspotDealId = cachedDeal.hubspot_id
            action = 'updated'
            updated++
            // Update the in-memory cache so subsequent rows reflect the new values
            cachedDeals.set(row.name, {
              ...cachedDeal,
              deal_stage: properties.dealstage ?? cachedDeal.deal_stage,
              total_estimates: row.estimatedRevenue,
              accrual_revenue: row.accrualRevenue,
            })
          }

          // ── Retroactive association linking ───────────────────────────────
          // HubSpot associations are idempotent — safe to call on every run.
          let associationAdded = false
          if (resolvedContactId) {
            await withRetry(() => associateDeal(cachedDeal.hubspot_id, 'contacts', resolvedContactId, session))
            associationAdded = true
          }
          if (resolvedCompanyId) {
            await withRetry(() => associateDeal(cachedDeal.hubspot_id, 'companies', resolvedCompanyId, session))
            associationAdded = true
          }
          if (action === 'skipped' && associationAdded) {
            action = 'updated'; skipped--; updated++
          }

          // Mark as resolved in held queue if this deal was previously held
          if (heldQueueMap.has(row.name)) {
            await supabase
              .from('hs_held_deals')
              .update({ resolved_at: new Date().toISOString(), resolved_deal_id: hubspotDealId })
              .eq('user_id', session.user.id)
              .eq('job_id', row.name)
          }
        } else {
          // ── Create new deal — or hold if referrer is unmatched ────────────
          const hasUnmatchedReferrer =
            row.referrer && !row.isGoogleLead && !resolvedContactId && !resolvedCompanyId

          if (hasUnmatchedReferrer) {
            await supabase.from('hs_held_deals').upsert({
              user_id: session.user.id,
              job_id: row.name,
              deal_name: row.dealName,
              referrer: row.referrer,
              sales_person: row.salesPerson || null,
              pipeline: row.pipeline || null,
              dealstage: row.status || null,
              estimated_revenue: row.estimatedRevenue || 0,
              accrual_revenue: row.accrualRevenue || 0,
              properties_json: properties,
            }, { onConflict: 'user_id,job_id' })
            action = 'held'
            heldCount++
          } else {
            const associations = []
            if (resolvedContactId) {
              associations.push({
                to: { id: resolvedContactId },
                types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }],
              })
            }
            if (resolvedCompanyId) {
              associations.push({
                to: { id: resolvedCompanyId },
                types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 5 }],
              })
            }

            let resolvedDealId
            try {
              const { deal: newDeal } = await withRetry(() =>
                createDeal(properties, associations, session)
              )
              resolvedDealId = newDeal.id
              action = 'created'
              created++
            } catch (createErr) {
              // HubSpot unique property conflict: the deal already exists in HubSpot
              // but wasn't in our local cache (stale sync). The error message contains
              // the existing deal ID — parse it and fall back to an update instead.
              const match = createErr.message.match(/(\d+) already has that value/)
              if (!match) throw createErr  // non-recoverable — rethrow to outer catch

              resolvedDealId = match[1]
              await withRetry(() => updateDeal(resolvedDealId, properties, session))
              // associations were bundled into the create attempt; apply them
              // separately on the existing deal (associateDeal is idempotent)
              if (resolvedContactId) {
                await withRetry(() => associateDeal(resolvedDealId, 'contacts', resolvedContactId, session))
              }
              if (resolvedCompanyId) {
                await withRetry(() => associateDeal(resolvedDealId, 'companies', resolvedCompanyId, session))
              }
              action = 'updated'
              updated++
            }

            hubspotDealId = resolvedDealId

            // Add/refresh in-memory cache so the same project_id isn't re-processed
            cachedDeals.set(row.name, {
              hubspot_id: resolvedDealId,
              project_id: row.name,
              deal_stage: properties.dealstage ?? null,
              total_estimates: row.estimatedRevenue,
              accrual_revenue: row.accrualRevenue,
            })

            if (heldQueueMap.has(row.name)) {
              await supabase
                .from('hs_held_deals')
                .update({ resolved_at: new Date().toISOString(), resolved_deal_id: resolvedDealId })
                .eq('user_id', session.user.id)
                .eq('job_id', row.name)
            }
          }
        }
      } catch (err) {
        action = 'error'
        errorMsg = err.message
        errors++
      }

      updateRowStatus(idx, { action, hubspotDealId, error: errorMsg })

      // Write to hs_deals — skip held rows (tracked in hs_held_deals instead)
      if (batchImportId && action !== 'held') {
        await supabase.from('hs_deals').insert({
          user_id: session.user.id,
          import_id: batchImportId,
          job_id: row.name,
          job_name: row.dealName,
          job_status: row.status,
          deal_value: row.estimatedRevenue,
          accrual_revenue: row.accrualRevenue,
          contact_name: row.customer,
          hubspot_deal_id: hubspotDealId,
          action_taken: action,
          error_message: errorMsg,
        })
      }

      setCompleted(prev => prev + 1)
    }, {
      batchSize: 10,
      delayMs: 1100,
      onProgress: (done) => setCompleted(done),
    })

    // ── Re-process held queue for deals NOT in current CSV ───────────────────
    if (!stopRequestedRef.current) {
      const blacklist = userConfig?.blacklist || []
      for (const heldDeal of heldQueue || []) {
        if (stopRequestedRef.current) break
        if (currentCsvJobIds.has(heldDeal.job_id)) continue

        if (blacklist.includes(heldDeal.job_id)) {
          await supabase
            .from('hs_held_deals')
            .update({ resolved_at: new Date().toISOString() })
            .eq('id', heldDeal.id)
          continue
        }

        try {
          // Retry referrer lookup using the same in-memory cache
          const parts = heldDeal.referrer.trim().split(/\s+/)
          const lastName  = parts.length > 1 ? parts[parts.length - 1] : parts[0]
          const firstName = parts.length > 1 ? parts.slice(0, -1).join(' ') : ''

          const contact = findCachedContact(contactsByLastName, firstName, lastName)
          let resolvedContactId = contact?.hubspot_id ?? null
          let resolvedCompanyId = contact?.company_hubspot_id ?? null

          if (!resolvedContactId) {
            const companyId = findCachedCompany(cachedCompanies, heldDeal.referrer)
            resolvedCompanyId = companyId || null
          }

          if (resolvedContactId || resolvedCompanyId) {
            const associations = []
            if (resolvedContactId) {
              associations.push({
                to: { id: resolvedContactId },
                types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }],
              })
            }
            if (resolvedCompanyId) {
              associations.push({
                to: { id: resolvedCompanyId },
                types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 5 }],
              })
            }

            let resolvedHeldDealId
            try {
              const { deal: newDeal } = await withRetry(() =>
                createDeal(heldDeal.properties_json || {}, associations, session)
              )
              resolvedHeldDealId = newDeal.id
              created++
            } catch (createErr) {
              // Same stale-cache recovery as the main loop: if the deal already
              // exists in HubSpot, parse its ID from the error and update instead.
              const match = createErr.message.match(/(\d+) already has that value/)
              if (!match) throw createErr
              resolvedHeldDealId = match[1]
              await withRetry(() => updateDeal(resolvedHeldDealId, heldDeal.properties_json || {}, session))
              if (resolvedContactId) await withRetry(() => associateDeal(resolvedHeldDealId, 'contacts', resolvedContactId, session))
              if (resolvedCompanyId) await withRetry(() => associateDeal(resolvedHeldDealId, 'companies', resolvedCompanyId, session))
              updated++
            }

            await supabase
              .from('hs_held_deals')
              .update({ resolved_at: new Date().toISOString(), resolved_deal_id: resolvedHeldDealId })
              .eq('id', heldDeal.id)

            if (batchImportId) {
              await supabase.from('hs_deals').insert({
                user_id: session.user.id,
                import_id: batchImportId,
                job_id: heldDeal.job_id,
                job_name: heldDeal.deal_name,
                job_status: heldDeal.dealstage,
                deal_value: heldDeal.estimated_revenue,
                accrual_revenue: heldDeal.accrual_revenue,
                hubspot_deal_id: newDeal.id,
                action_taken: 'created',
              })
            }
          }
        } catch (err) {
          console.warn('Failed to re-process held deal', heldDeal.job_id, ':', err.message)
        }
      }
    }

    // ── Finalize ──────────────────────────────────────────────────────────────
    const finalSummary = { created, updated, skipped, errors, held: heldCount }
    setSummary(finalSummary)

    if (batchImportId) {
      await supabase
        .from('hs_imports')
        .update({ created_count: created, updated_count: updated, error_count: errors, status: 'complete' })
        .eq('id', batchImportId)
    }

    setIsRunning(false)
    setIsDone(true)
  }

  if (loadingConfig) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
      </div>
    )
  }

  const configBlocked = configStatus !== 'valid'

  return (
    <AppShell session={session}>
      <div className="max-w-4xl mx-auto px-6 py-8">
        <div className="mb-6">
          <h1 className="text-xl font-bold text-gray-900">Import Deals</h1>
          <p className="text-sm text-gray-500 mt-1">
            Upload an Albi CSV export to create or update deals in HubSpot.
          </p>
        </div>

        {configBlocked && (
          <div className="mb-6 bg-yellow-50 border border-yellow-200 rounded-xl px-5 py-4">
            <p className="text-sm font-semibold text-yellow-800">Configuration required</p>
            <p className="text-sm text-yellow-700 mt-1">
              Your HubSpot configuration must pass all checks before you can import.
            </p>
            <button
              onClick={() => navigate('/configuration')}
              className="mt-2 text-xs text-brand-600 font-medium hover:underline"
            >
              Go to Configuration →
            </button>
          </div>
        )}

        {/* 24-hour sync staleness warning */}
        {!configBlocked && cacheStatus === 'ready' && needsResync && !isRunning && !isDone && (
          <div className="mb-6 bg-amber-50 border border-amber-200 rounded-xl px-5 py-4 flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-amber-800">HubSpot data may be stale</p>
              <p className="text-sm text-amber-700 mt-0.5">
                Last synced {Math.floor(syncAgeMs / (60 * 60 * 1000))} hours ago. Syncing before
                importing ensures referrer matches and duplicate detection are accurate.
              </p>
            </div>
            {!syncQueued ? (
              <button
                onClick={handleQueueSync}
                className="shrink-0 px-3 py-1.5 bg-amber-600 text-white text-xs font-medium rounded-lg hover:bg-amber-700 transition-colors"
              >
                Sync Now
              </button>
            ) : (
              <div className="flex items-center gap-2 text-xs text-amber-700 shrink-0 pt-0.5">
                <span className="animate-spin rounded-full h-3 w-3 border-b-2 border-amber-600" />
                Syncing in background…
              </div>
            )}
          </div>
        )}

        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-6">
          {/* Sync gate — first-time prompt */}
          {!isRunning && !isDone && !configBlocked && cacheStatus === 'empty' && (
            <div className="flex flex-col items-start gap-4 py-2">
              <div>
                <h3 className="text-sm font-semibold text-gray-800">Sync HubSpot data first</h3>
                <p className="text-sm text-gray-500 mt-1">
                  Your HubSpot contacts, companies, and deals haven't been synced yet.
                  Run a sync so the importer can match referrers and check for existing deals.
                </p>
                {syncError && (
                  <p className="text-xs text-red-600 mt-2">{syncError}</p>
                )}
              </div>
              {!syncQueued ? (
                <button
                  onClick={handleQueueSync}
                  className="px-4 py-2 bg-brand-600 text-white text-sm font-medium rounded-lg hover:bg-brand-700 transition-colors"
                >
                  Sync HubSpot Data
                </button>
              ) : (
                <div className="flex items-center gap-2 text-sm text-gray-600">
                  <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-brand-600" />
                  Sync queued — fetching data in the background…
                </div>
              )}
            </div>
          )}

          {/* Uploader */}
          {!isRunning && !isDone && (cacheStatus === 'ready' || configBlocked) && (
            <CSVUploader
              userConfig={userConfig}
              onConfirm={runImport}
              disabled={configBlocked}
            />
          )}

          {/* Progress */}
          {(isRunning || isDone) && importFile && (
            <ImportProgress
              rows={importFile.rows}
              rowStatuses={rowStatuses}
              completed={completed}
              isRunning={isRunning}
              summary={summary}
            />
          )}

          {/* Stop import */}
          {isRunning && (
            <div className="flex justify-end pt-2 border-t border-gray-100">
              <button
                onClick={handleStopImport}
                disabled={stopRequested}
                className="px-4 py-2 border border-red-300 text-red-600 text-sm font-medium rounded-lg hover:bg-red-50 disabled:opacity-50 transition-colors"
              >
                {stopRequested ? 'Stopping after current batch…' : 'Stop Import'}
              </button>
            </div>
          )}

          {/* Post-import actions */}
          {isDone && (
            <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-gray-100">
              {summary?.errors > 0 && (
                <button
                  onClick={() => downloadErrorCSV(importFile.rows, rowStatuses)}
                  className="px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors"
                >
                  Download Error Report
                </button>
              )}
              {summary?.held > 0 && (
                <button
                  onClick={() => navigate('/held-deals')}
                  className="px-4 py-2 border border-amber-300 text-amber-700 text-sm font-medium rounded-lg hover:bg-amber-50 transition-colors"
                >
                  View {summary.held} Held Deal{summary.held !== 1 ? 's' : ''}
                </button>
              )}
              <button
                onClick={() => {
                  setImportFile(null)
                  setIsRunning(false)
                  setCompleted(0)
                  setRowStatuses({})
                  setSummary(null)
                  setIsDone(false)
                  setImportId(null)
                  setStopRequested(false)
                }}
                className="px-4 py-2 bg-brand-600 text-white text-sm font-medium rounded-lg hover:bg-brand-700 transition-colors"
              >
                Import Another File
              </button>
              <button
                onClick={() => navigate('/dashboard')}
                className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors"
              >
                View History
              </button>
            </div>
          )}
        </div>
      </div>
    </AppShell>
  )
}
