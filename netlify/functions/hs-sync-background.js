/**
 * POST /.netlify/functions/hs-sync-background
 *
 * Netlify Background Function — returns 202 immediately; runs for up to 15 minutes.
 * Used in production. In local dev (netlify functions:serve), background functions
 * return 202 without executing the handler, so the client calls hs-sync instead.
 *
 * Re-exports the handler from hs-sync.js so both endpoints share a single implementation.
 */

export { handler } from './hs-sync.js'
