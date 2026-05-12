import { processBatched, withRetry } from '../../src/lib/rateLimiter.js'
import { hsDelete, hsGet, hsPatch, hsPost, hsPut } from './_getHubspotKey.js'

const LAST_DEAL_REFERRED_PROPERTY = 'last_deal_referred'
const LAST_DEAL_REFERRED_PROPERTY_BY_TYPE = {
  contacts: {
    groupName: 'contactinformation',
    label: 'Last Deal Referred',
  },
  companies: {
    groupName: 'companyinformation',
    label: 'Last Deal Referred',
  },
}

function findCachedDeal(cachedDeals, projectId) {
  return cachedDeals.get(projectId) ?? null
}

function normalizeLookupKey(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
}

function findCachedContact(contactsByLastName, firstName, lastName) {
  const candidates = contactsByLastName.get(normalizeLookupKey(lastName)) ?? []
  if (candidates.length === 0) return null
  if (!firstName) return candidates[0]

  const fn = normalizeLookupKey(firstName)
  const exact = candidates.find(c => normalizeLookupKey(c.first_name) === fn)
  if (exact) return exact

  const initial = candidates.find(c => normalizeLookupKey(c.first_name).startsWith(fn[0]))
  if (initial) return initial

  return candidates[0]
}

function findCachedCompany(cachedCompanies, name) {
  return cachedCompanies.get(normalizeLookupKey(name)) ?? null
}

function buildCachedDealRow(userId, dealId, properties, row, existingCacheRow = null) {
  return {
    user_id: userId,
    hubspot_id: dealId,
    project_id: row.name,
    deal_name: properties.dealname ?? row.dealName,
    deal_stage: properties.dealstage ?? existingCacheRow?.deal_stage ?? null,
    pipeline: properties.pipeline ?? existingCacheRow?.pipeline ?? null,
    total_estimates: row.estimatedRevenue,
    accrual_revenue: row.accrualRevenue,
    amount: row.estimatedRevenue,
    synced_at: new Date().toISOString(),
  }
}

async function persistCachedDeal(supabase, cachedDeals, userId, cacheRow) {
  cachedDeals.set(cacheRow.project_id, cacheRow)

  const { error } = await supabase
    .from('hs_cached_deals')
    .upsert(cacheRow, { onConflict: 'user_id,hubspot_id' })

  if (error) {
    console.warn(`Failed to persist cached deal ${cacheRow.project_id}:`, error.message)
  }
}

async function persistCachedContact(supabase, contactsByLastName, userId, contact) {
  const row = { user_id: userId, ...contact, synced_at: new Date().toISOString() }

  if (row.last_name) {
    const key = normalizeLookupKey(row.last_name)
    if (!contactsByLastName.has(key)) contactsByLastName.set(key, [])
    contactsByLastName.get(key).push(row)
  }

  const { error } = await supabase
    .from('hs_cached_contacts')
    .upsert(row, { onConflict: 'user_id,hubspot_id' })

  if (error) {
    console.warn(`Failed to persist cached contact ${row.hubspot_id}:`, error.message)
  }
}

function logUpdatedDeal(jobId, details) {
  console.log('[hs-import] deal updated', {
    jobId,
    ...details,
  })
}

function stageMatches(cachedStageId, expectedStageId, incomingStatusLabel, stageLabelById) {
  if (expectedStageId) return (cachedStageId || '') === expectedStageId
  return true
}

function numericDiffers(cachedValue, incomingValue, missingFallback = 0) {
  const cachedNumber = Number(cachedValue)
  const comparableCached = Number.isFinite(cachedNumber) ? cachedNumber : missingFallback
  return Math.abs(comparableCached - incomingValue) >= 0.01
}

async function createDeal(properties, associations, apiKey) {
  const payload = { properties }
  if (associations?.length > 0) payload.associations = associations
  return hsPost('/crm/v3/objects/deals', payload, apiKey)
}

async function updateDeal(dealId, properties, apiKey) {
  return hsPatch(`/crm/v3/objects/deals/${dealId}`, { properties }, apiKey)
}

function formatHubSpotDateValue(value = new Date()) {
  const date = new Date(value)
  const utcMidnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  return String(utcMidnight)
}

async function createLastDealReferredProperty(objectType, apiKey) {
  const spec = LAST_DEAL_REFERRED_PROPERTY_BY_TYPE[objectType]
  if (!spec) return

  await hsPost(`/crm/v3/properties/${objectType}`, {
    name: LAST_DEAL_REFERRED_PROPERTY,
    label: spec.label,
    type: 'date',
    fieldType: 'date',
    groupName: spec.groupName,
    description: 'Date of the most recent deal referred through the HubSpot importer.',
  }, apiKey)
}

async function updateLastDealReferredForObject(objectType, objectId, dateValue, apiKey) {
  if (!objectId) return

  const path = `/crm/v3/objects/${objectType}/${objectId}`
  const body = { properties: { [LAST_DEAL_REFERRED_PROPERTY]: dateValue } }

  try {
    await hsPatch(path, body, apiKey)
    return
  } catch (err) {
    try {
      await createLastDealReferredProperty(objectType, apiKey)
      await hsPatch(path, body, apiKey)
    } catch {
      // Best effort only. Missing schema scopes or property issues must not fail imports.
    }
  }
}

async function updateLastDealReferred({ contactId, companyId, dealCreatedAt, apiKey }) {
  const dateValue = formatHubSpotDateValue(dealCreatedAt)
  await Promise.all([
    updateLastDealReferredForObject('contacts', contactId, dateValue, apiKey),
    updateLastDealReferredForObject('companies', companyId, dateValue, apiKey),
  ])
}

async function associateDeal(dealId, objectType, objectId, apiKey) {
  return hsPut(`/crm/v4/objects/deals/${dealId}/associations/default/${objectType}/${objectId}`, apiKey)
}

async function fetchDealAssociationIds(dealId, objectType, apiKey) {
  const ids = []
  let after = null

  do {
    const query = new URLSearchParams({ limit: '500' })
    if (after) query.set('after', after)

    const result = await hsGet(
      `/crm/v4/objects/deals/${dealId}/associations/${objectType}?${query.toString()}`,
      apiKey
    )

    for (const association of result.results || []) {
      if (association.toObjectId) ids.push(String(association.toObjectId))
    }

    after = result.paging?.next?.after ?? null
  } while (after)

  return ids
}

async function fetchObjectAssociationIds(fromType, fromId, toType, apiKey) {
  const ids = []
  let after = null

  do {
    const query = new URLSearchParams({ limit: '500' })
    if (after) query.set('after', after)

    const result = await hsGet(
      `/crm/v4/objects/${fromType}/${fromId}/associations/${toType}?${query.toString()}`,
      apiKey
    )

    for (const association of result.results || []) {
      if (association.toObjectId) ids.push(String(association.toObjectId))
    }

    after = result.paging?.next?.after ?? null
  } while (after)

  return ids
}

async function deleteDealAssociation(dealId, objectType, objectId, apiKey) {
  return hsDelete(`/crm/v4/objects/deals/${dealId}/associations/${objectType}/${objectId}`, apiKey)
}

async function syncDealReferrerAssociations(dealId, { contactId, companyId }, apiKey) {
  const desiredByType = {
    contacts: contactId ? String(contactId) : null,
    companies: companyId ? String(companyId) : null,
  }
  const changes = []

  for (const [objectType, desiredId] of Object.entries(desiredByType)) {
    const currentIds = await fetchDealAssociationIds(dealId, objectType, apiKey)

    for (const currentId of currentIds) {
      if (currentId === desiredId) continue
      await deleteDealAssociation(dealId, objectType, currentId, apiKey)
      changes.push({ action: 'removed', objectType, objectId: currentId })
    }

    if (desiredId && !currentIds.includes(desiredId)) {
      await associateDeal(dealId, objectType, desiredId, apiKey)
      changes.push({ action: 'added', objectType, objectId: desiredId })
    }
  }

  return {
    changed: changes.length > 0,
    changes,
  }
}

async function createCompany(name, apiKey) {
  return hsPost('/crm/v3/objects/companies', { properties: { name } }, apiKey)
}

function contactMatchesName(contact, firstName, lastName) {
  const props = contact.properties || {}
  const contactFirst = normalizeLookupKey(props.firstname)
  const contactLast = normalizeLookupKey(props.lastname)
  const wantedFirst = normalizeLookupKey(firstName)
  const wantedLast = normalizeLookupKey(lastName)

  if (wantedLast && contactLast !== wantedLast) return false
  if (!wantedFirst) return true
  return contactFirst === wantedFirst || contactFirst.startsWith(wantedFirst[0])
}

async function searchLiveContactByName(firstName, lastName, apiKey) {
  const filters = [
    ...(firstName ? [{ propertyName: 'firstname', operator: 'EQ', value: firstName }] : []),
    ...(lastName ? [{ propertyName: 'lastname', operator: 'EQ', value: lastName }] : []),
  ]

  const searchBodies = []
  if (filters.length > 0) {
    searchBodies.push({ filterGroups: [{ filters }], properties: ['firstname', 'lastname', 'email'], limit: 1 })
  }

  const query = [firstName, lastName].filter(Boolean).join(' ').trim()
  if (query) {
    searchBodies.push({ query, properties: ['firstname', 'lastname', 'email'], limit: 10 })
  }

  for (const body of searchBodies) {
    const result = await hsPost('/crm/v3/objects/contacts/search', body, apiKey)
    const contact = (result.results || []).find(c => contactMatchesName(c, firstName, lastName))
    if (!contact) continue

    const companyIds = await fetchObjectAssociationIds('contacts', contact.id, 'companies', apiKey)
    return {
      hubspot_id: String(contact.id),
      email: contact.properties?.email || null,
      first_name: contact.properties?.firstname || null,
      last_name: contact.properties?.lastname || null,
      company_hubspot_id: companyIds[0] || null,
    }
  }

  return null
}

async function searchLiveCompanyByName(name, apiKey) {
  const result = await hsPost('/crm/v3/objects/companies/search', {
    query: name,
    properties: ['name'],
    limit: 10,
  }, apiKey)

  const wantedName = normalizeLookupKey(name)
  const company = (result.results || []).find(c => normalizeLookupKey(c.properties?.name) === wantedName)
  return company ? String(company.id) : null
}

async function fetchPipelinesAndOwners(apiKey) {
  const [pipelinesRes, ownersRes] = await Promise.allSettled([
    hsGet('/crm/v3/pipelines/deals', apiKey),
    hsGet('/crm/v3/owners/', apiKey),
  ])

  const pipelines = pipelinesRes.status === 'fulfilled'
    ? pipelinesRes.value.results.map(p => ({
        id: p.id,
        label: p.label,
        stages: p.stages.map(s => ({ id: s.id, label: s.label })),
      }))
    : []

  const owners = ownersRes.status === 'fulfilled'
    ? ownersRes.value.results.map(o => ({
        id: o.id,
        name: `${o.firstName || ''} ${o.lastName || ''}`.trim(),
        email: o.email,
      }))
    : []

  return { pipelines, owners }
}

async function fetchAllCacheRows(supabase, userId, table, columns) {
  const PAGE = 1000
  const all = []
  let from = 0

  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .eq('user_id', userId)
      .range(from, from + PAGE - 1)

    if (error) throw error
    if (data?.length) all.push(...data)
    if (!data || data.length < PAGE) break
    from += PAGE
  }

  return all
}

export async function runImportRows({
  supabase,
  userId,
  companyId,
  userConfig,
  apiKey,
  rows,
  filename,
  skipIfRecent = false,
  importId: existingImportId = null,
}) {
  // If the caller already created an import row and passed its id, it has
  // already decided this run should proceed. Re-checking recency here would
  // see that fresh row and incorrectly short-circuit the import.
  if (skipIfRecent && !existingImportId) {
    const { data: latestImport } = await supabase
      .from('hs_imports')
      .select('imported_at, filename')
      .eq('user_id', userId)
      .like('filename', 'Google Sheet:%')
      .order('imported_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const lastImportedAt = latestImport?.imported_at ? new Date(latestImport.imported_at).getTime() : 0
    if (Date.now() - lastImportedAt < 45 * 60 * 1000) {
      return { skipped: true, reason: 'recent_import' }
    }
  }

  let importId = existingImportId

  if (importId) {
    const { error: updateImportErr } = await supabase
      .from('hs_imports')
      .update({
        filename,
        total_rows: rows.length,
        status: 'processing',
      })
      .eq('id', importId)

    if (updateImportErr) throw new Error(`Failed to update import record: ${updateImportErr.message}`)
  } else {
    const { data: importRecord, error: importErr } = await supabase
      .from('hs_imports')
      .insert({
        user_id: userId,
        company_id: companyId ?? null,
        filename,
        total_rows: rows.length,
        status: 'processing',
      })
      .select('id')
      .single()

    if (importErr) throw new Error(`Failed to create import record: ${importErr.message}`)
    importId = importRecord.id
  }

  try {
    let pipelineLabelToId = {}
    let stagesByPipeline = {}
    let ownerNameToId = {}
    let stageLabelById = {}

    try {
      const { pipelines, owners } = await fetchPipelinesAndOwners(apiKey)
      for (const p of pipelines) {
        const pKey = p.label.toLowerCase().trim()
        pipelineLabelToId[pKey] = p.id
        stagesByPipeline[pKey] = {}
        for (const s of p.stages) {
          stagesByPipeline[pKey][s.label.toLowerCase().trim()] = s.id
          stageLabelById[s.id] = s.label.toLowerCase().trim()
        }
      }
      for (const o of owners) {
        if (o.name) ownerNameToId[normalizeLookupKey(o.name)] = o.id
        if (o.email) ownerNameToId[normalizeLookupKey(o.email)] = o.id
      }
    } catch (err) {
      console.warn('Could not fetch pipeline/owner metadata:', err.message)
    }

    const [dealRows, contactRows, companyRows, heldQueueRes] = await Promise.all([
      fetchAllCacheRows(supabase, userId, 'hs_cached_deals', 'hubspot_id, project_id, deal_stage, pipeline, total_estimates, accrual_revenue, amount'),
      fetchAllCacheRows(supabase, userId, 'hs_cached_contacts', 'hubspot_id, first_name, last_name, company_hubspot_id'),
      fetchAllCacheRows(supabase, userId, 'hs_cached_companies', 'hubspot_id, name'),
      supabase.from('hs_held_deals').select('*').eq('user_id', userId).is('resolved_at', null),
    ])

    const cachedDeals = new Map()
    const contactsByLastName = new Map()
    const cachedCompanies = new Map()

    for (const d of dealRows) {
      if (d.project_id) cachedDeals.set(d.project_id, d)
    }

    for (const c of contactRows) {
      const rawFirst = (c.first_name || '').trim()
      const rawLast = (c.last_name || '').trim()
      let indexFirst = rawFirst
      let indexLast = rawLast

      if (!rawLast && rawFirst.includes(' ')) {
        const parts = rawFirst.split(/\s+/)
        indexLast = parts[parts.length - 1]
        indexFirst = parts.slice(0, -1).join(' ')
      }

      const key = normalizeLookupKey(indexLast)
      if (!contactsByLastName.has(key)) contactsByLastName.set(key, [])

      const entry = (indexFirst === rawFirst && indexLast === rawLast)
        ? c
        : { ...c, first_name: indexFirst, last_name: indexLast }

      contactsByLastName.get(key).push(entry)
    }

    for (const c of companyRows) {
      if (c.name) cachedCompanies.set(normalizeLookupKey(c.name), c.hubspot_id)
    }

    const heldQueue = heldQueueRes.data || []
    const heldQueueMap = new Map(heldQueue.map(h => [h.job_id, h]))
    const currentCsvJobIds = new Set(rows.map(r => r.name))

    let created = 0
    let updated = 0
    let skipped = 0
    let errors = 0
    let heldCount = 0
    const updateReasons = {
      field_diff: 0,
      google_association: 0,
      held_association: 0,
      referrer_association: 0,
      duplicate_create_fallback: 0,
      held_duplicate_fallback: 0,
    }

    await processBatched(rows, async row => {
      let hubspotDealId = null
      let action = 'error'
      let errorMsg = null
      let madeHubspotCall = false

      try {
        const properties = {
          dealname: row.dealName,
          project_id: row.name,
          total_estimates: String(row.estimatedRevenue),
          amount: String(row.estimatedRevenue),
          accrual_revenue: String(row.accrualRevenue),
        }

        const pKey = (row.pipeline || '').toLowerCase().trim()
        const sKey = (row.status || '').toLowerCase().trim()
        const pipelineId = pipelineLabelToId[pKey]
        if (pipelineId) {
          properties.pipeline = pipelineId
          const stageId = stagesByPipeline[pKey]?.[sKey]
          if (stageId) properties.dealstage = stageId
        }

        const ownerKey = normalizeLookupKey(row.salesPerson)
        const ownerId = ownerNameToId[ownerKey]
        if (ownerId) properties.hubspot_owner_id = ownerId

        let resolvedContactId = null
        let resolvedCompanyId = null
        if (row.referrer) {
          const parts = row.referrer.trim().split(/\s+/)
          const lastName = parts.length > 1 ? parts[parts.length - 1] : parts[0]
          const firstName = parts.length > 1 ? parts.slice(0, -1).join(' ') : ''

          const contact = findCachedContact(contactsByLastName, firstName, lastName)
          if (contact) {
            resolvedContactId = contact.hubspot_id
            resolvedCompanyId = contact.company_hubspot_id || null
          } else {
            let liveContact = null
            try {
              liveContact = await searchLiveContactByName(firstName, lastName, apiKey)
            } catch (err) {
              console.warn(`Could not live-search HubSpot contact "${row.referrer}":`, err.message)
            }

            if (liveContact) {
              await persistCachedContact(supabase, contactsByLastName, userId, liveContact)
              resolvedContactId = liveContact.hubspot_id
              resolvedCompanyId = liveContact.company_hubspot_id || null
            } else {
              resolvedCompanyId = findCachedCompany(cachedCompanies, row.referrer) || null
              if (!resolvedCompanyId) {
                try {
                  resolvedCompanyId = await searchLiveCompanyByName(row.referrer, apiKey)
                  if (resolvedCompanyId) cachedCompanies.set(normalizeLookupKey(row.referrer), resolvedCompanyId)
                } catch (err) {
                  console.warn(`Could not live-search HubSpot company "${row.referrer}":`, err.message)
                }
              }
            }
          }
        }
        const hasUnmatchedReferrer =
          row.referrer && !row.isGoogleLead && !resolvedContactId && !resolvedCompanyId

        if (row.isGoogleLead && row.referrer && !resolvedCompanyId) {
          try {
            const company = await withRetry(() => createCompany(row.referrer, apiKey))
            resolvedCompanyId = company.id
            cachedCompanies.set(normalizeLookupKey(row.referrer), company.id)
          } catch (err) {
            console.warn(`Could not create Google company "${row.referrer}":`, err.message)
          }
        }

        const cachedDeal = findCachedDeal(cachedDeals, row.name)
        let createFallback = false

        if (cachedDeal) {
          if (hasUnmatchedReferrer) {
            hubspotDealId = cachedDeal.hubspot_id
            action = 'skipped'
            skipped++

            if (heldQueueMap.has(row.name)) {
              await supabase
                .from('hs_held_deals')
                .update({ resolved_at: new Date().toISOString(), resolved_deal_id: hubspotDealId })
                .eq('user_id', userId)
                .eq('job_id', row.name)
            }
          } else {
            const expectedStageId = stagesByPipeline[pKey]?.[sKey] ?? ''
            const stageUnchanged = stageMatches(cachedDeal.deal_stage, expectedStageId, sKey, stageLabelById)
            const totalEstimatesChanged = numericDiffers(cachedDeal.total_estimates, row.estimatedRevenue)
            const accrualRevenueChanged = numericDiffers(cachedDeal.accrual_revenue, row.accrualRevenue)
            const amountChanged = numericDiffers(cachedDeal.amount, row.estimatedRevenue)
            const unchanged =
              stageUnchanged &&
              !totalEstimatesChanged &&
              !accrualRevenueChanged &&
              !amountChanged

            if (unchanged) {
              hubspotDealId = cachedDeal.hubspot_id
              action = 'skipped'
              skipped++
            } else {
              try {
                const changedFields = []
                if (!stageUnchanged) changedFields.push('dealstage')
                if (totalEstimatesChanged) changedFields.push('total_estimates')
                if (accrualRevenueChanged) changedFields.push('accrual_revenue')
                if (amountChanged) changedFields.push('amount')

                madeHubspotCall = true
                await withRetry(() => updateDeal(cachedDeal.hubspot_id, properties, apiKey))
                hubspotDealId = cachedDeal.hubspot_id
                action = 'updated'
                updated++
                updateReasons.field_diff++
                logUpdatedDeal(row.name, {
                  reason: 'field_diff',
                  hubspotDealId,
                  changedFields,
                  cached: {
                    dealstage: cachedDeal.deal_stage || '',
                    total_estimates: cachedDeal.total_estimates ?? null,
                    accrual_revenue: cachedDeal.accrual_revenue ?? null,
                    amount: cachedDeal.amount ?? null,
                  },
                  incoming: {
                    dealstage: expectedStageId,
                    total_estimates: row.estimatedRevenue,
                    accrual_revenue: row.accrualRevenue,
                    amount: row.estimatedRevenue,
                  },
                })
                await persistCachedDeal(
                  supabase,
                  cachedDeals,
                  userId,
                  buildCachedDealRow(userId, cachedDeal.hubspot_id, properties, row, cachedDeal)
                )
              } catch (updateErr) {
                if (!updateErr.message.includes('404')) throw updateErr
                cachedDeals.delete(row.name)
                createFallback = true
              }
            }
          }

          const wasHeld = heldQueueMap.has(row.name)
          const shouldSyncReferrerAssociations =
            row.referrer &&
            !hasUnmatchedReferrer &&
            (action === 'updated' || wasHeld)

          if (!createFallback && shouldSyncReferrerAssociations) {
            madeHubspotCall = true
            const associationSync = await withRetry(() =>
              syncDealReferrerAssociations(
                cachedDeal.hubspot_id,
                { contactId: resolvedContactId, companyId: resolvedCompanyId },
                apiKey
              )
            )

            if (associationSync.changed) {
              if (action === 'skipped') {
                action = 'updated'
                skipped--
                updated++
              }

              const reason = wasHeld ? 'held_association' : 'referrer_association'
              updateReasons[reason]++
              logUpdatedDeal(row.name, {
                reason,
                hubspotDealId: cachedDeal.hubspot_id,
                contactId: resolvedContactId,
                companyId: resolvedCompanyId,
                associationChanges: associationSync.changes,
              })
            }

            if (wasHeld) {
              await supabase
                .from('hs_held_deals')
                .update({ resolved_at: new Date().toISOString(), resolved_deal_id: hubspotDealId })
                .eq('user_id', userId)
                .eq('job_id', row.name)
            }
          }
        }

        if (!cachedDeal || createFallback) {
          if (hasUnmatchedReferrer) {
            await supabase.from('hs_held_deals').upsert({
              user_id: userId,
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
              madeHubspotCall = true
              const newDeal = await withRetry(() => createDeal(properties, associations, apiKey))
              resolvedDealId = newDeal.id
              await updateLastDealReferred({
                contactId: resolvedContactId,
                companyId: resolvedCompanyId,
                dealCreatedAt: newDeal.createdAt,
                apiKey,
              })
              action = 'created'
              created++
            } catch (createErr) {
              const match = createErr.message.match(/(\d+) already has that value/)
              if (!match) throw createErr

              resolvedDealId = match[1]
              madeHubspotCall = true
              await withRetry(() => updateDeal(resolvedDealId, properties, apiKey))
              const associationSync = row.referrer
                ? await withRetry(() =>
                    syncDealReferrerAssociations(
                      resolvedDealId,
                      { contactId: resolvedContactId, companyId: resolvedCompanyId },
                      apiKey
                    )
                  )
                : { changes: [] }
              action = 'updated'
              updated++
              updateReasons.duplicate_create_fallback++
              logUpdatedDeal(row.name, {
                reason: 'duplicate_create_fallback',
                hubspotDealId: resolvedDealId,
                matchedExistingDealId: resolvedDealId,
                contactId: resolvedContactId,
                companyId: resolvedCompanyId,
                associationChanges: associationSync.changes,
              })
            }

            hubspotDealId = resolvedDealId
            await persistCachedDeal(
              supabase,
              cachedDeals,
              userId,
              buildCachedDealRow(userId, resolvedDealId, properties, row)
            )

            if (heldQueueMap.has(row.name)) {
              await supabase
                .from('hs_held_deals')
                .update({ resolved_at: new Date().toISOString(), resolved_deal_id: resolvedDealId })
                .eq('user_id', userId)
                .eq('job_id', row.name)
            }
          }
        }
      } catch (err) {
        action = 'error'
        errorMsg = err.message
        errors++
      }

      if (action !== 'held') {
        await supabase.from('hs_deals').insert({
          user_id: userId,
          company_id: companyId ?? null,
          import_id: importId,
          job_id: row.name,
          job_name: row.dealName,
          job_status: row.status,
          deal_value: row.estimatedRevenue,
          accrual_revenue: row.accrualRevenue,
          contact_name: row.customer,
          project_url: row.projectLink || null,
          hubspot_deal_id: hubspotDealId,
          action_taken: action,
          error_message: errorMsg,
        })
      }

      return madeHubspotCall || action === 'created' || action === 'updated' || action === 'error'
    }, {
      batchSize: 10,
      delayMs: 1100,
    })

    const blacklist = userConfig?.blacklist || []
    for (const heldDeal of heldQueue) {
      if (currentCsvJobIds.has(heldDeal.job_id)) continue

      if (blacklist.includes(heldDeal.job_id)) {
        await supabase
          .from('hs_held_deals')
          .update({ resolved_at: new Date().toISOString() })
          .eq('id', heldDeal.id)
        continue
      }

      try {
        const parts = heldDeal.referrer.trim().split(/\s+/)
        const lastName = parts.length > 1 ? parts[parts.length - 1] : parts[0]
        const firstName = parts.length > 1 ? parts.slice(0, -1).join(' ') : ''

        const contact = findCachedContact(contactsByLastName, firstName, lastName)
        let resolvedContactId = contact?.hubspot_id ?? null
        let resolvedCompanyId = contact?.company_hubspot_id ?? null

        if (!resolvedContactId) {
          let liveContact = null
          try {
            liveContact = await searchLiveContactByName(firstName, lastName, apiKey)
          } catch (err) {
            console.warn(`Could not live-search HubSpot contact "${heldDeal.referrer}":`, err.message)
          }

          if (liveContact) {
            await persistCachedContact(supabase, contactsByLastName, userId, liveContact)
            resolvedContactId = liveContact.hubspot_id
            resolvedCompanyId = liveContact.company_hubspot_id || null
          } else {
            resolvedCompanyId = findCachedCompany(cachedCompanies, heldDeal.referrer) || null
            if (!resolvedCompanyId) {
              try {
                resolvedCompanyId = await searchLiveCompanyByName(heldDeal.referrer, apiKey)
                if (resolvedCompanyId) cachedCompanies.set(normalizeLookupKey(heldDeal.referrer), resolvedCompanyId)
              } catch (err) {
                console.warn(`Could not live-search HubSpot company "${heldDeal.referrer}":`, err.message)
              }
            }
          }
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
            const newDeal = await withRetry(() => createDeal(heldDeal.properties_json || {}, associations, apiKey))
            resolvedHeldDealId = newDeal.id
            await updateLastDealReferred({
              contactId: resolvedContactId,
              companyId: resolvedCompanyId,
              dealCreatedAt: newDeal.createdAt,
              apiKey,
            })
            created++
          } catch (createErr) {
            const match = createErr.message.match(/(\d+) already has that value/)
            if (!match) throw createErr

            resolvedHeldDealId = match[1]
            await withRetry(() => updateDeal(resolvedHeldDealId, heldDeal.properties_json || {}, apiKey))
            const associationSync = await withRetry(() =>
              syncDealReferrerAssociations(
                resolvedHeldDealId,
                { contactId: resolvedContactId, companyId: resolvedCompanyId },
                apiKey
              )
            )
            updated++
            updateReasons.held_duplicate_fallback++
            logUpdatedDeal(heldDeal.job_id, {
              reason: 'held_duplicate_fallback',
              hubspotDealId: resolvedHeldDealId,
              matchedExistingDealId: resolvedHeldDealId,
              contactId: resolvedContactId,
              companyId: resolvedCompanyId,
              associationChanges: associationSync.changes,
            })
          }

          await supabase
            .from('hs_held_deals')
            .update({ resolved_at: new Date().toISOString(), resolved_deal_id: resolvedHeldDealId })
            .eq('id', heldDeal.id)

          await supabase.from('hs_deals').insert({
            user_id: userId,
            company_id: companyId ?? null,
            import_id: importId,
            job_id: heldDeal.job_id,
            job_name: heldDeal.deal_name,
            job_status: heldDeal.dealstage,
            deal_value: heldDeal.estimated_revenue,
            accrual_revenue: heldDeal.accrual_revenue,
            hubspot_deal_id: resolvedHeldDealId,
            action_taken: 'created',
          })
        }
      } catch (err) {
        console.warn('Failed to re-process held deal', heldDeal.job_id, err.message)
      }
    }

    const summary = { created, updated, skipped, errors, held: heldCount }
    console.log('[hs-import] import summary', {
      importId,
      userId,
      filename,
      summary,
      updateReasons,
    })

    await supabase
      .from('hs_imports')
      .update({
        created_count: created,
        updated_count: updated,
        error_count: errors,
        status: 'complete',
      })
      .eq('id', importId)

    return { importId, summary }
  } catch (err) {
    if (importId) {
      await supabase
        .from('hs_imports')
        .update({ status: 'error', error_count: 1 })
        .eq('id', importId)
    }
    throw err
  }
}
