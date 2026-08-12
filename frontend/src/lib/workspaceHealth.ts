import type { WorkspaceAlert, WorkspaceHealth } from '../api/types'
import { settleQuery } from './queryState'

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
  // fix-round 6 (PR #81, umbrella #385): retrofitted onto settleQuery — this
  // classifier's own `stale` was already unconditional (`q.isError`, no
  // `!q.data` gate); the bug rounds 4-5 found was in CONSUMERS not checking
  // it for the 'not-configured' phase. Expressed through the shared
  // primitive now so a new classifier gets the same unconditional shape by
  // copying this one, rather than re-deriving it correctly by luck.
  const settled = settleQuery(q)
  const alerts = settled.data?.alerts ?? []
  const verified = settled.data?.watchdog_firing ?? false
  const hasProblems = alerts.length > 0
  const stale = settled.failed

  let phase: WorkspaceHealthPhase
  if (settled.loading) phase = 'loading'
  else if (settled.data && !settled.data.configured) phase = 'not-configured'
  else if (settled.failed && !settled.data) phase = 'unknown'
  else phase = 'live'

  return { phase, stale, verified, alerts, hasProblems }
}

// The bell may claim "all systems nominal" ONLY when monitoring is live,
// not stale, Watchdog-verified, and carrying zero floored problems. Every
// other state is degraded/unknown and must be shown honestly.
export function isNominal(state: WorkspaceHealthState): boolean {
  return state.phase === 'live' && !state.stale && state.verified && !state.hasProblems
}
