# DMF Console Frontend

React 19 + Vite + TypeScript frontend for the dmfdeploy platform console.

## Development setup

To install, run, test and build the frontend, see
[Develop and test](../CONTRIBUTING.md#develop-and-test) in `CONTRIBUTING.md`.
That section is the only copy of these commands. `npm run build` writes to
`../src/dmf_cms/static/app/`, which the backend serves.

## Architecture

- **Vite** — fast dev server with HMR
- **React 19** — UI framework
- **React Router** — client-side routing with protected routes
- **TanStack Query** — server state management (API calls, caching, polling)
- **Zustand** — lightweight client state (current user, auth)
- **Tailwind v4** — utility CSS
- **TypeScript** — static typing

## Directory Structure

```
src/
├── main.tsx                # React root + TanStack Query setup
├── App.tsx                 # Router + protected routes
├── index.css              # Global styles + Tailwind
├── api/
│   ├── client.ts          # Fetch wrapper
│   ├── types.ts           # TypeScript types for API responses
│   └── hooks.ts           # TanStack Query hooks (useWorkflows, etc.)
├── store/
│   └── auth.ts            # Zustand auth store
├── components/
│   ├── Shell.tsx          # Sidebar + topbar layout
│   ├── Topbar.tsx         # Header with user menu
│   ├── Sidebar.tsx        # Navigation
│   └── ProtectedRoute.tsx # Auth guard
└── pages/
    ├── Overview.tsx       # Dashboard (app catalog)
    ├── Facility.tsx       # Stub
    ├── Workflows.tsx      # AWX integration (REAL)
    ├── Monitoring.tsx     # Stub
    ├── Changes.tsx        # Stub
    └── Admin.tsx          # Stub
```

## Key Features (Prototype)

### Shell
- Dark theme matching existing design
- Sidebar with 6 nav links (active state via React Router)
- Topbar with user display name, role badge, settings/logout menu

### Workflows (Production Code)
- Lists available AWX job templates via `/api/workflows`
- Launch button → POST to `/api/workflows/{name}/launch`
- Real-time polling of job status (5s interval) via TanStack Query
- Status badge updates automatically
- No manual setTimeout or DOM manipulation

### Other Pages
- Overview: shows app catalog (static fixture from `/api/contract`)
- Facility, Monitoring, Changes, Admin: "coming soon" stubs

### Auth
- Reads session via `/api/me` on app load
- Stores user + role in Zustand
- ProtectedRoute redirects to `/auth/login` if not authenticated
- Settings/Logout links point to backend routes

## Development workflow

Start the backend and the Vite dev server as
[Run the console locally](../CONTRIBUTING.md#run-the-console-locally) in
`CONTRIBUTING.md` describes. Then sign in with the dev login as "operator",
open **Workflows**, select **Launch** on a workflow, and watch the job status
update.

## Selector contract

Tests, e2e specs and demo scripts select the shell and the shared primitives
through a versioned list in `src/lib/selectorContract.ts`. The contract test
(`src/__tests__/selectorContract.test.tsx`) renders each entry's component and
checks that the selector resolves.

Naming rules:

- Select the shell by ARIA role and accessible name, for example
  `getByRole('navigation', { name: 'Console navigation' })`. Don't add a
  `data-testid` to an element that already has a role and a name.
- Use `data-testid` only for an element with no semantic handle.
- Write ids in lowercase kebab-case.
- Name a keyed item `<noun>-<domain key>`, for example `workload-tile-<slug>`.
  The entry's `key` field says what the key means.
- Name `ReasonConfirm` ids `confirm-<action>` and `reason-<action>` by passing
  `testIdPrefix="<action>"`. Without a prefix, the reason field is
  `reason-input` and the Confirm button has no id.

To change a selector on purpose:

1. Edit the entry in `src/lib/selectorContract.ts` and the component.
2. Increase `SELECTOR_CONTRACT_VERSION`.
3. Run `npx vitest run src/__tests__/selectorContract.test.tsx`. The failure
   message prints the new contents for `src/lib/selectorContract.lock.json`.
   Paste them into that file and run the test again.

The in-repo test checks that the lock matches the contract in the same
revision. It can't prove that you bumped the version. CI proves it on pull
requests: `scripts/check-selector-contract-version.mjs` compares the lock with
the one on the base branch. It fails when the digest changed and the version
didn't go up, and when the version went up and the digest didn't change. To run
it locally, from the repository root:

```bash
node frontend/scripts/check-selector-contract-version.mjs origin/main
```

Per-screen ids for layouts that are about to be replaced stay out of the
contract.

## Testing AWX Workflow Integration

Requires:
- AWX API configured (DMF_CONSOLE_AWX_API_URL + DMF_CONSOLE_AWX_API_TOKEN)
- `eso-openbao-health-check` workflow available in AWX

In dev mode with AWX configured:
1. Workflows page loads the template list
2. Click Launch
3. TanStack Query automatically polls `/api/workflows/jobs/{id}` every 5s
4. Status badge updates: running → successful/failed
5. After completion, the job row is removed from the active jobs list

## Next Steps (Release 1+)

- [ ] Role-differentiated UI (Media Operator / Manager / System Engineer mockups)
- [ ] Full Monitoring, Facility, Changes pages
- [ ] Topology visualization
- [ ] Approval workflows with branching logic
- [ ] Real-time updates (SSE/WebSocket)
- [ ] Error handling and retry logic
