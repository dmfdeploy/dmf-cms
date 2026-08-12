import HealthCore from './HealthCore'
import RecentChanges from './RecentChanges'
import PageHeading from '../../components/PageHeading'
import { usePageTitle } from '../../hooks/usePageTitle'

// Workspace — the single role-aware home (IA 2026-06-23 §4.1). The pinned
// core (HealthCore + RecentChanges) is non-removable and identical for
// every role: "is the facility healthy, what just changed" is always
// answered first.
//
// S1 cut (umbrella #285): the admin-only Integration Status / Infrastructure
// Services table is GONE from this page — it was infra plumbing on the
// operator's home screen, and its one genuinely useful payload (the real
// service URLs) moves to facility detail, where it is read from the cluster
// ingress objects instead of an example-domain placeholder.
//
// AdminPanels.tsx is deliberately left in the tree and is now unreferenced.
// Reversing it is small but NOT one line: it needs the import back, plus the
// useCurrentUser hook, the role derivation, and the gated JSX — four edits,
// all in this file. (The Admin page
// has its OWN Integration Status block — it does not render AdminPanels, so
// nothing over there changes.) Its unit test still passes against the
// component directly.
//
// The page is now exactly its two pinned answers, for every role — there is
// no per-role fork left at all. S2 adds an Operate widget here, gated on a
// provisioned media workload.
export default function Workspace() {
  usePageTitle('Workspace')
  return (
    <div className="flex-1 overflow-y-auto p-6">
      <PageHeading>Workspace</PageHeading>
      <HealthCore />
      <RecentChanges />
    </div>
  )
}
