# DMF Console — AI Agent Rules

<!-- WORKING-MODEL-BLOCK-START — generated from umbrella docs/templates/working-model-block.md; do not edit copies, edit the template and run bin/check-working-model-sync.sh -->
## Working model (mandatory)

Canonical: [docs/WORKING-MODEL.md](https://github.com/dmfdeploy/dmfdeploy/blob/main/docs/WORKING-MODEL.md)
in the umbrella repo. The three rules that matter mid-task:

1. **Work starts at an issue** in the canonical backlog
   ([dmfdeploy/dmfdeploy issues](https://github.com/dmfdeploy/dmfdeploy/issues);
   milestone + `component:*`/`workstream:*` labels). Non-trivial work gets a
   plan doc in umbrella `docs/plans/` with `tracking_issue` frontmatter.
2. **The completing PR closes the issue and flips the plan frontmatter in the
   same change.** From a component repo, reference umbrella issues **fully
   qualified** — `Closes dmfdeploy/dmfdeploy#N`; bare `#N` targets the wrong repo.
3. **Never invent a local backlog** (TODO files, ad-hoc trackers). Issues =
   liveness; plan frontmatter = design state; ADRs = decisions (RFC in
   Discussions first); STATUS.md = committed notes; STATUS.local.md = live repo snapshot.
<!-- WORKING-MODEL-BLOCK-END -->

## DMF Platform context — read first

This repo is a component of the **DMF Platform**, an umbrella workspace
checked out alongside this repo. Operators set `$DMFDEPLOY_UMBRELLA` to its
local path. Cross-cutting state (status, decisions, plans, skills) lives
there, not here.

Before any non-trivial change in this repo:

```bash
cd "$DMFDEPLOY_UMBRELLA"
git fetch && git pull
bin/generate-status.sh --no-fetch    # refreshes STATUS.md
```

Then read in order:
1. `dmfdeploy/STATUS.md` — what's happening across all repos right now
2. `dmfdeploy/CLAUDE.md` — full boot ritual + workspace map
3. `dmfdeploy/docs/decisions/INDEX.md` — ADRs applicable to your task
4. The most recent file under `dmfdeploy/docs/handoffs/`

For cluster ops, secrets, or dmf-cms releases, also read §0 Secrets Discipline
of the relevant skill in `dmfdeploy/.claude/skills/`.

If you change cross-repo state, update the `<!-- HUMAN-START -->` section of
`dmfdeploy/STATUS.md` before ending the session.

---

## 1. Design System & Visual Language

**Reference mockup:** `secbrain/tmp/dmf-portal-mockup-2025.png` — three role-aware dashboards
(Media Operator, Manager, System Engineer) with dark theme, metric cards, sparklines,
status tables, and approval/activity feeds.

### Layout Architecture
- **Topbar** — sticky, glass-blur (`bg-panel/80 backdrop-blur-xl`), brand icon + title on left,
  user name + role badge + settings menu on right.
- **Sidebar** — fixed 56-column width (`w-56`), icon + label nav items, active state highlighted
  with `bg-accent/20 text-accent`.
- **Content area** — `flex-1 overflow-auto`, pages use `p-8 max-w-6xl` wrapper.
- **Shell** — `Shell.tsx` wraps all SPA routes with `<Topbar />`, `<Sidebar />`, `<Outlet />`.

### Color Palette (defined in `index.css` `@theme`)
| Token | Value | Usage |
|-------|-------|-------|
| `--color-bg` | `#0f1720` | Page background |
| `--color-panel` | `#1c2835` | Cards, sidebar, topbar |
| `--color-accent` | `#7ec8a5` | Primary actions, active states, key metrics |
| `--color-warning` | `#efc15a` | Warnings, secondary lane badges |
| `--color-muted` | `#9fb0c1` | Secondary text, borders |
| `--color-text` | `#e7eef7` | Primary text |

### Metric Cards (KPI Row)
- 4–6 columns grid, each a `.panel` with large bold number (`text-2xl font-bold text-accent`),
  small muted label below, and optional sparkline/micro-chart with trend arrow (`↑5`, `↓3`).
- Trend arrows: green for positive, red for negative.
- Used for: Active Flows, Faulted Signals, Readiness %, SLA Compliance, etc.

### Status Badges
- Use semantic badge classes: `.badge-status-{new,pending,running,successful,failed,error,canceled}`
- Each maps to a color-coded pill with `text-xs` and appropriate bg/fg combo.
- Don't invent new status colors — use the defined set.

### Panels & Cards
- `.panel` — large section container: `bg-panel border border-muted/20 rounded-2xl p-6`
- `.card` — smaller item container: `bg-panel border border-muted/20 rounded-lg p-4`
- Panels can have headers with `.panel-header` and `.panel-subtitle`.

### Buttons
- `.btn` base: `px-3 py-2 rounded-lg font-medium transition-colors`
- `.btn-primary`: `bg-accent text-bg hover:bg-accent/90`
- `.btn-secondary`: `bg-panel text-text border border-muted/30 hover:bg-panel/80`
- `.btn-sm`: `text-sm px-2 py-1`

### Typography
- Page titles: `text-4xl font-bold` with `text-muted` subtitle below.
- Section headers within panels: `text-xl font-bold` or `text-lg font-semibold`.
- Body/subtitle text: `text-sm text-muted` or `text-xs text-muted`.
- Key numbers/metrics: `text-2xl font-bold text-accent`.

## 2. Role-Aware Content

The mockup shows three distinct dashboard layouts per role:

| Role | Focus | Key Panels |
|------|-------|-----------|
| **Media Operator** | Live operations | Signal Overview table, Active Alarms, My Systems, Quick Actions |
| **Manager** | Request approval | Approval Requests, Activity feed, Upcoming Changes, Site Readiness |
| **System Engineer** | Build & troubleshoot | Infrastructure Topology, Activity, Drift/Compliance, Quick Actions |

When implementing dashboard views, check `user.role` from the auth store and render
the appropriate panel set. The role is one of: `viewer`, `operator`, `engineer`, `admin`.

## 3. Component Architecture

```
frontend/src/
── api/          # TanStack Query hooks, axios client
├── components/   # Shared layout (Shell, Sidebar, Topbar, ProtectedRoute)
├── pages/        # Route-level components (Overview, Workflows, etc.)
├── store/        # Zustand stores (auth)
├── App.tsx       # Route definitions
├── index.css     # Design tokens + component classes
└── main.tsx      # Entry point
```

**Rules:**
- Route pages live in `pages/` — one file per route.
- Reusable UI primitives (when added) go in `components/ui/`.
- Feature-composed components go in `components/features/`.
- API hooks in `api/hooks.ts` — use `@tanstack/react-query` with `axios`.
- No inline styles for layout/spacing — use Tailwind utility classes or defined `.panel`/`.card`/`.badge` classes.
- SVG icons should be inline or from a consistent icon set (no mixed icon libraries).

## 4. React Conventions

- **Functional components only** — no class components.
- **TypeScript** — all `.tsx` files must be typed. No `any` for props or state.
- **TanStack Query** — all server data fetching goes through query hooks. No raw `fetch` or `axios` calls in components.
- **Zustand** — auth state managed in `store/auth.ts`. Don't duplicate user state in component `useState`.
- **React Router v7** — use `useLocation`, `Navigate`, `Outlet` for routing. Don't use `window.location` except for full-page navigation to non-SPA routes (`/settings`, `/auth/login`).
- **Keys** — always provide stable `key` props in `.map()` iterations.
- **Effects** — minimize `useEffect`. Prefer derived state and query hooks.

## 5. What NOT to Do

- Don't introduce new CSS frameworks or override the Tailwind theme.
- Don't add component libraries (MUI, Chakra, shadcn) — the design system is custom.
- Don't create "AI-looking" generic UI — match the mockup's dark theme, panel structure, and metric card layout.
- Don't hardcode mock data in pages — use the API hooks or show "Coming in Release X" placeholders.
- Don't modify `index.css` tokens without updating all consumers.
- Don't add Storybook or visual regression CI yet — these are deferred. The mockup is the visual reference.

## 6. Release Context

- **Release 0** (current): Auth scaffold, settings page, basic navigation. Landing page shows app catalog.
- **Release 1**: Role-aware dashboards matching the mockup — metric cards, sparklines, signal tables, approval flows.
- **Release 2**: NetBox inventory, AWX workflow execution, Prometheus/Grafana integration.

When adding features, scope them to the appropriate release. Release-1 features should
progressively replace Release-0 placeholders without breaking the existing contract.
