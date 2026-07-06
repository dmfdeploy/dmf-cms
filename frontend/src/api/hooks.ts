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
  ChangesCommitsResponse,
  ChangesPullsResponse,
  AdminGroupsResponse,
  CatalogListResponse,
  CatalogActionResult,
  CatalogJobStatus,
  MxlStatusResponse,
  MediaWorkloadsResponse,
  ClearForDeploymentResult,
  Operation,
} from './types'

// Type guard: check if response is an async operation (has operation_id)
export function isOperation(result: any): result is Operation {
  return result && typeof result === 'object' && 'operation_id' in result
}

export function useCurrentUser() {
  return useQuery({
    queryKey: ['user'],
    queryFn: () => apiCall<UserIdentity>('/api/me'),
    retry: false,
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

export function useLaunchWorkflow() {
  return useMutation({
    mutationFn: (workflowName: string) =>
      apiCall<WorkflowLaunchResult>(`/api/workflows/${workflowName}/launch`, {
        method: 'POST',
      }),
  })
}

export function useOperationStatus(operationId: string | null) {
  return useQuery({
    queryKey: ['operation', operationId],
    queryFn: () => apiCall<Operation>(`/api/operations/${operationId}`),
    enabled: operationId !== null,
    refetchInterval: (query) => {
      // Stop polling when operation reaches terminal state
      const data = query.state.data
      if (data && (data.state === 'launched' || data.state === 'error')) {
        return false
      }
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

export function useAdminJobs() {
  return useQuery({
    queryKey: ['admin', 'jobs'],
    queryFn: () => apiCall<AdminJobsResponse>('/api/admin/jobs'),
    refetchInterval: 15_000,
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
    mutationFn: (key: string) =>
      apiCall<CatalogActionResult>(`/api/catalog/${key}/deploy`, {
        method: 'POST',
      }),
  })
}

export function useTeardownCatalog() {
  return useMutation({
    mutationFn: (key: string) =>
      apiCall<CatalogActionResult>(`/api/catalog/${key}/teardown`, {
        method: 'POST',
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

// MXL Flows — poll fast so the grain head-index counter visibly ticks.
export function useMxlStatus() {
  return useQuery({
    queryKey: ['mxl-status'],
    queryFn: () => apiCall<MxlStatusResponse>('/api/mxl/status'),
    refetchInterval: 200,
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

// The ONE consequential media-workloads write (ADR-0037): flips desired
// state in NetBox; convergence belongs to the automation lane. reason is
// mandatory (C5 quartet).
export function useClearForDeployment() {
  return useMutation({
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
