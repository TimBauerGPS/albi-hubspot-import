const PACIFIC_TIME_ZONE = 'America/Los_Angeles'
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const ISO_TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i

const pacificFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: PACIFIC_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

function pacificParts(date) {
  return Object.fromEntries(pacificFormatter.formatToParts(date)
    .filter(({ type }) => type !== 'literal')
    .map(({ type, value }) => [type, Number(value)]))
}

function parseDate(value) {
  if (!(value instanceof Date) && typeof value !== 'string') throw new Error('Invalid date value')
  if (typeof value === 'string') {
    const dateMatch = ISO_DATE_PATTERN.exec(value)
    const timestampMatch = ISO_TIMESTAMP_PATTERN.exec(value)
    const calendarDate = dateMatch ? value : timestampMatch?.[1]
    if (!calendarDate || !isValidCalendarDate(calendarDate)) {
      throw new Error('Invalid date string: expected a valid ISO-8601 date or timezone-qualified timestamp')
    }
  }

  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error('Invalid date value')
  return date
}

function utcMillis(year, monthIndex, day, hour = 0, minute = 0, second = 0) {
  const date = new Date(0)
  date.setUTCHours(hour, minute, second, 0)
  date.setUTCFullYear(year, monthIndex, day)
  return date.getTime()
}

function isValidCalendarDate(dateString) {
  const match = ISO_DATE_PATTERN.exec(dateString)
  if (!match) return false
  const [, yearText, monthText, dayText] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const check = new Date(utcMillis(year, month - 1, day))
  return check.getUTCFullYear() === year && check.getUTCMonth() + 1 === month && check.getUTCDate() === day
}

export function pacificStartOfDate(dateString) {
  if (typeof dateString !== 'string') throw new Error('Date must use YYYY-MM-DD format')
  const match = ISO_DATE_PATTERN.exec(dateString)
  if (!match) throw new Error('Date must use YYYY-MM-DD format')

  const [, yearText, monthText, dayText] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const targetUtc = utcMillis(year, month - 1, day)
  if (!isValidCalendarDate(dateString)) {
    throw new Error(`Invalid calendar date: ${dateString}`)
  }

  // Iteratively align the candidate instant's Pacific wall clock with midnight.
  let candidate = targetUtc
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const local = pacificParts(new Date(candidate))
    const localAsUtc = utcMillis(local.year, local.month - 1, local.day, local.hour, local.minute, local.second)
    candidate += targetUtc - localAsUtc
  }
  return new Date(candidate).toISOString()
}

export function pacificBusinessDate(date) {
  const parts = pacificParts(parseDate(date))
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

export function isDailyRunDue({ now = new Date(), claimedBusinessDate = null } = {}) {
  const date = parseDate(now)
  const parts = pacificParts(date)
  const businessDate = `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
  return { due: parts.hour >= 2 && claimedBusinessDate !== businessDate, businessDate }
}
