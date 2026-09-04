import type { AuditEventOutcome, AuditEventsExcludedClass, AuditEventsResponse, AuditEventsWindow } from '../api/types'
import { settleQuery } from './queryState'
import { formatSecondsCeiling } from './duration'

// Single source of truth for the Activity History lane's degraded states
// (dmfdeploy/dmfdeploy#496), same shape as lib/changesState.ts's
// ChangesPhase deliberately — the Jobs/Console-actions panels on this same
// page already teach an operator what "unreachable" vs "unconfigured" vs a
// genuine empty list look like; this lane must not invent a different
// vocabulary for the same idea.
//
// The backend (/api/audit/events) is fail-soft: it always answers 200 with
// a `reason` token, so a Loki outage is designed content, not a react-query
// error (Arts. 1+8). `error` covers a genuine transport/auth failure of the
// console's OWN API — the case react-query still surfaces as isError.
export type AuditEventsPhase =
  | 'loading'
  | 'ok' // Loki answered; `events` is authoritative (may be legitimately empty)
  | 'unreachable' // Loki itself could not be read
  | 'unconfigured' // no Loki wired into this env
  | 'error' // the console's own API call failed

export interface AuditEventsState {
  phase: AuditEventsPhase
  events: AuditEventsResponse['events']
  window: AuditEventsWindow
  // See AuditEventsResponse.capped — false by construction whenever there's
  // nothing to render anyway (loading/unreachable/unconfigured/error all
  // carry an empty `events`, so "capped" would be meaningless there).
  capped: boolean
  excluded: AuditEventsExcludedClass[]
}

export interface AuditEventsQueryLike {
  isLoading: boolean
  isError: boolean
  data?: AuditEventsResponse
}

const EMPTY_WINDOW: AuditEventsWindow = { known: false, seconds: null, reason: 'unavailable' }

export function classifyAuditEvents(q: AuditEventsQueryLike): AuditEventsState {
  const settled = settleQuery(q)
  const events = settled.data?.events ?? []
  const window = settled.data?.window ?? EMPTY_WINDOW
  const excluded = settled.data?.excluded ?? []

  let phase: AuditEventsPhase
  if (settled.loading) phase = 'loading'
  else if (settled.failed) phase = 'error'
  else {
    switch (settled.data?.reason) {
      case 'loki-unreachable':
        phase = 'unreachable'
        break
      case 'loki-unconfigured':
        phase = 'unconfigured'
        break
      case '':
        phase = 'ok'
        break
      default:
        // lkirc P2 (dmfdeploy/dmf-cms#140, 2026-09-04), same shape as
        // classifyForgejo above (changesState.ts): apiCall's generic
        // return type is a compile-time cast, not runtime response
        // validation -- an ABSENT reason, or a malformed/unrecognised
        // token this frontend doesn't yet know about, must not fail OPEN
        // into 'ok' (which auditEventsEmptyCopy reads as the
        // authoritative "no actions were recorded" claim). Only an EXACT
        // "" authorises that claim; every other shape fails closed to
        // 'error' -- we could not establish the result, which is honest,
        // not a positive claim that nothing happened.
        phase = 'error'
    }
  }

  const capped = phase === 'ok' && (settled.data?.capped ?? false)
  return { phase, events, window, capped, excluded }
}

// Never claims completeness beyond what the phase actually confirms (Art.
// 1) — "unreachable" and "a real empty history" must read as different
// sentences, not the same "no facility actions" line with different icons.
export function auditEventsEmptyCopy(phase: AuditEventsPhase): string {
  switch (phase) {
    case 'unreachable':
      return 'Facility history is unreachable right now — recent actions cannot be read. Retrying automatically.'
    case 'unconfigured':
      return 'Facility history is not configured in this environment.'
    case 'error':
      return 'Facility history could not be loaded. Retrying automatically.'
    default:
      // Not "no facility actions" — the read is genuinely role-gated (plan
      // §4.3), so an empty list here means nothing in this user's
      // permitted view, never a claim about the facility as a whole
      // (codex R496-A F7).
      return 'No actions in your permitted view were recorded in this window.'
  }
}

// codex R496-A F6: a bound that binds must be disclosed, not applied
// silently behind what would otherwise read as an ordinary, complete
// history — see AuditEventsResponse.capped's comment for the two cases
// this covers.
export const AUDIT_EVENTS_CAPPED_COPY =
  "This list may not be complete — the read was capped and can't confirm every matching action is shown."

// Ceiling, never coverage (plan condition 3 / #530): "searches up to X ago"
// is a bound on how far back a search can reach, not a promise that X of
// history is present. A young environment, a filled volume, or a retention
// change that isn't retroactive can all mean less is actually there.
export function auditWindowCopy(window: AuditEventsWindow): string {
  if (!window.known || window.seconds == null) {
    return 'Search window unknown — retention could not be confirmed.'
  }
  return `Searches up to ${formatSecondsCeiling(window.seconds)} ago.`
}

// Plain-word badge for an event's outcome (Art. 8) — the SAME word a row's
// detail line is built from, one computation per row, same discipline as
// lib/labels.ts's jobOutcome()/describeJob() pair.
export function auditOutcomeLabel(outcome: AuditEventOutcome): string {
  switch (outcome.state) {
    case 'in_flight':
      return 'In progress'
    case 'succeeded':
      return 'Succeeded'
    case 'failed':
      return 'Failed'
    case 'unknown':
      // codex R496-C P1-2: distinct from 'Failed' on purpose — a lost
      // outcome is not a verdict.
      return 'Outcome unknown'
  }
}

// ----------------------------------------------------------------------
// Exclusion disclosure — the two reasons are NEVER flattened into one list
// (plan §4.3/AC 5): a reader must be able to tell a boundary (access) from
// a choice about detail (scope-of-round) apart from each other.
// ----------------------------------------------------------------------

const EXCLUDED_CLASS_LABELS: Record<string, string> = {
  'finalise-purge': 'permanently deleting a workload',
  launch: 'launching a workflow directly',
  'verify-drain': 'verifying a facility has drained',
  rollback: 'an operator-initiated rollback',
}

export function excludedClassLabel(cls: string): string {
  return EXCLUDED_CLASS_LABELS[cls] ?? cls
}

export interface GroupedExclusions {
  access: string[] // human labels, access-scoped exclusions
  scope: string[] // human labels, scope-of-round exclusions
}

export function groupExclusions(excluded: AuditEventsExcludedClass[]): GroupedExclusions {
  const access: string[] = []
  const scope: string[] = []
  for (const item of excluded) {
    const label = excludedClassLabel(item.class)
    if (item.reason === 'access') access.push(label)
    else scope.push(label)
  }
  return { access, scope }
}
