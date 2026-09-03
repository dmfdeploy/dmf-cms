/**
 * Cheap, mechanical regression net for the isError-gating defect shape this
 * whole fix arc (PR #81, umbrella #385, 8 rounds) kept re-discovering by
 * hand: a component reads `.data` off a TanStack Query read-hook and never
 * once considers `isError`/`.failed`/settleQuery for THAT SPECIFIC call, so
 * a settled failed refetch with data retained silently re-authorizes an
 * absence/count/status claim the CURRENT read never established.
 *
 * DISCLOSED SCOPE — read this before trusting a green run here. This is
 * regex-over-source-text, not an AST/type checker; every "verify" in this
 * file means "verify what this specific mechanism can see", not "verify
 * every consumer everywhere is provably safe". Two hardening rounds
 * (7 and 8) each closed a real hole codex found by deliberately trying to
 * defeat it; the shapes below are what survived that adversarial process,
 * not a completeness guarantee.
 *
 *   COVERED:
 *     - const { data, isError } = useHook()             (own destructure key)
 *     - const { data, failed } = settleQuery(useHook())  (direct wrap)
 *     - const q = useHook(); const s = settleQuery(q)    (two-step wrap)
 *     - const q = useHook(); classifyFoo(q)               (verified delegate —
 *       see KNOWN_DELEGATES below: RUNTIME-checked, not text-matched)
 *     - const q = useHook(); q.isError / q.failed / q.isFetching  (direct
 *       property access on the SAME bound variable)
 *
 *   NOT COVERED (round 8, codex adversarial pass — accepted, not fixed):
 *     - A hook called through an intermediate wrapper function, e.g.
 *       `function useSettingsUser() { return useCurrentUser() }` then
 *       `const { data } = useSettingsUser()` — findCallSites only matches
 *       the RECOGNIZED HOOK NAMES directly after `const <LHS> = `, so a
 *       renamed indirection is invisible to it. No such wrapper exists
 *       anywhere in this codebase today (verified by hand) — this is a
 *       defended-against hypothetical, not an active bug. General wrapper-
 *       tracing (following an arbitrary function to see what IT calls) is
 *       real data-flow analysis and was explicitly judged disproportionate
 *       to build for a regression test in one PR.
 *
 * fix-round 7 (codex gate on round 6): the FIRST version of this net was a
 * per-FILE textual heuristic ("does the file mention isError/settleQuery/
 * isFetching ANYWHERE") — defeated on the first real attempt by an aliased
 * destructure (Settings.tsx: `{ data: user, isLoading }`, no isError) and,
 * separately, by a comment merely mentioning the word "isError" on an
 * unrelated line (Activity/HistoryLane.tsx) coincidentally satisfying the
 * file-wide check. Rebuilt call-site precise: locate each individual
 * `const <LHS> = useHookName(...)` statement and ask, for THAT call alone,
 * whether error state reaches it.
 *
 * fix-round 8 (codex adversarial pass on round 7): codex defeated the
 * call-site version twice more —
 *   (a) an intermediate wrapper function (see NOT COVERED above — accepted);
 *   (b) DEAD-CODE delegation: `if (false) settleQuery(q)` inside a
 *       classifier's body still contains the literal text `settleQuery(`,
 *       so the old "does this function's source TEXT mention settleQuery("
 *       check called it a verified delegate while the function's REAL
 *       logic never touched isError at all. A text scan cannot tell live
 *       code from dead code. Fixed by replacing text-matching with an
 *       actual RUNTIME check: KNOWN_DELEGATES below imports each real
 *       classifier, spies on the REAL settleQuery (vi.mock + importOriginal,
 *       so it still behaves correctly — this only records calls, it doesn't
 *       replace behavior), calls the classifier with realistic input, and
 *       asserts the spy was actually invoked.
 *
 * fix-round 9 (codex adversarial pass on round 8): "settleQuery was called"
 * is an IMPLEMENTATION-DETAIL assertion, not a correctness one — codex
 * proved a classifier can stay "verified" while being actively broken:
 *   (a) call settleQuery on a HARMLESS non-error COPY of the input, use
 *       that wrong result — the spy still sees a call, the output is wrong;
 *   (b) call settleQuery(q) correctly, then DISCARD the result and use an
 *       unsafe substitute — same: spy sees a call, output is wrong.
 * Also named: the invocation-spy fixture (FAILED_QUERY_FIXTURE) was
 * isError:true with data:undefined — never RETAINED data, the exact
 * dangerous shape this whole arc exists to cover. Fixed with a BLACK-BOX
 * behavioral check per classifier below (a separate describe block): feed
 * each one a realistic isError:true + non-empty RETAINED-data input and
 * assert the OUTPUT reflects correct failed/stale semantics for that
 * classifier's own contract. There is no "call" to fake around in a
 * black-box input/output assertion — only a result to get right or wrong.
 * Verified this closes both demonstrated variants by reproducing them
 * (a harmless-copy mutation and a discard-and-substitute mutation) against
 * classifyChanges and confirming the new test fails each, then reverting.
 * The invocation-spy tests stay too (still a real, non-trivial signal —
 * "never calls settleQuery at all" is a distinct, cheaper-to-diagnose
 * failure mode from "calls it but ignores the result") — this round
 * supplements rather than replaces them.
 */
/// <reference types="vite/client" />
import { describe, expect, it, vi } from 'vitest'

// Spies on the REAL settleQuery (vi.fn wraps actual.settleQuery, so it still
// computes the correct result — this only ALSO records calls). Every module
// this file imports below that itself imports settleQuery from here shares
// this one mocked binding, because vi.mock resolves by module path, not by
// import string. Must be declared before the imports it affects; Vitest
// hoists vi.mock calls to the top of the file at transform time regardless
// of source position, but keeping it visually first states the intent.
vi.mock('../lib/queryState', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/queryState')>()
  return { ...actual, settleQuery: vi.fn(actual.settleQuery) }
})

import { settleQuery } from '../lib/queryState'
import { classifyChanges, classifyForgejo, type ChangesQueryLike, type ForgejoQueryLike } from '../lib/changesState'
import { classifyWorkspaceHealth, type HealthQueryLike } from '../lib/workspaceHealth'
import { classifyFacilityDetail, type FacilityDetailQueryLike } from '../pages/Facility/Detail'
import { classifyAuditEvents, type AuditEventsQueryLike } from '../lib/auditEventsState'

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

/** Every `export function` anywhere in src whose source TEXT mentions
 *  settleQuery(...) AND whose name fits the delegate calling convention
 *  pattern 4 actually looks for (`delegateName(someBareQueryVariable)`, a
 *  PLAIN function call — never JSX, never a hook consumed via its own
 *  props/args) — a CANDIDATE for delegation, NOT trust by itself (round 8
 *  proved text presence alone is gameable via dead code). Used only as a
 *  coverage nudge: see the "every candidate is a registered, runtime-
 *  verified delegate" test below, which fails loudly if this list ever
 *  finds a name KNOWN_DELEGATES hasn't accounted for.
 *
 *  Excludes React components (PascalCase, e.g. OperationStatusLine) and
 *  hooks (camelCase starting with `use`, e.g. useLivePreview) by this
 *  codebase's own established naming convention — both call settleQuery
 *  for entirely their OWN internal hook usage, never for a caller-supplied
 *  raw query object, so no consumer file could ever textually delegate to
 *  them the way pattern 4 checks for (`<Name(` / `use...(` never appears
 *  as a bare function-call handing off someone else's query variable —
 *  components are invoked as JSX, hooks take their own config, not a
 *  QueryLike). Excluding them isn't guessing they're safe — pattern 4's
 *  OWN regex (`delegateName\(\s*bareVar`) could never match their real
 *  call shape in the first place, so including them here would only ever
 *  be a false alarm on this coverage check, never close a real gap. */
function settleQueryTextCandidateNames(): string[] {
  const names = new Set<string>()
  for (const [globKey, src] of Object.entries(RAW_SOURCES)) {
    if (relPath(globKey) === 'lib/queryState.ts') continue // settleQuery's own definition
    for (const name of exportedFunctionsCallingWithin(src, 'settleQuery(')) {
      if (/^use[A-Z]/.test(name)) continue // hook
      if (/^[A-Z]/.test(name)) continue // component
      names.add(name)
    }
  }
  return [...names]
}

/** Every `export function NAME(...) { ... }`, body isolated by actual BRACE
 *  DEPTH (not "until the next match or EOF" — an earlier version of this
 *  net over-attributed trailing NON-exported code after the last matched
 *  export in a file to that function's "body", e.g. Facility/Detail.tsx's
 *  page-local WorkloadCountPanel's settleQuery call falsely counting
 *  towards facilityReasonCopy, the last `export function` before it).
 *  Doesn't skip braces inside strings/template-literals/comments — a real
 *  tokenizer would, but none of this codebase's actual function bodies put
 *  a brace inside a string in a way that would misdirect this (verified:
 *  every file here produces the correct attribution), and a full tokenizer
 *  is exactly the "real engineering effort" this net stays cheap by not
 *  building. */
function exportedFunctionsCallingWithin(src: string, needle: string): string[] {
  const fnRe = /export function (\w+)\([^)]*\)[^{]*\{/g
  const names: string[] = []
  let m: RegExpExecArray | null
  while ((m = fnRe.exec(src))) {
    const openBrace = m.index + m[0].length - 1 // m[0] ends in the opening `{`
    const closeBrace = matchingBraceIndex(src, openBrace)
    const body = src.slice(openBrace + 1, closeBrace)
    if (body.includes(needle)) names.push(m[1])
    fnRe.lastIndex = closeBrace + 1 // resume after this function's real end
  }
  return names
}

/** Index of the `}` matching the `{` at `src[openIndex]`, by depth count. */
function matchingBraceIndex(src: string, openIndex: number): number {
  let depth = 0
  for (let i = openIndex; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return src.length
}

// Realistic "settled, failed, nothing retained" input — every currently
// registered delegate's QueryLike-shaped sole argument accepts this
// structurally (data is always optional on that type).
const FAILED_QUERY_FIXTURE = { isLoading: false, isError: true, data: undefined }

// The delegate REGISTRY — deliberately hand-maintained, unlike the hook
// list above. Auto-deriving a list to TRUST by scanning source text is
// exactly what round 8 proved unsound (dead code contains the same tokens
// as live code); proving a function is safe to delegate to requires
// actually CALLING it, which requires knowing its real call signature —
// something only a human adding an entry here can assert honestly. Adding
// a new delegate classifier means adding it here with a realistic fixture,
// same discipline as the EXEMPT list below: a deliberate, reviewable
// addition, never silent, never inferred from text alone.
const KNOWN_DELEGATES: Record<string, () => unknown> = {
  classifyChanges: () => classifyChanges(FAILED_QUERY_FIXTURE),
  classifyForgejo: () => classifyForgejo(FAILED_QUERY_FIXTURE),
  classifyWorkspaceHealth: () => classifyWorkspaceHealth(FAILED_QUERY_FIXTURE),
  classifyFacilityDetail: () => classifyFacilityDetail(FAILED_QUERY_FIXTURE),
  classifyAuditEvents: () => classifyAuditEvents(FAILED_QUERY_FIXTURE),
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
    .sort((a, b) => b.length - a.length) // longer names first — defensive, not load-bearing
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

/** Offending call sites in one file — see the file-header "COVERED" list
 *  for the four recognized compliant shapes. */
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
    if (delegateNames.some((d) => new RegExp(String.raw`\b${escapeRe(d)}\(\s*${v}\b`).test(src))) continue // pattern 4: RUNTIME-verified delegate
    if (!new RegExp(String.raw`\b${v}\.data\b`).test(src)) continue // never reads .data off it — nothing to gate

    offenses.push(`${site.hook}() bound to "${site.lhs}" with no settleQuery(...)/.isError/.failed/.isFetching/verified-delegate anywhere`)
  }
  return offenses
}

// Files verified NOT to need isError-awareness, each with why — checked by
// hand at the time this net was built (fix-round 6) and re-checked under
// every later hardening round. The bar for adding an entry is a real
// reason, not a red test.
const EXEMPT: Record<string, string> = {
  'components/Topbar.tsx':
    "Both reads only ever supply an OPTIONAL display name (facility.data?.site.name, workload?.name), " +
    "each `|| <the URL slug>`. Undefined `.data` for ANY reason (loading, disabled, or a failed read) " +
    "already degrades to the honest raw-slug fallback the component documents as its own design (a name " +
    "is used as a label ONLY when confirmed; otherwise the slug itself is shown, never a fabricated or " +
    "stale-presented-as-current claim). There is no absence/count/status claim here for isError to gate — " +
    "this is a real, pre-existing gap in a DIFFERENT sense (a settled failed refetch keeps showing a " +
    "retained name past its own staleness with no notice, same as every OTHER retained-data notice this " +
    "arc added elsewhere), tracked separately as it touches no code this PR's rounds 1-8 already changed.",
}

describe('regression net: known delegate classifiers actually call settleQuery at runtime', () => {
  // fix-round 8 — the direct codex ask: proof of EXECUTION, not text
  // matching. If a classifier is ever refactored to skip settleQuery (dead
  // code, an early return, a rewritten fast path — any shape), this fails
  // here, by name, rather than silently letting every caller trusting it
  // via pattern 4 go unguarded.
  for (const [name, invoke] of Object.entries(KNOWN_DELEGATES)) {
    it(`${name} calls settleQuery for a failed input`, () => {
      vi.mocked(settleQuery).mockClear()
      invoke()
      expect(settleQuery).toHaveBeenCalled()
    })
  }

  it('every settleQuery-mentioning export function is a registered, runtime-verified delegate', () => {
    // Coverage nudge, not a trust source (see settleQueryTextCandidateNames'
    // own doc comment): if this ever finds a name NOT in KNOWN_DELEGATES,
    // a new classifier was added without being wired into the runtime
    // check above — fix by adding it there with a realistic fixture, not
    // by trusting its source text.
    const unregistered = settleQueryTextCandidateNames().filter((n) => !(n in KNOWN_DELEGATES))
    expect(unregistered).toEqual([])
  })
})

describe('regression net: known delegate classifiers produce the CORRECT OUTPUT for a failed-with-retained-data input', () => {
  // fix-round 9 — the direct codex ask: a BLACK-BOX behavioral assertion per
  // classifier, not "was settleQuery called". Each fixture is isError:true
  // WITH a realistic, non-empty retained payload — the exact shape a
  // harmless-copy or discard-and-substitute mutation would get wrong, and
  // the exact shape every other fix in this arc exists to handle honestly
  // (Art. 5: the retained data stays visible, Art. 1: it must not be
  // presented as current). Reason tokens/config flags in each fixture are
  // deliberately chosen so that if `failed`/`stale` were incorrectly
  // computed as false, the classifier would resolve to the WRONG, more
  // permissive phase (e.g. 'ok'/'live' instead of 'error'/stale) — so a
  // wrong computation is directly observable in the returned phase, not
  // just in a field that happens not to matter for this input.

  it('classifyChanges: isError wins over an otherwise-ok retained reason, jobs stay visible', () => {
    const q: ChangesQueryLike = {
      isLoading: false,
      isError: true,
      data: {
        jobs: [{ id: 1, name: 'media-launch-mxl-videotestsrc', status: 'successful', started: null, finished: null, elapsed: 12, failed: false }],
        reason: '', // '' alone means "ok" — isError must override this, not the other way round
      },
    }
    const s = classifyChanges(q)
    expect(s.phase).toBe('error')
    expect(s.jobs).toHaveLength(1) // Art. 5: retained data still exposed, not suppressed
  })

  it('classifyForgejo: isError wins over an otherwise-ok retained reason', () => {
    const q: ForgejoQueryLike = { isLoading: false, isError: true, data: { reason: '' } }
    expect(classifyForgejo(q)).toBe('error')
  })

  it('classifyAuditEvents: isError wins over an otherwise-ok retained reason, events stay visible', () => {
    const q: AuditEventsQueryLike = {
      isLoading: false,
      isError: true,
      data: {
        reason: '', // '' alone means "ok" — isError must override this, not the other way round
        window: { known: true, seconds: 604800, reason: '' },
        capped: false,
        excluded: [],
        events: [
          {
            request_id: 'rid-1', class: 'deploy', action: 'deploy', target: 'wl-a', workload: 'wl-a',
            actor: 'alice', role: 'operator', reason: 'demo', at: '2026-09-03T00:00:00Z',
            outcome: { state: 'in_flight', detail: 'dispatched' },
          },
        ],
      },
    }
    const s = classifyAuditEvents(q)
    expect(s.phase).toBe('error')
    expect(s.events).toHaveLength(1) // Art. 5: retained data still exposed, not suppressed
  })

  it('classifyWorkspaceHealth: stale reflects isError even though data is retained, configured, and verified', () => {
    const q: HealthQueryLike = {
      isLoading: false,
      isError: true,
      data: {
        configured: true,
        reachable: true,
        reason: '',
        watchdog_firing: true, // would compute verified:true — a wrong `stale` would make isNominal() lie
        alerts: [
          {
            id: 'a1', name: 'HighLatency', state: 'firing', severity: 'warning', instance: 'n1',
            context: '', summary: '', description: '', runbook_url: '', active_at: '',
          },
        ],
      },
    }
    const s = classifyWorkspaceHealth(q)
    // `phase` alone can't catch a broken `stale` here — data is retained and
    // configured, so phase is correctly 'live' regardless. `stale` is the
    // field this classifier exists to get right; assert it directly.
    expect(s.stale).toBe(true)
    expect(s.phase).toBe('live')
    expect(s.alerts).toHaveLength(1) // Art. 5: retained data still exposed
  })

  it('classifyFacilityDetail: stale reflects isError even though data is retained and configured', () => {
    const q: FacilityDetailQueryLike = {
      isLoading: false,
      isError: true,
      data: {
        requested_site: 'dmf-lab',
        prometheus_configured: true,
        netbox_configured: true,
        site: { slug: 'dmf-lab', name: 'DMF Lab', architecture: null, reason: '' },
        nodes: { reason: '', items: [] },
        platform_services: { reason: '', items: [] },
        storage: { reason: '', items: [] },
        capacity: {
          reason: '', node_name: 'n1', allocatable_cpu_m: 2000, allocatable_mem_b: 4 * 1024 ** 3,
          requests_committed_cpu_m: 500, requests_committed_mem_b: 512 * 1024 ** 2, pod_count: 3,
        },
      },
    }
    const s = classifyFacilityDetail(q)
    expect(s.phase).toBe('loaded')
    expect(s.stale).toBe(true)
    expect(s.data).toBeTruthy() // Art. 5: retained data still exposed
  })
})

describe('regression net: a read-hook consumer must consider isError for its OWN call site', () => {
  it('the hook extraction still finds a plausible number of read hooks (sanity, not a defect check)', () => {
    // Guards the net itself: if hooks.ts's shape changes enough that the
    // regex stops matching anything, the real test below would silently
    // pass with zero call sites checked — fail loudly instead.
    expect(readQueryHookNames().length).toBeGreaterThan(10)
  })

  it('flags no un-exempted call site that reads a query hook\'s data without considering isError for THAT call', () => {
    const readHooks = readQueryHookNames()
    const delegateNames = Object.keys(KNOWN_DELEGATES)

    const offendersByFile: Record<string, string[]> = {}
    for (const [globKey, src] of Object.entries(RAW_SOURCES)) {
      const rel = relPath(globKey)
      if (rel === 'api/hooks.ts' || rel === 'lib/queryState.ts') continue
      if (rel in EXEMPT) continue

      const offenses = fileOffenses(src, readHooks, delegateNames)
      if (offenses.length > 0) offendersByFile[rel] = offenses
    }

    expect(offendersByFile).toEqual({})
  })
})
