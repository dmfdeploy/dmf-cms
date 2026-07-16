import type { WorkspaceAlert, WorkspaceHealth } from '../api/types'

// Single source of truth for the "are we OK?" state machine, shared by the
// Workspace HealthCore panel and the shell notification bell so the two can
// never disagree (Constitution Art. 1: never present uncertainty as
// certainty — a degraded/unknown monitoring state must never render as a
// green "all systems nominal"). Pure over the react-query result shape.

export type WorkspaceHealthPhase =
  | 'loading' // first load, no data yet
  | 'not-configured' // Prometheus not wired in this env
  | 'unknown' // unreachable AND no last-known state
  | 'live' // we have a payload (possibly stale)

export interface WorkspaceHealthState {
  phase: WorkspaceHealthPhase
  stale: boolean // query errored but we still hold last-known data
  verified: boolean // Watchdog deadman firing → silence means healthy
  alerts: WorkspaceAlert[] // floored (warning+) firing conditions
  hasProblems: boolean
}

export interface HealthQueryLike {
  isLoading: boolean
  isError: boolean
  data?: WorkspaceHealth
}

export function classifyWorkspaceHealth(q: HealthQueryLike): WorkspaceHealthState {
  const alerts = q.data?.alerts ?? []
  const verified = q.data?.watchdog_firing ?? false
  const hasProblems = alerts.length > 0
  const stale = q.isError

  let phase: WorkspaceHealthPhase
  if (q.isLoading && !q.data) phase = 'loading'
  else if (q.data && !q.data.configured) phase = 'not-configured'
  else if (q.isError && !q.data) phase = 'unknown'
  else phase = 'live'

  return { phase, stale, verified, alerts, hasProblems }
}

// The bell may claim "all systems nominal" ONLY when monitoring is live,
// not stale, Watchdog-verified, and carrying zero floored problems. Every
// other state is degraded/unknown and must be shown honestly.
export function isNominal(state: WorkspaceHealthState): boolean {
  return state.phase === 'live' && !state.stale && state.verified && !state.hasProblems
}
