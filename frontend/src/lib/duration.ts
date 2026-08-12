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
