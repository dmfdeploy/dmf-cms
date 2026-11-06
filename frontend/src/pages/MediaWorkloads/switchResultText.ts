import type { SwitchSourceResult } from '../../api/types'

// The backend sends operator copy in `outcome_message` for every failed
// switch. This text covers a response without one, so a view never falls back
// to a machine code such as `switch-job-failed` or `failed_rollback_required`.
export const SWITCH_FAILED_GENERIC_TEXT =
  'Switch did not complete. Check the current source before you retry.'

// The switch endpoint runs the whole switch before it answers, so a request
// that errors, loses its response or returns unreadable data may still have
// run. The copy therefore never says nothing changed.
export const SWITCH_REQUEST_FAILED_TEXT =
  'The console could not confirm the switch request, so the switch may have run. ' +
  'Check the current source before you retry.'

export function switchFailureText(result: SwitchSourceResult): string {
  return result.outcome_message ?? SWITCH_FAILED_GENERIC_TEXT
}
