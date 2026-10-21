# AGENTS.md — dmf-cms

dmf-cms is the operator console of the dmfdeploy platform: a React 19 and
Tailwind SPA (`frontend/`) on a FastAPI backend (`src/dmf_cms/`). Umbrella repo:
https://github.com/dmfdeploy/dmfdeploy. Before you start, go to your umbrella
checkout (a sibling clone), run `git pull` and `bin/generate-status.sh` there,
then read `STATUS.digest.local.md`. Post shared notes to
https://github.com/dmfdeploy/dmfdeploy/issues/618. Before secrets, cluster work
or a release, read section 0 of the matching umbrella skill.

## Build and test

```bash
scripts/sync-version.sh --check                  # must pass before any PR
( cd frontend && npm ci && npm run lint && npm test && npm run build )
pip install -e '.[dev]' && rm -rf src/dmf_cms/static/app && pytest -q
DMF_CONSOLE_DEV_LOGIN_ENABLED=true uvicorn src.dmf_cms.main:app --reload
```

## Rules that are easy to miss

- `VERSION` is the only version source; change it only with
  `scripts/sync-version.sh`. Build, publish and deploy only through `scripts/`
  and playbooks 630 and 650, never by hand. Read
  `docs/DEVELOPMENT-AND-BUILD-RULES.md` before any release.
- Use Tailwind and the `.panel`, `.card`, `.btn`, `.badge-status-*` classes in
  `frontend/src/index.css`. No inline layout styles or new status colors;
  update all consumers if you change a token. Add no CSS framework, component
  library, Storybook or visual regression CI. Docker builds target the Colima
  `docker-build` profile, not the default one.
- React: typed functional components (no `any`), stable `key`s, few effects.
  Fetch only through TanStack Query hooks in `frontend/src/api/hooks.ts`. Keep
  auth state in `frontend/src/store/auth.ts`. Use `window.location` only for non-SPA routes.
- Render role views from `user.role`. Never hardcode mock data; use API hooks
  or a "Coming in Release X" placeholder.
- Plan non-trivial work; re-plan if it goes sideways. Never mark work done
  without proof: build, version check, tests, and signed-in and signed-out
  route checks.

<!-- WORKING-MODEL-BLOCK-START — generated from umbrella docs/templates/working-model-block.md; do not edit copies, edit the template and run bin/check-working-model-sync.sh -->
## Working model (mandatory)

Canonical: [docs/WORKING-MODEL.md](https://github.com/dmfdeploy/dmfdeploy/blob/main/docs/WORKING-MODEL.md)
in the umbrella repo. The three rules that matter mid-task:

1. **Work starts at an issue** in the canonical backlog
   ([dmfdeploy/dmfdeploy issues](https://github.com/dmfdeploy/dmfdeploy/issues)):
   `component:*`/`workstream:*` labels **always**, plus a milestone **only if
   the work is scheduled** — unscheduled work gets `platform-debt` and no
   milestone (§2). Non-trivial work gets a plan doc in umbrella `docs/plans/`
   with `tracking_issue` frontmatter.
2. **The completing PR auto-closes its issue; you still flip the plan
   frontmatter by hand in that PR.** Reference umbrella issues **fully
   qualified** — `Closes dmfdeploy/dmfdeploy#N` (bare `#N` targets the wrong
   repo); the daily issue-close reconciler honors that ref, cross-repo
   included. Manual close is a fallback.
3. **Never invent a local backlog** (TODO files, ad-hoc trackers). Issues =
   liveness; plan frontmatter = design state; ADRs = decisions (RFC in
   Discussions first); STATUS.md = committed notes; STATUS.local.md = live repo snapshot.
<!-- WORKING-MODEL-BLOCK-END -->
