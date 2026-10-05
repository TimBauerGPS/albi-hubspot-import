import { createH2AReadHandler } from './h2a-preflight.js'

export const createEstimateHandler = options => createH2AReadHandler(options, { estimate: true })
export const handler = createEstimateHandler()
