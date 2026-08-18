// Centralised media-workload route construction (dmfdeploy#414 H3).
//
// WHY THIS FILE EXISTS. workloadHomePath/workloadSetupPath are the ONLY
// sanctioned way to build a workload route from a slug — every call site
// across CreateWorkload.tsx, WorkloadHome.tsx, WorkloadSetup.tsx,
// WorkloadMaterializing.tsx, ViewLiveExit.tsx, LifecycleStrip.tsx (via its
// callers), Topbar.tsx and App.tsx's own route table goes through them, so
// a future route-shape change has exactly one place to change it rather
// than N hand-interpolated `/media-workloads/${slug}` template strings that
// can silently drift apart (dmfdeploy#414's own migration hazard H3; see
// the issue for the pre-#414 history this replaced).
//
// THE CONTRACT (dmfdeploy#414 Addendum 2, operator ruling):
//   /media-workloads/:slug          -> the live view (home)
//   /media-workloads/:slug/setup    -> the guided flow
//   /media-workloads/:slug/operate  -> compatibility redirect to home
//
// The bare slug is the workload's home — the ordinary resource-detail
// convention, chosen specifically because it makes the return path
// STRUCTURAL: the breadcrumb's workload crumb, the back button, bookmarks
// and every existing link to the bare slug land on home by construction,
// with no second "where does Home live" fact to keep in sync anywhere else.
export function workloadHomePath(slug: string): string {
  return `/media-workloads/${encodeURIComponent(slug)}`
}

export function workloadSetupPath(slug: string): string {
  return `${workloadHomePath(slug)}/setup`
}
