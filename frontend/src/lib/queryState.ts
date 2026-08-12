// Shared "settled query" primitive (fix-round 6, PR #81, umbrella #385).
//
// WHY THIS EXISTS. TanStack Query retains the last-good `data` across a
// failed background refetch: `isLoading`/`isFetching` settle back to
// `false`, `data` keeps its PRIOR successful value, and `isError` flips
// `true`. Across six review rounds on this one PR, the SAME shape recurred
// in more than a dozen consumers: something checked `isError` only when
// `!data` (or didn't check it at all), so a settled failed refetch with
// data retained silently re-authorized an absence/count/status claim the
// CURRENT read never established — presenting last-good data as current
// after the very read that would have confirmed it had already failed.
//
// Two exhaustive-sweep rounds (4 and 5) each found "just one more sibling"
// despite correct hook-inventory counts, because the mistake is easy to
// make by hand and easy to miss by re-reading: `data?.foo ?? fallback`
// reads as obviously correct at a glance. `settleQuery` makes the ONE rule
// this whole arc keeps re-discovering — isError wins, unconditionally,
// before any claim reads `data` — the thing a new consumer gets by copying
// the nearest example, not something to remember.
//
// USAGE. A consumer that ONLY needs "can I trust a claim from this data"
// checks `.failed`. A consumer that wants to keep SHOWING retained content
// alongside a notice (Art. 5 — the screen stays still, established by
// MediaWorkloads/index.tsx and every fix-round-3/4/5 panel since) reads
// `.data` off the settled result directly — that stays an explicit,
// visible choice at the call site, never something `data ?? []` does by
// accident.
//
//   const m = settleQuery(useMonitoringMetrics())
//   if (m.loading) return <Loading />
//   if (m.failed) return <Notice stale={m.data != null} />   // .data may still be real
//   return <Content data={m.data} />                          // m.failed is false: data is current

export interface QueryLike<T> {
  isLoading: boolean
  isError: boolean
  data?: T
}

export interface Settled<T> {
  /** First load, nothing to show yet — not even a settled error. */
  loading: boolean
  /**
   * The read this render should NOT be treated as authoritative for any
   * absence/count/status claim — true whenever `isError` is true, REGARDLESS
   * of whether `data` is retained. This is the one flag every consumer in
   * this arc's bug history either checked too late or not at all.
   */
  failed: boolean
  /** Retained/current payload, or undefined if this query has never
   *  resolved successfully even once. Still present (and still real) when
   *  `failed` is true — a caller that wants Art. 5 "screen stays still"
   *  behaviour reads it explicitly instead of treating `failed` as "hide
   *  everything". */
  data: T | undefined
}

export function settleQuery<T>(q: QueryLike<T>): Settled<T> {
  return {
    loading: q.isLoading && q.data === undefined,
    failed: q.isError,
    data: q.data,
  }
}
