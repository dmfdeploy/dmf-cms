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

// Async operation tracking (WS5 scale-to-zero)
export type OperationState = 'waking' | 'launching' | 'launched' | 'error'

export interface Operation {
  operation_id: string
  action: 'launch' | 'deploy' | 'teardown'
  target: string
  state: OperationState
  job_id: number | null
  error: string | null
  created_at: string
  updated_at: string
  // Spread onto the 202/200 async write response by the operator-gated write
  // (#185 WP-E); absent on later poll reads of the operation itself.
  request_id?: string
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

export interface NetBoxDevice {
  id: number
  name: string
  type: string
  site: string
  status: string
  ip: string | null
  role: string | null
}

export interface FacilitySummary {
  site_count: number
  device_count: number
  sites: Array<{
    name: string
    status: string
    device_count: number
  }>
}

export interface FacilityDevicesResponse {
  devices: NetBoxDevice[]
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

export interface MediaWorkloadsGroupedResponse {
  configured: boolean
  reason?: string
  degraded?: boolean
  scope?: 'all' | string[]
  workloads: MediaWorkload[]
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
