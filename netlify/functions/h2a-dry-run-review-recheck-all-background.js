import { createRecheckAllHandler } from './h2a-dry-run-review-recheck-all.js'

export const handler = createRecheckAllHandler({}, { background: true })
