// Shared desired-vs-observed badge palettes (ADR-0037 / hard gate 5). The table
// and the tile grid render the SAME facts with the SAME colours: requested is
// INTENT (never shown as running), observed is probe-proven runtime truth.

export const requestedBadge: Record<string, string> = {
  active: 'bg-sky-900/30 text-sky-300',
  bootstrapped: 'bg-gray-900/30 text-gray-300',
  unknown: 'bg-gray-900/30 text-gray-400',
}

export const observedBadge: Record<string, string> = {
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
 * Callers fall back with `requestedLabel[state] ?? requestedLabel.unknown`,
 * the same shape requestedBadge's colour lookup already uses.
 */
export const requestedLabel: Record<string, string> = {
  bootstrapped: 'planned',
  active: 'cleared to run',
  unknown: 'unknown',
}
