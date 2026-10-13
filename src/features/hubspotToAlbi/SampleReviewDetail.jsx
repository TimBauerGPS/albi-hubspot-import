import { presentSampleReviewItem, SAMPLE_REVIEW_GUIDANCE } from './sampleReview.js'

const eventLabels = {
  captured: 'Captured in sample', recheck_started: 'Recheck started', still_needs_review: 'Still needs review',
  cleared: 'Record cleared', no_longer_in_scope: 'No longer in scope', recheck_failed: 'Recheck failed',
}
const outcomeLabels = {
  still_needs_review: 'Still needs review', safe_to_link: 'Safe to link in a future sync',
  safe_to_create: 'Safe to create in a future sync', source_missing: 'Source record is missing', recheck_failed: 'Recheck failed',
}
const evidenceLabels = { existing_mapping: 'Existing mapping', email: 'Direct email', phone: 'Phone', mobilePhone: 'Mobile phone', name: 'Name', domain: 'Organization domain', address: 'Address' }
const statusLabels = { needs_review: 'Needs review', cleared: 'Cleared', no_longer_in_scope: 'No longer in scope' }

function time(value) {
  return value && Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Not rechecked yet'
}

function Comparisons({ comparisons }) {
  return (
    <dl className="grid gap-px overflow-hidden rounded-lg border border-gray-200 bg-gray-200 sm:grid-cols-2">
      {comparisons.map(field => (
        <div key={field.key} className="contents">
          <div className="min-w-0 bg-white px-3 py-3">
            <dt className="text-xs font-medium text-gray-500">HubSpot · {field.label}</dt>
            <dd className={`mt-1 text-sm text-gray-900 ${field.key.toLowerCase().endsWith('id') ? 'break-all' : 'break-words'}`}>{field.hubspot}</dd>
          </div>
          <div className="min-w-0 bg-white px-3 py-3">
            <dt className="text-xs font-medium text-gray-500">Albi · {field.label}</dt>
            <dd className={`mt-1 text-sm text-gray-900 ${field.key.toLowerCase().endsWith('id') ? 'break-all' : 'break-words'}`}>{field.albi}</dd>
          </div>
        </div>
      ))}
    </dl>
  )
}

export default function SampleReviewDetail({ item, busy, recheckPending, onRecheck }) {
  const review = presentSampleReviewItem(item)
  const events = Array.isArray(item?.events) ? item.events : []
  const comparisons = review.candidates.length ? review.candidates : [{ id: null, comparisons: Object.entries(review.source).map(([key, hubspot]) => ({
    key, label: ({ id: 'ID', fullName: 'Full name', firstName: 'First name', lastName: 'Last name', name: 'Name', email: 'Email', phoneNumber: 'Phone',
      mobileNumber: 'Mobile', organizationId: 'Organization ID', organizationName: 'Organization', domain: 'Domain', address1: 'Address', address2: 'Address line 2', city: 'City', state: 'State / region', zipcode: 'Postal code', country: 'Country' })[key],
    hubspot, albi: 'No candidate found',
  })) }]

  return (
    <section className="min-w-0 overflow-hidden rounded-xl border border-gray-200 bg-white" aria-labelledby="sample-review-detail-title">
      <header className="border-b border-gray-200 px-5 py-4">
        <p className="text-xs font-medium text-gray-500">{review.objectType === 'companies' ? 'Organization' : 'Contact'} · {statusLabels[review.status]}</p>
        <h3 id="sample-review-detail-title" className="mt-1 break-words text-lg font-semibold text-gray-900">{review.displayName}</h3>
        <p className="mt-2 break-all text-xs text-gray-600">HubSpot ID: {review.sourceId}</p>
      </header>

      <div className="space-y-6 px-5 py-5">
        <section className={`rounded-lg border px-4 py-3 ${review.status === 'needs_review' ? 'border-amber-200 bg-amber-50' : 'border-green-200 bg-green-50'}`} aria-labelledby="sample-review-guidance-title">
          <h4 id="sample-review-guidance-title" className="text-sm font-semibold text-gray-900">{review.reasonLabel}</h4>
          <p className="mt-1 text-sm leading-6 text-gray-700">{review.guidance}</p>
          <p className="mt-2 text-xs leading-5 text-gray-600">Make corrections directly in HubSpot or Albi, then recheck the current evidence here.</p>
        </section>

        <section aria-labelledby="sample-review-evidence-title">
          <h4 id="sample-review-evidence-title" className="text-sm font-semibold text-gray-900">Identity evidence</h4>
          {review.matchEvidence.length ? (
            <ul className="mt-2 flex flex-wrap gap-2">{review.matchEvidence.map(key => <li key={key} className="rounded-md bg-gray-100 px-2 py-1 text-xs font-medium text-gray-700">{evidenceLabels[key]}</li>)}</ul>
          ) : <p className="mt-1 text-sm text-gray-600">No confirmed matching evidence.</p>}
        </section>

        <section aria-labelledby="sample-review-comparison-title" className="space-y-4">
          <div>
            <h4 id="sample-review-comparison-title" className="text-sm font-semibold text-gray-900">Source and candidate values</h4>
            <p className="mt-1 text-xs leading-5 text-gray-600">Values captured at the sample or last successful recheck. Recheck reads current provider data.</p>
          </div>
          {!review.candidates.length && <p className="rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-600">No Albi candidate was found.</p>}
          {comparisons.map((candidate, index) => (
            <section key={candidate.id ?? index} className="min-w-0 space-y-2" aria-label={`Albi candidate ${index + 1}`}>
              {candidate.id && <h5 className="break-all text-xs font-semibold text-gray-700">Albi candidate {index + 1} · ID: {candidate.id}</h5>}
              <Comparisons comparisons={candidate.comparisons} />
            </section>
          ))}
        </section>

        {review.proposedChanges.length > 0 && (
          <section className="space-y-2" aria-labelledby="sample-review-differences-title">
            <h4 id="sample-review-differences-title" className="text-sm font-semibold text-gray-900">Fields with different values</h4>
            <Comparisons comparisons={review.proposedChanges} />
          </section>
        )}

        <section className="border-t border-gray-200 pt-4" aria-labelledby="sample-review-recheck-title">
          <h4 id="sample-review-recheck-title" className="text-sm font-semibold text-gray-900">Check your corrections</h4>
          <p className="mt-1 text-sm leading-6 text-gray-600">Recheck updates this diagnostic record and its audit history. Corrections are verified by a fresh sample before the full dry run.</p>
          <p className="mt-2 text-xs text-gray-600">Last recheck: {time(review.lastRecheckedAt)}</p>
          {Object.hasOwn(outcomeLabels, item?.recheckOutcome) && <p className="mt-1 text-sm font-medium text-gray-700" role="status">{outcomeLabels[item.recheckOutcome]}</p>}
          <button type="button" onClick={onRecheck} disabled={recheckPending || !review.updatedAt}
            aria-busy={busy} className="mt-3 inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50">
            {busy && <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden="true" />}Recheck this record</button>
          {recheckPending && <p className="mt-2 text-xs text-gray-600" role="status">{busy ? 'Rechecking current provider data…' : 'Another record is being rechecked. You can continue reviewing evidence.'}</p>}
        </section>

        <section className="border-t border-gray-200 pt-4" aria-labelledby="sample-review-history-title">
          <h4 id="sample-review-history-title" className="text-sm font-semibold text-gray-900">Audit history</h4>
          {events.length ? <ol className="mt-3 divide-y divide-gray-100">{events.map((event, index) => (
            <li key={event.id ?? index} className="py-2">
              <p className="text-sm font-medium text-gray-800">{Object.hasOwn(eventLabels, event.eventType) ? eventLabels[event.eventType] : 'Review event'}</p>
              <p className="mt-1 text-xs text-gray-600">{time(event.createdAt)}</p>
              {Object.hasOwn(SAMPLE_REVIEW_GUIDANCE, event.reason) && <p className="mt-1 text-xs text-gray-600">{SAMPLE_REVIEW_GUIDANCE[event.reason].label}</p>}
              {Object.hasOwn(outcomeLabels, event.details?.outcome) && <p className="mt-1 text-xs text-gray-600">{outcomeLabels[event.details.outcome]}</p>}
              {typeof event.actorId === 'string' && <p className="mt-1 break-all text-xs text-gray-600">Reviewer ID: {event.actorId}</p>}
            </li>
          ))}</ol> : <p className="mt-2 text-sm text-gray-600">No audit events recorded.</p>}
        </section>
      </div>
    </section>
  )
}
