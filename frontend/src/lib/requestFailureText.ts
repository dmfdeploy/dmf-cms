import { APIError } from '../api/client'

// The console says nothing changed only for its own refusal: a 4xx answer
// whose body has no `upstream` field. A 5xx, or an error the console passed
// through from AWX or NetBox (the body names its `upstream`), can follow a
// side effect, as can any throw that is not an APIError (a lost connection, a
// reply that is not JSON). Those leave the outcome unknown.
export function isConsoleRefusal(error: unknown): boolean {
  if (!(error instanceof APIError) || error.status < 400 || error.status >= 500) return false
  try {
    const body: unknown = JSON.parse(error.body)
    return typeof body === 'object' && body !== null && !('upstream' in body)
  } catch {
    return false
  }
}

export const REQUEST_REFUSED_TEXT =
  "That didn't go through — nothing was changed. Check your access, then retry."
export const REQUEST_UNKNOWN_TEXT =
  'The console could not confirm the result, so the action may have run. ' +
  'Check the current state before you retry.'

export function requestFailureText(error: unknown): string {
  return isConsoleRefusal(error) ? REQUEST_REFUSED_TEXT : REQUEST_UNKNOWN_TEXT
}
