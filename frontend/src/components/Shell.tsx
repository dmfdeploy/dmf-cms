import { Outlet } from 'react-router-dom'
import Topbar from './Topbar'
import Sidebar from './Sidebar'

/**
 * FIX ROUND (umbrella #515, gate P1 — the fixed row's height was assumed,
 * not measured). The first attempt kept the header-slot row `position:
 * fixed` and offset `<main>` by a constant `mt-14` (56px) matching that
 * row's height at ONE viewport (1440px wide, LifecycleStrip on a single
 * line). Below ~390px the strip wraps into a 5-key single column (5 keys at
 * `h-10` + 4 `gap-2` gaps + the row's own `py-2` ≈ 248px tall) — the row was
 * then ~248px tall while `<main>` still started 56px below it, so roughly
 * 192px of the page's own first content sat under the still-fixed row:
 * exactly the "sidebar holds still while the rail covers the page" trap the
 * operator named, reintroduced at a width the previous round never
 * measured.
 *
 * Fixed by inverting which element leaves the flow, not by making the
 * offset dynamic (a ResizeObserver measuring the row's real height would
 * work, but keeps the actual defect: two numbers in two files that must
 * agree). The header-slot row is back in NORMAL FLOW (Topbar.tsx) — at any
 * width, at any height the rail wraps to, it reserves exactly its own real
 * height for whatever comes after it, with no constant anywhere to drift
 * out of sync. `<Sidebar/>` is the element positioned OUT of flow instead
 * (`fixed`, anchored to the header's own bottom edge and the viewport's own
 * bottom — see that component's own comment) — its position is now
 * independent of the row's presence or height entirely, which is the
 * actual "sidebar does not move" requirement, not a side effect of getting
 * the row's height right elsewhere.
 *
 * `<main>` takes a permanent `pl-16` (64px, Sidebar's own `w-16`) instead
 * of a slot-row-conditional `mt-14`: the sidebar occupies that column for
 * the page's full height now (it's `fixed`, not scoped to the rail's own
 * band), not just alongside the rail, so the offset is unconditional too —
 * Shell no longer needs to know whether the row is showing at all (no
 * `useShowHeaderSlotRow` import here any more), which removes the transient
 * Shell/Topbar timing question the previous version had to reason about,
 * rather than answering it.
 */
export default function Shell() {
  return (
    <div className="bg-bg text-text h-full flex flex-col overflow-hidden">
      <Topbar />
      <Sidebar />
      <main className="flex-1 overflow-y-auto scroll-smooth pl-16">
        <Outlet />
      </main>
    </div>
  )
}
