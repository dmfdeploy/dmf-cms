import { Link } from 'react-router-dom'
import { Building2, ArrowRight } from 'lucide-react'
import { useFacilitySummary } from '@/api/hooks'

// Facilities (S1, #285): a single-facility console has exactly one entry
// here. This page used to render a grid of "sites" (plural) plus a
// hardcoded "Status: NetBox connected" card and a per-site Status field
// that was always blank (NetBox's dcim.Site.status is never populated by
// the born-inventory role) — both are gone now. Informational content this
// console can't actually back is not a design, it's a lie by omission
// (Constitution Art. 1). All this page does now is point at the facility's
// detail page, where live node/service/storage/capacity truth actually
// lives (pages/Facility/Detail.tsx).
export default function Facility() {
  const summary = useFacilitySummary()
  const loading = summary.isLoading && !summary.data

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="hero">
        <div className="hero-copy">
          <p className="kicker">Infrastructure</p>
          <h1>Facility</h1>
          <p>The physical facility this console operates.</p>
        </div>
      </div>

      {loading && (
        <div className="panel text-center py-8">
          <p className="text-muted text-sm">Loading facility inventory…</p>
        </div>
      )}

      {!loading && <FacilityEntry data={summary.data} />}
    </div>
  )
}

function FacilityEntry({ data }: { data: ReturnType<typeof useFacilitySummary>['data'] }) {
  const reason = data?.reason ?? ''

  if (reason === 'netbox-not-configured') {
    return (
      <div className="panel py-6 px-6">
        <p className="text-sm text-muted">
          NetBox is not configured in this environment, so the facility inventory
          cannot be read from here.
        </p>
      </div>
    )
  }

  if (reason === 'netbox-unreachable') {
    return (
      <div className="panel py-6 px-6 border-warn/40">
        <p className="text-sm text-warn">
          NetBox is unreachable — the facility inventory cannot be read right now.
          Retrying automatically.
        </p>
      </div>
    )
  }

  // Partial data is neither "fine" nor "unreachable": rows were dropped, so
  // the tile below is real but incomplete. Saying so beside it is the whole
  // point of the backend setting the reason (GATE-S1-RV2 P2) — a token no
  // surface renders is a token that does not exist.
  const partial = reason === 'netbox-rows-unparseable'

  const site = data?.sites?.[0] ?? null

  if (!site && partial) {
    return (
      <div className="panel py-6 px-6 border-warn/40">
        <p className="text-sm text-warn">
          NetBox returned records this console could not read, and none of them
          resolved to a facility. What is shown may be incomplete.
        </p>
      </div>
    )
  }

  if (!site) {
    return (
      <div className="panel py-6 px-6">
        <p className="text-sm text-muted">
          NetBox has no site recorded yet — nothing to show here until one is
          provisioned.
        </p>
      </div>
    )
  }

  if (!site.slug) {
    return (
      <div className="panel py-6 px-6">
        <p className="text-sm text-muted">
          NetBox has a site record for &quot;{site.name}&quot; but no slug for it — the
          facility detail page cannot be linked to until one is set.
        </p>
      </div>
    )
  }

  return (
    <>
      {partial && (
        <p className="mb-2 text-xs text-warn">
          Some NetBox records could not be read — this facility may be incomplete.
        </p>
      )}
    <Link
      to={`/facilities/${encodeURIComponent(site.slug)}`}
      className="panel p-6 flex items-center justify-between hover:bg-panel/30 transition group"
    >
      <div className="flex items-center gap-4">
        <div className="p-3 rounded-lg bg-blue-500/10">
          <Building2 className="w-6 h-6 text-blue-400" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">{site.name}</h2>
          <p className="text-xs text-muted mt-1">
            {site.device_count} device{site.device_count === 1 ? '' : 's'} in NetBox
          </p>
        </div>
      </div>
      <ArrowRight className="w-5 h-5 text-muted group-hover:text-accent transition" />
    </Link>
    </>
  )
}
