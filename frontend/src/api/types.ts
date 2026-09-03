export interface UserIdentity {
  subject: string
  display_name: string
  email: string
  role: 'viewer' | 'operator' | 'engineer' | 'admin'
  real_role: 'viewer' | 'operator' | 'engineer' | 'admin'
  view_as_active: boolean
  groups: string[]
  awx_configured: boolean
  authentik_configured: boolean
}

export interface AppLink {
  name: string
  url: string
}

export interface App {
  key: string
  display_name: string
  lane: 'public' | 'private'
  summary: string
  links: AppLink[]
}

export interface AppContract {
  product_name: string
  facility_name: string
  catalog_source: string
  apps: App[]
}

export interface WorkflowTemplate {
  id: number
  name: string
  description: string
  type: string
}

export interface WorkflowsListResponse {
  templates: WorkflowTemplate[]
}

export interface WorkflowLaunchResponse {
  job_id: number
  status: string
  // C5: echoed by the operator-gated write (#185 WP-E), correlates to the audit line.
  request_id?: string
}

// Async operation tracking (WS5 scale-to-zero). umbrella #347: widened past
// the original waking/launching/launched/error set — those four are all a
// plain "launch" operation ever reaches, but deploy/teardown/rollback/
// finalise-purge (#202 WP2's watched actions) continue past LAUNCHED
// through the job-terminal states below; a purge consumer needs to observe
// those to know when the operation is ACTUALLY done, not just dispatched.
//
// PR #127 review fix (umbrella #499): OperationState used to be a bare
// union with every operator-facing label table it feeds (JobProgress.tsx's
// OPERATION_LABEL/OPERATION_CLASS) typed as the unconstrained
// `Record<string, string>` — TypeScript cannot see a missing key in that
// shape, which is exactly how `running` shipped with no label (an operator
// watching a purge in progress saw a blank status line). OPERATION_STATES
// is now the single source of truth: the array literal below defines the
// runtime value set AND, via `typeof ... [number]`, the OperationState type
// itself, so any table declared `Record<OperationState, string>` gets a
// compiler error the moment a state here has no entry there — and any test
// that iterates OPERATION_STATES (rather than hand-copying the list) stays
// correct automatically when this array grows.
export const OPERATION_STATES = [
  'waking',
  'launching',
  'launched',
  'running',
  'run_complete',
  'run_failed',
  'failed_rollback_required',
  'rollback_incomplete',
  'run_status_unknown',
  'error',
] as const

export type OperationState = (typeof OPERATION_STATES)[number]

export interface Operation {
  operation_id: string
  action: 'launch' | 'deploy' | 'teardown' | 'finalise-purge'
  target: string
  state: OperationState
  job_id: number | null
  error: string | null
  created_at: string
  updated_at: string
  // Provenance-only launcher outcome token (umbrella #347: e.g. a
  // finalise-purge job's raw DMF_L3_PURGE_OUTCOME token) — present on the
  // watched-action states, absent/null otherwise.
  l3_outcome?: string | null
  // umbrella #347: ISO timestamp of the CONFIRMED-absent post-job source
  // read (Console Constitution Art. 1) — set only on a finalise-purge op
  // that reached run_complete via that confirmation, never derived from
  // job status alone.
  purge_verified_at?: string | null
  // Spread onto the 202/200 async write response by the operator-gated write
  // (#185 WP-E); absent on later poll reads of the operation itself.
  request_id?: string
  // dmfdeploy/dmfdeploy#390 (Phase 1, "the throbber"): latest raw
  // DMF_L3_MILESTONE token observed for this op — a best-effort,
  // side-channel progress signal, set only for deploy/teardown ops while
  // non-terminal (see dmf-cms main.py's _L3_MILESTONE_ORDER). null means
  // "no milestone observed yet", never a value to fake — AutomationInProgress
  // Notice's own degrade path (elapsed+phase, never a blank throbber) is
  // what handles that, not this field.
  progress_step?: string | null
}

// Union type: sync response (200) or async operation (202)
export type WorkflowLaunchResult = WorkflowLaunchResponse | Operation

export interface WorkflowJobStatus {
  job_id: number
  status: 'new' | 'pending' | 'waiting' | 'running' | 'successful' | 'failed' | 'canceled' | 'error'
  name: string
  url: string
  elapsed: number
  failed: boolean
}

export interface PasskeyInvitationResponse {
  enrollment_url: string
  expires: string
}

export interface IntegrationStatus {
  connected: boolean
  latency_ms?: number
  user_count?: number
  template_count?: number
  note?: string
  error?: string
}

export interface AdminHealthResponse {
  authentik: IntegrationStatus
  awx: IntegrationStatus
  netbox: IntegrationStatus
  prometheus: IntegrationStatus
}

export interface AdminUser {
  username: string
  display_name: string
  email: string
  role: 'viewer' | 'operator' | 'engineer' | 'admin'
  last_login: string | null
  is_active: boolean
  user_type: 'human' | 'machine'
  is_break_glass: boolean
}

export interface AdminUsersResponse {
  users: AdminUser[]
}

export interface AdminJob {
  id: number
  name: string
  status: string
  started: string | null
  finished: string | null
  elapsed: number
  failed: boolean
}

export interface AdminJobsResponse {
  jobs: AdminJob[]
  // Fail-soft state token from /api/changes/jobs — "" when AWX answered.
  // Optional so older payloads (and fixtures) classify as ok.
  reason?: '' | 'awx-unconfigured' | 'awx-not-running' | 'awx-unreachable'
}

// ------------------------------------------------------------------
// Monitoring
// ------------------------------------------------------------------

// Workspace "are we OK?" core (#174 WP2) — flattened, fail-soft contract.
export interface WorkspaceAlert {
  // Stable identity over the full label set (GATE-22): one rule can fire
  // per namespace/pod with a shared or blank instance.
  id: string
  name: string
  state: string
  severity: string
  instance: string
  context: string
  summary: string
  description: string
  runbook_url: string
  active_at: string
}

export interface WorkspaceHealth {
  configured: boolean
  reachable: boolean
  reason: string
  watchdog_firing: boolean
  alerts: WorkspaceAlert[]
}

export interface MonitoringAlert {
  name: string
  state: 'firing' | 'pending'
  severity?: string
  summary?: string
  description?: string
  activeAt?: string
}

export interface AlertsResponse {
  alerts: MonitoringAlert[]
}

export interface PrometheusTarget {
  job: string
  instance: string
  health: 'up' | 'down' | 'unknown'
  lastScrape?: string
  lastError?: string
}

export interface TargetsResponse {
  targets: PrometheusTarget[]
}

export interface MonitoringMetrics {
  cpu_percent: number
  memory_percent: number
  pod_restarts_24h: number
  pvc_usage_percent: number
}

// ------------------------------------------------------------------
// Facility (Physical Infrastructure)
// ------------------------------------------------------------------

// Every one of these is nullable in NetBox and the endpoint passes the null
// straight through (GATE-S1-RV P2: the type used to promise non-null and the
// endpoint disagreed — which is how `.get("name")` on a null `site` became a
// live 500).
export interface NetBoxDevice {
  id: number | null
  name: string | null
  type: string | null
  site: string | null
  status: string | null
  ip: string | null
  role: string | null
}

// S1 (#285): fail-soft — every facility response carries `reason` (""
// means live data; a non-empty token names why a section is degraded).
// Reads AND row shaping both sit inside the endpoint's guard, so neither an
// unreachable source nor a malformed row can produce a 500 (Arts. 1+8).
// The two cases differ, and the tests pin the difference: a NULLABLE field
// passes straight through with `reason` still "" (the row is readable, some
// values are simply absent), whereas a row that cannot be read at all is
// dropped and sets `netbox-rows-unparseable`, so the payload never implies a
// completeness it lacks. Auth failures are still 401.
export interface FacilitySummary {
  reason: string
  site_count: number
  device_count: number
  sites: Array<{
    name: string
    // Drives the Facilities list page's link to /facilities/<slug>. Absent
    // (null) only if NetBox itself omitted a slug for the site record.
    slug: string | null
    device_count: number
  }>
}

export interface FacilityDevicesResponse {
  reason: string
  devices: NetBoxDevice[]
}

// ------------------------------------------------------------------
// Facility Detail (S1, #285) — GET /api/facility/{site}/detail
// ------------------------------------------------------------------

export interface FacilityNode {
  name: string
  kubelet_version: string
  // null => neither node_uname_info nor the NetBox site's dmf_architecture
  // had anything for this node (per-node degrade, not a page failure).
  arch: string | null
  // Which source arch came from — 'netbox' is a facility-level declaration
  // rather than a measurement of this node, so the page says so.
  arch_source: 'node' | 'netbox' | null
}

export interface FacilityNodesSection {
  reason: string
  items: FacilityNode[]
}

export interface FacilityPlatformService {
  key: string
  display_name: string
  // The namespace that was searched for this service's containers. null =>
  // the contract declares no cluster location, so nothing was searched —
  // which is not the same as the service being absent.
  namespace: string | null
  // The image repositories that identify this service's own containers, so
  // a neighbour sharing the namespace is never reported as its version.
  image_repositories: string[]
  // Access route when the cluster has an ingress for it. Absence of a URL is
  // never evidence the service isn't running (AWX runs without one).
  url: string | null
  // As-deployed container images. Empty => nothing in `namespace` matched.
  images: string[]
}

export interface FacilityPlatformServicesSection {
  reason: string
  items: FacilityPlatformService[]
}

export interface FacilityVolume {
  namespace: string
  name: string
  storageclass: string | null
  // null => the usage-by-request series had no matching row — never a
  // fabricated 0 (Constitution Art. 1).
  requested_bytes: number | null
}

export interface FacilityStorageSection {
  reason: string
  items: FacilityVolume[]
}

// Scheduler-truth capacity (reused from capacity.py's own arithmetic).
// Field names are deliberately "allocatable" / "requests_committed" —
// never "used"/"free": requests-committed is a scheduler bound, not a
// measurement of actual utilisation.
export interface FacilityCapacity {
  reason: string
  node_name: string | null
  allocatable_cpu_m: number | null
  allocatable_mem_b: number | null
  requests_committed_cpu_m: number | null
  requests_committed_mem_b: number | null
  pod_count: number | null
}

export interface FacilitySiteIdentity {
  slug: string | null
  name: string | null
  // dmf-infra's site-level dmf_architecture custom field (arm64|amd64), the
  // fallback source behind FacilityNode.arch.
  architecture: string | null
  reason: string
}

export interface FacilityDetailResponse {
  requested_site: string
  prometheus_configured: boolean
  netbox_configured: boolean
  site: FacilitySiteIdentity
  nodes: FacilityNodesSection
  platform_services: FacilityPlatformServicesSection
  storage: FacilityStorageSection
  capacity: FacilityCapacity
}

// ------------------------------------------------------------------
// Changes (Audit Trail)
// ------------------------------------------------------------------

export interface CommitEntry {
  sha_short: string
  message: string
  author: string
  date: string
  url: string
}

export interface RepoCommits {
  name: string
  commits: CommitEntry[]
}

export interface ChangesCommitsResponse {
  repos: RepoCommits[]
  // Fail-soft reason token: "" means Forgejo answered and `repos` is
  // authoritative; a non-empty token names why it could not or could only
  // partially (see lib/changesState.ts's classifier). REQUIRED, not
  // optional — every backend path (api_changes_commits) always sets it.
  // classifyForgejo fails CLOSED (non-authoritative) on anything other than
  // an exact `""`, including this field being absent at runtime despite the
  // type saying otherwise (apiCall's generic return type is a compile-time
  // cast, not runtime validation) — so an omitted `reason` is a bug to fix
  // at the source, never a case to design comfortably around here.
  reason: '' | 'forgejo-unconfigured' | 'forgejo-unreachable' | 'forgejo-partial'
}

export interface PullEntry {
  repo: string
  number: number
  title: string
  state: string
  author: string
  created: string
  url: string
}

export interface ChangesPullsResponse {
  pulls: PullEntry[]
  // Same fail-soft contract as ChangesCommitsResponse.reason — REQUIRED,
  // see that field's comment for why.
  reason: '' | 'forgejo-unconfigured' | 'forgejo-unreachable' | 'forgejo-partial'
}

// ------------------------------------------------------------------
// Audit events (dmfdeploy/dmfdeploy#496) — the durable, server-side
// Activity History lane over Loki. See lib/auditEventsState.ts for the
// fail-soft classifier this feeds.
// ------------------------------------------------------------------

export interface AuditEventOutcome {
  // 'unknown' (codex R496-C P1-2): the record's outcome could not be read
  // (e.g. a truncated/corrupted Loki line) — a THIRD case, never folded
  // into 'failed'. "Not proven in flight" is not "the action failed";
  // rendering a lost outcome as a definite failure would be this lane
  // claiming knowledge it does not have.
  state: 'in_flight' | 'succeeded' | 'failed' | 'unknown'
  // Raw outcome token off the audit record — expert-level detail ONLY.
  // Never render this directly at default (plan §4.5 / AC 2a); use
  // headline/meaning/next_step below instead. Always "" when
  // state === 'unknown' (that IS the lost field).
  detail: string
  // Present when state === 'failed' or 'unknown' — plain-language copy,
  // safe at default level.
  headline?: string
  meaning?: string
  next_step?: string
}

export interface AuditEvent {
  request_id: string
  class: 'deploy' | 'teardown' | 'switch-source' | 'auto-rollback'
  action: string
  target: string
  // null when the action's own record never carries a workload, OR (the
  // ordinary auto-rollback case) the parent record does but is unresolved
  // — the row still renders; only the label is missing (plan AC 3/5b).
  workload: string | null
  actor: string
  role: string
  reason: string
  at: string
  // lkirc (dmfdeploy/dmf-cms#140): request_id is NOT a per-row identity
  // — one request can legitimately produce multiple rows (an L3
  // preflight's capacity-skipped/capacity-override line shares its
  // request_id with that same request's later dispatched line). This is
  // Loki's own raw, unrounded nanosecond timestamp string for THIS log
  // line specifically — the real per-row identity, used ONLY for the
  // React key (HistoryLane), never for display (use `at` for that).
  at_ns: string
  outcome: AuditEventOutcome
}

export interface AuditEventsExcludedClass {
  class: string
  // The two reasons are NEVER interchangeable (plan §4.3/AC 5): 'access'
  // means rendering it would widen access beyond its own live surface;
  // 'scope' means this lane cannot render it meaningfully yet, and nothing
  // about it is a security decision.
  reason: 'access' | 'scope'
}

export interface AuditEventsWindow {
  known: boolean
  seconds: number | null
  // "" when known; else why not — see lib/auditEventsState.ts. Never a
  // reason to guess a number.
  reason: string
}

export interface AuditEventsResponse {
  // Fail-soft reason token, same shape as ChangesCommitsResponse.reason:
  // "" means Loki answered and `events` is authoritative (an empty list
  // genuinely means no matching rows in the window). REQUIRED.
  reason: '' | 'loki-unconfigured' | 'loki-unreachable'
  window: AuditEventsWindow
  // true when this read is NOT confirmed exhaustive — the retention window
  // could not be derived (the query ran against a technical ceiling
  // instead of a real bound) or the raw result count hit the backend's
  // own limit. A bound that binds must be disclosed, not applied silently
  // behind what would otherwise read as an ordinary, complete history.
  capped: boolean
  excluded: AuditEventsExcludedClass[]
  events: AuditEvent[]
}

// ------------------------------------------------------------------
// Admin (Groups)
// ------------------------------------------------------------------

export interface AdminGroup {
  pk: string
  name: string
  user_count: number
  users: Array<{
    username: string
    display_name: string
  }>
}

export interface AdminGroupsResponse {
  groups: AdminGroup[]
}

// ------------------------------------------------------------------
// Catalog (Media Functions)
// ------------------------------------------------------------------

export interface CatalogEntry {
  key: string
  display_name: string
  summary: string
  ebu_layer: number | null
  ebu_vertical: string | null
  ebu_media_function_type: string | null
  ebu_lifecycle_owner: string | null
  lifecycle: 'bootstrapped' | 'active' | 'unknown' | 'error'
  provision_image: string | null
  provision_netbox_service: string | null
  configure_awx_job_template: string | null
  finalise_awx_job_template: string | null
  dependencies: string[]
  // Link-out to the function's own console (e.g. nmos-crosspoint), shown when active.
  ingress_url: string | null
  // umbrella #285 S3: the entry's declared provision.resources.requests,
  // parsed server-side by capacity.py's own catalog-quantity parsers
  // (main.py's _entry_to_dict). Optional (rather than required-nullable) so
  // every pre-existing fixture across the test suite that builds a
  // CatalogEntry literal without this field stays valid — a field this new
  // page reads defensively should not force an edit onto every sibling
  // fixture that has nothing to do with capacity. Null/absent both mean the
  // same thing to a reader: the entry declares no resources block, OR it
  // declares one but a quantity failed to parse — the two are
  // indistinguishable from here on purpose, since either way the console
  // has no honest number to show and must say so rather than guess or
  // silently treat it as zero demand.
  provision_demand?: { cpu_m: number; mem_b: number } | null
  // umbrella #401: this entry's referenced topology instance's shared
  // source display noun (dmf-media catalog/topology-params.j1.yaml's
  // source_noun) — null for every entry without a topology, and null when
  // the instance has no noun of its own. Optional, same reasoning as
  // provision_demand above: every pre-existing fixture that builds a
  // CatalogEntry literal stays valid without an edit.
  topology_source_noun?: string | null
}

export interface CatalogListResponse {
  entries: CatalogEntry[]
}

export interface CatalogActionResponse {
  job_id: number
  status: string
  // C5: echoed by the operator-gated write (#185 WP-E), correlates to the audit line.
  request_id?: string
}

// Union type: sync response (200) or async operation (202)
export type CatalogActionResult = CatalogActionResponse | Operation

export interface CatalogJobStatus {
  job_id: number
  status: string
  is_done: boolean
  is_running: boolean
}

// MXL Flows (libfabric/tcp cross-host demo evaluation)
export interface MxlNode {
  role: string        // producer | receiver
  provider: string    // cloud slug for the logo (e.g. aliyun) — no IP exposed
  online: boolean
  node: string | null
  interface?: string | null
  host?: {
    os?: string | null
    kernel?: string | null
    arch?: string | null
  }
  container?: {
    k8s_version?: string | null
  }
  infra?: {
    zone?: string | null
  }
  mxl_version?: string | null
  flow: Record<string, unknown>
  preview?: boolean
}

export interface MxlFlow {
  id?: string
  format?: string
  grain_rate?: string
  active?: boolean
  head_index?: number
  latency_grains?: number
  latency_ms?: number
  mxl_version?: string | null
}

export interface MxlTransport {
  library?: string    // libfabric
  provider?: string   // tcp
  service?: string    // 1234
  interface?: string | null
}

export interface MxlStatusResponse {
  configured: boolean
  reachable: boolean
  nodes: MxlNode[]
  flow: MxlFlow
  transport: MxlTransport
}

// Per-instance MXL live view (WP-D endpoint GET
// /api/media-workloads/{instance}/mxl/status). Server-shaped, bounded field
// set — a compromised sidecar cannot smuggle a locator (mxl.shape_status).
// NOTE: `node` is deliberately NOT relayed here — NetBox placement.node is the
// source of truth, so the tile joins node from the inventory payload, not this.
export interface MxlInstanceFlow {
  head_index: number | null
  latency_ms: number | null
  latency_grains: number | null
  active: boolean | null
  format: string | null
  grain_rate: string | null
}

export interface MxlInstanceStatus {
  instance: string
  available: boolean
  // Present only when available:
  role?: string | null
  provider?: string | null
  preview?: boolean
  mxl_version?: string | null
  flow?: MxlInstanceFlow
  // Present only when unavailable (available:false):
  reason?: 'no-sidecar' | 'unreachable' | 'not-found' | string
}

// ------------------------------------------------------------------
// Media Workloads (ADR-0037): NetBox instance inventory, desired vs observed.
// requested_state is INTENT (NetBox lifecycle tag); observed_state is runtime
// proof (probe overlay). The UI must never render intent as running.
export interface MediaWorkloadInstance {
  instance: string
  netbox_id: number | null
  function_key: string | null
  // ONLY a boolean crosses the trust boundary (WP-D): whether a scoped MXL
  // sidecar is resolvable. WP-C uses it to decide which tiles poll live view.
  // Coords/URLs/IPs never leave the backend.
  live_view?: boolean
  requested_state: 'bootstrapped' | 'active' | 'unknown' | string
  observed_state: 'running' | 'failing' | 'unknown'
  reconcile_pending: boolean
  placement: {
    node: string | null
    ports: number[]
    protocol: string | null
  }
  // umbrella #401: a topology-spawned source instance's recorded
  // provenance — read verbatim from the NetBox topology-parent:/
  // topology-source: tags the launcher stamps at deploy time
  // (dmf-runbooks roles/mxl/defaults/main.yml), the SAME generic way
  // function_key already comes from app:. Never constructed or parsed
  // from `instance`/function_key on this side.
  //
  // topology_parent_key: the catalog entry that produced this instance.
  // topology_source_id: the declared topology sources[].id this instance
  // embodies (e.g. "source-a").
  // Both null for an ordinary (non-topology) instance, AND for a
  // topology-spawned instance provisioned before this tagging existed —
  // both are genuinely "not recorded", never a guess. Optional, same
  // fixture-compatibility reasoning as CatalogEntry.provision_demand: the
  // real API always sets them; every pre-existing test fixture that
  // builds a MediaWorkloadInstance literal stays valid without an edit.
  topology_parent_key?: string | null
  topology_source_id?: string | null
}

export interface MediaWorkloadFunction {
  function_key: string
  count: number
  running: number
  reconcile_pending: number
}

export interface MediaWorkloadsResponse {
  configured: boolean
  reason?: string
  degraded?: boolean
  scope?: 'all' | string[]
  instances: MediaWorkloadInstance[]
  functions: MediaWorkloadFunction[]
}

// ADR-0046 decisions 3 + 5: workload-first grouped API.
// The flat MediaWorkloadsResponse stays; this is the additive grouped shape.
export interface MediaWorkload {
  slug: string
  name: string
  lifecycle: 'provision' | 'configure' | 'operate' | 'unknown'
  health: 'ok' | 'degraded'
  instances: (MediaWorkloadInstance & { workload_assignment: string })[]
  functions: MediaWorkloadFunction[]
}

export interface InvalidInstance {
  instance: string
  function_key: string | null
  workload_assignment: 'invalid-multiple'
  conflicting_workloads: string[]
}

export interface MediaWorkloadsGroupedResponse {
  configured: boolean
  reason?: string
  degraded?: boolean
  scope?: 'all' | string[]
  workloads: MediaWorkload[]
  invalid_instances: InvalidInstance[]
}

export interface ClearForDeploymentResult {
  instance: string
  requested_state: string
  previous_state: string
  request_id: string
  actor: string
  role: string
  reason: string
  reconcile: {
    expectation: string
    watch: string
  }
}

// umbrella #201 WP5 — console switch surface (spec §6/§7).
export interface TopologySource {
  id: string
  flow_id: string
  pattern: string
}

export interface InstanceTopology {
  receiver_instance: string
  sources: TopologySource[]
  // umbrella #320/#321: active_source is now derived from a live sidecar
  // observation (matched against declared sources[].flow_id), never a static
  // catalog fallback. provenance === 'observed-flow' iff this is a fresh,
  // successfully-matched observation; otherwise active_source/observed_at
  // are both null (unreachable sidecar, unconfigured, or no flow match).
  active_source: string | null
  provenance: string | null
  observed_at: string | null
}

export type SwitchStatus = 'pending' | 'reconnecting' | 'active' | 'failed_rollback_required'

export interface SwitchSourceResult {
  command_id: string
  receiver_instance: string
  source_instance: string
  reason: string
  status: SwitchStatus
  previous_source: string | null
  error: string | null
  // umbrella #320/#321 gate follow-up: additive fields from
  // SwitchSourceCommand.to_dict(). `outcome` is a machine enum string (e.g.
  // 'switch_failed_previous_source_restored'); `outcome_message` is a canned,
  // human-readable operator string present only for a couple of specific
  // outcomes and null otherwise — the UI prefers it when non-null and falls
  // back to the coarse `error` string when it's null (no regression for
  // outcomes without a canned message).
  outcome: string | null
  outcome_message: string | null
  request_id: string
  initiator: string | null
  created_at: string
  updated_at: string
  actor: string
  role: string
}
