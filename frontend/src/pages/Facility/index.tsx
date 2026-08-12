import { Link } from 'react-router-dom'
import { Building2 } from 'lucide-react'
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
      {loading && (
        <div className="panel text-center py-8">
          <p className="text-muted text-sm">Loading facility inventory…</p>
        </div>
      )}

      {/* fix-round 4 (PR #81, codex sibling sweep): `isError` was ignored
          entirely — a settled failed read with NO retained data (first
          load, or a query that never succeeded) fell through
          FacilityEntry's whole reason ladder to `!site`, which reads
          "NetBox has no site recorded yet" — a real environment fact this
          is not; it misstates a read failure as a facility that has never
          been provisioned. */}
      {!loading && summary.isError && !summary.data && (
        <div className="panel py-6 px-6 border-warn/40">
          <p className="text-sm text-warn">
            The facility inventory could not be read. Retrying automatically.
          </p>
        </div>
      )}

      {/* A settled failure with RETAINED data (a prior successful read):
          Art. 5 keeps the tile visible rather than suppressing it, but the
          read that would have confirmed it's still current just failed —
          that must be visible too, not silently absent. */}
      {!loading && summary.isError && summary.data && (
        <div className="panel py-3 px-6 mb-4 border-warn/40">
          <p className="text-sm text-warn">
            The facility inventory could not be refreshed just now — showing the last successful
            read. Retrying automatically.
          </p>
        </div>
      )}

      {!loading && summary.data && <FacilityEntry data={summary.data} />}
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
    // Both facts, not the first one that matched: a site with no slug AND
    // dropped rows is two separate things wrong, and reporting only the
    // link failure hides that what is shown is also incomplete
    // (GATE-S1-RV3 P3).
    return (
      <div className="panel py-6 px-6">
        {partial && (
          <p className="mb-2 text-xs text-warn">
            Some NetBox records could not be read — this facility may be incomplete.
          </p>
        )}
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
      {/* Same square control-surface tile structure Media Workloads uses
          (pages/MediaWorkloads/index.tsx), in the same responsive grid, so
          the streamdeck skin pass hangs one treatment on both single-entry
          pages instead of two. Structure only: the provider mark is a skin
          concern AND a data-driven one (envs rotate providers), so the
          generic building glyph stands in rather than a hardcoded logo. */}
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Link
          to={`/facilities/${encodeURIComponent(site.slug)}`}
          className="card group flex aspect-square flex-col gap-3 overflow-hidden rounded-xl transition hover:border-accent/40 hover:bg-white/5"
          aria-label={`Open ${site.name} facility detail`}
        >
          <div className="flex aspect-video w-full items-center justify-center rounded-md border border-white/10 bg-black/40">
            <Building2 className="h-8 w-8 text-blue-400" />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <h2 className="truncate text-base font-semibold">{site.name}</h2>
            <p className="mt-auto truncate text-xs text-muted">
              {site.device_count} device{site.device_count === 1 ? '' : 's'} in NetBox
            </p>
          </div>
        </Link>
      </div>
    </>
  )
}
