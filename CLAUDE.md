# dmf-cms

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

DMF Console, the operator-facing single-pane-of-glass for the DMF Platform.

**AI agent rules:** Read `AGENTS.md` before editing any frontend code. It defines the
design system, component architecture, React conventions, and anti-patterns.

## Implementation Stack

- **Frontend:** React 18 + TypeScript + Vite + Tailwind CSS + React Router v7 + TanStack Query + Zustand
- **Backend:** FastAPI + JSON APIs (SPA-only; legacy Jinja/templates removed)
- **Auth:** Authentik OIDC (passkey-first), session cookies via `starlette.middleware.sessions`
- **Deploy:** Helm chart → `dmf-infra` stack/operator/cms role, invoked by `playbooks/650-dmf-cms.yml`
- **Registry:** `registry.dmf.example.com/dmf-cms:<VERSION>` (Zot)
- **Versioning:** `VERSION` file is source of truth; `scripts/sync-version.sh` propagates to all derived files

## Design Reference

The target UI is defined by the DMF Portal mockup (three role-aware dashboards):
- Media Operator — live operations (signal tables, alarms, quick actions)
- Manager — request approval (approval flows, activity feed, site readiness)
- System Engineer — build & troubleshoot (topology, drift/compliance)

Reference image: `secbrain/tmp/dmf-portal-mockup-2025.png` in the knowledge base vault.
All new UI must match this dark theme, panel structure, and metric card layout.
See `AGENTS.md` for the full design token and component spec.

## Consumes

NetBox API, AWX API, Prometheus API, NMOS IS-04/05 API.

## EBU DMF Scope

Layer 6 — Application & UI. See `dmfdeploy/docs/architecture/DMF EBU Mapping (2026-04-25).md`
for the canonical layer/vertical reference.
