const DEFAULT_ALERT_TO = 'tbauer@alliedrestoration.com'
const DEFAULT_ALERT_FROM = 'HubSpot Importer <onboarding@resend.dev>'
const RESEND_API_URL = 'https://api.resend.com/emails'

function isEmailConfigured() {
  return Boolean(process.env.RESEND_API_KEY)
}

function formatJson(value) {
  if (!value) return ''
  return JSON.stringify(value, null, 2)
}

export async function sendImportAlert({ subject, text, html }) {
  if (!isEmailConfigured()) {
    console.warn('[import-alert] RESEND_API_KEY not configured; skipping email alert.')
    return { sent: false, skipped: 'missing_resend_api_key' }
  }

  const to = process.env.IMPORT_ALERT_TO_EMAIL || DEFAULT_ALERT_TO
  const from = process.env.IMPORT_ALERT_FROM_EMAIL || DEFAULT_ALERT_FROM

  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      text,
      html,
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Resend ${res.status}: ${body}`)
  }

  return { sent: true }
}

export async function notifyGoogleSheetImportError({
  importId,
  userId,
  companyName,
  sheetUrl,
  message,
  details,
}) {
  const subject = `HubSpot Importer error${importId ? ` (${importId})` : ''}`
  const summary = [
    'A Google Sheet import failed.',
    '',
    importId ? `Import ID: ${importId}` : null,
    userId ? `User ID: ${userId}` : null,
    companyName ? `Company: ${companyName}` : null,
    sheetUrl ? `Sheet URL: ${sheetUrl}` : null,
    `Error: ${message}`,
    details ? '' : null,
    details ? formatJson(details) : null,
  ].filter(Boolean).join('\n')

  const htmlDetails = details
    ? `<pre>${formatJson(details)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')}</pre>`
    : ''

  return sendImportAlert({
    subject,
    text: summary,
    html: `
      <h2>Google Sheet import failed</h2>
      <p><strong>Error:</strong> ${message}</p>
      <ul>
        ${importId ? `<li><strong>Import ID:</strong> ${importId}</li>` : ''}
        ${userId ? `<li><strong>User ID:</strong> ${userId}</li>` : ''}
        ${companyName ? `<li><strong>Company:</strong> ${companyName}</li>` : ''}
        ${sheetUrl ? `<li><strong>Sheet URL:</strong> ${sheetUrl}</li>` : ''}
      </ul>
      ${htmlDetails}
    `,
  })
}

export async function notifyStaleGoogleSheetImports(rows) {
  if (!rows?.length) return { sent: false, skipped: 'no_rows' }

  const subject = `HubSpot Importer cleaned ${rows.length} stuck Google Sheet import${rows.length === 1 ? '' : 's'}`
  const text = [
    `Marked ${rows.length} stale Google Sheet import${rows.length === 1 ? '' : 's'} as error.`,
    '',
    ...rows.map(row => [
      `Import ID: ${row.id}`,
      `Imported At: ${row.imported_at}`,
      `User ID: ${row.user_id}`,
      `Filename: ${row.filename}`,
    ].join('\n')),
  ].join('\n\n')

  const html = `
    <h2>Stale Google Sheet imports marked as error</h2>
    <p>Marked ${rows.length} stale Google Sheet import${rows.length === 1 ? '' : 's'} as <code>error</code>.</p>
    <ul>
      ${rows.map(row => `
        <li>
          <strong>${row.id}</strong><br />
          Imported at: ${row.imported_at}<br />
          User ID: ${row.user_id}<br />
          Filename: ${row.filename}
        </li>
      `).join('')}
    </ul>
  `

  return sendImportAlert({ subject, text, html })
}
