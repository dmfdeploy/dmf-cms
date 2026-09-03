import { useChangesJobs, useChangesCommits, useChangesPulls, useAuditEvents } from '@/api/hooks'
import { GitCommit, GitPullRequest, History, MousePointerClick, Zap, ExternalLink } from 'lucide-react'
import { useActivityStore, type ConsoleActionType } from '../../store/activity'
import { describeJob, jobOutcome } from '../../lib/labels'
import { classifyChanges, changesEmptyCopy, classifyForgejo, forgejoEmptyCopy } from '../../lib/changesState'
import {
  classifyAuditEvents,
  auditEventsEmptyCopy,
  auditWindowCopy,
  auditOutcomeLabel,
  groupExclusions,
} from '../../lib/auditEventsState'
import type { AuditEvent, AuditEventOutcome } from '../../api/types'

// Per-class title, honest about acceptance-vs-verdict (plan §4.4/AC 2): a
// watched action never claims completion, so its title says "dispatched",
// never a past-tense verb implying it finished. switch-source is the one
// class with a real terminal outcome, so it's the only one allowed a
// succeeded/failed past-tense title.
function eventTitle(event: AuditEvent): string {
  const label = event.workload ?? event.target
  const failed = event.outcome.state === 'failed'
  switch (event.class) {
    case 'deploy':
      return failed ? `Deploy failed for ${label}` : `Deploy dispatched for ${label}`
    case 'teardown':
      return failed ? `Teardown failed for ${label}` : `Teardown dispatched for ${label}`
    case 'auto-rollback':
      return failed
        ? `Automatic rollback failed${event.workload ? ` for ${event.workload}` : ''}`
        : `Automatic rollback dispatched${event.workload ? ` for ${event.workload}` : ''}`
    case 'switch-source':
      return event.outcome.state === 'succeeded'
        ? `Switched source on ${event.target}`
        : `Switch source failed on ${event.target}`
  }
}

function AuditEventOutcomeBlock({ outcome }: { outcome: AuditEventOutcome }) {
  const badgeClass =
    outcome.state === 'succeeded'
      ? 'bg-green-500/20 text-green-400'
      : outcome.state === 'failed'
        ? 'bg-red-500/20 text-red-400'
        : 'bg-blue-500/20 text-blue-400'
  return (
    <div className="mt-2">
      <span className={`inline-block px-2 py-1 rounded text-xs font-semibold ${badgeClass}`}>
        {auditOutcomeLabel(outcome)}
      </span>
      {outcome.state === 'failed' && outcome.headline && (
        <div className="mt-1 text-xs text-muted">
          <p>{outcome.headline}</p>
          {outcome.next_step && <p className="mt-0.5">{outcome.next_step}</p>}
        </div>
      )}
      {/* Raw token, demoted to expert detail — same convention as the Jobs
          panel below keeping the raw AWX template name as a muted line
          under the humanised title (see lib/labels.ts's describeJob
          comment). Never the ONLY thing shown for a failure — the plain-
          language block above renders first. */}
      <p className="text-xs text-muted/70 mt-1 font-mono">{outcome.detail}</p>
    </div>
  )
}

// Human title per console-originated action (#185 WP-E: AWX writes join the
// clear record in this lane).
function actionTitle(action: ConsoleActionType, target: string): string {
  switch (action) {
    case 'clear-for-deployment':
      return `Cleared ${target} for deployment`
    case 'deploy':
      return `Deployed ${target}`
    case 'teardown':
      return `Tore down ${target}`
    case 'launch':
      return `Launched ${target}`
    case 'switch-source':
      return `Switched source on ${target}`
    case 'finalise-purge':
      return `Deleted ${target} permanently`
  }
}

// History lane — "what just changed" (IA §5): the audit/history lens the
// merge condition protects. The former /changes page body plus the
// console-local record of console-originated actions (#173 follow-on).
// Rows are keyed by stable identity, not index — unchanged data must not
// rebuild DOM (hard gate 5; this page's predecessor was the measured
// anti-pattern).
export default function HistoryLane() {
  const jobs = useChangesJobs()
  const commits = useChangesCommits()
  const pulls = useChangesPulls()
  const auditState = classifyAuditEvents(useAuditEvents())
  const exclusions = groupExclusions(auditState.excluded)
  const consoleActions = useActivityStore((s) => s.records)
  // dmfdeploy/dmfdeploy#496: deploy/teardown/switch-source/auto-rollback
  // are now the facility panel's job — server-side, every browser agrees.
  // Rendering them from this client-only store too would be exactly the
  // "two answers that can disagree" defect this round exists to remove, so
  // this panel narrows to the three classes that have NO server answer
  // this round: clear-for-deployment never emits this stream's line at
  // all (a different record entirely — plan §4.3), and finalise-purge/
  // launch are the facility panel's own disclosed exclusions. The write
  // call sites (ProvisionStage/FinaliseStage/ConfigureStage/Catalog/
  // JobsLane) are untouched — this is a display-only filter, so it also
  // quietly drops any deploy/teardown/switch-source rows already sitting
  // in a returning user's localStorage from before this change.
  const localOnlyActions = consoleActions.filter(
    (rec) => rec.action === 'clear-for-deployment' || rec.action === 'finalise-purge' || rec.action === 'launch',
  )
  // Same classifier as the Workspace RecentChanges widget — one endpoint,
  // one set of designed states (Art. 1).
  const jobsState = classifyChanges(jobs)
  // Same classifier the jobs panel above uses, applied to Forgejo's two
  // sibling reads (hard gate 1: an empty/failed read is not "zero commits").
  const commitsPhase = classifyForgejo(commits)
  const pullsPhase = classifyForgejo(pulls)
  // fix-round 3 (PR #81): the two phases that can co-exist with NON-EMPTY
  // retained rows and therefore need a notice regardless of emptiness.
  // 'partial' (fix-round 2): some repos read, some failed, real rows kept.
  // 'error' (this round): a SETTLED failed refetch — TanStack Query
  // retains the last-good `data` across it, so `isLoading` is false and
  // the panel below still has real rows to render, but the CURRENT read
  // failed. Without this, those retained rows rendered with no notice at
  // all — presenting last-good data as current after the read that would
  // have confirmed it had already failed (same defect class as
  // MediaWorkloads/WorkloadCountPanel/classifyChanges' own isError fixes).
  const commitsNeedsNotice = commitsPhase === 'partial' || commitsPhase === 'error'
  const pullsNeedsNotice = pullsPhase === 'partial' || pullsPhase === 'error'

  const isLoading = jobs.isLoading || commits.isLoading || pulls.isLoading

  return (
    <div>
      {/* Facility activity (dmfdeploy/dmfdeploy#496) — server-side, over
          Loki, gated per record class. The durable answer to "what
          happened" the rest of this page is built around: every operator
          sees the same rows regardless of browser. */}
      <div className="panel mb-6">
        <div className="px-6 py-4 border-b border-panel">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <History className="w-5 h-5 text-accent" />
            Facility activity
          </h2>
          <p className="text-xs text-muted mt-1">
            Deploys, teardowns, source switches, and automatic rollbacks —
            recorded server-side and visible to every operator, regardless
            of browser. {auditWindowCopy(auditState.window)}
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
              {auditState.events.length === 0 ? (
                auditState.phase === 'ok' && (
                  <div className="px-6 py-8 text-center text-muted text-sm">
                    {auditEventsEmptyCopy(auditState.phase)}
                  </div>
                )
              ) : (
                auditState.events.map((event) => (
                  <div key={event.request_id} className="px-6 py-4 hover:bg-panel/30 transition">
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

      {/* This browser's own actions — explicitly NOT a facility record
          (umbrella#496 condition 4). Narrowed to exactly the three classes
          the facility panel above does not carry: clear-for-deployment
          never emits the "awx write:" line this lane reads at all (a
          different record entirely — plan §4.3), and finalise-purge/
          launch are the SAME two exclusions disclosed above, same
          reasons. Nothing here is confirmed anywhere else — not to
          another operator, not even to this same browser after
          localStorage is cleared. */}
      <div className="panel mb-6">
        <div className="px-6 py-4 border-b border-panel">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <MousePointerClick className="w-5 h-5 text-accent" />
            This browser&apos;s own actions
          </h2>
          <p className="text-xs text-muted mt-1">
            Not a facility record — recorded locally, in this browser only,
            and only for what the facility activity above doesn&apos;t
            carry: clearing a workload for deployment (a separate record
            entirely), permanently deleting a workload, and launching a
            workflow directly (the same two exclusions disclosed above, for
            the same reasons). No other operator, and no other browser of
            your own, sees these.
          </p>
        </div>
        <div className="divide-y divide-panel">
          {localOnlyActions.length === 0 ? (
            <div className="px-6 py-8 text-center text-muted text-sm">
              None of these actions have been recorded in this browser yet
            </div>
          ) : (
            localOnlyActions.map((rec) => (
              <div key={rec.request_id} className="px-6 py-4 hover:bg-panel/30 transition">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-sm">
                      {actionTitle(rec.action, rec.target)}
                    </h3>
                    <p className="text-xs text-muted mt-1">
                      {rec.requested_state
                        ? `${rec.previous_state} → ${rec.requested_state}`
                        : rec.outcome}{' '}
                      · “{rec.reason}”
                    </p>
                    <p className="text-xs text-muted mt-1">
                      {rec.actor} ({rec.role}) · request {rec.request_id.slice(0, 8)}
                    </p>
                    {rec.reconcile_expectation && (
                      <p className="text-xs text-muted mt-1">{rec.reconcile_expectation}</p>
                    )}
                  </div>
                  <div className="text-right text-xs text-muted shrink-0">
                    {new Date(rec.at).toLocaleString()}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Recent Jobs */}
      <div className="panel mb-6">
        <div className="px-6 py-4 border-b border-panel">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Zap className="w-5 h-5 text-amber-500" />
            Recent automation runs
          </h2>
        </div>
        <div className="divide-y divide-panel">
          {isLoading ? (
            <div className="px-6 py-8 text-center text-muted text-sm">Loading jobs...</div>
          ) : (
            <>
              {/* fix-round 4 (PR #81, codex sibling sweep): a settled failed
                  refetch ('error' phase) retains TanStack Query's last-good
                  `jobs` — the length===0 branch below never fires when rows
                  are retained, so this used to render them with no notice
                  at all, exactly the History-lane defect fix-round 3 closed
                  for the commits/pulls panels. Same fix: a notice
                  independent of emptiness; retained rows stay visible
                  (Art. 5). Every OTHER phase here (not-running/unreachable/
                  unconfigured) is a fresh, real 200 whose `jobs` is always
                  [] by the backend's own fail-soft contract, so the
                  length===0 branch already covers those correctly. */}
              {jobsState.phase === 'error' && (
                <div className="px-6 py-2 text-xs text-amber-300 bg-amber-500/10">
                  {changesEmptyCopy('error')}
                </div>
              )}
              {jobsState.jobs.length === 0 ? (
                // Was a bare "No recent jobs", which claimed AWX had answered
                // even when it had not. The token now names the real cause.
                jobsState.phase !== 'error' && (
                  <div className="px-6 py-8 text-center text-muted text-sm">
                    {changesEmptyCopy(jobsState.phase)}
                  </div>
                )
              ) : (
                jobsState.jobs.slice(0, 10).map((job) => {
                  // Derived ONCE per row and fed to BOTH the title and the
                  // badge below — see RecentChanges.tsx's matching comment
                  // (umbrella #432 §F fix-round 3, codex gate). Styling below
                  // still keys off the raw job.status, unchanged — only the
                  // TEXT is unified; a styling mismatch is a separate,
                  // out-of-scope concern.
                  const outcome = jobOutcome(job.status)
                  return (
                    <div key={job.id} className="px-6 py-4 hover:bg-panel/30 transition">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          {/* Operator language leads (Art. 3/8); the raw AWX
                              template name stays as a muted expert line — the
                              History lane still surfaces the catalog key (demo
                              runbook §7a), just no longer as the headline. */}
                          <h3 className="font-semibold text-sm">{describeJob(job.name, outcome)}</h3>
                          <p className="text-xs text-muted/70 mt-0.5">{job.name}</p>
                          <div className="flex items-center gap-2 mt-2 text-xs text-muted">
                            <span className={`inline-block px-2 py-1 rounded font-semibold ${
                              job.status === 'successful' ? 'bg-green-500/20 text-green-400' :
                              job.status === 'failed' ? 'bg-red-500/20 text-red-400' :
                              job.status === 'running' ? 'bg-blue-500/20 text-blue-400' :
                              'bg-gray-500/20 text-gray-400'
                            }`}>
                              {outcome}
                            </span>
                            <span>Run {job.id}</span>
                            {job.elapsed && <span>{job.elapsed.toFixed(1)}s</span>}
                          </div>
                        </div>
                        <div className="text-right text-xs text-muted">
                          {job.started && new Date(job.started).toLocaleString()}
                        </div>
                      </div>
                    </div>
                  )
                })
              )}
            </>
          )}
        </div>
      </div>

      {/* Recent Commits */}
      <div className="panel mb-6">
        <div className="px-6 py-4 border-b border-panel">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <GitCommit className="w-5 h-5 text-green-500" />
            Recent Commits
          </h2>
        </div>
        <div className="divide-y divide-panel">
          {isLoading ? (
            <div className="px-6 py-8 text-center text-muted text-sm">Loading commits...</div>
          ) : (
            <>
              {/* fix-round P1-2 (PR #81, round 2) + fix-round 3: rendered
                  whenever the phase is 'partial' OR 'error', INDEPENDENT of
                  emptiness. Round 2 covered 'partial' (some repos read, some
                  failed) but a SETTLED failed refetch ('error') retains the
                  prior successful `data` — round 3 closes that gap: those
                  retained rows below used to render with no notice at all,
                  presenting last-good data as current after the read that
                  would have confirmed it had already failed. */}
              {commitsNeedsNotice && (
                <div className="px-6 py-2 text-xs text-amber-300 bg-amber-500/10">
                  {forgejoEmptyCopy(commitsPhase, 'commits')}
                </div>
              )}
              {(commits.data?.repos?.length ?? 0) === 0 ? (
                // The notice above already named the cause — a second,
                // generic "no recent commits" would contradict it (this
                // repo list isn't confirmed empty, it's unconfirmed).
                !commitsNeedsNotice && (
                  <div className="px-6 py-8 text-center text-muted text-sm">
                    {forgejoEmptyCopy(commitsPhase, 'commits')}
                  </div>
                )
              ) : (
                commits.data?.repos?.map((repo: typeof commits.data.repos[0]) => (
                  <div key={repo.name}>
                    <div className="px-6 py-3 bg-panel/30 font-semibold text-sm">{repo.name}</div>
                    {repo.commits.slice(0, 5).map((commit: typeof repo.commits[0]) => (
                      <div key={commit.sha_short} className="px-6 py-3 hover:bg-panel/30 transition text-xs border-b border-panel/50 last:border-b-0">
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex-1 min-w-0">
                            <p className="font-mono text-muted text-xs">{commit.sha_short}</p>
                            <p className="truncate mt-1">{commit.message}</p>
                            <p className="text-muted mt-1">{commit.author}</p>
                          </div>
                          <div className="text-right text-muted shrink-0">
                            {commit.date && new Date(commit.date).toLocaleDateString()}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ))
              )}
            </>
          )}
        </div>
      </div>

      {/* Open Pull Requests */}
      <div className="panel">
        <div className="px-6 py-4 border-b border-panel">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <GitPullRequest className="w-5 h-5 text-blue-500" />
            Pull Requests
          </h2>
        </div>
        <div className="divide-y divide-panel">
          {isLoading ? (
            <div className="px-6 py-8 text-center text-muted text-sm">Loading PRs...</div>
          ) : (
            <>
              {/* Same fix as Recent Commits above — see its comment. */}
              {pullsNeedsNotice && (
                <div className="px-6 py-2 text-xs text-amber-300 bg-amber-500/10">
                  {forgejoEmptyCopy(pullsPhase, 'pull requests')}
                </div>
              )}
              {(pulls.data?.pulls?.length ?? 0) === 0 ? (
                !pullsNeedsNotice && (
                  <div className="px-6 py-8 text-center text-muted text-sm">
                    {forgejoEmptyCopy(pullsPhase, 'pull requests')}
                  </div>
                )
              ) : (
                pulls.data?.pulls?.map((pr: typeof pulls.data.pulls[0]) => (
                  <div key={`${pr.repo}#${pr.number}`} className="px-6 py-4 hover:bg-panel/30 transition">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-2">
                          <span className={`inline-block w-2 h-2 rounded-full ${
                            pr.state === 'open' ? 'bg-green-500' : 'bg-purple-500'
                          }`}></span>
                          <h3 className="font-semibold text-sm truncate">{pr.title}</h3>
                        </div>
                        <p className="text-xs text-muted">
                          {pr.repo} #{pr.number} by {pr.author}
                        </p>
                      </div>
                      <a
                        href={pr.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-500 hover:text-blue-400 shrink-0"
                      >
                        <ExternalLink className="w-4 h-4" />
                      </a>
                    </div>
                  </div>
                ))
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
