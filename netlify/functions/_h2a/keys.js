const DELIVERY_KEY_PARTS = [
  'companyId',
  'portalId',
  'objectType',
  'activityId',
  'albiTargetType',
  'albiTargetId',
]

export function makeDeliveryKey(input) {
  const parts = DELIVERY_KEY_PARTS.map((name) => input?.[name])
  if (parts.some((part) => typeof part !== 'string' || part.trim() === '')) {
    throw new Error('Delivery key is missing an identity component')
  }
  return parts.join(':')
}

export function makeSourceMarker({ objectType, activityId } = {}) {
  if (typeof objectType !== 'string' || objectType.trim() === '' ||
      typeof activityId !== 'string' || activityId.trim() === '') {
    throw new Error('Source marker requires an activity type and identifier')
  }
  return `Source: HubSpot ${objectType} ${activityId}`
}
