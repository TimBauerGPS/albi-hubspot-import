import { pacificStartOfDate } from './time.js'

function nextDate(date) {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10)
}

export function compareBoundary(left, right) {
  const timestampComparison = Date.parse(left.timestamp) - Date.parse(right.timestamp)
  if (!Number.isFinite(timestampComparison)) throw new TypeError('Invalid checkpoint timestamp')
  if (timestampComparison) return Math.sign(timestampComparison)
  const a = String(left.objectId)
  const b = String(right.objectId)
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const x = BigInt(a), y = BigInt(b)
    return x < y ? -1 : x > y ? 1 : 0
  }
  return a < b ? -1 : a > b ? 1 : 0
}

export function advanceCheckpoint({ current = null, items = [] } = {}) {
  let boundary = current
  for (const item of [...items].sort((a, b) => compareBoundary(a, b))) {
    if (boundary && compareBoundary(item, boundary) <= 0) continue
    if (item.resolved !== true) break
    boundary = { timestamp: new Date(item.timestamp).toISOString(), objectId: String(item.objectId) }
  }
  return boundary
}

export function readStartWithOverlap(boundary, startAt, overlapMs = 5 * 60_000) {
  if (!boundary) return startAt
  const shifted = Date.parse(boundary.timestamp) - overlapMs
  return new Date(Math.max(Date.parse(startAt), shifted)).toISOString()
}

export function planBackfillWindows({ startDate, endDate, objectType, existingWindows = [], maxWindows = 366 } = {}) {
  if (!startDate || !endDate || startDate >= endDate) throw new TypeError('Backfill requires ascending Pacific dates')
  const windows = []
  for (let date = startDate; date < endDate; date = nextDate(date)) {
    if (windows.length >= maxWindows) throw new RangeError('Backfill window limit exceeded')
    const startAt = pacificStartOfDate(date)
    const endAt = pacificStartOfDate(nextDate(date))
    const prior = existingWindows.find(row => row.object_type === objectType && row.start_at === startAt && row.end_at === endAt)
      ?? existingWindows.find(row => row.objectType === objectType && row.startAt === startAt && row.endAt === endAt)
    if (prior?.status === 'completed') continue
    windows.push({ ...prior, objectType, startAt, endAt,
      checkpoint: prior?.checkpoint_timestamp && prior?.checkpoint_object_id
        ? { timestamp: prior.checkpoint_timestamp, objectId: prior.checkpoint_object_id } : null })
  }
  return windows
}
