export interface UserIdentity {
  subject: string
  display_name: string
  email: string
  role: 'viewer' | 'operator' | 'engineer' | 'admin'
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
}

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
  ebu_lifecycle_owner: string | null
  lifecycle: 'bootstrapped' | 'active' | 'unknown' | 'error'
  provision_image: string | null
  provision_netbox_service: string | null
  configure_awx_job_template: string | null
  finalise_awx_job_template: string | null
  dependencies: string[]
}

export interface CatalogListResponse {
  entries: CatalogEntry[]
}

export interface CatalogActionResponse {
  job_id: number
  status: string
}

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
