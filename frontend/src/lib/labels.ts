// Operator-language label helpers (UX Constitution Art. 3 / 8): the default
// level speaks the operator's language and hides system/infrastructure jargon
// (raw alert rule names, AWX job-template ids, key=value label blobs). These
// pure functions map the raw machine strings to readable titles; the raw
// forms are demoted to an expert "details" affordance by the callers, never
// destroyed. Data-driven maps for the known facility conditions/functions,
// with a humanising fallback for anything not yet mapped.

// ── Alerts ────────────────────────────────────────────────────────────────

// Known alert rules → plain operator-language titles. Extend as the #166
// suite grows; unmapped names fall through to humaniseIdentifier().
const ALERT_TITLES: Record<string, string> = {
  ContainerCPUThrottling: 'Container CPU throttling',
  PodCrashLooping: 'Pods restarting repeatedly',
  KubePodCrashLooping: 'Pods restarting repeatedly',
  HostMemoryPressure: 'Host memory pressure',
  NodeMemoryPressure: 'Node memory pressure',
  HostHighCpuLoad: 'Host CPU load high',
  NodeDown: 'Node down',
  KubeNodeNotReady: 'Node not ready',
  KubeletDown: 'Kubelet down',
  TargetDown: 'Monitoring target down',
  NodeFilesystemAlmostOutOfSpace: 'Disk almost full',
}

export function humanizeAlertName(name: string): string {
  if (!name) return 'Condition'
  return ALERT_TITLES[name] ?? humaniseIdentifier(name)
}

// "namespace=mxl pod=a" → "mxl · pod a": keep the disambiguating VALUES
// (Art. 3 removes the key=value jargon) so two rows of the same condition
// still read distinctly at default; the raw key=value string stays available
// as expert detail via the caller.
export function humanizeContext(context: string): string {
  if (!context) return ''
  return context
    .split(/\s+/)
    .map((pair) => {
      const eq = pair.indexOf('=')
      if (eq === -1) return pair
      const key = pair.slice(0, eq)
      const value = pair.slice(eq + 1)
      // Prefix the value with a shortened key only when the key adds meaning
      // beyond the value itself (pod=a → "pod a"; namespace=mxl → "mxl").
      return key === 'namespace' || key === 'instance' ? value : `${key} ${value}`
    })
    .filter(Boolean)
    .join(' · ')
}

// ── AWX jobs / catalog launchers ────────────────────────────────────────────

// Catalog function key → plain noun. The launcher template names encode these
// (media-launch-<key> / media-finalise-<key>).
const FUNCTION_NOUNS: Record<string, string> = {
  'mxl-videotestsrc': 'MXL Test-Pattern Source',
  'mxl-videotest-view': 'MXL Test-Pattern Viewer',
  'mxl-hello': 'MXL Hello',
  'nmos-cpp': 'NMOS Registry',
  'nmos-crosspoint': 'NMOS Crosspoint',
}

function functionNoun(key: string): string {
  return FUNCTION_NOUNS[key] ?? humaniseIdentifier(key)
}

// An AWX job/template name → an operator-language "what changed" title.
//   media-launch-mxl-videotestsrc   → "Deployed MXL Test-Pattern Source"
//   media-finalise-mxl-videotest-view → "Removed MXL Test-Pattern Viewer"
//   eso-openbao-health-check         → "Eso openbao health check" (humanised)
// The raw name is kept by callers as demoted expert detail.
export function describeJob(name: string): string {
  if (!name) return 'Change'
  const launch = name.match(/^media-launch-(.+)$/)
  if (launch) return `Deployed ${functionNoun(launch[1])}`
  const finalise = name.match(/^media-(?:finalise|finalize|teardown)-(.+)$/)
  if (finalise) return `Removed ${functionNoun(finalise[1])}`
  return humaniseIdentifier(name)
}

// Raw AWX status → plain-word outcome (Art. 8: outcome in plain words).
const JOB_OUTCOMES: Record<string, string> = {
  successful: 'Succeeded',
  failed: 'Failed',
  error: 'Failed',
  running: 'Running',
  pending: 'Queued',
  waiting: 'Queued',
  new: 'Queued',
  canceled: 'Canceled',
  cancelled: 'Canceled',
}

export function jobOutcome(status: string): string {
  if (!status) return 'Unknown'
  return JOB_OUTCOMES[status] ?? humaniseIdentifier(status)
}

// ── Generic humaniser ───────────────────────────────────────────────────────

// Turn a machine identifier into a readable sentence-case phrase:
// splits CamelCase, kebab-case, and snake_case; lowercases the tail; keeps
// short all-caps tokens (MXL, NMOS, CPU) upper-cased.
const KEEP_UPPER = new Set(['mxl', 'nmos', 'cpu', 'awx', 'eso', 'sd', 'ip', 'dns', 'api'])

export function humaniseIdentifier(raw: string): string {
  const words = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (words.length === 0) return raw
  return words
    .map((w, i) => {
      const lower = w.toLowerCase()
      if (KEEP_UPPER.has(lower)) return w.toUpperCase()
      if (i === 0) return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
      return lower
    })
    .join(' ')
}
