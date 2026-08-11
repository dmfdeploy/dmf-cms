import { useHeaderSlotContent } from '../../store/headerSlot'
import LifecycleStrip from '../../pages/MediaWorkloads/LifecycleStrip'

/**
 * Test-only stand-in for Topbar's header-slot rendering (Arc 4 WP-3,
 * umbrella dmfdeploy/dmfdeploy#347). WorkloadDetail/Operate register the
 * rail into the header slot rather than rendering it inline now
 * (store/headerSlot.ts); mount this alongside them in a test so the
 * existing rail()-style DOM queries keep finding the same LifecycleStrip
 * output, without pulling in the real Topbar's own data dependencies
 * (breadcrumb queries, notification bell, an authenticated user) into test
 * files that don't otherwise need them.
 *
 * WHAT THIS DOES NOT PROVE. The ROUTE-SCOPED MOUNTING CONTRACT — rail
 * absent on /new, present+selecting on /:slug, present+Operate-selected on
 * /:slug/operate — is a fact about Topbar's OWN route-gating logic, which
 * this probe does not exercise at all (it renders unconditionally,
 * wherever it is mounted). That contract has its own App/Shell integration
 * test; this probe exists only so the many existing page-behaviour tests
 * that assert on the rail's contents keep working without becoming
 * Topbar-integration tests themselves.
 */
export default function HeaderSlotProbe() {
  const content = useHeaderSlotContent()
  if (!content) return null
  return <LifecycleStrip {...content.rail} slug={content.slug} />
}
