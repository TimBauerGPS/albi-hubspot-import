import assert from 'node:assert/strict'
import {
  computeGoogleSheetFingerprint,
  extractGoogleSheetFingerprint,
  formatGoogleSheetImportFilename,
} from '../netlify/functions/google-sheet-import.js'

const sheet = {
  spreadsheetTitle: 'Allied Import',
  sheetTitle: 'albidata',
  values: [
    ['Name', 'Customer', 'Status', 'Estimated Revenue'],
    ['25-1000-WTR', 'Jane Customer', 'Closed', '$1,000.00'],
  ],
  hyperlinks: ['', 'https://example.com/jobs/25-1000-WTR'],
}

const sameSheet = {
  ...sheet,
  values: sheet.values.map(row => [...row]),
  hyperlinks: [...sheet.hyperlinks],
}

const changedSheet = {
  ...sheet,
  values: [
    ['Name', 'Customer', 'Status', 'Estimated Revenue'],
    ['25-1000-WTR', 'Jane Customer', 'Closed', '$1,001.00'],
  ],
}

const fingerprint = computeGoogleSheetFingerprint(sheet)

assert.equal(
  fingerprint,
  computeGoogleSheetFingerprint(sameSheet),
  'same sheet payload should produce the same fingerprint'
)

assert.notEqual(
  fingerprint,
  computeGoogleSheetFingerprint(changedSheet),
  'changed sheet values should produce a different fingerprint'
)

const filename = formatGoogleSheetImportFilename(sheet, fingerprint)
assert.equal(
  extractGoogleSheetFingerprint(filename),
  fingerprint,
  'fingerprint should round-trip through the import filename'
)

assert.equal(
  extractGoogleSheetFingerprint('Google Sheet: Allied Import / albidata'),
  null,
  'legacy Google Sheet import filenames should not look fingerprinted'
)
