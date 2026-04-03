import { processBatched, withRetry } from '../../src/lib/rateLimiter.js'
import { hsGet, hsPatch, hsPost, hsPut } from './_getHubspotKey.js'

function findCachedDeal(cachedDeals, projectId) {
  return cachedDeals.get(projectId) ?? null
}

function findCachedContact(contactsByLastName, firstName, lastName) {
  const candidates = contactsByLastName.get(lastName.toLowerCase().trim()) ?? []
  if (candidates.length === 0) return null
  if (!firstName) return candidates[0]

  const fn = firstName.toLowerCase().trim()
  const exact = candidates.find(c => (c.first_name || '').toLowerCase() === fn)
  if (exact) return exact

  const initial = candidates.find(c => (c.first_name || '').toLowerCase().startsWith(fn[0]))
  if (initial) return initial

  return candidates[0]
}

function findCachedCompany(cachedCompanies, name) {
  return cachedCompanies.get(name.toLowerCase().trim()) ?? null
}

async function createDeal(properties, associations, apiKey) {
  const payload = { properties }
  if (associations?.length > 0) payload.associations = associations
  return hsPost('/crm/v3/objects/deals', payload, apiKey)
}

async function updateDeal(dealId, properties, apiKey) {
  return hsPatch(`/crm/v3/objects/deals/${dealId}`, { properties }, apiKey)
}

async function associateDeal(dealId, objectType, objectId, apiKey) {
  return hsPut(`/crm/v4/objects/deals/${dealId}/associations/default/${objectType}/${objectId}`, apiKey)
}

async function createCompany(name, apiKey) {
  return hsPost('/crm/v3/objects/companies', { properties: { name } }, apiKey)
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
  if (skipIfRecent) {
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

    try {
      const { pipelines, owners } = await fetchPipelinesAndOwners(apiKey)
      for (const p of pipelines) {
        const pKey = p.label.toLowerCase().trim()
        pipelineLabelToId[pKey] = p.id
        stagesByPipeline[pKey] = {}
        for (const s of p.stages) {
          stagesByPipeline[pKey][s.label.toLowerCase().trim()] = s.id
        }
      }
      for (const o of owners) {
        if (o.name) ownerNameToId[o.name.toLowerCase().trim()] = o.id
        if (o.email) ownerNameToId[o.email.toLowerCase().trim()] = o.id
      }
    } catch (err) {
      console.warn('Could not fetch pipeline/owner metadata:', err.message)
    }

    const [dealRows, contactRows, companyRows, heldQueueRes] = await Promise.all([
      fetchAllCacheRows(supabase, userId, 'hs_cached_deals', 'hubspot_id, project_id, deal_stage, total_estimates, accrual_revenue, amount'),
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

      const key = indexLast.toLowerCase()
      if (!contactsByLastName.has(key)) contactsByLastName.set(key, [])

      const entry = (indexFirst === rawFirst && indexLast === rawLast)
        ? c
        : { ...c, first_name: indexFirst, last_name: indexLast }

      contactsByLastName.get(key).push(entry)
    }

    for (const c of companyRows) {
      if (c.name) cachedCompanies.set(c.name.toLowerCase().trim(), c.hubspot_id)
    }

    const heldQueue = heldQueueRes.data || []
    const heldQueueMap = new Map(heldQueue.map(h => [h.job_id, h]))
    const currentCsvJobIds = new Set(rows.map(r => r.name))

    let created = 0
    let updated = 0
    let skipped = 0
    let errors = 0
    let heldCount = 0

    await processBatched(rows, async row => {
      let hubspotDealId = null
      let action = 'error'
      let errorMsg = null

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

        const ownerKey = (row.salesPerson || '').toLowerCase().trim()
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
            resolvedCompanyId = findCachedCompany(cachedCompanies, row.referrer) || null
          }
        }

        if (row.isGoogleLead && row.referrer && !resolvedCompanyId) {
          try {
            const company = await withRetry(() => createCompany(row.referrer, apiKey))
            resolvedCompanyId = company.id
            cachedCompanies.set(row.referrer.toLowerCase().trim(), company.id)
          } catch (err) {
            console.warn(`Could not create Google company "${row.referrer}":`, err.message)
          }
        }

        const cachedDeal = findCachedDeal(cachedDeals, row.name)
        let createFallback = false

        if (cachedDeal) {
          const expectedStageId = stagesByPipeline[pKey]?.[sKey] ?? ''
          const unchanged =
            (cachedDeal.deal_stage || '') === expectedStageId &&
            Math.abs((cachedDeal.total_estimates ?? 0) - row.estimatedRevenue) < 0.01 &&
            Math.abs((cachedDeal.accrual_revenue ?? 0) - row.accrualRevenue) < 0.01 &&
            Math.abs((cachedDeal.amount ?? -1) - row.estimatedRevenue) < 0.01

          if (unchanged) {
            hubspotDealId = cachedDeal.hubspot_id
            action = 'skipped'
            skipped++
          } else {
            try {
              await withRetry(() => updateDeal(cachedDeal.hubspot_id, properties, apiKey))
              hubspotDealId = cachedDeal.hubspot_id
              action = 'updated'
              updated++
              cachedDeals.set(row.name, {
                ...cachedDeal,
                deal_stage: properties.dealstage ?? cachedDeal.deal_stage,
                total_estimates: row.estimatedRevenue,
                accrual_revenue: row.accrualRevenue,
                amount: row.estimatedRevenue,
              })
            } catch (updateErr) {
              if (!updateErr.message.includes('404')) throw updateErr
              cachedDeals.delete(row.name)
              createFallback = true
            }
          }

          if (!createFallback) {
            const wasHeld = heldQueueMap.has(row.name)
            let associationAdded = false

            if (row.isGoogleLead && resolvedCompanyId) {
              try {
                await withRetry(() => associateDeal(cachedDeal.hubspot_id, 'companies', resolvedCompanyId, apiKey))
                associationAdded = true
              } catch (assocErr) {
                console.warn(`Google association failed for ${row.name}:`, assocErr.message)
              }
              if (action === 'skipped' && associationAdded) {
                action = 'updated'
                skipped--
                updated++
              }
            }

            if (wasHeld) {
              if (resolvedContactId) {
                try {
                  await withRetry(() => associateDeal(cachedDeal.hubspot_id, 'contacts', resolvedContactId, apiKey))
                  associationAdded = true
                } catch (assocErr) {
                  console.warn(`Contact association failed for ${row.name}:`, assocErr.message)
                }
              }

              if (resolvedCompanyId) {
                try {
                  await withRetry(() => associateDeal(cachedDeal.hubspot_id, 'companies', resolvedCompanyId, apiKey))
                  associationAdded = true
                } catch (assocErr) {
                  console.warn(`Company association failed for ${row.name}:`, assocErr.message)
                }
              }

              if (action === 'skipped' && associationAdded) {
                action = 'updated'
                skipped--
                updated++
              }

              await supabase
                .from('hs_held_deals')
                .update({ resolved_at: new Date().toISOString(), resolved_deal_id: hubspotDealId })
                .eq('user_id', userId)
                .eq('job_id', row.name)
            }
          }
        }

        if (!cachedDeal || createFallback) {
          const hasUnmatchedReferrer =
            row.referrer && !row.isGoogleLead && !resolvedContactId && !resolvedCompanyId

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
              const newDeal = await withRetry(() => createDeal(properties, associations, apiKey))
              resolvedDealId = newDeal.id
              action = 'created'
              created++
            } catch (createErr) {
              const match = createErr.message.match(/(\d+) already has that value/)
              if (!match) throw createErr

              resolvedDealId = match[1]
              await withRetry(() => updateDeal(resolvedDealId, properties, apiKey))
              if (resolvedContactId) {
                await withRetry(() => associateDeal(resolvedDealId, 'contacts', resolvedContactId, apiKey))
              }
              if (resolvedCompanyId) {
                await withRetry(() => associateDeal(resolvedDealId, 'companies', resolvedCompanyId, apiKey))
              }
              action = 'updated'
              updated++
            }

            hubspotDealId = resolvedDealId
            cachedDeals.set(row.name, {
              hubspot_id: resolvedDealId,
              project_id: row.name,
              deal_stage: properties.dealstage ?? null,
              total_estimates: row.estimatedRevenue,
              accrual_revenue: row.accrualRevenue,
              amount: row.estimatedRevenue,
            })

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
          hubspot_deal_id: hubspotDealId,
          action_taken: action,
          error_message: errorMsg,
        })
      }

      return action === 'created' || action === 'updated' || action === 'error'
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
          resolvedCompanyId = findCachedCompany(cachedCompanies, heldDeal.referrer) || null
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
            created++
          } catch (createErr) {
            const match = createErr.message.match(/(\d+) already has that value/)
            if (!match) throw createErr

            resolvedHeldDealId = match[1]
            await withRetry(() => updateDeal(resolvedHeldDealId, heldDeal.properties_json || {}, apiKey))
            if (resolvedContactId) await withRetry(() => associateDeal(resolvedHeldDealId, 'contacts', resolvedContactId, apiKey))
            if (resolvedCompanyId) await withRetry(() => associateDeal(resolvedHeldDealId, 'companies', resolvedCompanyId, apiKey))
            updated++
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
