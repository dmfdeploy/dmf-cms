/**
 * The route's <h1> (WP-4 stage 2, umbrella #385 finding 5: zero <h1>s exist
 * on any happy-path route — `document.querySelectorAll('h1').length === 0`
 * on both Workspace and Facilities, confirmed live — so a screen-reader
 * user's document outline started at h2 with no page heading at all).
 *
 * DELIBERATELY VISUALLY HIDDEN (`sr-only`), not a rendered heading. The
 * topbar breadcrumb has carried page identity VISUALLY since Arc 1, and the
 * Arc 4 pass is explicitly a *reduction* pass ("less is more, minimal
 * modern design" — umbrella #347's plan §1) that retired the old per-page
 * hero headings this would otherwise resurrect one line under the
 * breadcrumb — the same text, twice, for a sighted operator. A screen
 * reader still gets a correct, present, first-in-outline <h1> either way;
 * sr-only changes nothing about what that user perceives, because the
 * breadcrumb already gives a sighted user the identical information
 * visually. So this closes the accessibility gap (Art. 11) without
 * reopening the visual one Arc 4 closed.
 *
 * Mount this on every render state EXCEPT one that already carries its own
 * single, VISIBLE <h1> as the heading for that state (WorkloadSetup's/
 * WorkloadHome's "Workload not found", WorkloadMaterializing's "Launch failed"/
 * "Provisioning") — a page must never carry two. A loading/error/degraded
 * state that has no visible heading of its own (the common case) still owes
 * the document outline a page identity, the same as the happy path; the WP-4
 * stage 2 audit (umbrella #385 finding 5) found several such states silently
 * missing it and fixed each one, rather than only the happy path this
 * component originally shipped on.
 */
export default function PageHeading({ children }: { children: React.ReactNode }) {
  return <h1 className="sr-only">{children}</h1>
}
