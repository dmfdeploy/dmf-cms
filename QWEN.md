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
2. `dmfdeploy/QWEN.md` — full boot ritual + skills index + Qwen-specific rules
3. `dmfdeploy/docs/decisions/INDEX.md` — ADRs applicable to your task
4. The most recent file under `dmfdeploy/docs/handoffs/`

For cluster ops, secrets, or dmf-cms releases, also read §0 Secrets Discipline
of the relevant skill in `dmfdeploy/.claude/skills/`. Qwen doesn't have
Claude's `/skill-name` invocation — read the SKILL.md as documentation
and apply its sections like instructions.

If you change cross-repo state, update the `<!-- HUMAN-START -->` section of
`dmfdeploy/STATUS.md` before ending the session.

---

## Workflow Rules (Qwen-specific for dmf-cms)

### Before editing any frontend code
1. Read `AGENTS.md` — it contains the design system, component architecture, and anti-patterns.
2. Check current `VERSION` and run `scripts/sync-version.sh --check` to verify repo state.

### Build & verify
```bash
# Version check (must pass before any PR)
scripts/sync-version.sh --check

# Frontend dev (hot reload)
cd frontend && npm run dev    # proxies /api and /auth to localhost:8000

# Backend dev
DMF_CONSOLE_DEV_LOGIN_ENABLED=true uvicorn src.dmf_cms.main:app --reload

# Build check
cd frontend && npm ci && npm run build
```

### Release procedure
```bash
scripts/release.sh patch      # or minor / major / X.Y.Z
git push origin HEAD && git push origin v<NEW>

# Deploy via Ansible
cd $DMFDEPLOY_UMBRELLA/dmf-env
bin/run-playbook.sh ../dmf-infra/k3s-lab-bootstrap/playbooks/650-dmf-cms.yml

# Verify
scripts/verify-cluster.sh
curl -sk https://console.dmf.example.com/healthz
```

### Docker / Colima
- All Docker commands target Colima: `DOCKER_HOST=unix://$HOME/.colima/docker-build/docker.sock`
- Colima instance name: `docker-build` (not default profile)
- Start: `colima start docker-build &` then wait for `docker info` to succeed

### Plan mode
- Enter plan mode for any non-trivial task (3+ steps, architectural decisions, new pages).
- STOP and re-plan if something goes sideways.
- After any correction: update the repo's AGENTS.md or CLAUDE.md with the lesson.

### Verification before done
- Never mark a task complete without proving it works.
- Run `scripts/sync-version.sh --check`, build the frontend, and verify no compile errors.
- For route changes: test both authenticated and unauthenticated paths.
