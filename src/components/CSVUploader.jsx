import { useRef, useState } from 'react'
import { parseAlbiCSV, REQUIRED_COLUMNS } from '../lib/parseCSV'

// Currency formatter
const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

function PreviewTable({ rows }) {
  const preview = rows.slice(0, 10)
  const more = rows.length - preview.length

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200">
      <table className="min-w-full text-xs">
        <thead>
          <tr className="bg-gray-50 border-b border-gray-200">
            <th className="text-left px-3 py-2 font-semibold text-gray-600 whitespace-nowrap">Job ID</th>
            <th className="text-left px-3 py-2 font-semibold text-gray-600 whitespace-nowrap">Deal Name</th>
            <th className="text-left px-3 py-2 font-semibold text-gray-600 whitespace-nowrap">Status</th>
            <th className="text-left px-3 py-2 font-semibold text-gray-600 whitespace-nowrap">Pipeline</th>
            <th className="text-right px-3 py-2 font-semibold text-gray-600 whitespace-nowrap">Est. Revenue</th>
            <th className="text-left px-3 py-2 font-semibold text-gray-600 whitespace-nowrap">Sales Person</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {preview.map((row, idx) => (
            <tr key={idx} className="hover:bg-gray-50/50">
              <td className="px-3 py-2 font-mono text-gray-700 whitespace-nowrap">{row.name}</td>
              <td className="px-3 py-2 text-gray-800 max-w-xs truncate">{row.dealName}</td>
              <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{row.status || '—'}</td>
              <td className="px-3 py-2 whitespace-nowrap">
                {row.pipeline
                  ? <span className="inline-block bg-brand-100 text-brand-700 text-xs rounded px-1.5 py-0.5">{row.pipeline}</span>
                  : <span className="text-orange-500 font-medium text-xs">No mapping</span>
                }
              </td>
              <td className="px-3 py-2 text-right text-gray-700 tabular-nums whitespace-nowrap">
                {fmt.format(row.estimatedRevenue)}
              </td>
              <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{row.salesPerson || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {more > 0 && (
        <p className="text-xs text-gray-400 text-center py-2 border-t border-gray-100">
          +{more} more rows (showing first 10)
        </p>
      )}
    </div>
  )
}

export default function CSVUploader({ userConfig, onConfirm, disabled }) {
  const inputRef = useRef(null)
  const [dragging, setDragging] = useState(false)
  const [parsing, setParsing] = useState(false)
  const [result, setResult] = useState(null) // { rows, missingColumns, excludedCount, filename }
  const [error, setError] = useState(null)

  async function processFile(file) {
    if (!file?.name.toLowerCase().endsWith('.csv')) {
      setError('Please upload a CSV file.')
      return
    }

    setParsing(true)
    setError(null)
    setResult(null)

    try {
      const { rows, missingColumns, excludedCount, filteredCount, unmappedSuffixes } = await parseAlbiCSV(file, userConfig)
      setResult({ rows, missingColumns, excludedCount, filteredCount, unmappedSuffixes, filename: file.name })
    } catch (err) {
      setError('Failed to parse CSV: ' + err.message)
    }

    setParsing(false)
  }

  function handleDrop(e) {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (file) processFile(file)
  }

  function handleInput(e) {
    const file = e.target.files?.[0]
    if (file) processFile(file)
    e.target.value = ''
  }

  function handleReset() {
    setResult(null)
    setError(null)
  }

  const hasMissing = result?.missingColumns?.length > 0
  const hasRows = result?.rows?.length > 0
  const canConfirm = hasRows && !hasMissing

  return (
    <div className="space-y-4">
      {/* Drop zone */}
      {!result && (
        <div
          onDragOver={e => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => !disabled && inputRef.current?.click()}
          className={`border-2 border-dashed rounded-xl p-10 flex flex-col items-center justify-center cursor-pointer transition-colors ${
            disabled ? 'opacity-40 cursor-not-allowed' :
            dragging ? 'border-brand-400 bg-brand-50' : 'border-gray-300 hover:border-brand-300 hover:bg-gray-50'
          }`}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".csv"
            onChange={handleInput}
            className="hidden"
            disabled={disabled}
          />
          {parsing ? (
            <div className="flex flex-col items-center gap-2">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-brand-600" />
              <p className="text-sm text-gray-500">Parsing CSV…</p>
            </div>
          ) : (
            <>
              <svg className="w-10 h-10 text-gray-300 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <p className="text-sm font-medium text-gray-700">Drop your Albi export here</p>
              <p className="text-xs text-gray-400 mt-1">or click to browse — CSV files only</p>
            </>
          )}
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3">
          <p className="text-sm text-red-700">{error}</p>
          <button onClick={handleReset} className="mt-1 text-xs text-red-500 hover:underline">Try again</button>
        </div>
      )}

      {result && (
        <div className="space-y-4">
          {/* File info bar */}
          <div className="flex items-center justify-between bg-gray-50 border border-gray-200 rounded-lg px-4 py-3">
            <div className="flex items-center gap-3">
              <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <div>
                <p className="text-sm font-medium text-gray-800">{result.filename}</p>
                <p className="text-xs text-gray-500">
                  {result.rows.length} rows to import
                  {result.excludedCount > 0 && ` · ${result.excludedCount} excluded by suffix/blacklist`}
                  {result.filteredCount > 0 && ` · ${result.filteredCount} filtered (not your team's jobs)`}
                </p>
              </div>
            </div>
            <button
              onClick={handleReset}
              className="text-xs text-gray-400 hover:text-gray-700 transition-colors"
            >
              Remove
            </button>
          </div>

          {/* Missing columns warning */}
          {hasMissing && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3">
              <p className="text-sm font-semibold text-red-800">Missing required columns</p>
              <p className="text-xs text-red-700 mt-1">
                The following columns were not found in the CSV:{' '}
                <strong>{result.missingColumns.join(', ')}</strong>.
              </p>
              <p className="text-xs text-red-600 mt-1">
                Required: {REQUIRED_COLUMNS.join(', ')}. Check that you exported from Albi with the correct columns.
              </p>
            </div>
          )}

          {/* Rows with no pipeline mapping warning */}
          {result.unmappedSuffixes?.length > 0 && (
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg px-4 py-3">
              <p className="text-sm font-semibold text-yellow-800">Some rows have no pipeline mapping</p>
              <p className="text-xs text-yellow-700 mt-1">
                {result.rows.filter(r => !r.pipeline).length} job(s) use the suffix{result.unmappedSuffixes.length > 1 ? 'es' : ''}{' '}
                <strong>{result.unmappedSuffixes.join(', ')}</strong> which {result.unmappedSuffixes.length > 1 ? 'are' : 'is'} not in your pipeline mapping.
                These rows will be imported without a pipeline assigned.
                Add {result.unmappedSuffixes.length > 1 ? 'these suffixes' : 'this suffix'} in Settings → Pipeline Mapping to fix this.
              </p>
            </div>
          )}

          {/* Preview table */}
          {hasRows && <PreviewTable rows={result.rows} />}

          {!hasRows && !hasMissing && (
            <p className="text-sm text-gray-500 text-center py-4">No importable rows found in this file.</p>
          )}

          {/* Confirm / cancel */}
          {hasRows && (
            <div className="flex items-center gap-3 pt-2">
              <button
                onClick={() => onConfirm(result)}
                disabled={!canConfirm}
                className="px-5 py-2.5 bg-brand-600 text-white text-sm font-medium rounded-lg hover:bg-brand-700 disabled:opacity-50 transition-colors"
              >
                Import {result.rows.length} deals
              </button>
              <button
                onClick={handleReset}
                className="px-4 py-2.5 border border-gray-300 text-gray-600 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
