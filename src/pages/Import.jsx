import { useEffect, useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import {
  createDeal,
  updateDeal,
  associateDeal,
  createCompany,
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

export default function Import({ session, isAdmin, companyName, companyId }) {
  const navigate = useNavigate()
  const [userConfig, setUserConfig] = useState(null)
  const [configStatus, setConfigStatus] = useState(null)
  const [loadingConfig, setLoadingConfig] = useState(true)
  const [lastSyncAt, setLastSyncAt] = useState(null)

  // Sync gate state
  const [cacheStatus, setCacheStatus] = useState('checking') // 'checking' | 'empty' | 'ready'

  // Sync UI state (mirrors Configuration.jsx polling pattern)
  const [syncing,     setSyncing]     = useState(false)
  const [syncStep,    setSyncStep]    = useState(null)
  const [syncPolling, setSyncPolling] = useState(null)
  const pollIntervalRef = useRef(null)

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

  // Clean up any running poll interval on unmount
  useEffect(() => () => clearInterval(pollIntervalRef.current), [])

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

  async function handleSync() {
    clearInterval(pollIntervalRef.current)
    setSyncing(true)
    setSyncStep(null)
    setSyncPolling(null)

    // Read the CURRENT updated_at as our baseline BEFORE triggering the sync.
    // We compare against this value (not the browser clock) to avoid any
    // clock-skew false positives or negatives.
    const { data: beforeSync } = await supabase
      .from('hs_user_config')
      .select('updated_at')
      .eq('user_id', session.user.id)
      .single()
    const baselineUpdatedAt = beforeSync?.updated_at ?? '1970-01-01'

    try {
      await syncHubspotData(session)  // single sequential call — no type = all 3
    } catch (err) {
      setSyncing(false)
      setSyncPolling({ error: err.message })
      return
    }

    setSyncing(false)

    // Show spinners for all 3 types while waiting
    setSyncPolling({ contacts: null, companies: null, deals: null, done: false, timedOut: false })

    const pollStart = Date.now()
    const POLL_TIMEOUT_MS = 15 * 60 * 1000  // 15 min — Netlify background function max

    pollIntervalRef.current = setInterval(async () => {
      if (Date.now() - pollStart > POLL_TIMEOUT_MS) {
        clearInterval(pollIntervalRef.current)
        setSyncPolling(prev => ({ ...prev, timedOut: true }))
        return
      }

      // The background function always writes hs_user_config.updated_at at the end,
      // regardless of how many rows were cached. This is the reliable completion signal.
      const { data: cfg } = await supabase
        .from('hs_user_config')
        .select('updated_at')
        .eq('user_id', session.user.id)
        .single()

      if (cfg?.updated_at && cfg.updated_at > baselineUpdatedAt) {
        clearInterval(pollIntervalRef.current)

        // Fetch cached counts for all 3 types now that sync is done
        const [{ count: cc }, { count: co }, { count: dc }] = await Promise.all([
          supabase.from('hs_cached_contacts').select('*', { count: 'exact', head: true }).eq('user_id', session.user.id),
          supabase.from('hs_cached_companies').select('*', { count: 'exact', head: true }).eq('user_id', session.user.id),
          supabase.from('hs_cached_deals').select('*', { count: 'exact', head: true }).eq('user_id', session.user.id),
        ])

        setSyncPolling({ contacts: cc ?? 0, companies: co ?? 0, deals: dc ?? 0, done: true, timedOut: false })
        setCacheStatus('ready')
        setLastSyncAt(cfg.updated_at)
      }
    }, 3000)
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
    //
    // Supabase's JS client defaults to 1,000 rows per query. Accounts with more
    // than 1,000 contacts/deals/companies must be paginated or contacts beyond
    // row 1,000 will silently be absent from the lookup maps.
    async function fetchAllCacheRows(table, columns) {
      const PAGE = 1000
      const all = []
      let from = 0
      while (true) {
        const { data, error } = await supabase
          .from(table)
          .select(columns)
          .eq('user_id', session.user.id)
          .range(from, from + PAGE - 1)
        if (error) throw error
        if (data?.length) all.push(...data)
        if (!data || data.length < PAGE) break
        from += PAGE
      }
      return all
    }

    let cachedDeals = new Map()           // project_id → cached deal row
    let contactsByLastName = new Map()    // lowercase lastName → [contacts]
    let cachedCompanies = new Map()       // lowercase company name → hubspot_id

    try {
      const [dealRows, contactRows, companyRows] = await Promise.all([
        fetchAllCacheRows('hs_cached_deals',    'hubspot_id, project_id, deal_stage, total_estimates, accrual_revenue'),
        fetchAllCacheRows('hs_cached_contacts', 'hubspot_id, first_name, last_name, company_hubspot_id'),
        fetchAllCacheRows('hs_cached_companies','hubspot_id, name'),
      ])

      for (const d of dealRows) {
        if (d.project_id) cachedDeals.set(d.project_id, d)
      }
      for (const c of contactRows) {
        // Normalize names: some HubSpot contacts store the full "First Last" in
        // firstname with an empty lastname (e.g. when created via a "Name" field).
        // Detect and split those so last-name lookups still work correctly.
        const rawFirst = (c.first_name || '').trim()
        const rawLast  = (c.last_name  || '').trim()
        let indexFirst = rawFirst
        let indexLast  = rawLast
        if (!rawLast && rawFirst.includes(' ')) {
          const parts = rawFirst.split(/\s+/)
          indexLast  = parts[parts.length - 1]
          indexFirst = parts.slice(0, -1).join(' ')
        }
        const key = indexLast.toLowerCase()
        if (!contactsByLastName.has(key)) contactsByLastName.set(key, [])
        // If the names were derived from splitting firstname, store a normalized
        // copy so findCachedContact's first-name matching works correctly.
        const entry = (indexFirst === rawFirst && indexLast === rawLast)
          ? c
          : { ...c, first_name: indexFirst, last_name: indexLast }
        contactsByLastName.get(key).push(entry)
      }
      for (const c of companyRows) {
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
        company_id: companyId ?? null,
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
        if (row.referrer) {
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

        // ── Google leads: find or create the matching HubSpot company ─────────
        // If the cache has no match, create the company in HubSpot and add it
        // to the in-memory cache so subsequent rows with the same referrer skip
        // the API call (e.g. "Google PPC" appears on hundreds of rows).
        if (row.isGoogleLead && !resolvedCompanyId) {
          try {
            const { companyId: newId } = await withRetry(() => createCompany(row.referrer, session))
            resolvedCompanyId = newId
            cachedCompanies.set(row.referrer.toLowerCase().trim(), newId)
          } catch (err) {
            console.warn(`[Import] Could not find/create Google company "${row.referrer}":`, err.message)
          }
        }

        // ── Look up existing deal via in-memory cache — zero HubSpot calls ───
        const cachedDeal = findCachedDeal(cachedDeals, row.name)

        // createFallback: set true if updateDeal 404s (stale cached ID).
        // Falls through to the create path, which itself recovers from 400
        // "already has that value" if the deal exists under a new ID.
        let createFallback = false

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
            try {
              await withRetry(() => updateDeal(cachedDeal.hubspot_id, properties, session))
              hubspotDealId = cachedDeal.hubspot_id
              action = 'updated'
              updated++
              cachedDeals.set(row.name, {
                ...cachedDeal,
                deal_stage: properties.dealstage ?? cachedDeal.deal_stage,
                total_estimates: row.estimatedRevenue,
                accrual_revenue: row.accrualRevenue,
              })
            } catch (updateErr) {
              // 404: cached deal ID deleted/merged in HubSpot — drop stale entry
              // and let the create path handle it (with its own 400 recovery).
              if (!updateErr.message.includes('404')) throw updateErr
              cachedDeals.delete(row.name)
              createFallback = true
            }
          }

          if (!createFallback) {
            // ── Retroactive association linking ─────────────────────────────
            // Only link (and count as an update) when resolving a previously held
            // deal. Deals created with associations already have them; re-calling
            // associateDeal every run is idempotent but incorrectly flips
            // action from 'skipped' → 'updated' on every subsequent import.
            const wasHeld = heldQueueMap.has(row.name)
            let associationAdded = false

            // Google leads: always ensure the company association exists.
            // Handles deals imported before this feature was added (retroactive).
            // associateDeal is idempotent in HubSpot so re-running is safe.
            if (row.isGoogleLead && resolvedCompanyId) {
              try {
                await withRetry(() => associateDeal(cachedDeal.hubspot_id, 'companies', resolvedCompanyId, session))
                associationAdded = true
              } catch (assocErr) {
                console.warn(`[Import] Google company association failed for ${row.name}:`, assocErr.message)
              }
              if (action === 'skipped' && associationAdded) {
                action = 'updated'; skipped--; updated++
              }
            }

            if (wasHeld) {
              // Wrap each call so a failure doesn't abort held deal resolution.
              if (resolvedContactId) {
                try {
                  await withRetry(() => associateDeal(cachedDeal.hubspot_id, 'contacts', resolvedContactId, session))
                  associationAdded = true
                } catch (assocErr) {
                  console.warn(`[Import] Contact association failed for ${row.name}:`, assocErr.message)
                }
              }
              if (resolvedCompanyId) {
                try {
                  await withRetry(() => associateDeal(cachedDeal.hubspot_id, 'companies', resolvedCompanyId, session))
                  associationAdded = true
                } catch (assocErr) {
                  console.warn(`[Import] Company association failed for ${row.name}:`, assocErr.message)
                }
              }
              if (action === 'skipped' && associationAdded) {
                action = 'updated'; skipped--; updated++
              }

              // Mark as resolved — runs regardless of association outcome.
              await supabase
                .from('hs_held_deals')
                .update({ resolved_at: new Date().toISOString(), resolved_deal_id: hubspotDealId })
                .eq('user_id', session.user.id)
                .eq('job_id', row.name)
            }
          }
        }

        if (!cachedDeal || createFallback) {
          // ── Create new deal — or hold if referrer is unmatched ────────────
          const hasUnmatchedReferrer =
            row.referrer && !row.isGoogleLead && !resolvedContactId && !resolvedCompanyId

          if (hasUnmatchedReferrer) {
            await supabase.from('hs_held_deals').upsert({
              user_id: session.user.id,
              company_id: companyId ?? null,
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
          company_id: companyId ?? null,
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

      // Signal whether a HubSpot API call was made this row.
      // rateLimiter only inserts the 1.1s delay when at least one row in a batch returns true.
      // Skipped and held rows return false so all-skip/all-held batches are instant.
      return action === 'created' || action === 'updated' || action === 'error'
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
                company_id: companyId ?? null,
                import_id: batchImportId,
                job_id: heldDeal.job_id,
                job_name: heldDeal.deal_name,
                job_status: heldDeal.dealstage,
                deal_value: heldDeal.estimated_revenue,
                accrual_revenue: heldDeal.accrual_revenue,
                hubspot_deal_id: resolvedHeldDealId,
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
    <AppShell session={session} isAdmin={isAdmin} companyName={companyName}>
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

        {/* ── Sync HubSpot Data card ─────────────────────────────────────── */}
        {!configBlocked && !isRunning && !isDone && (
          <div className={`mb-4 bg-white rounded-xl border p-5 ${
            cacheStatus === 'empty' ? 'border-amber-300' : 'border-gray-200'
          }`}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-sm font-semibold text-gray-900">Sync HubSpot Data</h3>
                {!syncPolling && (
                  <p className={`text-xs mt-0.5 ${
                    cacheStatus === 'empty'
                      ? 'text-amber-600'
                      : needsResync
                        ? 'text-amber-600'
                        : 'text-gray-400'
                  }`}>
                    {cacheStatus === 'empty'
                      ? 'Not yet synced — run a sync before importing to match referrers and detect existing deals.'
                      : needsResync
                        ? `Last synced ${Math.floor(syncAgeMs / (60 * 60 * 1000))}h ago — data may be stale.`
                        : lastSyncAt
                          ? `Last synced: ${new Date(lastSyncAt).toLocaleString()}`
                          : 'Run sync to populate the local cache.'}
                  </p>
                )}
              </div>
              <button
                onClick={handleSync}
                disabled={syncing || (syncPolling && !syncPolling.done && !syncPolling.timedOut)}
                className={`shrink-0 px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:opacity-50 ${
                  cacheStatus === 'empty' && !syncPolling
                    ? 'bg-brand-600 text-white hover:bg-brand-700'
                    : 'border border-gray-300 text-gray-700 hover:bg-gray-50'
                }`}
              >
                {syncing ? (
                  <span className="flex items-center gap-2">
                    <span className="animate-spin rounded-full h-3 w-3 border-b-2 border-current" />
                    {syncStep ? `Queuing ${syncStep}…` : 'Queuing…'}
                  </span>
                ) : 'Sync Now'}
              </button>
            </div>

            {/* Error */}
            {syncPolling?.error && (
              <p className="mt-2 text-xs text-red-600">Sync failed: {syncPolling.error}</p>
            )}

            {/* Live polling progress */}
            {syncPolling && !syncPolling.error && (
              <div className="mt-3 space-y-1.5">
                {[
                  { key: 'contacts',  label: 'Contacts'  },
                  { key: 'companies', label: 'Companies' },
                  { key: 'deals',     label: 'Deals'     },
                ].map(({ key, label }) => {
                  const count = syncPolling[key]
                  const done  = count !== null && count !== undefined
                  return (
                    <div key={key} className="flex items-center gap-2 text-sm">
                      {done ? (
                        <svg className="w-4 h-4 text-green-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                      ) : (
                        <span className="w-4 h-4 shrink-0 flex items-center justify-center">
                          <span className="animate-spin rounded-full h-3 w-3 border-b-2 border-gray-400" />
                        </span>
                      )}
                      <span className={done ? 'text-gray-700' : 'text-gray-400'}>
                        {label}
                        {done && <span className="ml-1.5 text-gray-400 font-normal">— {count.toLocaleString()} cached</span>}
                      </span>
                    </div>
                  )
                })}

                {syncPolling.done && (
                  <p className="text-xs text-green-700 pt-1">Sync complete — cache is up to date.</p>
                )}
                {syncPolling.timedOut && !syncPolling.done && (
                  <p className="text-xs text-amber-700 pt-1">
                    Still running in the background — large accounts can take a few minutes. You can import once it finishes; the cache status above will reflect the latest sync.
                  </p>
                )}
                {!syncPolling.done && !syncPolling.timedOut && (
                  <p className="text-xs text-gray-400 pt-1">Fetching from HubSpot — usually 15–60 seconds…</p>
                )}
              </div>
            )}
          </div>
        )}

        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-6">
          {/* Uploader — blocked until first sync completes */}
          {!isRunning && !isDone && (
            <>
              {cacheStatus === 'empty' && !syncPolling?.done ? (
                <p className="text-sm text-gray-500 py-2">
                  Run a sync above to enable importing.
                </p>
              ) : (
                <CSVUploader
                  userConfig={userConfig}
                  onConfirm={runImport}
                  disabled={configBlocked}
                />
              )}
            </>
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
