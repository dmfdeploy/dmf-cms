import { APIError } from '../api/client'

/**
 * The deploy preflight answers 409 `capacity-preflight-refused` for several
 * reasons, and only one of them is about room. The backend builds the payloads
 * in src/dmf_cms/main.py:
 *
 * - `no-fit` (main.py:675-686): the facility has no room. Carries
 *   `report.shortfall_cpu_m` / `report.shortfall_mem_b` and a server `text`.
 * - `budget-unavailable` and `multi-node-unsupported` (main.py:664-669, tokens
 *   from capacity.py:read_node_supply): supply could not be read or is not
 *   supported. Freeing capacity does not help.
 * - `missing-budget`, `missing-source-profile`, `invalid-budget`,
 *   `invalid-source-profile` (main.py:631-650): the catalog entry itself has no
 *   usable resource budget. Freeing capacity does not help.
 *
 * "Finalise a workload, then retry" is therefore advice for `no-fit` alone.
 * The same body also tells a refusal apart from a real in-flight 409, which
 * carries a different error code, so callers must branch on the code and never
 * on the status.
 */
interface RefusalBody {
  error?: unknown
  kind?: unknown
  text?: unknown
  report?: { shortfall_cpu_m?: number; shortfall_mem_b?: number }
}

function parseRefusal(error: unknown): RefusalBody | null {
  if (!(error instanceof APIError)) return null
  try {
    const body = JSON.parse(error.body) as RefusalBody
    return body?.error === 'capacity-preflight-refused' ? body : null
  } catch {
    return null
  }
}

export function capacityRefusalMessage(error: unknown): string | null {
  const body = parseRefusal(error)
  if (!body) return null

  if (body.kind === 'no-fit') {
    const short: string[] = []
    const cpu = body.report?.shortfall_cpu_m
    const mem = body.report?.shortfall_mem_b
    if (cpu) short.push(`CPU short by ${cpu}m`)
    // Round up: any positive shortfall must read as at least 1Mi, never 0Mi.
    if (mem) short.push(`memory short by ${Math.ceil(mem / 1024 ** 2)}Mi`)
    const budget =
      short.length > 0
        ? `The facility has no room for this deploy: ${short.join(', ')}.`
        : typeof body.text === 'string' && body.text
          ? body.text
          : 'The facility has no room for this deploy.'
    return `${budget} Nothing was changed. Finalise a running workload to free capacity, then retry.`
  }

  const text = typeof body.text === 'string' && body.text ? ` ${body.text}` : ''
  return `The console could not confirm the facility has room for this deploy.${text} Nothing was changed. Freeing capacity will not fix this; ask an administrator to check the catalog budget and the monitoring data.`
}
