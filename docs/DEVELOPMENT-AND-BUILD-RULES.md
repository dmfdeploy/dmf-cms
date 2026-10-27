# DMF Console — Development & Build Rules

**Status:** Authoritative. Violations cause rollout drift. Read before any release.
**Last update:** 2026-10-27: exact-SHA release workflow.

This document defines the **only** supported way to version, build, and ship dmf-cms.
The `scripts/` directory in the repo root implements these rules; if you find yourself
running `docker build` or `docker push registry.dmf.example.com/...` by hand, or
editing version numbers in two files, stop.

---

## 1. The Single Source of Truth: `VERSION`

The file `VERSION` at the repo root holds one line: `MAJOR.MINOR.PATCH`.

Every other version field is **derived** from it:

| File | Field | How it's set |
|------|-------|--------------|
| `VERSION` | (whole file) | **Source of truth** — edit only via `scripts/sync-version.sh` |
| `pyproject.toml` | `project.version` | Derived |
| `frontend/package.json` | `.version` | Derived |
| `charts/dmf-cms/Chart.yaml` | `version` and `appVersion` | Derived |
| `charts/dmf-cms/values.yaml` | `image.tag` | Derived |
| `dmf-infra/.../cms/defaults/main.yml` | `cms_image_tag` | Reads `dmf-cms/VERSION` at playbook runtime |

The container image is always tagged `registry.dmf.example.com/dmf-cms:<VERSION>`.
There is no `latest` tag. There is no `v` prefix. There are no pre-release suffixes
in image tags (`-rc1`, `-dirty`, etc.) — if you need to test, use a feature branch
and run `--no-push --dirty`.

### Versioning policy

Strict [SemVer](https://semver.org/) on a release-0 console:

- **PATCH** — bug fix or internal refactor; no behavior change for the operator.
  Example: 0.2.2 → 0.2.3.
- **MINOR** — additive feature; existing flows continue to work unchanged.
  Example: 0.2.x → 0.3.0.
- **MAJOR** — breaking change to API contract, OIDC config, or runtime env shape.
  Example: 0.x.x → 1.0.0. Reserved until release-1.

Until release-1 ships, MAJOR stays at 0. "UI behavior" means what the operator
can *do*, not what they see. A change that adds a capability or alters a flow is
MINOR. A fix that only corrects how an existing state looks is PATCH, even
though the operator can see it. Example: a button that was already disabled but
looked enabled.

---

## 2. The Five Scripts

All under `scripts/`. They are the **only** sanctioned way to bump, build, and verify.

### `sync-version.sh`

Propagates `VERSION` to every derived file, or checks they are in sync.

```bash
scripts/sync-version.sh                 # propagate current VERSION
scripts/sync-version.sh 0.3.0           # set new VERSION, then propagate
scripts/sync-version.sh --check         # exit non-zero if anything is stale
```

Run `--check` in CI on every PR; if it fails, the PR has broken the contract.

### `build-image.sh`

Builds the image locally and tags it `registry.dmf.example.com/dmf-cms:<VERSION>`.
This is the local tag. The release workflow builds the exact merged commit and
publishes it to GHCR; `--no-push` is the default that `release.sh` uses.

Refuses to run if any of these are true:

- `VERSION` isn't valid semver
- `sync-version.sh --check` fails
- Working tree is dirty (override: `--dirty` for local test)

```bash
scripts/build-image.sh --no-push        # build only (the normal mode)
scripts/build-image.sh --check          # validate state, don't build
```

Image labels embed `org.opencontainers.image.version` and `.revision` (git sha)
for traceability.

### `release.sh`

Prepares the release bump: sync → commit → build (local only). It refuses dirty
trees and rejects `--tag`. The release workflow creates the tag and publishes
the image after the bump PR merges and all required checks pass on the merged
commit. Run it on a release branch cut from `origin/main` (§4).

```bash
scripts/release.sh patch                # 0.2.2 → 0.2.3
scripts/release.sh minor                # 0.2.2 → 0.3.0
scripts/release.sh major                # reserve for 1.0
scripts/release.sh 0.4.0                # explicit version
```

The script:
1. Bump VERSION and propagate to all derived files
2. Commit the bump as `chore(release): v<NEW>` (signed off)
3. Build the Docker image locally as `registry.dmf.example.com/dmf-cms:<NEW>`

That image is a local pre-merge build. The release workflow builds the merged
commit again after checking its exact-SHA status results. Cut the release
branch from `origin/main` before running `release.sh`; this avoids carrying a
stale feature branch into the release PR.

```bash
git fetch origin
git switch -c release/0.4.0 origin/main
scripts/release.sh 0.4.0
git push -u origin release/0.4.0
gh pr create --title "chore(release): v0.4.0" --body "Refs dmfdeploy/dmfdeploy#<N>"
# After merge, start the release workflow with this PR number:
gh api repos/dmfdeploy/dmf-cms/dispatches \\
  -f event_type=cms-release -f "client_payload[pr_number]=<PR-NUMBER>"
```

The workflow validates the merged PR and current `main`, then dispatches every
required check on the exact merged SHA. It builds and publishes only when all
live `main-protection` contexts pass. At validation, the release SHA must be
the tip of `main`. If `main` advances during dispatch and any required run
resolves to another SHA, its expected-SHA guard or the exact-run check fails.
No tag or image is created. Once all required checks pass on the release SHA,
a later `main` commit does not change the release source. The tag and image
name the tested commit, which remains an ancestor of `main`.

**The release tag is one-shot.** Two rulesets guard tags on this repo:
`tags-nonrelease-block` blocks creating, updating or deleting any tag that does
not match `v*`, and `tags-release-protect` blocks updating or deleting a `v*`
tag once it exists. Before the release workflow is enabled, add a third tag
ruleset that restricts creation of `refs/tags/v*` to the GitHub Actions app
(integration ID 15368). Keep the update/delete rule without a bypass actor.
The Actions bypass applies to every Actions workflow; only trusted protected
`main` workflows with write permission belong in this boundary. Do not issue a
release dispatch until this creation rule and GHCR package access are reviewed.
The existing `automerge` workflow has `contents: write` so GitHub can rebase-merge
eligible PRs. Its trusted `pull_request_target` job does not check out PR code
and only calls `gh pr merge`; review that job with any change to tag-rule bypass
permissions. Keep `packages: write` limited to the release job.

The workflow checks the image's version and source revision labels before
publishing. To mirror and deploy after it succeeds, follow these steps:

```bash
# 1. Mirror GHCR → cluster-internal Zot
cd $DMFDEPLOY_UMBRELLA/dmf-env
bin/run-playbook.sh <env-name> \
  ../dmf-infra/k3s-lab-bootstrap/playbooks/630-zot-seed-platform.yml

# 2. Helm-deploy via 650 (HEAD-checks Zot, then Helm upgrade)
bin/run-playbook.sh <env-name> \
  ../dmf-infra/k3s-lab-bootstrap/playbooks/650-dmf-cms.yml
```

### `publish-to-ghcr.sh`

The wrapper checks the workflow event, run identity, merged SHA, and gate
marker, then passes the workflow's short-lived token to the umbrella publisher
on stdin. The publisher uses an isolated `DOCKER_CONFIG` and removes it on
exit. These environment checks reject accidental local or alternate-workflow
calls; they are defense in depth, not a security boundary against a holder of
a package-write token who can set arbitrary environment variables.

### `verify-cluster.sh`

After deploying, confirms the cluster is actually running your local `VERSION`.
Reads via SSH from the canonical control node.

```bash
scripts/verify-cluster.sh
```

Drift between local `VERSION` and cluster image is the most common failure mode.
Run this after every Ansible deploy.

### Local dev (no script needed)

```bash
# Terminal 1 — FastAPI
DMF_CONSOLE_DEV_LOGIN_ENABLED=true uvicorn src.dmf_cms.main:app --reload

# Terminal 2 — Vite (proxies /api and /auth to :8000)
cd frontend && npm install && npm run dev
# → http://localhost:5173
```

---

## 3. Publish + Mirror Procedure

The release path has two registries:

| Registry | Role | Auth |
|---|---|---|
| `ghcr.io/dmfdeploy/dmf-cms:<VERSION>` | Canonical public source | Short-lived GitHub Actions token from the verified release workflow |
| `registry.dmf.example.com/dmf-cms:<VERSION>` | Cluster-internal Zot mirror | OpenBao-managed admin creds (used by playbook 630 only) |

The 2026-05-19 ADR-0025 convergence retired direct workstation→Zot pushes.
The verified release workflow publishes to GHCR; **playbook 630 mirrors
GHCR → Zot** using credentials it pulls from OpenBao. Playbook 650 only
HEAD-checks Zot and Helm-deploys.

### Publishing to GHCR

Only the verified release workflow is the supported publisher. It checks the live
required contexts on the merged SHA, builds that commit, checks the image
labels, then passes its short-lived `GITHUB_TOKEN` to
`scripts/publish-to-ghcr.sh` on stdin. The wrapper's environment and dispatch
checks guard the supported call path but can be spoofed by anyone who already
holds a package-write token; they do not prevent that holder from publishing
through another path. Configure the package for public read and grant Actions
access only to the `dmf-cms` repository. Remove unneeded user and team write
grants before enabling release dispatches. Keep package-write permission on
the protected release workflow only. The umbrella helper uses an isolated
`DOCKER_CONFIG` and removes it on exit. Package and organization administrators
and approved package-write workflow maintainers remain trusted; they can
change package access or publish through privileged credentials. Do not use a
PAT or manually push an image.

### Mirroring GHCR → Zot (playbook 630)

Operators do not log into Zot. Playbook `630-zot-seed-platform.yml` does it:

1. Reads Zot admin creds from OpenBao via `dmf-env/bin/get-admin-cred.sh` (which
   uses an ADR-0007-compliant retrieval path — `no_log: true`, password never in
   argv, response not echoed)
2. Materialises the creds to a tempfile authfile at mode 0600
3. `skopeo copy ghcr.io/dmfdeploy/dmf-cms:<VERSION> registry.dmf.example.com/dmf-cms:<VERSION>`
4. Removes the authfile in an `always` block

`cms_image_tag` is read at runtime from the operator's local `dmf-cms/VERSION`
file (role default), so 630 always mirrors whatever the operator just published.

### Anti-patterns (do not do these)

| ❌ Don't | Why | ✅ Do instead |
|---|---|---|
| `docker push registry.dmf.example.com/dmf-cms:*` from workstation | Path removed 2026-05-19; no creds, will fail | Verified release workflow, then 630 |
| `docker login -u USER -p PASS …` | Password lands in shell history + `ps` | `--password-stdin` (umbrella helper already does this) |
| `curl -d '{"password":"..."}' …` | Same argv leak | `--data @<(jq …)` or skip — `get-admin-cred.sh` handles it |
| Curl OpenBao yourself for Zot creds | Burns the secret into the agent transcript | Let playbook 630 do it server-side |
| Re-run 650 when image is missing in Zot | 650 only HEAD-checks; it will fail the same way | Run 630 (or `bootstrap-provision-post-seed.yml --tags zot-seed`) |

---

## 4. The Release Procedure

> **`<env-name>` in the commands below** — substitute the current Hetzner test
> env id from the umbrella's `STATUS.md` (env ids rotate; this doc stays
> env-agnostic).

For every change that needs to land in the cluster:

```
1.  Develop on a feature branch.
2.  Run scripts/sync-version.sh --check       (must pass before PR)
3.  Open PR. Merge to main.
4.  git fetch origin
    git switch -c release/<NEW> origin/main   (never release from a feature branch)
    scripts/release.sh patch                  (or minor / major / X.Y.Z)
5.  Push the branch and open the PR:
    git push -u origin release/<NEW>
    gh pr create --title "chore(release): v<NEW>" --body "Refs dmfdeploy/dmfdeploy#<N>"
6.  After the release PR merges, trigger the release workflow:
    gh api repos/dmfdeploy/dmf-cms/dispatches \
      -f event_type=cms-release -f client_payload[pr_number]=<PR-NUMBER>
    Wait for DMF CMS Release to verify all live required checks, create the
    immutable v<NEW> tag, and publish the verified image.
7.  cd $DMFDEPLOY_UMBRELLA/dmf-env
    bin/run-playbook.sh <env-name> \
        ../dmf-infra/k3s-lab-bootstrap/playbooks/630-zot-seed-platform.yml
    bin/run-playbook.sh <env-name> \
        ../dmf-infra/k3s-lab-bootstrap/playbooks/650-dmf-cms.yml
8.  scripts/verify-cluster.sh
9.  curl -sk https://console.dmf.example.com/healthz
```

Steps 4–9 are not optional. The release workflow owns tag creation and GHCR
publication; local `publish-to-ghcr.sh` calls fail closed. Playbook 630 mirrors
the verified public image to Zot and playbook 650 deploys it.

### What can go wrong (and where)

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Pod still on old image after `helm upgrade` | Helm chart `image.tag` not bumped | `scripts/sync-version.sh --check` |
| `npm ci` fails in Docker build | `package-lock.json` not committed | Commit it; never `.gitignore` it |
| React app 404s; Jinja shell renders | `static/app/` missing or main.py routes shadow | Confirm `Dockerfile` `COPY --from=frontend-builder` line and main.py catch-all is last |
| Playbook re-run downgrades image | Hardcoded `cms_image_tag` in role | Use the `lookup('file', ...)` default that reads `dmf-cms/VERSION` |
| Playbook 650 fails on "image not in Zot" HEAD check | The release workflow or 630 mirror is missing | Re-run 630 (or `bootstrap-provision-post-seed.yml --tags zot-seed`) |
| Local `kubectl` disagrees with reality | Wrong context | Use control node `ssh k3s-admin@<control-node-public-ip>` as canonical |

---

## 5. Repository Layout Rules

### What lives in git

The frontend `src/` is **production source code**; it must be tracked. Until
2026-05-01 we shipped a release with `frontend/src/` untracked — only
`package-lock.json` was in git, and a fresh clone could not build. Don't repeat that.

```
dmf-cms/
├── VERSION                           ← source of truth, plain text, one line
├── pyproject.toml                    ← derived
├── Dockerfile                        ← never edited per-release
├── scripts/                          ← the sanctioned tooling
│   ├── sync-version.sh
│   ├── build-image.sh
│   ├── release.sh
│   ├── publish-to-ghcr.sh
│   └── verify-cluster.sh
├── src/dmf_cms/                      ← FastAPI source (Python)
├── frontend/                         ← React source (TypeScript)
│   ├── package.json                  ← derived (.version)
│   ├── package-lock.json             ← TRACKED, required for npm ci reproducibility
│   ├── src/                          ← TRACKED, the app
│   ├── index.html
│   ├── *.config.ts
│   └── tsconfig*.json
├── charts/dmf-cms/
│   ├── Chart.yaml                    ← derived (version + appVersion)
│   ├── values.yaml                   ← derived (image.tag)
│   └── templates/
└── docs/
    ├── DEVELOPMENT-AND-BUILD-RULES.md       ← this file
    ├── IMPLEMENTATION-STRATEGY.md
    └── ...
```

### What is `.gitignore`d

`node_modules/`, `dist/`, `build/` (Python), `.venv/`, `.env*`, `.DS_Store`,
`*.egg-info/`, `__pycache__/`, `.pytest_cache/`.

**Never** add to `.gitignore`: `package-lock.json`, anything under
`frontend/src/`, anything under `src/dmf_cms/`, the `VERSION` file, or the
`scripts/` directory.

### Branch strategy

- `main`: always shippable. No direct commits; every change lands through a
  pull request.
- Short-lived branches, one per pull request (for example `feature/<name>`, or
  `release/<NEW>` for a release as described in §4). Each one is rebase-merged
  into `main`.

A merge to `main` requires the PR to pass `sync-version.sh --check`. A push of
a `vX.Y.Z` tag triggers (manually, today) the deploy playbook run.

---

## 6. Build Reproducibility Rules

### Frontend

- `npm ci` only — never `npm install` in the build path.
  `npm install` mutates `package-lock.json` and breaks reproducibility.
- Lockfile is committed. If you need new dependencies, run `npm install <pkg>`
  locally, commit both `package.json` **and** `package-lock.json`.
- Build output goes to `src/dmf_cms/static/app/` via `vite.config.ts`'s
  `outDir`. Do **not** commit the build output; the Docker build regenerates it.

### Backend / image

- Two-stage Dockerfile is fixed. Stage 1 produces `static/app/`; Stage 2
  installs the Python package and copies the bundle into the site-packages
  install location (because FastAPI resolves static paths from the installed
  package, not the source tree).
- The image tag is **always** `registry.dmf.example.com/dmf-cms:<VERSION>`.
- `imagePullPolicy: IfNotPresent` is intentional. Bumping VERSION is the only
  way to force a pull. Don't add `Always`; it just hides drift.

### Image label contract

Every built image carries:

```
org.opencontainers.image.version   = <VERSION>
org.opencontainers.image.revision  = <full git commit sha>
org.opencontainers.image.source    = https://github.com/dmfdeploy/dmf-cms
```

`docker inspect <image>` exposes them; useful for forensics when a pod is on
a tag you don't recognize.

### Signing (deferred)

Cosign signing is not yet wired. When it is, the release workflow can sign the
verified image before publication and the cluster can gate pulls on its signature.

---

## 7. The Cluster Is the Truth — Use the Right Lens

The Mac's local `kubectl` context can point at any cluster. For dmf-cms in
the Hetzner lab, the **only** authoritative source is the control node:

```bash
ssh k3s-admin@<control-node-public-ip>
sudo kubectl --kubeconfig /etc/rancher/k3s/k3s.yaml -n dmf-cms get pods -o wide
sudo kubectl --kubeconfig /etc/rancher/k3s/k3s.yaml -n dmf-cms describe deploy dmf-cms | grep Image
```

`scripts/verify-cluster.sh` does this for you. Don't trust local `kubectl get`
for "is the rollout done?" until you've confirmed it points at the right
cluster (`kubectl config current-context`).

---

## 8. Anti-patterns (do not do these)

| Anti-pattern | Why it breaks | Do instead |
|--------------|---------------|------------|
| `docker build -t dmf-cms:latest .` | No version traceability | `scripts/build-image.sh` |
| Editing `pyproject.toml` version by hand | Drifts from chart | `scripts/sync-version.sh X.Y.Z` |
| Hardcoding `cms_image_tag` in the Ansible role | Re-run downgrades | Default reads `VERSION` |
| `git tag` without bumping VERSION | Image doesn't match tag | `scripts/release.sh` |
| Pushing image with dirty tree | Can't reproduce later | Commit first, then build |
| Adding `frontend/src/` to `.gitignore` | Fresh clones can't build | Source belongs in git |
| Reusing a tag (rebuilding `0.2.2`) | Pods cache by tag, won't repull | Bump VERSION |
| `imagePullPolicy: Always` to "fix" caching | Hides drift, doesn't solve it | Bump VERSION |
| Reading state from local `kubectl` for prod | Wrong context — silent | Always SSH to the control node |

---

## 9. CI hooks (target state)

`.forgejo/workflows/ci.yml` should fail the PR if any of these don't hold:

```yaml
on: [push, pull_request]
jobs:
  validate:
    runs-on: docker
    steps:
      - uses: actions/checkout@v4
      - run: scripts/sync-version.sh --check
      - run: cd frontend && npm ci && npm run build
      - run: pip install . && python -c "import dmf_cms"
      - run: helm lint charts/dmf-cms
```

Currently the workflow is a placeholder; wiring this up is the next CI task.

---

## 10. When in doubt

1. Run `scripts/sync-version.sh --check`. If it fails, the repo is the problem.
2. Run `scripts/verify-cluster.sh`. If it fails, the cluster doesn't match the repo.
3. SSH to the control node and read the deployment directly.
4. If the rollout is wrong, do **not** patch the Helm release by hand:
   - **Image missing from Zot** → re-run `630-zot-seed-platform.yml` (or
     `bootstrap-provision-post-seed.yml --tags zot-seed`).
   - **Image in Zot but pod on old tag** → re-run `650-dmf-cms.yml`.
   - **Image not on GHCR either** → inspect the release workflow failure. A
     retry requires the same merged release SHA to remain the tip of `main`;
     if `main` advanced, prepare a new version bump PR from its current tip.

   All three are idempotent and read `cms_image_tag` from `dmf-cms/VERSION`.

---

**Last updated:** 2026-10-27: exact-SHA release workflow (GHCR canonical, 630 mirrors to Zot, 650 is Helm-only)
**Owner:** @dmfdeploy/maintainers
