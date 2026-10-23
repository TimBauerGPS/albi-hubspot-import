import { createOutboxHandler } from './h2a-review-outbox.js'

export const handler = createOutboxHandler({}, { background: true })
