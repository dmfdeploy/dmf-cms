import { useParams, Link } from 'react-router-dom'
import { useFacilityDetail, useMediaWorkloadsGrouped } from '@/api/hooks'
import type { FacilityDetailResponse } from '@/api/types'

// Facility Detail (S1, #285): node/service/storage/capacity truth for the
// one facility this console operates, read entirely through the console's
// two existing seams (prometheus.query() + NetBox) — see facility.py's
// module docstring for the full fact -> source-series map. This page
// replaces the Workspace "Infrastructure Services" table (dead
// example-domain links, config/app-contracts.yaml's static deep_links) with
// the real cluster ingress objects, and the old Facility page's meaningless
// "Status: NetBox connected" card with actual scheduler-truth capacity.
//
// Every section renders its OWN `reason` (facility.py's fail-soft
// contract) — a Prometheus outage degrades nodes/platform_services/
// storage/capacity together but never touches the NetBox-only site/
// instance-class facts, and vice versa. No disabled controls, no
// "loading" spinner standing in for "we cannot read this" (Constitution
// Art. 1).

// ---------------------------------------------------------------------------
// Page-level classifier — pure over the react-query result shape, same
// style as lib/workspaceHealth.ts / lib/changesState.ts. Exported for
// __tests__/facility.test.tsx.
// ---------------------------------------------------------------------------

export type FacilityDetailPhase = 'loading' | 'unconfigured' | 'unreadable' | 'loaded'

export interface FacilityDetailQueryLike {
  isLoading: boolean
  isError: boolean
  data?: FacilityDetailResponse
}

export interface FacilityDetailState {
  phase: FacilityDetailPhase
  data?: FacilityDetailResponse
}

export function classifyFacilityDetail(q: FacilityDetailQueryLike): FacilityDetailState {
  if (q.isLoading && !q.data) return { phase: 'loading' }
  if (q.isError && !q.data) return { phase: 'unreadable' }
  if (!q.data) return { phase: 'unreadable' }
  if (!q.data.prometheus_configured && !q.data.netbox_configured) {
    return { phase: 'unconfigured', data: q.data }
  }
  return { phase: 'loaded', data: q.data }
}

// Reason-token -> operator-language copy (Art. 3: plain words, no system
// jargon; Art. 1: never imply we know more than we do). Shared across every
// section banner on this page so the same cause always reads the same way.
export function facilityReasonCopy(reason: string): string {
  switch (reason) {
    case 'prometheus-not-configured':
      return 'Monitoring is not configured in this environment.'
    case 'nodes-unreadable':
      return 'Node inventory cannot be read from monitoring right now. Retrying automatically.'
    case 'platform-services-unreadable':
      return 'Platform service versions and URLs cannot be read from monitoring right now. Retrying automatically.'
    case 'storage-unreadable':
      return 'Storage inventory cannot be read from monitoring right now. Retrying automatically.'
    case 'budget-unavailable':
      return 'Capacity cannot be read from monitoring right now. Retrying automatically.'
    case 'multi-node-unsupported':
      return 'This facility has more than one node reporting capacity — the console only summarises a single-node facility today.'
    case 'netbox-not-configured':
      return 'NetBox is not configured in this environment.'
    case 'netbox-unreadable':
      return 'NetBox is unreachable right now. Retrying automatically.'
    case 'site-ambiguous':
      return 'NetBox does not resolve to exactly one site, so the facility identity cannot be confirmed.'
    default:
      return reason
  }
}

// ---------------------------------------------------------------------------
// Formatting — local to this page, no lib file in scope for this leg.
// ---------------------------------------------------------------------------

function formatMillicores(m: number): string {
  if (m % 1000 === 0) return `${m / 1000} core${m === 1000 ? '' : 's'}`
  return `${m}m`
}

function formatBytes(bytes: number): string {
  const gi = bytes / 1024 ** 3
  if (gi >= 1) return `${gi.toFixed(gi >= 10 ? 0 : 1)} GiB`
  const mi = bytes / 1024 ** 2
  return `${mi.toFixed(mi >= 10 ? 0 : 1)} MiB`
}

export default function FacilityDetail() {
  const { site } = useParams<{ site: string }>()
  const query = useFacilityDetail(site ?? '')
  const state = classifyFacilityDetail(query)

  const heading = state.data?.site.name || site || 'Facility'

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="hero">
        <div className="hero-copy">
          <p className="kicker">Infrastructure</p>
          <h1>{heading}</h1>
          <p>Nodes, platform services, storage, and capacity for this facility.</p>
        </div>
      </div>

      {state.phase === 'loading' && (
        <div className="panel text-center py-8">
          <p className="text-muted text-sm">Loading facility detail…</p>
        </div>
      )}

      {state.phase === 'unreadable' && (
        <div className="panel py-6 px-6 border-warn/40">
          <p className="text-sm text-warn">
            Facility detail could not be loaded. Retrying automatically.
          </p>
        </div>
      )}

      {state.phase === 'unconfigured' && (
        <div className="panel py-6 px-6">
          <p className="text-sm text-muted">
            Neither monitoring nor NetBox is configured in this environment, so
            no facility detail can be read from here.
          </p>
        </div>
      )}

      {state.phase === 'loaded' && state.data && <Loaded data={state.data} />}
    </div>
  )
}

function SectionBanner({ reason }: { reason: string }) {
  if (!reason) return null
  return (
    <div className="px-6 py-6 text-center text-muted text-sm">{facilityReasonCopy(reason)}</div>
  )
}

function Loaded({ data }: { data: FacilityDetailResponse }) {
  return (
    <>
      {data.site.reason !== '' && (
        <div className="panel py-3 px-6 mb-6">
          <p className="text-sm text-muted">{facilityReasonCopy(data.site.reason)}</p>
        </div>
      )}

      <NodesPanel data={data} />
      <PlatformServicesPanel data={data} />
      <StoragePanel data={data} />
      <CapacityPanel data={data} />
      <WorkloadCountPanel />
    </>
  )
}

function NodesPanel({ data }: { data: FacilityDetailResponse }) {
  const { nodes } = data
  return (
    <div className="panel mb-6">
      <div className="px-6 py-4 border-b border-panel">
        <h2 className="text-lg font-semibold">Nodes</h2>
      </div>
      {nodes.reason !== '' ? (
        <SectionBanner reason={nodes.reason} />
      ) : nodes.items.length === 0 ? (
        <div className="px-6 py-6 text-center text-muted text-sm">No nodes reported.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table w-full">
            <thead>
              <tr>
                <th>Name</th>
                <th>Kubernetes version</th>
                <th>Architecture</th>
              </tr>
            </thead>
            <tbody>
              {nodes.items.map((n) => (
                <tr key={n.name}>
                  <td className="font-medium text-text">{n.name}</td>
                  <td className="font-mono text-xs">{n.kubelet_version}</td>
                  <td className="font-mono text-xs">{n.arch ?? <span className="text-muted">cannot be read</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function PlatformServicesPanel({ data }: { data: FacilityDetailResponse }) {
  const { platform_services: services } = data
  return (
    <div className="panel mb-6">
      <div className="px-6 py-4 border-b border-panel">
        <h2 className="text-lg font-semibold">Platform services</h2>
        <p className="text-xs text-muted mt-1">
          As-deployed versions and live URLs, read from the cluster's own ingress objects.
        </p>
      </div>
      {services.reason !== '' ? (
        <SectionBanner reason={services.reason} />
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table w-full">
            <thead>
              <tr>
                <th>Service</th>
                <th>Version</th>
                <th>Access</th>
              </tr>
            </thead>
            <tbody>
              {services.items.map((s) => (
                <tr key={s.key}>
                  <td className="font-medium text-text">{s.display_name}</td>
                  <td className="font-mono text-xs">
                    {s.images.length > 0 ? (
                      s.images.join(', ')
                    ) : s.namespace ? (
                      <span className="text-muted">no running containers</span>
                    ) : (
                      <span className="text-muted">not found in this cluster</span>
                    )}
                  </td>
                  <td>
                    {s.url ? (
                      <a
                        href={s.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-accent-blue hover:underline"
                      >
                        Open →
                      </a>
                    ) : (
                      <span className="text-xs text-muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function StoragePanel({ data }: { data: FacilityDetailResponse }) {
  const { storage } = data
  return (
    <div className="panel mb-6">
      <div className="px-6 py-4 border-b border-panel">
        <h2 className="text-lg font-semibold">Storage</h2>
      </div>
      {storage.reason !== '' ? (
        <SectionBanner reason={storage.reason} />
      ) : storage.items.length === 0 ? (
        <div className="px-6 py-6 text-center text-muted text-sm">No persistent volume claims reported.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table w-full">
            <thead>
              <tr>
                <th>Namespace</th>
                <th>Claim</th>
                <th>Storage class</th>
                <th>Requested</th>
              </tr>
            </thead>
            <tbody>
              {storage.items.map((v) => (
                <tr key={`${v.namespace}/${v.name}`}>
                  <td className="text-xs text-muted">{v.namespace}</td>
                  <td className="font-mono text-xs">{v.name}</td>
                  <td className="text-xs">{v.storageclass ?? <span className="text-muted">not recorded</span>}</td>
                  <td className="font-mono text-xs">
                    {v.requested_bytes != null ? (
                      formatBytes(v.requested_bytes)
                    ) : (
                      <span className="text-muted">cannot be read</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function CapacityPanel({ data }: { data: FacilityDetailResponse }) {
  const { capacity } = data
  return (
    <div className="panel mb-6">
      <div className="px-6 py-4 border-b border-panel">
        <h2 className="text-lg font-semibold">Capacity</h2>
        <p className="text-xs text-muted mt-1">
          Scheduler truth for {capacity.node_name ?? 'this facility'}: what the node can hold, and what
          is already committed against it. Requests committed is not usage — it is what the
          scheduler has already promised out of the allocatable budget.
        </p>
      </div>
      {capacity.reason !== '' ? (
        <SectionBanner reason={capacity.reason} />
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table w-full">
            <thead>
              <tr>
                <th></th>
                <th>Allocatable</th>
                <th>Requests committed</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="font-medium text-text">CPU</td>
                <td className="font-mono text-xs">
                  {capacity.allocatable_cpu_m != null ? formatMillicores(capacity.allocatable_cpu_m) : '—'}
                </td>
                <td className="font-mono text-xs">
                  {capacity.requests_committed_cpu_m != null
                    ? formatMillicores(capacity.requests_committed_cpu_m)
                    : '—'}
                </td>
              </tr>
              <tr>
                <td className="font-medium text-text">Memory</td>
                <td className="font-mono text-xs">
                  {capacity.allocatable_mem_b != null ? formatBytes(capacity.allocatable_mem_b) : '—'}
                </td>
                <td className="font-mono text-xs">
                  {capacity.requests_committed_mem_b != null ? formatBytes(capacity.requests_committed_mem_b) : '—'}
                </td>
              </tr>
            </tbody>
          </table>
          {capacity.pod_count != null && (
            <p className="px-6 py-3 text-xs text-muted">
              {capacity.pod_count} pod{capacity.pod_count === 1 ? '' : 's'} contribute to the committed figure.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function WorkloadCountPanel() {
  // Reuses the existing media-workloads inventory verbatim — this page
  // never re-derives that count (a second, divergent count would be a
  // trust hazard, not a convenience).
  const { data, isLoading } = useMediaWorkloadsGrouped()
  return (
    <div className="panel mb-6">
      <div className="px-6 py-4 border-b border-panel flex items-center justify-between">
        <h2 className="text-lg font-semibold">Media workloads</h2>
        <Link to="/media-workloads" className="text-xs text-accent-blue hover:underline">
          Open Media Workloads
        </Link>
      </div>
      <div className="px-6 py-6">
        {isLoading && !data ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : !data || !data.configured ? (
          <p className="text-sm text-muted">
            {data?.reason
              ? facilityReasonCopy(data.reason) || 'Media workloads are not configured for this environment.'
              : 'Media workloads are not configured for this environment.'}
          </p>
        ) : (
          <p className="text-sm text-text">
            <span className="font-mono">{data.workloads.length}</span> media workload
            {data.workloads.length === 1 ? '' : 's'} provisioned on this facility.
          </p>
        )}
      </div>
    </div>
  )
}
