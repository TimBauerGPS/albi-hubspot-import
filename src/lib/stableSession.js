// supabase-js re-emits SIGNED_IN with a fresh session object whenever the tab regains focus, and every
// page keys its fetch effects on that object, so returning to the tab re-ran every request. This holder keeps
// one object per signed-in user; its fields always read the newest token, so refreshes stay transparent.
export function createStableSessionHolder() {
  let latest = null
  let stable = null
  let stableUserId = null
  const view = () => Object.defineProperties({}, {
    access_token: { enumerable: true, get: () => latest?.access_token },
    refresh_token: { enumerable: true, get: () => latest?.refresh_token },
    expires_at: { enumerable: true, get: () => latest?.expires_at },
    token_type: { enumerable: true, get: () => latest?.token_type },
    user: { enumerable: true, get: () => latest?.user },
  })
  return {
    update(next) {
      latest = next ?? null
      if (!latest) { stable = null; stableUserId = null; return null }
      const userId = latest.user?.id ?? null
      if (!stable || stableUserId !== userId) { stable = view(); stableUserId = userId }
      return stable
    },
  }
}
