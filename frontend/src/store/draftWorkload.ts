import { create } from 'zustand'

/**
 * The in-progress Create Media Workload draft (umbrella #347 WP-3 spec C).
 * A workload's identity is not something the console can create — see
 * CreateWorkload.tsx's own docstring for the full why — so the draft (studio
 * name, chosen template, facility acknowledgement) lives here, in the
 * browser, until Provision fires.
 *
 * NON-PERSISTED, deliberately: no persist middleware, so this is a plain
 * tab-lifetime Zustand store, not localStorage/sessionStorage. The wizard
 * this arc introduces makes navigating away and back a REACHABLE path
 * (Identity/Design/Plan/Provision are real steps now, not one page's worth
 * of accordion) — this store is what makes the draft survive that. It must
 * NOT survive a reload: sessionStorage would be WRONG here, not just
 * unnecessary. Surviving a reload contradicts the draft-loss warning the
 * page renders in the same breath as the name field — a silently-still-
 * there draft after "refreshing or closing the tab before then loses it"
 * (test-pinned: createWorkload.test.tsx) would be the dishonest version of
 * exactly the trade that warning states, not a nicer one.
 *
 * `reset()` is called from three places, all of which end the draft's life
 * the same way: a successful provision (CreateWorkload's handleProvisionConfirm
 * — the draft becomes a real workload and has nothing left to hold), an
 * explicit "Start over" (the operator's own choice to abandon it), and
 * logout (store/auth.ts's logout action) — a draft that outlives the
 * session it was typed in is residue, not a feature.
 */
export interface DraftWorkloadState {
  studioName: string
  slug: string
  /** Latches true the first time the operator edits the slug field
   *  directly, so a later keystroke in the name field never clobbers it. */
  slugTouched: boolean
  selectedKey: string | null
  /** WP-3 spec D: the operator's own acknowledgement of the resolved
   *  placement — see lib/workloadFlow.ts's DraftProgress.facilityConfirmed. */
  facilityConfirmed: boolean
  setStudioName: (value: string) => void
  setSlug: (value: string) => void
  setSelectedKey: (key: string | null) => void
  setFacilityConfirmed: (confirmed: boolean) => void
  reset: () => void
}

/**
 * Turn a human studio name into the slug the backend will actually record.
 * Mirrors, rather than replaces, WORKLOAD_SLUG_RE (workloadSlug.ts): this
 * only proposes a candidate for the operator to accept or edit — the single
 * validity check that decides whether it is USABLE stays isValidWorkloadSlug,
 * called at CreateWorkload.tsx's one call site.
 */
function deriveSlug(name: string): string {
  let candidate = name.toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '')
  candidate = candidate.replace(/^-+/, '').replace(/-+$/, '')
  if (candidate.length > 40) candidate = candidate.slice(0, 40).replace(/-+$/, '')
  return candidate
}

const INITIAL_DRAFT = {
  studioName: '',
  slug: '',
  slugTouched: false,
  selectedKey: null as string | null,
  facilityConfirmed: false,
}

export const useDraftWorkloadStore = create<DraftWorkloadState>((set) => ({
  ...INITIAL_DRAFT,
  setStudioName: (value) =>
    set((s) => ({ studioName: value, slug: s.slugTouched ? s.slug : deriveSlug(value) })),
  setSlug: (value) => set({ slug: value, slugTouched: true }),
  setSelectedKey: (key) => set({ selectedKey: key }),
  setFacilityConfirmed: (confirmed) => set({ facilityConfirmed: confirmed }),
  reset: () => set({ ...INITIAL_DRAFT }),
}))
