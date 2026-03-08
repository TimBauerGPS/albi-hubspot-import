import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import {
  searchDeal,
  createDeal,
  updateDeal,
  searchContact,
  searchCompany,
  associateDeal,
} from '../lib/hubspot'
import { processBatched, withRetry } from '../lib/rateLimiter'
import CSVUploader from '../components/CSVUploader'
import ImportProgress from '../components/ImportProgress'
import AppShell from '../components/AppShell'

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

export default function Import({ session }) {
  const navigate = useNavigate()
  const [userConfig, setUserConfig] = useState(null)
  const [configStatus, setConfigStatus] = useState(null)
  const [loadingConfig, setLoadingConfig] = useState(true)

  // Import state
  const [importFile, setImportFile] = useState(null) // { rows, filename }
  const [isRunning, setIsRunning] = useState(false)
  const [completed, setCompleted] = useState(0)
  const [rowStatuses, setRowStatuses] = useState({})
  const [summary, setSummary] = useState(null)
  const [importId, setImportId] = useState(null)
  const [isDone, setIsDone] = useState(false)

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
    setLoadingConfig(false)
  }

  function updateRowStatus(idx, update) {
    setRowStatuses(prev => ({ ...prev, [idx]: { ...prev[idx], ...update } }))
  }

  async function runImport(parseResult) {
    const { rows, filename } = parseResult
    setImportFile(parseResult)
    setIsRunning(true)
    setCompleted(0)
    setRowStatuses({})
    setSummary(null)
    setIsDone(false)

    let created = 0
    let updated = 0
    let skipped = 0
    let errors = 0

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

    if (importErr) {
      console.error('Failed to create import record:', importErr)
    }

    // Process rows in batches of 10
    await processBatched(rows, async (row, idx) => {
      updateRowStatus(idx, { action: 'processing' })

      let hubspotDealId = null
      let action = 'error'
      let errorMsg = null

      try {
        // Build the HubSpot properties object
        const properties = {
          dealname: row.dealName,
          project_id: row.name,
          total_estimates: String(row.estimatedRevenue),
          accrual_revenue: String(row.accrualRevenue),
        }

        // Map status/pipeline if available
        if (row.pipeline) properties.pipeline_label = row.pipeline
        if (row.status) properties.dealstage_label = row.status

        // Google leads (Referrer contains "Google") are inbound — no deal owner is assigned.
        // Non-Google leads: owner would be set here via salesPerson → HubSpot owner lookup
        // when that feature is added. For now, hubspot_owner_id is intentionally omitted.

        // 1. Search for existing deal by project_id (upsert key)
        const { deal: existingDeal } = await withRetry(() => searchDeal(row.name, session))

        if (existingDeal) {
          // ── Duplicate detection ───────────────────────────────────────────
          // Skip update if stage + revenues all match (mirrors Google Script logic).
          const p = existingDeal.properties || {}
          const unchanged =
            (p.dealstage_label || '') === (row.status || '') &&
            Math.abs(parseFloat(p.total_estimates || 0) - row.estimatedRevenue) < 0.01 &&
            Math.abs(parseFloat(p.accrual_revenue  || 0) - row.accrualRevenue)  < 0.01

          if (unchanged) {
            hubspotDealId = existingDeal.id
            action = 'skipped'
            skipped++
          } else {
            await withRetry(() => updateDeal(existingDeal.id, properties, session))
            hubspotDealId = existingDeal.id
            action = 'updated'
            updated++
          }
        } else {
          // ── Create new deal with Referrer-based associations ─────────────
          // Mirrors Google Script's matchReferrer():
          //   Split referrer on last space → firstName/lastName → find contact.
          //   If contact found, also associate their HubSpot company.
          //   If no contact, try full referrer string as company name.
          //   Google leads skip referrer matching (they're inbound, no referrer record).
          const associations = []

          if (row.referrer && !row.isGoogleLead) {
            const parts = row.referrer.trim().split(/\s+/)
            const lastName  = parts.length > 1 ? parts[parts.length - 1] : parts[0]
            const firstName = parts.length > 1 ? parts.slice(0, -1).join(' ') : ''

            const { contactId, companyId: contactCompanyId } = await withRetry(() =>
              searchContact(null, firstName, lastName, session)
            )

            if (contactId) {
              // Associate contact (deal → contact, type 3)
              associations.push({
                to: { id: contactId },
                types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }],
              })
              // Also associate the contact's company if we have it (deal → company, type 5)
              if (contactCompanyId) {
                associations.push({
                  to: { id: contactCompanyId },
                  types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 5 }],
                })
              }
            } else {
              // No contact — try full referrer string as a company name
              const { companyId } = await withRetry(() =>
                searchCompany(row.referrer, session)
              )
              if (companyId) {
                associations.push({
                  to: { id: companyId },
                  types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 5 }],
                })
              }
            }
          }

          const { deal: newDeal } = await withRetry(() =>
            createDeal(properties, associations, session)
          )
          hubspotDealId = newDeal.id
          action = 'created'
          created++
        }
      } catch (err) {
        action = 'error'
        errorMsg = err.message
        errors++
      }

      updateRowStatus(idx, { action, hubspotDealId, error: errorMsg })

      // Write result to hs_deals
      if (batchImportId) {
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
      delayMs: 1100, // ~10 req/sec well within HubSpot's 100 req/10s limit
      onProgress: (done, total) => setCompleted(done),
    })

    // Finalize import record
    const finalSummary = { created, updated, skipped, errors }
    setSummary(finalSummary)

    if (batchImportId) {
      await supabase
        .from('hs_imports')
        .update({
          created_count: created,
          updated_count: updated,
          error_count: errors,
          status: 'complete',
        })
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

        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-6">
          {/* Uploader — only show if not yet running */}
          {!isRunning && !isDone && (
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

          {/* Post-import actions */}
          {isDone && (
            <div className="flex items-center gap-3 pt-2 border-t border-gray-100">
              {summary?.errors > 0 && (
                <button
                  onClick={() => downloadErrorCSV(importFile.rows, rowStatuses)}
                  className="px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors"
                >
                  Download Error Report
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
