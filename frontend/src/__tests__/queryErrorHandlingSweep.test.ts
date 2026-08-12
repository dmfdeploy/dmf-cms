/**
 * Cheap, mechanical regression net for the isError-gating defect shape this
 * whole fix arc (PR #81, umbrella #385, 6 rounds) kept re-discovering by
 * hand: a component reads `.data` off a TanStack Query read-hook and never
 * once considers `isError`/`.failed`/settleQuery anywhere in the file, so a
 * settled failed refetch with data retained silently re-authorizes an
 * absence/count/status claim the CURRENT read never established.
 *
 * This is deliberately NOT an AST-based checker — building one (a real
 * ESLint rule walking the actual data-flow from a specific hook call to a
 * specific claim) was flagged in fix-round 6's report as real engineering
 * effort, not built. This is the "cheap, mechanical" alternative: a
 * per-FILE textual heuristic — "this file calls a read-hook AND reads
 * `.data` somewhere AND never once mentions isError/.failed/settleQuery/
 * isFetching anywhere in the whole file". Coarse on purpose (file-level, not
 * call-site-level), so it trades precision for near-zero maintenance cost.
 * Source text comes from Vite's own `import.meta.glob(..., { query: '?raw' })`
 * — no Node `fs`/`path` types needed under this project's DOM-only tsconfig.
 *
 * The read-hook list is DERIVED from api/hooks.ts itself (whichever export
 * calls useQuery(...) in its body), not hand-maintained — a new query hook
 * added there is covered automatically rather than silently falling outside
 * this net.
 *
 * A file can legitimately dodge this net (see EXEMPT below). The bar for
 * adding an entry is a one-line reason the pattern is genuinely safe, not
 * "the test went red" — same discipline as every fix in this arc.
 */
/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest'

// Every .ts/.tsx source file under src, as raw text, keyed by a path
// relative to src/ (e.g. "pages/Admin.tsx") — eager + raw so this is plain
// data by the time the test body runs, no async loader plumbing needed.
const RAW_SOURCES = import.meta.glob('../**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>

function relPath(globKey: string): string {
  // glob keys are relative to THIS file's directory ("../pages/Admin.tsx");
  // strip the leading "../" to match the rest of this file's "src-relative"
  // paths (e.g. api/hooks.ts, lib/queryState.ts, EXEMPT's own keys).
  return globKey.replace(/^\.\.\//, '')
}

/** Every exported hooks.ts function whose OWN body calls useQuery(...) —
 *  i.e. a read, not a useMutation(...) write. Mutations don't retain stale
 *  data across a failed background refetch the way a query does, so they
 *  are a different defect class and out of this net's scope. */
function readQueryHookNames(): string[] {
  const hooksSrc = Object.entries(RAW_SOURCES).find(([k]) => relPath(k) === 'api/hooks.ts')?.[1]
  if (!hooksSrc) return []
  const fnRe = /export function (use\w+)\([^)]*\)\s*\{/g
  const matches = [...hooksSrc.matchAll(fnRe)]
  const names: string[] = []
  matches.forEach((m, i) => {
    const start = m.index! + m[0].length
    const end = i + 1 < matches.length ? matches[i + 1].index! : hooksSrc.length
    const body = hooksSrc.slice(start, end)
    if (body.includes('useQuery(')) names.push(m[1])
  })
  return names
}

// Files verified NOT to need isError-awareness, each with why — checked by
// hand at the time this net was built (fix-round 6, PR #81). The bar for
// adding an entry is a real reason, not a red test.
const EXEMPT: Record<string, string> = {
  'components/Topbar.tsx':
    "Both reads only ever supply an OPTIONAL display name (facility.data?.site.name, workload?.name), " +
    "each `|| <the URL slug>`. Undefined `.data` for ANY reason (loading, disabled, or a failed read) " +
    "already degrades to the honest raw-slug fallback the component documents as its own design (a name " +
    "is used as a label ONLY when confirmed; otherwise the slug itself is shown, never a fabricated or " +
    "stale-presented-as-current claim). There is no absence/count/status claim here for isError to gate — " +
    "this is a real, pre-existing gap in a DIFFERENT sense (a settled failed refetch keeps showing a " +
    "retained name past its own staleness with no notice, same as every OTHER retained-data notice this " +
    "arc added elsewhere), tracked separately as it touches no code this PR's rounds 1-6 already changed.",
}

describe('regression net: a read-hook consumer must consider isError somewhere in the file', () => {
  it('the hook extraction still finds a plausible number of read hooks (sanity, not a defect check)', () => {
    // Guards the net itself: if hooks.ts's shape changes enough that the
    // regex stops matching anything, the real test below would silently
    // pass with zero files checked — this fails loudly instead.
    expect(readQueryHookNames().length).toBeGreaterThan(10)
  })

  it('flags no un-exempted file that reads .data off a query hook without ever checking isError/.failed/settleQuery/isFetching', () => {
    const readHooks = readQueryHookNames()
    const escaped = readHooks.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    const hookRe = new RegExp(`\\b(${escaped.join('|')})\\s*\\(`)
    const errorSignalRe = /isError|\.failed\b|settleQuery|isFetching/

    const offenders: string[] = []
    for (const [globKey, src] of Object.entries(RAW_SOURCES)) {
      const rel = relPath(globKey)
      if (rel === 'api/hooks.ts' || rel === 'lib/queryState.ts') continue
      if (rel in EXEMPT) continue

      if (!hookRe.test(src)) continue // doesn't call a read hook at all
      if (!src.includes('.data')) continue // never reads .data — nothing to gate
      if (errorSignalRe.test(src)) continue // considers error state somewhere

      offenders.push(rel)
    }

    expect(offenders).toEqual([])
  })
})
