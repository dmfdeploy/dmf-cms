import { History } from 'lucide-react'
import { useAuditEvents } from '../api/hooks'
import {
  classifyAuditEvents,
  auditEventsEmptyCopy,
  auditWindowCopy,
  auditOutcomeLabel,
  groupExclusions,
  AUDIT_EVENTS_CAPPED_COPY,
} from '../lib/auditEventsState'
import type { AuditEvent, AuditEventOutcome } from '../api/types'

// Per-class title, honest about acceptance-vs-verdict (plan §4.4/AC 2): a
// watched action never claims completion, so its title says "dispatched",
// never a past-tense verb implying it finished. switch-source is the one
// class with a real terminal outcome, so it's the only one allowed a
// succeeded/failed past-tense title. 'unknown' (codex R496-C P1-2) gets
// its own honest phrasing — never folded into "failed" or "dispatched",
// either of which would claim knowledge the row does not have.
function eventTitle(event: AuditEvent): string {
  const label = event.workload ?? event.target
  const state = event.outcome.state
  switch (event.class) {
    case 'deploy':
      if (state === 'failed') return `Deploy failed for ${label}`
      if (state === 'unknown') return `Deploy — outcome unknown for ${label}`
      return `Deploy dispatched for ${label}`
    case 'teardown':
      if (state === 'failed') return `Teardown failed for ${label}`
      if (state === 'unknown') return `Teardown — outcome unknown for ${label}`
      return `Teardown dispatched for ${label}`
    case 'auto-rollback': {
      const suffix = event.workload ? ` for ${event.workload}` : ''
      if (state === 'failed') return `Automatic rollback failed${suffix}`
      if (state === 'unknown') return `Automatic rollback — outcome unknown${suffix}`
      return `Automatic rollback dispatched${suffix}`
    }
    case 'switch-source':
      if (state === 'succeeded') return `Switched source on ${event.target}`
      if (state === 'unknown') return `Switch source on ${event.target} — outcome unknown`
      return `Switch source failed on ${event.target}`
  }
}

function AuditEventOutcomeBlock({ outcome }: { outcome: AuditEventOutcome }) {
  const badgeClass =
    outcome.state === 'succeeded'
      ? 'bg-green-500/20 text-green-400'
      : outcome.state === 'failed'
        ? 'bg-red-500/20 text-red-400'
        : outcome.state === 'unknown'
          ? 'bg-gray-500/20 text-gray-400'
          : 'bg-blue-500/20 text-blue-400'
  // Default level (plan §4.5 / AC 2a): what happened, what it means for
  // the facility, what to do next — all three, not just headline+
  // next_step (codex R496-A F4 caught `meaning` silently missing here).
  // Shared by 'failed' AND 'unknown' (codex R496-C P1-2) — both need an
  // honest explanation at default; only 'failed' also carries a raw
  // system-error string worth gating below.
  const plainLanguageBlock = outcome.headline && (
    <div className="mt-1 text-xs text-muted">
      <p>{outcome.headline}</p>
      {outcome.meaning && <p className="mt-0.5">{outcome.meaning}</p>}
      {outcome.next_step && <p className="mt-0.5">{outcome.next_step}</p>}
    </div>
  )
  return (
    <div className="mt-2">
      {/* umbrella #554, operator decision 2026-09-04: the pill this badge
          renders is REMOVED entirely for 'in_flight' (a watched action —
          deploy/teardown/rollback/auto-rollback — still running). The
          row's own title already says "Deploy dispatched for X"; a badge
          repeating "In progress" on top of that adds no information, and
          it never ages (a job dispatched three weeks ago would still read
          "In progress" today — see #554's own live evidence). Options
          considered and rejected: relabelling it "Dispatched" (redundant
          with the title) and naming the lane's own ignorance, e.g.
          "Outcome not recorded" (this session's own earlier lean, formally
          overruled — recorded on #554 so it isn't reopened). Every OTHER
          state keeps its badge, switch-source included — it carries a real
          terminal verdict, never 'in_flight'. */}
      {outcome.state !== 'in_flight' && (
        <span className={`inline-block px-2 py-1 rounded text-xs font-semibold ${badgeClass}`}>
          {auditOutcomeLabel(outcome)}
        </span>
      )}
      {plainLanguageBlock}
      {outcome.state === 'failed' && (
        // Expert level ONLY: a raw system-error string (e.g.
        // awx-error:503) must not reach the default view at all —
        // CSS-muted-but-always-rendered is NOT an access boundary
        // (codex R496-A F4). A closed <details> keeps it out of the
        // rendered default view; expanding it is the deliberate,
        // explicit act that makes reading it "expert level". Not shown
        // for 'unknown' — its detail is always "" (that IS the lost
        // field), nothing to disclose.
        <details className="mt-1">
          <summary className="text-xs text-muted/70 cursor-pointer select-none">
            Technical detail (for support)
          </summary>
          <p className="text-xs text-muted/70 mt-1 font-mono">{outcome.detail}</p>
        </details>
      )}
      {(outcome.state === 'in_flight' || outcome.state === 'succeeded') && (
        // An ordinary operational word (dispatched, launched, active,
        // ...), never a raw system-error string — safe to show plainly,
        // same convention as the Jobs panel keeping the raw AWX template
        // name as a muted line (lib/labels.ts's describeJob comment). For
        // 'in_flight' this is now the ONLY outcome text on the row (the
        // badge above it is gone) — still honest and still there, just no
        // longer duplicated into a second, non-aging pill.
        <p className="text-xs text-muted/70 mt-1 font-mono">{outcome.detail}</p>
      )}
    </div>
  )
}

interface ActivityPanelProps {
  title: string
}

// The durable, server-side audit record (dmfdeploy/dmfdeploy#496), over
// /api/audit/events, gated per record class — every operator sees the same
// rows regardless of browser. Shared by Activity → History (rendered there
// as "Facility activity") and Workspace (dmfdeploy/dmfdeploy#419/#554,
// rendered there as plain "Activity" — Workspace already has its own
// "Facilities" page, so "Facility activity" there would misname itself).
// Same data, same states, same disclosures at both sites; only the heading
// text is parameterized. A NEW render site on Workspace, not a component
// move — Activity → History keeps its own instance.
export default function ActivityPanel({ title }: ActivityPanelProps) {
  const auditState = classifyAuditEvents(useAuditEvents())
  const exclusions = groupExclusions(auditState.excluded)

  return (
    <div className="panel mb-6">
      <div className="px-6 py-4 border-b border-panel">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <History className="w-5 h-5 text-accent" />
          {title}
        </h2>
        <p className="text-xs text-muted mt-1">
          Deploys, teardowns, source switches, and automatic rollbacks —
          recorded server-side, the same for every browser. Shows what
          your role is permitted to see, not a merged view across every
          role: deploy/teardown/rollback need operator, source switches
          need engineer or media-engineers membership.{' '}
          {auditWindowCopy(auditState.window)}
        </p>
        {(exclusions.access.length > 0 || exclusions.scope.length > 0) && (
          <p className="text-xs text-muted mt-1">
            {exclusions.access.length > 0 && (
              <>Kept off this record, access-scoped: {exclusions.access.join(', ')}. </>
            )}
            {exclusions.scope.length > 0 && (
              <>Not shown here yet — out of scope this round, not a security decision: {exclusions.scope.join(', ')}.</>
            )}
          </p>
        )}
        {/* Operator ruling, 2026-09-03: name the stopgap honestly and
            visibly, here (not the Workspace) — this surface isn't on the
            demo path, so it costs nothing to state plainly. STATE, don't
            apologise, and be specific about the two limits that actually
            bite rather than a disclaimer that says nothing checkable.
            codex (residual, orchestrator's own miss): the switch-source
            exemption below is qualified, not unconditional — a record
            whose outcome field itself is blank resolves outcome=''
            before the switch-source branch even runs, same as
            deploy/teardown's blank case, and renders "outcome unknown"
            here too (resolve_outcome_state checks blank first). The
            clause below now says switch-source differs in KIND (a real
            verdict is possible), not that it's immune to the general
            unknown case.
            dmfdeploy/dmfdeploy#552/#553: two more overclaims found by a
            live walk, both corrected below. Deploy/teardown's own
            refusal record is gated on the SAME role+reason checks the
            request itself is gated on (main.py's C5 quartet) — a
            refusal ahead of those checks (wrong role, no reason) writes
            no record at all, so "any refusal" was too strong. And
            outcome-unknown is reached only by a complete, parseable
            line whose outcome field is blank — a truncated/malformed
            line fails parsing and is dropped before it ever reaches an
            outcome, so "if truncated" named the wrong cause. This surface
            is now on TWO pages (Workspace included, umbrella#419/#554) —
            the same honesty bar applies at both, since Workspace is the
            more-visible one, not the less. */}
        <p className="text-xs text-muted mt-1">
          First implementation of this lane — for deploy and teardown, it
          records the request and any refusal after the role and reason
          checks, but an accepted one is never updated with whether the
          job later finished. Switch source normally carries a real
          succeeded or failed outcome instead — unlike deploy and
          teardown — but is subject to the same outcome-unknown case as
          any other record when its outcome field is blank. Coverage is
          bounded by the window stated above, not a guarantee of
          complete history.
        </p>
      </div>
      <div className="divide-y divide-panel">
        {auditState.phase === 'loading' ? (
          <div className="px-6 py-8 text-center text-muted text-sm">Loading facility activity...</div>
        ) : (
          <>
            {auditState.phase !== 'ok' && (
              <div className="px-6 py-2 text-xs text-amber-300 bg-amber-500/10">
                {auditEventsEmptyCopy(auditState.phase)}
              </div>
            )}
            {auditState.phase === 'ok' && auditState.capped && (
              <div className="px-6 py-2 text-xs text-amber-300 bg-amber-500/10">{AUDIT_EVENTS_CAPPED_COPY}</div>
            )}
            {auditState.events.length === 0 ? (
              auditState.phase === 'ok' && (
                <div className="px-6 py-8 text-center text-muted text-sm">
                  {auditEventsEmptyCopy(auditState.phase)}
                </div>
              )
            ) : (
              auditState.events.map((event) => (
                // lkirc (dmfdeploy/dmf-cms#140): request_id alone is
                // NOT a per-row identity — an L3 preflight's own
                // capacity-skipped/capacity-override row shares its
                // request_id with that same request's later dispatched
                // row. Duplicate sibling keys make React reconciliation
                // unstable across this panel's refetch, which can
                // surface as a row rendering stale or swapped content —
                // demo-visible and easy to mistake for the DATA being
                // wrong. at_ns is Loki's own raw per-log-line timestamp
                // (unrounded, unlike `at`), a real distinguishing
                // identity for two rows sharing one request_id.
                <div key={`${event.request_id}-${event.at_ns}`} className="px-6 py-4 hover:bg-panel/30 transition">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <h3 className="font-semibold text-sm">{eventTitle(event)}</h3>
                      <p className="text-xs text-muted mt-1">
                        {event.actor} ({event.role}) · “{event.reason}”
                      </p>
                      <AuditEventOutcomeBlock outcome={event.outcome} />
                    </div>
                    <div className="text-right text-xs text-muted shrink-0">
                      {event.at && new Date(event.at).toLocaleString()}
                    </div>
                  </div>
                </div>
              ))
            )}
          </>
        )}
      </div>
    </div>
  )
}
