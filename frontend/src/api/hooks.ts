import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiCall, APIError } from './client'
import type {
  UserIdentity,
  AppContract,
  WorkflowsListResponse,
  WorkflowLaunchResult,
  WorkflowJobStatus,
  PasskeyInvitationResponse,
  AdminHealthResponse,
  AdminUsersResponse,
  AdminJobsResponse,
  AlertsResponse,
  WorkspaceHealth,
  TargetsResponse,
  MonitoringMetrics,
  FacilitySummary,
  FacilityDevicesResponse,
  FacilityDetailResponse,
  ChangesCommitsResponse,
  ChangesPullsResponse,
  AdminGroupsResponse,
  CatalogListResponse,
  CatalogActionResult,
  CatalogJobStatus,
  MxlStatusResponse,
  MxlInstanceStatus,
  MediaWorkloadsResponse,
  MediaWorkloadsGroupedResponse,
  ClearForDeploymentResult,
  InstanceTopology,
  SwitchSourceResult,
  Operation,
  OperationState,
} from './types'

// Type guard: check if response is an async operation (has operation_id)
export function isOperation(result: any): result is Operation {
  return result && typeof result === 'object' && 'operation_id' in result
}

/**
 * `enabled` defaults to `true` — every existing call site (every one of
 * them calls this with no arguments) is unaffected. FIX ROUND (dmf-cms#391,
 * codex gate — D): added specifically so App.tsx can pass `false` on the
 * dev-harness route, so that route makes genuinely zero network calls
 * rather than firing an unstubbed /api/me it never reads the result of.
 * Safe because callers share ['user'] as a cache key regardless of their
 * own `enabled` value — TanStack Query fetches for a key as long as ANY
 * mounted observer for it has `enabled: true`, so a single `enabled: false`
 * instance (this one) never suppresses a fetch any OTHER mounted instance
 * still needs; on the dev-harness route this is the only mounted instance
 * at all (that branch returns before Shell/Topbar/any other page mounts).
 */
export function useCurrentUser(enabled: boolean = true) {
  return useQuery({
    queryKey: ['user'],
    queryFn: () => apiCall<UserIdentity>('/api/me'),
    retry: false,
    enabled,
  })
}

export function useSetViewAs() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (role: 'viewer' | 'operator' | 'engineer') =>
      apiCall('/api/me/view-as', { method: 'POST', body: JSON.stringify({ role }) }),
    onSuccess: () => queryClient.invalidateQueries(),
  })
}

export function useClearViewAs() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => apiCall('/api/me/view-as', { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries(),
  })
}

export function useAppContract() {
  return useQuery({
    queryKey: ['contract'],
    queryFn: () => apiCall<AppContract>('/api/contract'),
    retry: false,
  })
}

export function useWorkflows() {
  return useQuery({
    queryKey: ['workflows'],
    queryFn: () => apiCall<WorkflowsListResponse>('/api/workflows'),
  })
}

// AWX writes are operator-gated and carry the C5 quartet: a mandatory reason
// is sent in the body (backend 400s without it), and the response echoes a
// request_id (#185 WP-E), mirroring clear-for-deployment.
export function useLaunchWorkflow() {
  return useMutation({
    mutationFn: ({ workflowName, reason }: { workflowName: string; reason: string }) =>
      apiCall<WorkflowLaunchResult>(`/api/workflows/${workflowName}/launch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      }),
  })
}

// umbrella #347: terminal states for a WATCHED action (#202 WP2's
// deploy/teardown/rollback/finalise-purge) — LAUNCHED is a mid-flight state
// for these (the job watcher takes over), unlike a plain "launch" op, for
// which LAUNCHED itself is terminal (see operations.py's own
// terminal_states()). Existing consumers (OperationStatusLine) unmount
// themselves right at LAUNCHED via their own onLaunched hand-off, so
// widening the stop condition to this full set is behavior-neutral for
// them — it only newly lets a consumer that stays mounted (e.g. a
// finalise-purge completion tracker) keep observing through to the
// operation's REAL outcome.
const _WATCHED_TERMINAL_STATES: OperationState[] = [
  'run_complete', 'run_failed', 'failed_rollback_required', 'rollback_incomplete', 'run_status_unknown',
]

export function useOperationStatus(operationId: string | null) {
  return useQuery({
    queryKey: ['operation', operationId],
    queryFn: () => apiCall<Operation>(`/api/operations/${operationId}`),
    enabled: operationId !== null,
    refetchInterval: (query) => {
      // Stop polling when operation reaches terminal state
      const data = query.state.data
      if (!data) return 3000
      if (data.state === 'error') return false
      if (data.action === 'launch' && data.state === 'launched') return false
      if (_WATCHED_TERMINAL_STATES.includes(data.state)) return false
      return 3000 // Poll every 3s for non-terminal states
    },
  })
}

export function useCreatePasskeyInvitation() {
  return useMutation({
    mutationFn: () =>
      apiCall<PasskeyInvitationResponse>('/api/admin/invitations', {
        method: 'POST',
      }),
  })
}

export function useWorkflowJobStatus(jobId: number | null) {
  return useQuery({
    queryKey: ['job', jobId],
    queryFn: () => apiCall<WorkflowJobStatus>(`/api/workflows/jobs/${jobId}`),
    enabled: jobId !== null,
    refetchInterval: 5000,
  })
}

export function useAdminHealth() {
  return useQuery({
    queryKey: ['admin', 'health'],
    queryFn: () => apiCall<AdminHealthResponse>('/api/admin/health'),
    refetchInterval: 30_000,
    retry: false,
  })
}

export function useAdminUsers() {
  return useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => apiCall<AdminUsersResponse>('/api/admin/users'),
    retry: false,
  })
}

// ------------------------------------------------------------------
// Monitoring
// ------------------------------------------------------------------

// Workspace core (#174 WP2). The queryFn throws on reachable:false so
// react-query keeps the last good snapshot (data + dataUpdatedAt gives
// "last-known state, Xs old") while error signals the degradation.
// configured:false is a valid resting state, not an error.
export function useWorkspaceHealth() {
  return useQuery({
    queryKey: ['workspace', 'health'],
    queryFn: async () => {
      const health = await apiCall<WorkspaceHealth>('/api/workspace/health')
      if (health.configured && !health.reachable) {
        throw new APIError(503, health.reason, 'monitoring unreachable')
      }
      return health
    },
    refetchInterval: 30_000,
    staleTime: 10_000,
  })
}

export function useMonitoringAlerts() {
  return useQuery({
    queryKey: ['monitoring', 'alerts'],
    queryFn: () => apiCall<AlertsResponse>('/api/monitoring/alerts'),
    refetchInterval: 30_000,
    staleTime: 10_000,
  })
}

export function useMonitoringTargets() {
  return useQuery({
    queryKey: ['monitoring', 'targets'],
    queryFn: () => apiCall<TargetsResponse>('/api/monitoring/targets'),
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
}

export function useMonitoringMetrics() {
  return useQuery({
    queryKey: ['monitoring', 'metrics'],
    queryFn: () => apiCall<MonitoringMetrics>('/api/monitoring/metrics'),
    refetchInterval: 30_000,
    staleTime: 10_000,
  })
}

// ------------------------------------------------------------------
// Facility (Physical Infrastructure)
// ------------------------------------------------------------------

export function useFacilitySummary() {
  return useQuery({
    queryKey: ['facility', 'summary'],
    queryFn: () => apiCall<FacilitySummary>('/api/facility/summary'),
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
}

export function useFacilityDevices() {
  return useQuery({
    queryKey: ['facility', 'devices'],
    queryFn: () => apiCall<FacilityDevicesResponse>('/api/facility/devices'),
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
}

// S1 (#285): the Facility Detail page — node/service/storage/capacity
// truth. Same cadence as useFacilitySummary; this is inventory, not a
// live-view surface.
export function useFacilityDetail(site: string) {
  return useQuery({
    queryKey: ['facility', 'detail', site],
    queryFn: () => apiCall<FacilityDetailResponse>(`/api/facility/${encodeURIComponent(site)}/detail`),
    enabled: site.length > 0,
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
}

// ------------------------------------------------------------------
// Changes (Audit Trail)
// ------------------------------------------------------------------

export function useChangesJobs() {
  return useQuery({
    queryKey: ['changes', 'jobs'],
    queryFn: () => apiCall<AdminJobsResponse>('/api/changes/jobs'),
    refetchInterval: 30_000,
    staleTime: 10_000,
  })
}

export function useChangesCommits() {
  return useQuery({
    queryKey: ['changes', 'commits'],
    queryFn: () => apiCall<ChangesCommitsResponse>('/api/changes/commits'),
    refetchInterval: 30_000,
    staleTime: 10_000,
  })
}

export function useChangesPulls() {
  return useQuery({
    queryKey: ['changes', 'pulls'],
    queryFn: () => apiCall<ChangesPullsResponse>('/api/changes/pulls'),
    refetchInterval: 30_000,
    staleTime: 10_000,
  })
}

// ------------------------------------------------------------------
// Admin (Groups)
// ------------------------------------------------------------------

export function useAdminGroups() {
  return useQuery({
    queryKey: ['admin', 'groups'],
    queryFn: () => apiCall<AdminGroupsResponse>('/api/admin/groups'),
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
}

// ------------------------------------------------------------------
// Catalog (Media Functions)
// ------------------------------------------------------------------

export function useCatalog() {
  return useQuery({
    queryKey: ['catalog'],
    queryFn: () => apiCall<CatalogListResponse>('/api/catalog'),
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  })
}

export function useDeployCatalog() {
  return useMutation({
    // workload (#239) is sent only when non-empty — omitted keeps the request
    // body bit-compatible with pre-#239 behaviour.
    mutationFn: ({ key, reason, workload }: { key: string; reason: string; workload?: string }) =>
      apiCall<CatalogActionResult>(`/api/catalog/${key}/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(workload ? { reason, workload } : { reason }),
      }),
  })
}

export function useTeardownCatalog() {
  return useMutation({
    mutationFn: ({ key, reason }: { key: string; reason: string }) =>
      apiCall<CatalogActionResult>(`/api/catalog/${key}/teardown`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      }),
  })
}

export function useCatalogJobStatus(key: string, jobId: number | null) {
  return useQuery({
    queryKey: ['catalog-job', key, jobId],
    queryFn: () => apiCall<CatalogJobStatus>(`/api/catalog/${key}/status/${jobId}`),
    enabled: jobId !== null,
    refetchInterval: 2000,
  })
}

// MXL Flows aggregate — the live_view=false fallback panel. Polls fast so the
// grain head-index counter visibly ticks, but BOUNDED like every other
// preview surface (GATE-S1-RV P2): the caller passes `active`, which is false
// on a hidden tab or under reduced motion, and the query simply stops. An
// unbounded 200ms poll was the last path that ignored the rules.
export function useMxlStatus(opts?: { active?: boolean }) {
  const active = opts?.active ?? true
  return useQuery({
    queryKey: ['mxl-status'],
    queryFn: () => apiCall<MxlStatusResponse>('/api/mxl/status'),
    enabled: active,
    refetchInterval: active ? 200 : false,
  })
}

// Media Workloads — inventory changes slowly; 15s keeps the status overlay
// fresh without hammering NetBox/Prometheus through the backend.
export function useMediaWorkloads() {
  return useQuery({
    queryKey: ['media-workloads'],
    queryFn: () => apiCall<MediaWorkloadsResponse>('/api/media-workloads'),
    refetchInterval: 15000,
  })
}

// ADR-0046: workload-first grouped inventory. Additive — the flat hook stays.
export function useMediaWorkloadsGrouped(opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ['media-workloads-grouped'],
    queryFn: () =>
      apiCall<MediaWorkloadsGroupedResponse>('/api/media-workloads/grouped'),
    refetchInterval: 15000,
    enabled: opts?.enabled ?? true,
  })
}

// Per-instance MXL live view (WP-D). Consumers gate `enabled` and choose
// `refetchInterval` so polling only runs when it should: in grid view, with a
// visible tab, within the live-tile cap, and not under reduced motion. The
// modal drives it faster. `false`/undefined interval means fetch-once-then-hold
// (a static last frame with an explicit Refresh affordance).
export function useInstanceMxlStatus(
  instance: string,
  opts?: { enabled?: boolean; refetchInterval?: number | false },
) {
  return useQuery({
    queryKey: ['mxl-instance-status', instance],
    queryFn: () =>
      apiCall<MxlInstanceStatus>(
        `/api/media-workloads/${encodeURIComponent(instance)}/mxl/status`,
      ),
    enabled: opts?.enabled ?? true,
    refetchInterval: opts?.refetchInterval ?? false,
  })
}

// umbrella #201 WP5 — read seam the switch UI needs (not itself in the
// spec's own endpoint list; see api_media_workloads_topology's own
// docstring in main.py).
//
// A 404 is the ORDINARY answer here, not a failure: the endpoint returns it
// for receiver-not-found (the instance is not a catalog key at all — every
// function key the catalog has since dropped) and receiver-not-topology (it
// is, but carries no topology_ref — every non-viewer instance). Both mean
// "this instance has no topology", which is a fact, so it resolves to null
// data rather than an error state (umbrella #339 item 5). 422
// (topology-invalid) is a genuine catalog-authoring defect and still errors.
//
// Both callers — the Design stage's composition line and the Configure
// stage's switch control — already render nothing on absent data, so the
// fail-closed switch contract is unchanged: no topology, no switch offered.
//
// KNOWN LIMIT, so nobody re-opens #339 item 5 expecting this to have gone:
// the browser still prints its own "Failed to load resource: 404" line in
// the Network panel. That line comes from the browser, not from this code,
// and cannot be suppressed while the request is made at all. What changed
// here is that the APPLICATION stops treating the reply as a fault — no
// error state, no retry, no error-path render. Removing the line entirely
// means not issuing requests that will 404, which needs the console to know
// in advance which instances carry a topology; CatalogEntry does not expose
// `topology_ref`, so only the receiver-not-found subset is predictable and
// not receiver-not-topology, which is most of them. Exposing that field is
// the remedy and is deliberately out of this arc's scope.
// umbrella #402: this read feeds ConfigureStage's OBSERVED_SOURCE_STALE_MS
// fuse (15s) — the backend re-stamps observed_at on every request from a
// live sidecar probe, so polling is what actually renews it. Without a
// refetchInterval, observed_at freezes at mount while the fuse's own clock
// (Date.now()) keeps advancing: freshness can only decay, never renew, and
// the switch control withdraws for good ~15s after page load. 5000ms is
// comfortably under the 15s bound (3 polls fit inside it) and matches
// existing practice (useWorkflowJobStatus above).
//
// retry: false meant a SINGLE transient poll failure flipped isError
// immediately (no attempts to exhaust), which — combined with the interval
// above — would otherwise blink the control out at whatever moment a
// transient failure landed. retry: 1 absorbs exactly one such failure
// (react-query's `isError` only flips once retries are exhausted, so the
// retained data + a pending retry keeps `settleQuery(...).failed` false
// throughout). retryDelay is explicit and fixed rather than the client's
// default exponential backoff: 300ms resolves a retry far inside both the
// 15s staleness bound and the 5s poll cadence, and — deterministic instead
// of backoff-computed — keeps fake-timer tests exact instead of timing-
// flaky.
export function useInstanceTopology(instance: string, opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ['media-workloads-topology', instance],
    queryFn: async (): Promise<InstanceTopology | null> => {
      try {
        return await apiCall<InstanceTopology>(
          `/api/media-workloads/${encodeURIComponent(instance)}/topology`,
        )
      } catch (e) {
        if (e instanceof APIError && e.status === 404) return null
        throw e
      }
    },
    enabled: opts?.enabled ?? true,
    refetchInterval: 5000,
    retry: 1,
    retryDelay: 300,
  })
}

// umbrella #201 WP5, spec §6/§7 — the coarse reconnect switch, consumed by
// the Configure stage's switch control (it lived in the live modal until
// GATE-S1; that modal is read-only now). Synchronous-await contract: the
// mutation resolves to the TERMINAL command (active or
// failed_rollback_required) directly, never a separate pending/reconnecting
// state to poll — `isPending` on this mutation IS the live "reconnecting"
// signal the console shows.
export function useSwitchSource() {
  return useMutation({
    mutationFn: ({
      instance,
      sourceInstance,
      reason,
    }: {
      instance: string
      sourceInstance: string
      reason: string
    }) =>
      apiCall<SwitchSourceResult>(
        `/api/media-workloads/${encodeURIComponent(instance)}/switch-source`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source_instance: sourceInstance, reason }),
        },
      ),
  })
}

// The ONE consequential media-workloads write (ADR-0037): flips desired
// state in NetBox; nothing converges it automatically (dmfdeploy#411) —
// Provision does, when run. reason is mandatory (C5 quartet).
export function useClearForDeployment() {
  const queryClient = useQueryClient()
  return useMutation({
    // Close the loop at the point of action (Art. 2): a successful clear
    // changes the inventory that decides whether the control should still
    // be offered. Without this the stale, already-taken action stays
    // clickable until the next 15s poll.
    // RETURNED, not fired-and-forgotten: react-query keeps the mutation
    // pending until this settles, so `busy` cannot fall before the fresh
    // inventory has landed. With `void` the refetch raced the re-render and
    // a stale Clear/Deploy could flash back during a slow NetBox read
    // (GATE-S1-RV3 P2). The loop closes atomically or not at all.
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['media-workloads-grouped'] }),
        queryClient.invalidateQueries({ queryKey: ['media-workloads'] }),
      ])
    },
    mutationFn: ({ instance, reason }: { instance: string; reason: string }) =>
      apiCall<ClearForDeploymentResult>(
        `/api/media-workloads/${encodeURIComponent(instance)}/clear`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason }),
        },
      ),
  })
}

// umbrella #347 (Arc 2b) — delete permanently: SoT removal of a finalised
// workload's residual dmf-catalog NetBox records via the finalise-purge AWX
// launcher. Always an async Operation (the backend never launches this
// synchronously) — the response is dispatch-only ("launched", not "done");
// completion is observed by polling the returned operation_id via
// useOperationStatus to a REAL terminal state (see that hook's own #347
// note), never assumed from this mutation settling. No onSuccess
// invalidation here for the same reason useTeardownCatalog has none: a
// 202 response means dispatched, not complete — the caller invalidates at
// the operation's own terminal state instead (FinaliseStage).
export function usePurgeWorkload() {
  return useMutation({
    mutationFn: ({ slug, confirm, reason }: { slug: string; confirm: string; reason: string }) =>
      apiCall<Operation>(`/api/media-workloads/${encodeURIComponent(slug)}/purge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm, reason }),
      }),
  })
}
