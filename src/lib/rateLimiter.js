/**
 * Processes an array of items in batches with a delay between batches.
 * Designed to stay within HubSpot's rate limit of 100 requests per 10 seconds.
 *
 * @param {Array} items - Items to process
 * @param {number} batchSize - Items per batch (default 10)
 * @param {number} delayMs - Delay between batches in ms (default 1100ms)
 * @param {Function} processFn - async (item, index) => result
 * @param {Function} onProgress - (completed, total) => void
 */
export async function processBatched(items, processFn, {
  batchSize = 10,
  delayMs = 1100,
  onProgress = null,
} = {}) {
  const results = []
  let completed = 0

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize)

    const batchResults = await Promise.all(
      batch.map(async (item, batchIdx) => {
        const result = await processFn(item, i + batchIdx)
        completed++
        onProgress?.(completed, items.length)
        return result
      })
    )

    results.push(...batchResults)

    // Delay between batches (skip after last batch)
    if (i + batchSize < items.length) {
      await sleep(delayMs)
    }
  }

  return results
}

/**
 * Wraps an async function with exponential backoff on 429 responses.
 * The wrapped function should throw an error with message containing "429".
 */
export async function withRetry(fn, maxRetries = 3) {
  let attempt = 0
  while (true) {
    try {
      return await fn()
    } catch (err) {
      const is429 = err.message?.includes('429') || err.message?.includes('rate limit')
      if (is429 && attempt < maxRetries) {
        const wait = Math.pow(2, attempt) * 1000 // 1s, 2s, 4s
        await sleep(wait)
        attempt++
      } else {
        throw err
      }
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
