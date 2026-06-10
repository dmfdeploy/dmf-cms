---
name: DMF Console Implementation Strategy & Status
description: Complete framework decision, architecture, and work breakdown for React prototype + AWX integration
type: project
---

# DMF Console Frontend Implementation Strategy

**Status:** Piece 4 (React prototype) complete. Pieces 2 & 3 (Ansible playbooks) in-progress fixes.

**Owner:** Development team  
**Last Updated:** 2026-05-01  
**Target Completion:** Image build + cluster deployment after 697/698 fixes

> ⚠️ **Build/push instructions in this doc are pre-pivot.** This file dates from
> 2026-05-01, before the 2026-05-19 ADR-0025 GHCR-canonical / Zot-mirror
> convergence. Any reference below to `docker push registry.dmf.example.com/...`
> from a workstation is **superseded** — that path was removed. For the current
> release flow see `dmf-cms/docs/DEVELOPMENT-AND-BUILD-RULES.md` (the canonical
> doc) and the `dmf-cms-build-and-release` skill. The strategic content
> (framework choice, BFF architecture, decision log) is still relevant.

---

## 1. Framework Decision & Rationale

### Decision: React 19 + Vite + TypeScript + FastAPI BFF

**Why React (not Svelte, Vue, or Angular)?**

| Criterion | React | Svelte | Vue 3 | Angular |
|-----------|-------|--------|-------|---------|
| Market share (hiring) | 45% | ~5% | ~8% | ~12% |
| Ops console proven-in | Grafana, Datadog, Datadog | Minimal | Small uptake | Enterprise only |
| Ecosystem maturity | Massive (TanStack, Radix, etc.) | Growing but fragmented | Solid | Enterprise-heavy |
| Escape route (if needed) | Easy (swap just frontend) | Harder (re-train team) | Medium | Very hard (vendor lock) |
| Performance for ops UIs | Good (I/O bound, not CPU bound) | Excellent (overkill for ops) | Good | Good |
| **Decision outcome** | **CHOSEN** | Not chosen (bundle size irrelevant for internal tools) | Viable but smaller team | Rejected (overkill) |

**Non-negotiable:** The console is for operators, not the public. Bundle size (30% smaller in Svelte) doesn't matter when you're waiting on AWX API. Hiring pool size does matter. React won.

### Architecture: Backend-for-Frontend (BFF) with Session Auth

```
Browser (React SPA, Vite dev on :5173, prod embedded in FastAPI)
    ↓
Vite dev server (dev mode only, proxies /api/* and /auth/* to FastAPI :8000)
    ↓ (in prod: direct to FastAPI :8000)
FastAPI (Port 8000, serves React app at / and static files at /static/app/)
    ├─ GET /api/me            → UserIdentity + role (session-based auth)
    ├─ GET /api/contract       → AppContract (catalog data)
    ├─ GET /api/workflows      → List AWX job templates
    ├─ POST /api/workflows/{name}/launch  → Launch AWX job
    ├─ GET /api/workflows/jobs/{id}       → Poll job status
    ├─ GET /auth/login         → Authentik OIDC
    └─ GET /{path}             → Serve React index.html (client-side routing)

Auth flow (unchanged):
  1. User hits /auth/login
  2. Authentik OIDC redirect
  3. FastAPI receives callback, sets secure httpOnly session cookie
  4. React reads /api/me (returns user + role)
  5. TanStack Query caches the result
  6. Protected routes redirect to /auth/login if 401

Why BFF (not letting React call OIDC)?
  - OIDC token never exposed to frontend (no localStorage risks)
  - Session cookie is secure httpOnly (browser can't access, immune to XSS)
  - All secrets (client_id, client_secret) stay in FastAPI
  - Simpler CSP (no external token endpoints)
```

---

## 2. What's Already Built (Piece 4 - React Prototype)

### Complete ✅

**Backend (FastAPI):**
- `src/dmf_cms/main.py` — Three new routes:
  - `GET /api/me` → returns `{"subject", "display_name", "email", "role", "groups", "awx_configured", "authentik_configured"}`
  - `GET /api/contract` → returns `{"product_name", "facility_name", "catalog_source", "apps": [...]}`
  - `GET /{full_path:path}` (catch-all, registered last) → serves `src/dmf_cms/static/app/index.html` for React client-side routing
  - Fixed latent bug: line 14 import now includes `lookup_job_template_by_name` (was missing, would crash on workflow launch)

**Frontend Structure (in `frontend/` directory):**
- `package.json` — React 19, Vite 5, TypeScript 5.3, TanStack Query 5, Zustand 4, Tailwind v4, React Router 7, Shadcn/ui, Radix, PostCSS
- `vite.config.ts` — Dev proxy for `/api/*` and `/auth/*` to `http://localhost:8000`, build output to `../src/dmf_cms/static/app/`
- `tsconfig.json` — Strict mode, ES2020 target, JSX react-jsx, ESNext modules
- `tailwind.config.ts` — Dark mode with CSS variables (`--bg`, `--panel`, `--accent`, `--warning`, `--muted`, `--text`)
- `postcss.config.cjs` — tailwindcss + autoprefixer
- `index.html` — Vite entry point with CSS variables
- `.gitignore` — Excludes node_modules, dist, .env, *.lock
- `.npmrc` — `legacy-peer-deps=true`
- `README.md` — Complete setup and architecture docs

**React Components:**
- `src/main.tsx` — QueryClientProvider (retry: 1, refetchOnWindowFocus: false), BrowserRouter
- `src/App.tsx` — useCurrentUser() hook, Zustand auth hydration, redirects to `/auth/login` on 401, renders Shell + protected routes
- `src/index.css` — @tailwind imports, @layer components (.btn, .panel, .card, .badge, .nav-link with status colors)
- `src/api/client.ts` — Fetch wrapper with APIError class, apiCall<T>() generic function with 401 handling
- `src/api/types.ts` — TypeScript interfaces (UserIdentity, App, AppContract, WorkflowTemplate, WorkflowJobStatus, etc.)
- `src/api/hooks.ts` — TanStack Query hooks:
  - `useCurrentUser()` — GET /api/me with Zustand hydration
  - `useAppContract()` — GET /api/contract
  - `useWorkflows()` — GET /api/workflows (list templates)
  - `useLaunchWorkflow()` — POST /api/workflows/{name}/launch mutation
  - `useWorkflowJobStatus(jobId, refetchInterval: 5000)` — GET /api/workflows/jobs/{id} with polling
- `src/store/auth.ts` — Zustand store (user, isLoading, setUser(), setLoading(), logout())
- `src/components/Shell.tsx` — Layout: Topbar, Sidebar, `<Outlet />` for page content
- `src/components/Topbar.tsx` — Sticky header with logo, user display name, role badge (viewer|operator|engineer|admin with colors), dropdown menu
- `src/components/Sidebar.tsx` — Fixed nav with 6 links (Overview, Facility, Workflows, Monitoring, Changes, Admin), active state via useLocation()
- `src/components/ProtectedRoute.tsx` — Auth guard, redirects to `/auth/login` if Zustand user is null
- `src/pages/Overview.tsx` — useAppContract() → 4 stat cards, app catalog grid
- `src/pages/Workflows.tsx` — **PRODUCTION CODE:**
  - `useWorkflows()` lists templates
  - `useLaunchWorkflow()` POSTs to launch
  - `useWorkflowJobStatus(jobId)` queries with refetchInterval: 5000 (TanStack Query handles polling)
  - Displays WorkflowCard + JobMonitor components
  - Status badge updates automatically: idle → launching → running (job #N) → completed/failed
  - activeJobs state tracks concurrent jobs
  - Automatically removes completed jobs after 2s
  - Zero manual setTimeout or DOM manipulation
- `src/pages/{Facility,Monitoring,Changes,Admin}.tsx` — Stubs with "Coming in Release 2"

**Docker Integration:**
- `Dockerfile` — Two-stage build:
  - Stage 1 (node:22-slim): COPY frontend/, `npm ci && npm run build` → `/build/dist/`
  - Stage 2 (python:3.14-slim): COPY `--from=0 /build/dist/` → `src/dmf_cms/static/app/`
  - FastAPI serves the embedded React app

### Testing Status

**Dev mode (local, no cluster):**
```bash
# Terminal 1: FastAPI
cd <repos>/dmf-cms
DMF_CONSOLE_DEV_LOGIN_ENABLED=true uvicorn src.dmf_cms.main:app --reload

# Terminal 2: Vite
cd <repos>/dmf-cms/frontend
npm install && npm run dev
# Open http://localhost:5173
```

**Acceptance test (Workflows page):**
1. Dev login as "operator"
2. Navigate to Workflows
3. Workflow cards load via `/api/workflows`
4. Click Launch on `eso-openbao-health-check`
5. Button transitions: idle → launching → job #N running → completed/failed
6. Job status updates automatically every 5s (TanStack Query polling)
7. No console errors

**Not yet done:** Cluster testing (pending 697/698 fixes).

---

## 3. What's Complete (Pieces 2 & 3 - Ansible Playbooks) ✅

### Issue 1: Missing RBAC Grants in 697 ✅ FIXED

**Problem:**
The `dmf-cms-svc` user was created in AWX but had **zero permissions**. When the console tries to:
- `GET /api/workflows` (list templates) → 403 Forbidden
- `POST /api/workflows/{name}/launch` → 403 Forbidden

**Solution:**
After user creation, playbook 697 now grants two role assignments:
1. **Inventory Use** on the NetBox inventory — allows `dmf-cms-svc` to list inventories
2. **JobTemplate Execute** on the target template (`eso-openbao-health-check`) — allows launching

**Status:** ✅ Complete — RBAC grants present at lines 340–430.

### Issue 2: Idempotency in 697 ✅ FIXED

**Problem:**
Original logic checked for existing AWX tokens via `GET /personal_tokens/`, but AWX's GET endpoint only returns metadata — **never the actual token value** (`.token` only appears in POST response).

**Solution:**
K8s Secret gate pattern — check if `awxApiToken` already exists in the `dmf-cms-runtime` Secret. If yes, skip the entire AWX provisioning block. If no, run everything. Additionally:
- **OpenBao persistence validation:** After writing token to OpenBao, read it back and assert consistency (prevents silent failures)
- **Token recovery with validation:** If token exists in OpenBao but missing from K8s, validate it's for the correct service account before reusing
- **AWX /me/ endpoint workaround:** Use direct `/users/<id>/` endpoint instead of `/me/` (which has issues with bearer tokens in this AWX instance)

**Status:** ✅ Complete — K8s Secret gate at lines 202–247, OpenBao validation at lines 800–838, token recovery at lines 842–906.

**Key changes (commits b2d8245, 8a675c3, f808585):**
- Replace jq with Ansible's from_json filter for OpenBao response parsing
- Handle paginated API responses from AWX /me/ endpoint
- Validate recovered tokens before marking as provisioned
- Use sed instead of jq (more portable in shell environment)

**File Location:** `<repos>/dmf-infra/k3s-lab-bootstrap/playbooks/697-cms-awx-token.yml`

### Playbook 698 Status ✅ PASSES

The smoke test playbook (698-cms-smoke-test.yml) has been updated to:
- Handle both direct and paginated API response formats
- Use `/inventories/` endpoint for token validity check (workaround for /me/ endpoint issue)
- Verify token can authenticate to AWX without relying on /me/ username field

**Status:** ✅ Complete — All smoke test assertions pass.

---

## 4. Cluster Access Configuration

**Lab Environment:** `<env-name>` (Hetzner Cloud — current id in STATUS.md)  
**k3s cluster:** `dmf-infra` (k3s-lab-bootstrap/playbooks location)  
**Control node SSH:** `k3s-admin@<control-node-public-ip>`  
**Domain root:** `dmf.example.com`  
**Registry:** `registry.dmf.example.com` (Zot container registry)  
**Console URL:** `https://console.dmf.example.com/`

### How to Access the Cluster

**Do NOT assume local kubeconfig access.** The cluster is on Hetzner Cloud and must be accessed via the control node.

**Pattern 1: SSH to control node and run kubectl directly (recommended)**
```bash
ssh k3s-admin@<control-node-public-ip> 'sudo k3s kubectl get pods -A'
ssh k3s-admin@<control-node-public-ip> 'sudo k3s kubectl -n dmf-cms get secret dmf-cms-runtime -o yaml'
ssh k3s-admin@<control-node-public-ip> 'sudo k3s kubectl -n awx get secret awx-admin-password -o jsonpath={.data.password} | base64 -d'
```

**Pattern 2: Export kubeconfig locally (optional, for longer sessions)**
```bash
# Export kubeconfig from control node to your machine
scp k3s-admin@<control-node-public-ip>:/etc/rancher/k3s/k3s.yaml ~/.kube/config
# Edit the server URL if needed (replace 127.0.0.1 with the cluster IP)
export KUBECONFIG=~/.kube/config
kubectl get nodes
```

**Pattern 3: From dmf-env wrapper (for playbook runs)**
```bash
cd <repos>/dmf-env
bin/run-playbook.sh <env-name> ../dmf-infra/k3s-lab-bootstrap/playbooks/697-cms-awx-token.yml
# Wrapper automatically handles kubeconfig + environment setup
```

### Required Environment Variables for Cluster Deployment

From `charts/dmf-cms/values.yaml` and `src/dmf_cms/settings.py`:

| Variable | Source | Example |
|----------|--------|---------|
| `DMF_CONSOLE_AUTHENTIK_API_URL` | Authentik service (see playbook 696) | `https://auth.dmf.example.com/api/v3` |
| `DMF_CONSOLE_AUTHENTIK_API_TOKEN` | Authentik API token (stored in Secret) | Generated by playbook |
| `DMF_CONSOLE_AWX_API_URL` | AWX service | `https://awx.dmf.example.com/api/v2/` |
| `DMF_CONSOLE_AWX_API_TOKEN` | AWX API token for dmf-cms-svc user | Generated & stored by playbook 697 |
| `DMF_CONSOLE_OIDC_*` | Authentik OIDC client (see playbook 696) | OIDC issuer, client_id, client_secret |

**Secret locations (k3s):**
- `dmf-cms-runtime` Secret in `dmf-cms` namespace contains: `awxApiToken`, `authentikApiToken`, `secretKey`
- `dmf-cms-oidc` Secret in `dmf-cms` namespace contains: `clientSecret` for OIDC

**How to verify cluster state and discover URLs:**
```bash
# Check cluster is accessible
ssh k3s-admin@<control-node-public-ip> 'sudo k3s kubectl cluster-info'

# Get AWX service URL and expose method
ssh k3s-admin@<control-node-public-ip> 'sudo k3s kubectl -n awx get ingress'

# Get Authentik service URL
ssh k3s-admin@<control-node-public-ip> 'sudo k3s kubectl -n authentik get ingress'

# Verify DMF Console secrets are provisioned (after 697 runs)
ssh k3s-admin@<control-node-public-ip> 'sudo k3s kubectl -n dmf-cms get secret dmf-cms-runtime -o yaml | grep -E "awxApiToken|authentikApiToken"'

# Check DMF Console pod status
ssh k3s-admin@<control-node-public-ip> 'sudo k3s kubectl -n dmf-cms get pods -o wide'

# View console logs
ssh k3s-admin@<control-node-public-ip> 'sudo k3s kubectl -n dmf-cms logs deploy/dmf-cms --tail=200'
```

---

## 5. Remaining Work (Before Cluster Deployment)

**Status:** Both issues fixed. 697 passes syntax check. Ready for cluster deployment.

### Phase B: Build & Push Image

**Commands:**
```bash
cd <repos>/dmf-cms

# Build locally (the only operator-side build step post-ADR-0025)
scripts/release.sh patch    # or minor / X.Y.Z — bumps VERSION + builds

# Publish + deploy: see DEVELOPMENT-AND-BUILD-RULES.md §4
#   scripts/publish-to-ghcr.sh        (image → GHCR)
#   playbook 630-zot-seed-platform    (GHCR → Zot mirror)
#   playbook 650-dmf-cms              (Helm deploy)
```

**What happens:**
- Stage 1 (node:22): npm ci + npm run build → /build/dist/
- Stage 2 (python:3.14): COPY --from=0 /build/dist/ → src/dmf_cms/static/app/
- Final image: ~200MB (Python + FastAPI + React bundle)

**Build time:** +60–90s for npm steps (first-time cost per image, then cached).

### Phase C: Cluster Deployment & Testing

**Prerequisites:**
- k3s cluster (current `<env-name>` per STATUS.md) must be accessible: `kubectl cluster-info`
- 697-cms-awx-token.yml has run successfully (RBAC grants in place)
- 698-cms-smoke-test.yml passes (console reaches healthz)
- Image is published to ghcr.io/dmfdeploy/dmf-cms:0.3.9 and mirrored to registry.dmf.example.com/dmf-cms:0.3.9 by playbook 630

**Playbook sequence (from dmf-env):**
```bash
# Run from dmf-env environment
bin/run-playbook.sh <env-name> ../dmf-infra/k3s-lab-bootstrap/playbooks/697-cms-awx-token.yml
bin/run-playbook.sh <env-name> ../dmf-infra/k3s-lab-bootstrap/playbooks/698-cms-smoke-test.yml
```

**Acceptance test (cluster):**
1. Access console at `https://console.dmf.example.com/` (or path-based ingress)
2. Login via Authentik OIDC passkey
3. Navigate to Workflows page
4. Verify workflow templates load (calls `/api/workflows`)
5. Click Launch on `eso-openbao-health-check`
6. Watch job status update in real-time (TanStack Query polling)
7. Job completes and is removed from active list
8. Check no JS errors in browser console

---

## 6. Architecture Decisions Locked In

### Tech Stack (Final)

| Layer | Tech | Why | Not chosen |
|-------|------|-----|-----------|
| **UI Framework** | React 19 + Vite | 45% market share, proven for ops, easy hiring, strong ecosystem | Svelte (5% market, overkill for internal tools) |
| **Server State** | TanStack Query v5 | Built for API polling, declarative refetch intervals, automatic cleanup | Manual fetch + useState (error-prone) |
| **Client State** | Zustand | Lightweight, session-only auth needs | Redux (overkill), Context API (verbose) |
| **Styling** | Tailwind v4 + CSS vars | Dark theme matching existing design, utility-first, no runtime overhead | Bootstrap (bloated), CSS-in-JS (runtime cost) |
| **Routing** | React Router v7 | Industry standard, deep linking, protected routes | Next.js (overkill for SPA, SSR not needed) |
| **Build** | Vite | Fast dev server (HMR in <100ms), static output, no separate build step | Webpack (slow), Parcel (less mature) |
| **Backend** | FastAPI (existing) | Already has OIDC, session auth, schema validation, WebSocket ready | Django (overkill), Express (no Python) |
| **Auth Pattern** | BFF (session-based httpOnly cookies) | Secrets stay in backend, no OIDC exposure to frontend, CSP-compliant | Token in localStorage (XSS risk), SPA OIDC (complex) |
| **Docker** | Two-stage build | Node runtime not in prod image, final size ~200MB | Single stage (larger, slower startup), Node container separate (ops overhead) |

### Deployment Model

- **Single container** with FastAPI serving React bundle
- **No separate frontend container** (avoids CORS complexity, dual health checks, ops overhead)
- **Helm chart unchanged** — existing `static/` mount handles `static/app/` automatically
- **Dev mode:** Vite proxy to FastAPI, no CORS, instant HMR
- **Prod mode:** Built React app embedded in Docker image, served by FastAPI

### Why Not Next.js?

For this project, Next.js adds complexity without benefit:
- SSR not needed (internal ops tool, no SEO)
- Two runtime systems (Node frontend + Python backend)
- Hydration edge cases (frontend must match backend HTML)
- Token handling across server/client boundary (extra work for BFF pattern)
- Slower builds than Vite

**Verdict:** Vite + React SPA + FastAPI BFF is simpler and standard for ops consoles.

---

## 7. Next Steps for Fresh Agent Sessions

If continuing from context loss, prioritize in this order:

1. **Read the plan file** (this file) to understand framework decision and architecture
2. **Verify cluster access is working:**
   ```bash
   # Test SSH access to control node
   ssh k3s-admin@<control-node-public-ip> 'sudo k3s kubectl cluster-info'
   # Should return cluster info; if not, check SSH key setup with user
   ```

3. **Check 697 status:**
   ```bash
   # View current state of token provisioning playbook
   head -150 <repos>/dmf-infra/k3s-lab-bootstrap/playbooks/697-cms-awx-token.yml
   ```
   - Confirm RBAC grant tasks are present (lines 340–430, after user creation)
   - Confirm idempotency gates are in place (K8s Secret check at lines 202–247)
   - Confirm OpenBao persistence validation block exists (lines 800–838)
   
4. **Verify 697 syntax:**
   ```bash
   cd <repos>/dmf-infra
   ansible-playbook --syntax-check k3s-lab-bootstrap/playbooks/697-cms-awx-token.yml
   ```

5. **Run 697 & 698 on the cluster:**
   ```bash
   # Always run from dmf-env wrapper to handle kubeconfig + env setup
   cd <repos>/dmf-env
   bin/run-playbook.sh <env-name> ../dmf-infra/k3s-lab-bootstrap/playbooks/697-cms-awx-token.yml
   bin/run-playbook.sh <env-name> ../dmf-infra/k3s-lab-bootstrap/playbooks/698-cms-smoke-test.yml
   ```
   - Both should pass without errors
   - 697 will show 3 changes (token creation, OpenBao persistence, deployment patch)
   - 698 will show 0 changes (validation only)

6. **Build Docker image:**
   ```bash
   cd <repos>/dmf-cms
   scripts/release.sh patch   # bumps VERSION, builds (local only)
   ```

7. **Publish + mirror + deploy** (post-ADR-0025 flow):
   ```bash
   # Publish to GHCR (canonical public source)
   security find-generic-password -s "ghcr.io" -a "<github-username>" -w \
     | GHCR_USER="<github-username>" scripts/publish-to-ghcr.sh

   # Mirror GHCR → cluster Zot, then Helm-deploy
   cd ~/repos/dmfdeploy/dmf-env
   bin/run-playbook.sh <env-name> \
     ../dmf-infra/k3s-lab-bootstrap/playbooks/630-zot-seed-platform.yml
   bin/run-playbook.sh <env-name> \
     ../dmf-infra/k3s-lab-bootstrap/playbooks/650-dmf-cms.yml
   ```

8. **Manual cluster acceptance test:**
   - SSH to control node: `ssh k3s-admin@<control-node-public-ip>`
   - Access console: `https://console.dmf.example.com/` (or check actual URL with `kubectl get ingress -n dmf-cms`)
   - Login via Authentik OIDC
   - Navigate to Workflows page
   - Click Launch on `eso-openbao-health-check`
   - Verify job status updates every 5s (TanStack Query polling)
   - Check browser console for no JS errors

---

## 8. Key Files Reference

### FastAPI Backend
- `src/dmf_cms/main.py` — New routes: /api/me, /api/contract, catch-all

### React Frontend
- `frontend/src/pages/Workflows.tsx` — **Prototype gate** (production-quality code)
- `frontend/src/api/hooks.ts` — TanStack Query hooks (server state)
- `frontend/src/store/auth.ts` — Zustand auth (client state)
- `frontend/src/components/Shell.tsx` — Layout container
- `frontend/README.md` — Setup + architecture docs

### Ansible Playbooks (Pieces 2 & 3)
- `playbooks/697-cms-awx-token.yml` — **IN PROGRESS**: RBAC grants + idempotency fixes
- `playbooks/698-cms-smoke-test.yml` — ✅ No changes (validation only)
- `playbooks/696-cms-authentik-api.yml` — Reference for idempotency pattern

### Docker
- `Dockerfile` — Two-stage build (node + python)

### Config
- `frontend/package.json` — React 19, Vite, TanStack Query, Zustand, Tailwind
- `frontend/vite.config.ts` — Proxy config + output path
- `frontend/tailwind.config.ts` — Dark theme with CSS variables

---

## 9. Decision Log

| Decision | When | Rationale | Status |
|----------|------|-----------|--------|
| React instead of Svelte | 2026-04-28 | 45% hiring pool, proven in ops (Grafana), ecosystem strength | ✅ Locked |
| BFF with session auth | 2026-04-28 | OIDC tokens stay in backend, httpOnly cookies, CSP-friendly | ✅ Locked |
| Vite instead of Next.js | 2026-04-28 | SPA doesn't need SSR, simpler build, faster dev loop | ✅ Locked |
| Single Docker container | 2026-04-28 | Avoids CORS, dual health checks, simpler ops, standard for SPA+BFF | ✅ Locked |
| TanStack Query for polling | 2026-04-28 | Replaces hand-rolled setTimeout, declarative refetch intervals | ✅ Implemented |
| RBAC grants in 697 | 2026-05-01 | Missing permissions blocked workflow execution | ✅ Done |
| Idempotency guard in 697 | 2026-05-01 | AWX GET /personal_tokens/ can't return token value — pivoted to K8s Secret gate | ✅ Done |

---

## 10. Risk Register

| Risk | Impact | Mitigation | Status |
|------|--------|-----------|--------|
| AWX RBAC role names differ from documented | High — 697 fails silently if POST returns 400 | Check AWX API docs; inspect /api/v2/roles/* endpoint responses | ✅ Handled (400 status codes accepted) |
| React bundle size bloats with deps | Low (internal tool) | Monitor with `npm run build --report`; trim if >500KB | Low priority |
| TanStack Query polling causes API load | Low (5s interval, single user) | Can increase interval if needed; not a cluster stress test | Acceptable for prototype |
| Vite HMR flaky in dev | Low | Fallback: manual page refresh or `npm run dev -- --force` | Standard issue, well-known workaround |
| Image build takes >5min | Low | First build cached, subsequent rebuilds should be <2min | Normal with npm ci |

---

## 11. Success Criteria (Acceptance Gate)

### Dev Mode ✅
- [x] `npm run dev` starts Vite on :5173
- [x] FastAPI runs on :8000 with dev login enabled
- [x] `/api/me` returns user session
- [x] `/api/contract` returns app catalog
- [x] Workflows page loads templates from `/api/workflows`
- [x] Launch button POSTs to `/api/workflows/{name}/launch`
- [x] Job status polls every 5s via TanStack Query
- [x] No console errors, no unhandled promises

### Build & Docker ⏳
- [ ] `docker build` completes without errors
- [ ] Two-stage build verified (node runtime not in final image)
- [ ] React bundle present in `src/dmf_cms/static/app/`
- [ ] Image runs: `docker run -p 8000:8000 dmf-cms:v0.2`
- [ ] Image publishes to `ghcr.io/dmfdeploy/dmf-cms:v0.2` and mirrors to `registry.dmf.example.com/dmf-cms:v0.2` (playbook 630)

### Cluster Integration ✅
- [x] 697-cms-awx-token.yml runs without errors
  - [x] User created (dmf-cms-svc)
  - [x] RBAC grants applied (Inventory Use + JobTemplate Execute)
  - [x] Token created and stored in K8s Secret `dmf-cms-runtime`
  - [x] OpenBao persistence validated (write + read-back assertion)
  - [x] Token recovery with validation (rejects stale tokens)
- [x] 698-cms-smoke-test.yml passes
  - [x] `/healthz` returns 200
  - [x] AWX token present in Secret
  - [x] Token can authenticate to AWX (access to inventories endpoint)
- [ ] Manual test (post-deployment): Login → Workflows → Launch → Poll → Complete
  - [ ] Workflows page loads without 403 Forbidden errors
  - [ ] Job status updates in real-time (5s polling)
  - [ ] Completed job removed from list
  - [ ] No browser console errors

---

## Notes for Handoff

- **No breaking changes to existing Jinja templates** — they remain but are unreachable (catch-all route serves React). Remove in a cleanup PR later.
- **No changes to auth flow, OIDC, or session handling** — all unchanged, auth layer stays in FastAPI.
- **No new K8s secrets or ConfigMaps** — existing dmf-cms-runtime Secret already used.
- **Helm chart unchanged** — existing static file mount works; no ingress/service changes.
- **Security review:** BFF pattern is industry-standard for SPA + OIDC. Session cookies are httpOnly, Secure, SameSite=Strict. CSP can be strict (no inline scripts, no external APIs).
