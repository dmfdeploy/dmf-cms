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

// ── Topology-spawned sources (umbrella #401) ────────────────────────────────

// A topology-spawned source instance (e.g. "mxl-videotest-view-source-a")
// renders as its catalog-declared noun plus its declared source id — "MXL
// Test-Pattern Source · source-a". `noun` comes from the PARENT catalog
// entry's topology_source_noun (dmf-media catalog/topology-params.j1.yaml's
// source_noun field, surfaced by CatalogEntry.topology_source_noun) — read,
// never guessed. Deliberately does NOT fall back through FUNCTION_NOUNS
// above (a separate, hardcoded, already-stale concern this fix must not
// widen): when the topology declares no noun, the fallback is the raw
// function_key — true, not invented.
export function topologySourceLabel(
  noun: string | null | undefined,
  functionKey: string,
  sourceId: string,
): string {
  return `${noun ?? functionKey} · ${sourceId}`
}

// A launch/finalise job name → its action and plain-language target noun.
// `action` is null for internal/spike templates that carry no launch/finalise
// verb at all (e.g. health checks) — those humanise straight through with no
// tense applied.
function jobTarget(name: string): { action: 'deploy' | 'remove' | null; noun: string } {
  const launch = name.match(/^media-launch-(.+)$/)
  if (launch) return { action: 'deploy', noun: functionNoun(launch[1]) }
  const finalise = name.match(/^media-(?:finalise|finalize|teardown)-(.+)$/)
  if (finalise) return { action: 'remove', noun: functionNoun(finalise[1]) }
  return { action: null, noun: humaniseIdentifier(name) }
}

// Raw AWX status → plain-word outcome (Art. 8: outcome in plain words). This
// is the badge's ONLY source of truth for job state.
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

// Verb forms per action, keyed by the exact word jobOutcome() produces for
// the badge (umbrella #432 §F). The row verb and the badge MUST derive from
// the same status read — this table is keyed by jobOutcome()'s own output,
// not a second switch over the raw AWX status, so the two can never
// contradict each other again. This is what closes the defect a live
// operator walk measured: "Removed MXL Test-Pattern Viewer … Running",
// asserting a destructive action as already complete while it was still in
// progress.
const ACTION_VERBS: Record<'deploy' | 'remove', Record<string, string>> = {
  deploy: {
    Running: 'Deploying',
    Succeeded: 'Deployed',
    Failed: 'Failed to deploy',
    Queued: 'Queued to deploy',
    Canceled: 'Canceled deploying',
  },
  remove: {
    Running: 'Removing',
    Succeeded: 'Removed',
    Failed: 'Failed to remove',
    Queued: 'Queued to remove',
    Canceled: 'Canceled removing',
  },
}

// An AWX job/template name + its ALREADY-COMPUTED jobOutcome() word → a
// tense-correct, operator-language "what changed" title.
//   media-launch-mxl-videotestsrc, 'Running'    → "Deploying MXL Test-Pattern Source"
//   media-launch-mxl-videotestsrc, 'Succeeded'  → "Deployed MXL Test-Pattern Source"
//   media-finalise-mxl-videotest-view, 'Running' → "Removing MXL Test-Pattern Viewer"
//   media-finalise-mxl-videotest-view, 'Failed'  → "Failed to remove MXL Test-Pattern Viewer"
//   eso-openbao-health-check, anything           → "Eso openbao health check" (humanised, no verb)
//
// `outcome` is a PARAMETER, not something this function derives from a raw
// status — fix-round 3 (codex gate, umbrella #432 §F): the previous shape
// took the raw AWX status and called jobOutcome() internally, while callers
// separately called jobOutcome() again for the badge. Both calls always
// agreed for jobOutcome's own 5 named outcomes (same pure function, same
// input), but jobOutcome() ALSO returns 'Unknown' (empty status) or an
// open-ended humanised string (a genuinely unrecognised status) — values
// this file's old fallback (`?? ACTION_VERBS[action].Queued`) silently
// discarded in favour of a specific, WRONG, hardcoded tense: a job with no
// readable status rendered "Queued to remove X" as its title while its
// badge — computed independently — rendered "Unknown". Two different claims
// about the same job. The badge is the more honest of the two: it says
// "Unknown" precisely because the status genuinely isn't one of the 5 known
// words, and the title should carry that same honesty, not paper over it
// with an invented tense.
//
// Now there is exactly ONE computation per row (every caller runs
// `jobOutcome(job.status)` once and passes the result to both this function
// AND the badge), and this function's own fallback echoes that SAME value
// instead of guessing — so no outcome, known or not, can produce disagreeing
// text: the mapped 5 always agree because it's the same string driving both;
// the unmapped case can't disagree either, because the same string is
// literally what both sites render. The raw job name is kept by callers as
// demoted expert detail.
export function describeJob(name: string, outcome: string): string {
  if (!name) return 'Change'
  const { action, noun } = jobTarget(name)
  if (!action) return noun
  const verb = ACTION_VERBS[action][outcome]
  return verb ? `${verb} ${noun}` : `${outcome} — ${noun}`
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
