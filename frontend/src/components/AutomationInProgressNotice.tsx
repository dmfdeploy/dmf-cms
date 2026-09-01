import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { Disc3 } from 'lucide-react'

/**
 * The loud, friendly layer next to an in-flight AWX automation job —
 * umbrella #432 (operator feedback: "too much small text on those
 * provision / switch / teardown / delete action... if you must keep all
 * the small text just add large friendly message, i am quite sure the
 * users will ignore all the small text"). First built inline in
 * WorkloadMaterializing.tsx for the provision path; lifted here once the
 * SAME visual treatment was needed for teardown's in-flight state
 * (FinaliseStage.tsx) too.
 *
 * dmfdeploy/dmfdeploy#390 (Phase 1, "the throbber") REPLACES the two-<p>,
 * no-motion, no-elapsed, no-phase version this component used to be. A
 * live operator walkthrough named the exact defect: "automation is
 * running. You need a throbber" — waiting feels longer with no visible
 * proof anything is moving. FOUR elements, deliberately, because they are
 * three INDEPENDENT liveness proofs that fail differently:
 *
 *   - the SPINNER dies under `prefers-reduced-motion` (killed by the CSS
 *     rule paired with `.throbber-spin` in index.css) — it can prove
 *     nothing there;
 *   - the ELAPSED CLOCK always works, but only proves the BROWSER is still
 *     asking (a stalled poll against a truly stuck job would still tick);
 *   - only the CURRENT STEP, swapped as milestone markers arrive, proves
 *     the JOB is moving. This is the whole reason the cross-repo change
 *     (dmf-runbooks milestone markers + the console's during-run read of
 *     them) was worth making.
 *   - the TYPICAL-DURATION line is a statement about OTHER runs, never a
 *     promise about this one (Constitution hard gate 1 — no uncertainty
 *     stated as certainty).
 *
 * NO PROGRESS BAR, NO PERCENTAGE — deliberately absent, not an oversight.
 * A bar invites the eye to read a position this component has no honest
 * fraction for.
 *
 * DEGRADE PATH: `progressStep` is optional and frequently absent — a
 * playbook that hasn't reached its next milestone yet, an uninstrumented
 * action, or a genuinely marker-less dispatch path (see call sites' own
 * comments on when no operation id is available at all). Absent step text
 * is never rendered as blank; the spinner/clock/action-label/typical-
 * duration lines are ALWAYS present regardless, so the box degrades to
 * "elapsed + phase" (the big action label IS the phase), never to nothing.
 *
 * TAIL COVERAGE (operator ruling, dmfdeploy/dmfdeploy#390 follow-up): once
 * the caller's own milestone vocabulary is exhausted — the helm-install +
 * readiness-wait tail, where no further marker is structurally possible —
 * `runningReadout` lets the caller hand this component the same "N of M
 * running" fact `LifecycleStrip`'s own readout already shows elsewhere on
 * the page, so the tail is not a frozen, dead-looking box for the majority
 * of a run. FOUR guardrails, each a way this turns into a lie if dropped:
 *
 *   G1 — NEVER "0 of 0". `runningReadout` is only rendered when
 *        `trustworthy` AND `total > 0`; an unknown/zero expected count
 *        falls back to the frozen step phrase instead of a fabricated
 *        line. This is enforced HERE, not left to callers to remember.
 *   G2 — observed state, not progress. Worded as a fact about what is up
 *        RIGHT NOW ("N of M ... running"), never as a fraction of "done",
 *        and never paired with a bar/percentage (see above — there isn't
 *        one to pair it with).
 *   G3 — freshness. Captioned "as of the last check" — the count derives
 *        from probe data with scrape lag, so it must read as a recent
 *        observation, not a live truth.
 *   G4 — never contradicts the terminal outcome. Structural, not a prop:
 *        this component is only ever rendered by a caller while the
 *        operation is IN FLIGHT; every call site stops rendering it (and
 *        switches to its own terminal UI, driven by `state`) the moment
 *        the operation resolves — this box never renders next to a result.
 *
 * `action`/`typicalDuration`/`children` are all fully caller-owned, same
 * discipline the original component had for `lead`/`children` — provision
 * and teardown are not honestly interchangeable prose (different actions,
 * different typical durations, different claims about what shows up where
 * and when). No shared default exists to inherit a claim that isn't true
 * of the caller's own action.
 */

const MILESTONE_PHRASES: Record<string, string> = {
  'preflight-passed': 'Preflight checks passed',
  provisioning: 'Provisioning the workload',
  configuring: 'Applying configuration',
  'tearing-down': 'Tearing down the workload',
  finalising: 'Finalising cleanup',
}

/**
 * Operator ruling (dmfdeploy/dmfdeploy#390 follow-up): rolls over to hours
 * past 60 minutes — "1h 15m 13s", not "75m 13s". A 60m+ run is by
 * definition a stuck one (every typical-duration claim in this file tops
 * out well under that), which is exactly when the number matters most, and
 * "75m" makes the reader do arithmetic a rollover does instantly. Below 60
 * minutes, behavior is UNCHANGED — "Nm Ss" / seconds-only, same as before.
 */
function formatElapsed(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

/**
 * The non-motion liveness cue (Art. 1 of the decisions record: the spinner
 * dies under `prefers-reduced-motion`, the clock must not). Computed
 * CLIENT-SIDE from a SERVER timestamp (`Operation.created_at`, threaded in
 * as `startedAt`) — deliberately never a client-invented start time. This
 * codebase already rejected that once, for a different readout
 * (LifecycleStrip's own `jobInFlight` branch): "no elapsed-since-start
 * fact exists... inventing a client-side start timestamp here would be
 * exactly that new clock, for a number this rail could not verify against
 * anything." `startedAt` being `null` here (no operation id was ever
 * available to read one from — see call sites) means this hook returns
 * `null` too, honestly, rather than starting a clock from the moment the
 * component happened to mount.
 */
function useElapsedSeconds(startedAt: string | null): number | null {
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    if (!startedAt) return
    const id = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(id)
  }, [startedAt])
  if (!startedAt) return null
  const startedMs = new Date(startedAt).getTime()
  if (Number.isNaN(startedMs)) return null
  return Math.max(0, Math.floor((nowMs - startedMs) / 1000))
}

export interface AutomationRunningReadout {
  running: number
  total: number
  // G1: the SAME freshness/completeness gate LifecycleStrip's own readout
  // uses (lib/workloadLifecycle.ts's isGroupedReadTrustworthy) — the
  // caller is expected to pass this through unmodified, not re-derive a
  // second formula. See that function's own docstring for the exact rule.
  trustworthy: boolean
}

export default function AutomationInProgressNotice({
  action,
  startedAt,
  progressStep,
  typicalDuration,
  runningReadout,
  stale,
  children,
}: {
  /** Plain-words action label — "Provisioning", "Tearing down". Also the
   * "+phase" half of the degrade path when no step marker has arrived. */
  action: string
  /** Operation.created_at, or null when no operation id is available to
   * this call site (a genuinely marker-less dispatch path) — see this
   * file's own useElapsedSeconds docstring for why that means no clock,
   * never a guessed one. */
  startedAt: string | null
  /** Operation.progress_step, raw — mapped through MILESTONE_PHRASES here
   * so callers never need to know the token vocabulary. An unrecognized
   * or absent token renders no step line at all (fails open to the
   * degrade path), never a raw token leaking into operator-facing copy. */
  progressStep?: string | null
  /** Caller-owned duration fragment, e.g. "a few minutes" — rendered as
   * "Typically takes {typicalDuration}." Never "will take" (Constitution
   * hard gate 1). */
  typicalDuration: string
  /** Tail-coverage fact (see this file's own docstring, "TAIL COVERAGE").
   * Pass this ONLY once the caller's own milestone vocabulary is
   * exhausted — the component does not know or guess that boundary
   * itself, since only the caller knows which token is "last" for its
   * own action. Omit/null at every other time, including the whole
   * degrade path (no operation id at all). */
  runningReadout?: AutomationRunningReadout | null
  /** The caller's own operation poll settled on a failed refetch and is
   * showing RETAINED data (same `settleQuery` shape every other status
   * line in this app already surfaces — JobProgress.tsx's own
   * OperationStatusLine/JobStatusLine). Elapsed/step/running-count above
   * all stay exactly as last known (a retained start time or step is still
   * a true fact about the run, never a fabricated one) — this only adds
   * the same honest caption those other lines already use, so a stuck poll
   * never reads as a silently-current one. */
  stale?: boolean
  children: ReactNode
}) {
  const elapsedSeconds = useElapsedSeconds(startedAt)
  const stepPhrase = progressStep ? MILESTONE_PHRASES[progressStep] : undefined
  // G1 + G2: only a trustworthy, non-empty count ever displaces the frozen
  // step phrase — an untrustworthy or zero-total read falls back to
  // whatever step text is already known, never a fabricated "0 of 0".
  const showRunningReadout =
    runningReadout != null && runningReadout.trustworthy && runningReadout.total > 0

  return (
    <div>
      {/* FIX ROUND (dmfdeploy/dmfdeploy#514, operator: "disc-3 not centered
          vertically to the text it belongs to"): `items-baseline` ->
          `items-center`. Tailwind's preflight sets `svg { display: block }`,
          so the disc icon's own box has no text baseline to align to — it
          was aligning to its BOTTOM edge instead, which is what read as
          misplaced. `items-center` aligns every child by its own box's
          vertical MIDPOINT instead, which is a property the icon actually
          has. Checked against all three children (icon, `text-lg` label,
          `text-sm` clock) on a real render before landing on this, not just
          the icon — see the WO report for the measured before/after boxes. */}
      <div className="flex items-center gap-2">
        {/* dmfdeploy/dmfdeploy#514 (mark): lucide's Disc3, not the old ◐
            glyph — same `throbber-spin` class (the reduced-motion kill in
            index.css and a test that greps the shipped stylesheet both key
            off that class name, so reusing it as-is needs neither to
            change), same aria-hidden, same 1.5s linear rotation, default
            lucide stroke weight (strokes-vs-filled is
            dmfdeploy/dmfdeploy#507's question, not this one). Sized h-6 w-6
            (24px) to match what ◐ actually occupied at this notice's
            rendered size (measured live via pages/Dev/ThrobberHarness.tsx:
            ~28x26px bounding box at the ambient 16px font-size, closest
            square match) — not assumed at 1em. */}
        <span aria-hidden="true" className="throbber-spin inline-block shrink-0 text-accent">
          <Disc3 className="h-6 w-6" />
        </span>
        <p className="text-lg font-medium text-text">{action}</p>
        {elapsedSeconds !== null && (
          // aria-live="off": a screen reader announcing this every second
          // would be actively hostile, not helpful — the clock is a VISUAL
          // liveness cue, not something to narrate on every tick.
          <span
            aria-live="off"
            className="ml-auto shrink-0 whitespace-nowrap font-mono text-sm text-muted tabular-nums"
          >
            {formatElapsed(elapsedSeconds)}
          </span>
        )}
      </div>
      {showRunningReadout ? (
        // G3: captioned as a recent observation, never a live truth — the
        // count derives from probe data with scrape lag.
        <p className="mt-1 text-muted">
          {runningReadout!.running} of {runningReadout!.total} services running, as of the last check.
        </p>
      ) : (
        stepPhrase && <p className="mt-1 text-muted">{stepPhrase}</p>
      )}
      <p className="mt-1 text-muted">Typically takes {typicalDuration}.</p>
      <p className="mt-1 text-muted">{children}</p>
      {stale && (
        <p className="mt-1 text-amber-300">Could not confirm — showing the last read, retrying</p>
      )}
    </div>
  )
}
