import HealthCore from './HealthCore'
import ActivityPanel from '../../components/ActivityPanel'
import PageHeading from '../../components/PageHeading'
import { usePageTitle } from '../../hooks/usePageTitle'

// Workspace — the single role-aware home (IA 2026-06-23 §4.1). The pinned
// core (HealthCore + ActivityPanel) is non-removable and identical for
// every role: "is the facility healthy, what just changed" is always
// answered first.
//
// dmfdeploy/dmfdeploy#419/#554, 2026-09-04: the pinned "what just changed"
// widget used to be RecentChanges (deleted — /api/changes/jobs, raw AWX job
// records only). It's now ActivityPanel, titled plain "Activity" — not
// "Facility activity" the way Activity → History titles the same component,
// since this page already has its own "Facilities" rail item and "Facility
// activity" here would misname itself. Same durable, server-side audit
// record (/api/audit/events) either way. A viewer's own role gates every
// record class server-side, same as it always gated deploy/teardown/
// rollback themselves — an operator-only environment renders normally; a
// viewer sees this panel's own honest "no actions in your permitted view"
// empty state, not a claim that the facility was idle (see ActivityPanel's
// own comment). Accepted as-is, deliberately — not something to "fix" here.
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
      <ActivityPanel title="Activity" />
    </div>
  )
}
