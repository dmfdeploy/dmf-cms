import { Link } from 'react-router-dom'
import { STAGES, type StageId } from '../../lib/workloadLifecycle'

/**
 * The compact vocabulary strip: five Facility Orchestration stages, plus
 * Operate set apart under a Control label.
 *
 * Per the operator's 2026-08-02 ruling on the EBU Facility Orchestration
 * Model graphic: Operate is NOT a sixth stage of the orchestration flow — it
 * falls under the Control vertical, a sibling column alongside Monitor and
 * Security, with the Media Workload Lifecycle axis crossing all of them.
 * This strip mirrors that grouping rather than flattening it: the five
 * orchestration stages (Design → Plan → Provision → Configure → Finalise &
 * Review) chain left to right, then a visual divider sets Operate apart
 * under its own "Control" group label. All six lifecycle names stay present
 * and verbatim — the console's outsider-pedagogy goal (umbrella #200) still
 * requires an EBU-literate viewer to count six — but the grouping now
 * matches the graphic instead of contradicting it.
 *
 * STAGES (lib/workloadLifecycle.ts) is untouched: its order still drives
 * classification elsewhere, so this component derives its own two groups
 * from it rather than reordering the source of truth.
 *
 * The Workspace-verticals direction — surfacing Control/Monitor/Security as
 * first-class workspace areas rather than strip annotations — is recorded as
 * umbrella issue dmfdeploy/dmfdeploy#345 (v0.2); this strip is the interim
 * presentation until that lands.
 *
 * It renders NO state of its own. The highlight comes from the same
 * classification driving the steps below, so the strip and the flow cannot
 * disagree about where the workload is.
 */
export default function LifecycleStrip({
  active,
  slug,
}: {
  /** The workload's stage, or null when the backend could not place it. */
  active: StageId | null
  slug: string
}) {
  const flow = STAGES.filter((stage) => stage.id !== 'operate')
  const operate = STAGES.find((stage) => stage.id === 'operate')!
  const operateActive = operate.id === active

  return (
    <nav aria-label="Media workload lifecycle" className="mt-6">
      <ol className="flex flex-wrap items-center gap-x-1 gap-y-2">
        {flow.map((stage, i) => {
          const isActive = stage.id === active
          const chipClass = `badge text-xs ${
            isActive ? 'bg-accent/20 text-accent' : 'bg-white/5 text-muted'
          }`
          return (
            <li key={stage.id} className="flex items-center gap-1">
              <span className={chipClass} aria-current={isActive ? 'step' : undefined}>
                {stage.label}
              </span>
              {i < flow.length - 1 && (
                <span className="text-muted/40" aria-hidden="true">
                  ›
                </span>
              )}
            </li>
          )
        })}
        <li className="flex items-center gap-2 border-l border-white/10 pl-2">
          <span className="text-[10px] uppercase tracking-wide text-muted">Control</span>
          {/* The one chip that navigates. Operate's content is
              observational and lives on its own route; the chip is a
              real link to a real page, so it is not a dead control. */}
          <Link
            to={`/media-workloads/${encodeURIComponent(slug)}/operate`}
            className={`badge text-xs underline decoration-dotted underline-offset-2 hover:text-accent ${
              operateActive ? 'bg-accent/20 text-accent' : 'bg-white/5 text-muted'
            }`}
            aria-current={operateActive ? 'step' : undefined}
            title="Operate sits in the Control vertical — open its surface"
          >
            {operate.label}
          </Link>
        </li>
      </ol>
    </nav>
  )
}
