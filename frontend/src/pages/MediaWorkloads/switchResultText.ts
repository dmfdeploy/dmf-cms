import type { SwitchSourceResult } from '../../api/types'

// The backend sends operator copy in `outcome_message` for every failed
// switch. This text covers a response without one, so a view never falls back
// to a machine code such as `switch-job-failed` or `failed_rollback_required`.
export const SWITCH_FAILED_GENERIC_TEXT =
  'Switch did not complete. Check the current source before you retry.'

export function switchFailureText(result: SwitchSourceResult): string {
  return result.outcome_message ?? SWITCH_FAILED_GENERIC_TEXT
}
