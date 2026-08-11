// Console role ladder (umbrella dmfdeploy/dmfdeploy#378). A small, dependency-
// free comparison — deliberately not importing UserIdentity from api/types,
// matching lib/workloadLifecycle.ts's own "pure over the console's existing
// truth" discipline (that module redeclares WorkloadLifecycle rather than
// importing MediaWorkload['lifecycle'] for the same reason).
//
// This is affordance control only. The backend's own _require_min_role is
// the actual authorization boundary; this ladder exists so the console can
// decide whether to OFFER a control the backend would accept, never to grant
// or withhold access itself.

export type ConsoleRole = 'viewer' | 'operator' | 'engineer' | 'admin'

const ROLE_RANK: Record<ConsoleRole, number> = {
  viewer: 0,
  operator: 1,
  engineer: 2,
  admin: 3,
}

/**
 * Whether an EFFECTIVE role meets a floor. "Effective" matters: callers must
 * pass the auth store's `role` field (already view-as-resolved server-side —
 * an admin viewing as viewer receives `role: 'viewer'` back from /api/me),
 * never `real_role`, or a view-as session would see controls its acting role
 * cannot use.
 *
 * Fail-closed: an absent/unrecognised role never passes, so a not-yet-loaded
 * user (`useCurrentUser()` still pending) withholds rather than admits.
 */
export function roleAtLeast(role: ConsoleRole | undefined | null, min: ConsoleRole): boolean {
  if (!role) return false
  return ROLE_RANK[role] >= ROLE_RANK[min]
}
