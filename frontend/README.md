# DMF Console Frontend

React 19 + Vite + TypeScript frontend for the DMF Platform console.

## Development Setup

### Prerequisites
- Node.js 22+
- npm or yarn

### Installation & Running

```bash
# Install dependencies
npm install

# Start dev server (proxies /api to http://localhost:8000)
npm run dev

# Open http://localhost:5173 in your browser
```

The dev server will proxy API calls to FastAPI running on port 8000.

### Building for Production

```bash
npm run build
```

Output goes to `../src/dmf_cms/static/app/` (automatically served by FastAPI).

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

## Development Workflow

1. **FastAPI running on port 8000:**
   ```bash
   cd <repos>/dmf-cms
   DMF_CONSOLE_DEV_LOGIN_ENABLED=true uvicorn src.dmf_cms.main:app --reload
   ```

2. **Vite dev server on port 5173** (in another terminal):
   ```bash
   cd <repos>/dmf-cms/frontend
   npm run dev
   ```

3. Open http://localhost:5173
4. Dev login as "operator"
5. Navigate to Workflows
6. Click Launch on a workflow
7. Watch the job status update in real-time

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
