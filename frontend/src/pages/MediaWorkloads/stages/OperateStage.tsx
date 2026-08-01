import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useCatalog } from '../../../api/hooks'
import type { MediaWorkload, MediaWorkloadInstance } from '../../../api/types'
import type { StageState } from '../../../lib/workloadLifecycle'
import WorkloadTile from '../WorkloadTile'
import InstanceLiveModal from '../InstanceLiveModal'
import {
  LIVE_TILE_CAP,
  useDocumentVisible,
  usePrefersReducedMotion,
} from '../liveView'
import StageCard from './StageCard'

/**
 * Operate — read-only running state plus a pointer to Workspace → Problems.
 * Carries NO action, by design (corrected S1/S2 framing, umbrella #285): it
 * is a lifecycle STAGE, not a vertical, but its own surface is
 * observational — the operational surfaces (monitoring of media functions
 * and underlying facility resources) live on Workspace, not here. S2 adds
 * a dedicated Operate widget there; this stage states that honestly today
 * rather than inventing a control the console doesn't have yet.
 */
export default function OperateStage({
  workload,
  state,
}: {
  workload: MediaWorkload
  state: StageState
}) {
  const instances = [...workload.instances].sort((a, b) => a.instance.localeCompare(b.instance))
  const [openInstance, setOpenInstance] = useState<MediaWorkloadInstance | null>(null)

  // Human names, not catalog slugs: the tile joins function_key to the
  // catalog's display_name, falling back to the key and then the instance so
  // a missing catalog entry degrades to something true rather than blank.
  const { data: catalog } = useCatalog()
  const displayNames = useMemo(() => {
    const map = new Map<string, string>()
    for (const entry of catalog?.entries ?? []) map.set(entry.key, entry.display_name)
    return map
  }, [catalog?.entries])
  const nameFor = (i: MediaWorkloadInstance) =>
    displayNames.get(i.function_key ?? '') ?? i.function_key ?? i.instance

  const visible = useDocumentVisible()
  const reducedMotion = usePrefersReducedMotion()

  // The live-tile cap, unchanged from the retired instance grid: only the
  // first N previews auto-churn. Polling also stops while the modal is open —
  // the modal is the single fast-cadence surface (codex P2).
  const motionTiles = new Set<string>()
  for (const inst of instances) {
    if (inst.live_view && motionTiles.size < LIVE_TILE_CAP) motionTiles.add(inst.instance)
  }
  const tilesActive = state !== 'not-applicable' && visible && openInstance === null

  return (
    <StageCard label="Operate" state={state}>
      {state === 'not-applicable' ? (
        <p className="text-muted">
          Nothing is running yet for this workload — Operate will show live state once
          Provision and Configure have run.
        </p>
      ) : (
        // The live view IS the read-only running state Operate exists to
        // show. The tile already carries instance name, requested/observed
        // badges and placement, so there is no separate status list beside
        // it — one instance, one row of truth.
        //
        // The tiles carry NO action here: showClear={false} keeps the C5
        // clear control out, because the rail authorises actions per stage
        // and Operate carries none. A control smuggled in through a shared
        // component would break that invariant from the side.
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {instances.map((inst) => (
            <WorkloadTile
              key={inst.instance}
              instance={inst}
              displayName={nameFor(inst)}
              active={tilesActive}
              motionAllowed={motionTiles.has(inst.instance) && !reducedMotion}
              onOpen={setOpenInstance}
              showClear={false}
            />
          ))}
        </div>
      )}

      {openInstance && (
        <InstanceLiveModal
          instance={openInstance}
          displayName={nameFor(openInstance)}
          onClose={() => setOpenInstance(null)}
        />
      )}

      <p className="mt-4 text-xs text-muted">
        For live health across the facility, see{' '}
        <Link to="/" className="text-accent hover:underline">
          Workspace → Problems
        </Link>
        .
      </p>
    </StageCard>
  )
}
