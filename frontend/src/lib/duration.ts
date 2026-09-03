// Zabbix Problems model: how long has this problem been active (operator
// preference — duration visible per row, not just an absolute timestamp).
// Pure and testable: nowMs is passed in rather than read from Date.now()
// inside the formatter, so callers (and their tests) control "now" exactly.
export function formatDuration(fromIso: string, nowMs: number): string | null {
  if (!fromIso) return null
  const fromMs = Date.parse(fromIso)
  if (Number.isNaN(fromMs)) return null
  const diffMs = nowMs - fromMs
  if (diffMs < 0) return null // future active_at — never render garbage

  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`

  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

// dmfdeploy/dmfdeploy#496: a retention window is a SECOND COUNT, not a
// from-timestamp — same bucket boundaries as formatDuration above (m/h/d),
// reused here rather than re-derived, so "7 days" and "168h ago" can never
// disagree about where an hour rolls into a day. Deliberately never called
// with an invented number: the caller either has a real derived window or
// doesn't render a duration at all (plan condition 2 — no hardcoded
// fallback stands in for a window that failed to derive).
export function formatSecondsCeiling(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return 'an unknown time'

  const minutes = Math.floor(totalSeconds / 60)
  if (minutes < 1) return 'less than a minute'
  if (minutes < 60) return `${minutes}m`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`

  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}
