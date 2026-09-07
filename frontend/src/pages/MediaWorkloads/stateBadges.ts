// Shared desired-vs-observed badge palettes (ADR-0037 / hard gate 5). The table
// and the tile grid render the SAME facts with the SAME colours: requested is
// INTENT (never shown as running), observed is probe-proven runtime truth.

/** Own-property lookup for state→value maps: an untrusted state such as
 *  "constructor" or "__proto__" must fall back to `unknown`, never resolve an
 *  inherited Object property (review finding on PR #144). */
export function lookupState<T>(map: Record<string, T> & { unknown: T }, state: string | null | undefined): T {
  return typeof state === 'string' && Object.prototype.hasOwnProperty.call(map, state) ? map[state] : map.unknown
}

// The `& { unknown: string }` intersection (not a bare Record<string, string>)
// is what lets lookupState's signature guarantee a fallback exists at compile
// time — dropping it would let a map missing `unknown` type-check and defeat
// the guard silently.
export const requestedBadge: Record<string, string> & { unknown: string } = {
  active: 'bg-sky-900/30 text-sky-300',
  bootstrapped: 'bg-gray-900/30 text-gray-300',
  unknown: 'bg-gray-900/30 text-gray-400',
}

export const observedBadge: Record<string, string> & { unknown: string } = {
  running: 'bg-green-900/30 text-green-300',
  failing: 'bg-red-900/30 text-red-300',
  unknown: 'bg-gray-900/30 text-gray-400',
}

export const REQUESTED_TITLE =
  'Requested state — intent recorded in the facility source of truth, not proof of running'
export const OBSERVED_TITLE = 'Observed state — proven by live monitoring probes'

/**
 * Operator-facing label for an instance's REQUESTED state — the NetBox intent
 * value, never observed runtime (ADR-0037: intent is never rendered as
 * running). Vocabulary is borrowed, not invented (dmfdeploy/dmfdeploy#556):
 *
 *   bootstrapped → "planned"        — the workload-level resting grammar in
 *                                     lib/workloadFlow.ts (RESTING_GRAMMAR:
 *                                     a workload at `provision` reads
 *                                     "planned"), so a member and its
 *                                     workload describe the same fact in
 *                                     the same word.
 *   active       → "cleared to run" — the phrase lib/workloadLifecycle.ts
 *                                     already uses for the active intent
 *                                     ("nothing has been cleared to run
 *                                     yet").
 *   anything else → "unknown"       — the backend declined to place it and
 *                                     this layer does not improve on that.
 *
 * Callers look up with `lookupState(requestedLabel, state)` — an own-property
 * check, not `requestedLabel[state] ?? requestedLabel.unknown` (that shape
 * resolves inherited Object properties like `constructor` instead of falling
 * back; see the review finding on PR #144) — the same lookup requestedBadge's
 * colour lookup and the Provision icon map now use too.
 */
export const requestedLabel: Record<string, string> & { unknown: string } = {
  bootstrapped: 'planned',
  active: 'cleared to run',
  unknown: 'unknown',
}
