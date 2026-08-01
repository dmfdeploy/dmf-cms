import type { AdminJobsResponse } from '../api/types'

// Single source of truth for the "recent changes" degraded states, shared by
// the Workspace RecentChanges widget and the Activity → History jobs lane so
// the two can never disagree (Constitution Art. 1). Pure over the react-query
// result shape, mirroring lib/workspaceHealth.ts.
//
// The backend (/api/changes/jobs) is fail-soft: it always answers 200 with a
// reason token, so an unreachable AWX is designed content, not an error
// (Arts. 1+8). `error` therefore only covers a genuine transport/auth failure
// of the console's own API — the case react-query still surfaces as isError.

export type ChangesPhase =
  | 'loading' // first load, no data yet
  | 'ok' // AWX answered; jobs is authoritative (may be legitimately empty)
  | 'not-running' // AWX refused the connection while autoscale is enabled
  | 'unreachable' // any other AWX failure — honest error state
  | 'unconfigured' // no AWX wired into this env
  | 'error' // the console's own API call failed

export interface ChangesState {
  phase: ChangesPhase
  jobs: AdminJobsResponse['jobs']
}

export interface ChangesQueryLike {
  isLoading: boolean
  isError: boolean
  data?: AdminJobsResponse
}

export function classifyChanges(q: ChangesQueryLike): ChangesState {
  const jobs = q.data?.jobs ?? []

  let phase: ChangesPhase
  if (q.isLoading && !q.data) phase = 'loading'
  else if (q.isError && !q.data) phase = 'error'
  else {
    switch (q.data?.reason) {
      case 'awx-not-running':
        phase = 'not-running'
        break
      case 'awx-unreachable':
        phase = 'unreachable'
        break
      case 'awx-unconfigured':
        phase = 'unconfigured'
        break
      default:
        phase = 'ok'
    }
  }

  return { phase, jobs }
}

// Operator-language copy per state (Art. 3: plain words, no system jargon;
// Art. 1: never imply we know more than we do).
//
// "not running" is deliberate and load-bearing: a refused connection proves
// the API is not accepting connections, NOT that it was put to sleep on
// purpose. Saying "asleep" would present an inference as a fact — see
// awx.is_connection_refused. Nothing here claims completeness of history
// either, because a not-running AWX means we simply cannot know.
export function changesEmptyCopy(phase: ChangesPhase): string {
  switch (phase) {
    case 'not-running':
      return 'Facility automation is not running — recent changes appear when it next runs.'
    case 'unreachable':
      return 'Facility automation is unreachable — recent changes cannot be read right now. Retrying automatically.'
    case 'unconfigured':
      return 'Facility automation is not configured in this environment.'
    case 'error':
      return 'Recent changes could not be loaded. Retrying automatically.'
    default:
      return 'No recent changes recorded'
  }
}
