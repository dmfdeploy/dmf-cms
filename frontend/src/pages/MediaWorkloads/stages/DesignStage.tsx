import { useInstanceTopology } from '../../../api/hooks'
import type { CatalogEntry, MediaWorkload } from '../../../api/types'
import type { StageState } from '../../../lib/workloadLifecycle'
import StageCard from './StageCard'

/**
 * Design — read-only from catalog SoT (never mutating): the selected
 * template(s) and the workload's composition. This is where the Catalog
 * page's DESCRIPTIVE content relocates (display name, summary, EBU system
 * details); the deploy/teardown MUTATIONS stay off this stage — they live
 * on Provision/Finalise, where the rail says they belong.
 *
 * Design and Plan are always 'informational' per lib/workloadLifecycle.ts
 * (never 'active', never 'not-applicable') — the chosen template and the
 * assigned facility are facts even before anything has run.
 */
export default function DesignStage({
  workload,
  catalogEntries,
  catalogLoading,
  catalogFailed,
  state,
}: {
  workload: MediaWorkload
  catalogEntries: CatalogEntry[]
  catalogLoading: boolean
  // fix-round 5 (PR #81, codex sibling sweep): a failed catalog read left
  // `catalogEntries` empty exactly like a genuinely-empty catalog would —
  // every function's join then missed, and EVERY item below rendered "this
  // function key isn't in the current catalog… may have been removed" for a
  // reason that had nothing to do with removal. See below.
  catalogFailed: boolean
  state: StageState
}) {
  const entries = workload.functions
    .map((fn) => ({ fn, entry: catalogEntries.find((e) => e.key === fn.function_key) }))
    // Deterministic order: same sort key the rest of Media Workloads uses.
    .sort((a, b) => a.fn.function_key.localeCompare(b.fn.function_key))

  return (
    <StageCard label="Design" state={state}>
      <div className="space-y-4">
        <div>
          <h3 className="text-xs uppercase tracking-wide text-muted">Templates</h3>
          {/* fix-round 5: named ONCE at the section level — a failed catalog
              read misses EVERY join below, so accusing each function
              individually of having been "removed" would repeat a false
              claim once per row instead of naming the real, single cause.
              "Retrying automatically" is not said here on purpose: useCatalog
              carries no refetchInterval, so nothing is actually retrying
              (the same true-tail correction CreateWorkload.tsx's
              TemplatePicker already made). */}
          {catalogFailed && (
            <p className="mt-1 text-xs text-amber-200/80">
              The catalog couldn&apos;t be read right now, so template details below could not
              be checked. Reload the page to try the read again.
            </p>
          )}
          {entries.length === 0 ? (
            <p className="mt-1 text-muted">
              {catalogLoading
                ? 'Loading template information…'
                : 'No templates recorded for this workload yet.'}
            </p>
          ) : (
            <ul className="mt-2 space-y-3">
              {entries.map(({ fn, entry }) => (
                <li key={fn.function_key} className="border-t border-white/5 pt-3 first:border-t-0 first:pt-0">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-medium text-text">
                      {entry?.display_name ?? fn.function_key}
                    </span>
                    <span className="text-xs text-muted">
                      {fn.running}/{fn.count} instance{fn.count !== 1 ? 's' : ''}
                    </span>
                  </div>
                  {entry?.summary && <p className="mt-1 text-xs text-muted">{entry.summary}</p>}
                  {!entry && !catalogFailed && (
                    <p className="mt-1 text-xs text-amber-200/80">
                      This function key isn&apos;t in the current catalog — it may have been
                      removed since this workload was deployed.
                    </p>
                  )}
                  {entry &&
                    (entry.ebu_layer || entry.ebu_vertical || entry.ebu_media_function_type || entry.ebu_lifecycle_owner) && (
                      <details className="mt-1 text-xs text-muted">
                        <summary className="cursor-pointer select-none opacity-80 hover:opacity-100">
                          System details
                        </summary>
                        <p className="mt-1 pl-4">
                          {entry.ebu_layer ? `EBU layer ${entry.ebu_layer}` : ''}
                          {entry.ebu_layer && (entry.ebu_vertical || entry.ebu_media_function_type) ? ' · ' : ''}
                          {entry.ebu_vertical ? <span className="capitalize">{entry.ebu_vertical}</span> : ''}
                          {entry.ebu_media_function_type ? (
                            <span className="capitalize"> {entry.ebu_media_function_type}</span>
                          ) : (
                            ''
                          )}
                          {(entry.ebu_layer || entry.ebu_vertical || entry.ebu_media_function_type) &&
                          entry.ebu_lifecycle_owner
                            ? ' · '
                            : ''}
                          {entry.ebu_lifecycle_owner ? <span className="capitalize">{entry.ebu_lifecycle_owner}</span> : ''}
                        </p>
                      </details>
                    )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h3 className="text-xs uppercase tracking-wide text-muted">Composition</h3>
          <div className="mt-2 space-y-2">
            {[...workload.instances]
              .sort((a, b) => a.instance.localeCompare(b.instance))
              .map((inst) => (
                <InstanceComposition key={inst.instance} instance={inst.instance} />
              ))}
          </div>
        </div>
      </div>
    </StageCard>
  )
}

/**
 * Renders the ONE structural fact the console can read about this
 * instance's composition — the same topology read seam Configure uses to
 * arm a switch, here read-only. Renders nothing when the instance carries
 * no topology (the common case for every non-viewer instance) — matching
 * the exact "renders nothing, not an error" contract the switch control
 * already established, so an ordinary source instance doesn't grow a
 * confusing empty box.
 */
function InstanceComposition({ instance }: { instance: string }) {
  const topology = useInstanceTopology(instance)
  // fix-round 5 (PR #81, codex sibling sweep): this was the unfixed twin of
  // Operate.tsx's InstanceActiveSource — same seam, same missing check. An
  // errored read is unknown, not absence: a failed refetch can retain the
  // prior successful data while isError flips true (useInstanceTopology has
  // retry:false, and ConfigureStage's switch control calls topology.refetch()
  // right after a successful source switch — so the reachable path is
  // "operator switches source on Configure, the refetch here fails, and this
  // line keeps naming the OLD source as active on the very page where they
  // just changed it"). The row withdraws on error too, same as its sibling —
  // the newest read is the one it speaks for.
  if (topology.isError || !topology.data || !Array.isArray(topology.data.sources)) return null

  const { sources, active_source } = topology.data
  if (sources.length === 0) return null

  return (
    <p className="text-xs text-muted">
      <span className="font-mono text-text">{instance}</span> (viewer) — composed of{' '}
      {sources
        .map((s) => `${s.id} (${s.pattern})${s.id === active_source ? ', active' : ''}`)
        .join('; ')}
    </p>
  )
}
