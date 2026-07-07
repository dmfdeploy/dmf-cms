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
