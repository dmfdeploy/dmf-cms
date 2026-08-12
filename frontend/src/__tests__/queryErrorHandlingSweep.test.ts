/**
 * Cheap, mechanical regression net for the isError-gating defect shape this
 * whole fix arc (PR #81, umbrella #385, 7 rounds) kept re-discovering by
 * hand: a component reads `.data` off a TanStack Query read-hook and never
 * once considers `isError`/`.failed`/settleQuery for THAT SPECIFIC call, so
 * a settled failed refetch with data retained silently re-authorizes an
 * absence/count/status claim the CURRENT read never established.
 *
 * fix-round 7 (codex gate on round 6): the first version of this net was a
 * per-FILE textual heuristic ("does the file mention isError/settleQuery/
 * isFetching ANYWHERE") and codex broke it on the first real attempt —
 * Settings.tsx destructured `{ data: user, isLoading }` (an ALIAS, never
 * the literal token `.data`) with no isError anywhere, and would have kept
 * passing forever if some UNRELATED hook call elsewhere in the same file
 * happened to reference isError (or even just a comment mentioning the
 * word, which is exactly what let HistoryLane.tsx's raw
 * useChangesJobs()/useChangesCommits()/useChangesPulls() bindings slip past
 * the old check — none of the three is ever checked directly in that file
 * at all; only a COMMENT on an unrelated line contains the word "isError").
 *
 * This version is CALL-SITE precise: it locates each individual
 * `const <LHS> = useHookName(...)` statement and asks, for THAT call alone,
 * whether error state reaches it, via any of three real patterns actually
 * used in this codebase:
 *
 *   1. Direct wrap:     const { data, failed } = settleQuery(useHook())
 *   2. Two-step wrap:   const q = useHook(); const s = settleQuery(q)
 *                       (needed when `.refetch()` off the raw query is also
 *                       used, e.g. ConfigureStage.tsx's switch control)
 *   3. Own destructure: const { data, isError } = useHook()   — checked by
 *      DESTRUCTURE KEY, not by whether the literal string "isError"
 *      appears anywhere in the file
 *   4. Delegation:      const q = useHook(); classifyFoo(q)   — the raw
 *      query object handed to a classifier that is ITSELF verified (by the
 *      same mechanism, recursively) to call settleQuery internally
 *      (lib/changesState.ts's classifyChanges/classifyForgejo, lib/
 *      workspaceHealth.ts's classifyWorkspaceHealth, Facility/Detail.tsx's
 *      classifyFacilityDetail) — a raw property/token check on the
 *      CONSUMING file would never see this; the callee owns the check.
 *
 * Direct property access (`q.isError`) or `q.isFetching` on the SAME bound
 * variable also counts — pre-settleQuery code and WorkloadDetail.tsx's
 * groupedRead (which genuinely needs isFetching, not just settleQuery's
 * failed/loading) both use this shape.
 *
 * This is still NOT an AST-based checker — no scope/type resolution, pure
 * regex over source text, so it can be fooled by sufficiently unusual
 * formatting (a hook call not immediately preceded by `const`, e.g. a
 * reassignment or an inline prop) — those call sites are silently skipped
 * (a false negative, not a false positive), which is an accepted tradeoff
 * for "cheap, mechanical, not full tooling." Every read-hook call in the
 * app today IS one of the four `const`-declared shapes above (verified by
 * running this net and getting zero surprises beyond the one already-known
 * exemption below).
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

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Every exported hooks.ts function whose OWN body calls useQuery(...) —
 *  i.e. a read, not a useMutation(...) write. Mutations don't retain stale
 *  data across a failed background refetch the way a query does, so they
 *  are a different defect class and out of this net's scope. */
function readQueryHookNames(): string[] {
  const hooksSrc = Object.entries(RAW_SOURCES).find(([k]) => relPath(k) === 'api/hooks.ts')?.[1]
  if (!hooksSrc) return []
  return exportedFunctionsCallingWithin(hooksSrc, 'useQuery(')
}

/** Every `export function` anywhere in src whose OWN body calls
 *  settleQuery(...) — a classifier a caller can safely DELEGATE a raw
 *  query object to (pattern 4 above), derived the same way as the hook
 *  list rather than hand-maintained. */
function settleQueryDelegateNames(): string[] {
  const names = new Set<string>()
  for (const [globKey, src] of Object.entries(RAW_SOURCES)) {
    if (relPath(globKey) === 'lib/queryState.ts') continue // settleQuery's own definition
    for (const name of exportedFunctionsCallingWithin(src, 'settleQuery(')) names.add(name)
  }
  return [...names]
}

/** Crude top-level function splitter: finds `export function NAME(...) {`
 *  and slices from there to the NEXT such match (or EOF) as that
 *  function's "body" — good enough for this file's flat, non-nested export
 *  shape (verified against hooks.ts and every classifier file); does not
 *  handle arbitrarily nested exported functions in general, which is fine
 *  here since a false MISS just means a delegate/hook goes undetected
 *  (caught immediately as a fresh offender, not silently trusted). */
function exportedFunctionsCallingWithin(src: string, needle: string): string[] {
  const fnRe = /export function (\w+)\([^)]*\)[^{]*\{/g
  const matches = [...src.matchAll(fnRe)]
  const names: string[] = []
  matches.forEach((m, i) => {
    const start = m.index! + m[0].length
    const end = i + 1 < matches.length ? matches[i + 1].index! : src.length
    if (src.slice(start, end).includes(needle)) names.push(m[1])
  })
  return names
}

interface CallSite {
  hook: string
  kind: 'destructure' | 'bare'
  lhs: string // destructure object text (incl. braces), or the bare variable name
  wrappedInline: boolean // settleQuery(useHook(...)) directly
}

/** Every `const <LHS> = [settleQuery(] useHookName(` statement in a file,
 *  for the given hook names. `[^{}]*` (not `.`) inside the destructure
 *  naturally spans multi-line Prettier-wrapped destructures without
 *  needing the `s` flag. */
function findCallSites(src: string, hookNames: string[]): CallSite[] {
  if (hookNames.length === 0) return []
  const alternation = hookNames
    .slice()
    .sort((a, b) => b.length - a.length) // longer names first — defensive, not load-bearing (see file docstring)
    .map(escapeRe)
    .join('|')
  const re = new RegExp(
    String.raw`const\s+(\{[^{}]*\}|[A-Za-z_$][\w$]*)\s*=\s*(settleQuery\(\s*)?(?:${alternation})\s*\(`,
    'g',
  )
  const sites: CallSite[] = []
  let m: RegExpExecArray | null
  const hookRe = new RegExp(`(?:${alternation})`)
  while ((m = re.exec(src))) {
    const lhs = m[1]
    const wrappedInline = Boolean(m[2])
    const hookMatch = m[0].match(hookRe)
    sites.push({
      hook: hookMatch ? hookMatch[0] : '?',
      kind: lhs.startsWith('{') ? 'destructure' : 'bare',
      lhs,
      wrappedInline,
    })
  }
  return sites
}

/** Offending call sites in one file — see the file docstring for the four
 *  recognized compliant shapes. */
function fileOffenses(src: string, hookNames: string[], delegateNames: string[]): string[] {
  const offenses: string[] = []
  for (const site of findCallSites(src, hookNames)) {
    if (site.wrappedInline) continue // pattern 1: direct settleQuery(useHook()) wrap

    if (site.kind === 'destructure') {
      if (!/\bdata\b/.test(site.lhs)) continue // never binds `data` — nothing to gate
      if (/\bisError\b/.test(site.lhs) || /\bisFetching\b/.test(site.lhs)) continue // pattern 3
      offenses.push(`${site.hook}() destructured as ${site.lhs.replace(/\s+/g, ' ')} with no isError/isFetching key`)
      continue
    }

    // bare identifier
    const v = escapeRe(site.lhs)
    if (new RegExp(String.raw`settleQuery\(\s*${v}\s*\)`).test(src)) continue // pattern 2: two-step wrap
    if (new RegExp(String.raw`\b${v}\.(isError|failed|isFetching)\b`).test(src)) continue // direct property access
    if (delegateNames.some((d) => new RegExp(String.raw`\b${escapeRe(d)}\(\s*${v}\b`).test(src))) continue // pattern 4
    if (!new RegExp(String.raw`\b${v}\.data\b`).test(src)) continue // never reads .data off it — nothing to gate

    offenses.push(`${site.hook}() bound to "${site.lhs}" with no settleQuery(...)/.isError/.failed/.isFetching/known-delegate anywhere`)
  }
  return offenses
}

// Files verified NOT to need isError-awareness, each with why — checked by
// hand at the time this net was built (fix-round 6, PR #81) and re-checked
// under the call-site-precise version (fix-round 7). The bar for adding an
// entry is a real reason, not a red test.
const EXEMPT: Record<string, string> = {
  'components/Topbar.tsx':
    "Both reads only ever supply an OPTIONAL display name (facility.data?.site.name, workload?.name), " +
    "each `|| <the URL slug>`. Undefined `.data` for ANY reason (loading, disabled, or a failed read) " +
    "already degrades to the honest raw-slug fallback the component documents as its own design (a name " +
    "is used as a label ONLY when confirmed; otherwise the slug itself is shown, never a fabricated or " +
    "stale-presented-as-current claim). There is no absence/count/status claim here for isError to gate — " +
    "this is a real, pre-existing gap in a DIFFERENT sense (a settled failed refetch keeps showing a " +
    "retained name past its own staleness with no notice, same as every OTHER retained-data notice this " +
    "arc added elsewhere), tracked separately as it touches no code this PR's rounds 1-7 already changed.",
}

describe('regression net: a read-hook consumer must consider isError for its OWN call site', () => {
  it('the hook/delegate extraction still finds a plausible number of names (sanity, not a defect check)', () => {
    // Guards the net itself: if the export shapes this scans for change
    // enough that the regexes stop matching anything, the real test below
    // would silently pass with zero call sites checked — fail loudly instead.
    expect(readQueryHookNames().length).toBeGreaterThan(10)
    expect(settleQueryDelegateNames().length).toBeGreaterThanOrEqual(4) // the 4 classifiers, at minimum
  })

  it('flags no un-exempted call site that reads a query hook\'s data without considering isError for THAT call', () => {
    const readHooks = readQueryHookNames()
    const delegates = settleQueryDelegateNames()

    const offendersByFile: Record<string, string[]> = {}
    for (const [globKey, src] of Object.entries(RAW_SOURCES)) {
      const rel = relPath(globKey)
      if (rel === 'api/hooks.ts' || rel === 'lib/queryState.ts') continue
      if (rel in EXEMPT) continue

      const offenses = fileOffenses(src, readHooks, delegates)
      if (offenses.length > 0) offendersByFile[rel] = offenses
    }

    expect(offendersByFile).toEqual({})
  })
})
