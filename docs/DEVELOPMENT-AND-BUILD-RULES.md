# DMF Console — Development & Build Rules

**Status:** Authoritative. Violations cause rollout drift. Read before any release.
**Last update:** 2026-10-30: unattended release workflow behind the `RELEASE_ENABLED` variable. Earlier: 2026-05-23, rewritten for the ADR-0025 GHCR-canonical / Zot-mirror flow.

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
This is the *local* tag. The release workflow builds with `--tag-suffix` and
`publish-to-ghcr.sh` re-tags and pushes each platform image to GHCR.
The legacy workstation-to-Zot push was removed in the 2026-05-19 ADR-0025
convergence; `--no-push` is the default that `release.sh` uses.

Refuses to run if any of these are true:

- `VERSION` isn't valid semver
- `sync-version.sh --check` fails
- Working tree is dirty (override: `--dirty` for local test)

```bash
scripts/build-image.sh --no-push        # build only (the normal mode)
scripts/build-image.sh --check          # validate state, don't build
```

Image labels embed `org.opencontainers.image.version` and `.revision` for
traceability. The revision label holds the full 40-character commit SHA. The
release workflow compares it with the verified commit, so a short SHA would not
match.

**Each release is a multi-platform index.** The k3s nodes are ARM64, and a
developer or CI machine may be amd64, so every release publishes one index
under the version tag with exactly `linux/arm64` and `linux/amd64`. arm64 is the
primary platform. Docker builds for the platform of the build host unless you
say otherwise, so `build-image.sh` always passes an explicit `--platform`. The
default is `linux/arm64`; override it with `--platform` or `DMF_CMS_PLATFORM`.
On Apple Silicon that is the native platform, so a local build does not change.
`--tag-suffix` (for example `-amd64`) keeps one checkout's builds apart. The
build adds no provenance or SBOM attestation manifests to the image, because the
release index must list exactly the two platforms. The frontend build stage runs
natively on the build host (`FROM --platform=$BUILDPLATFORM`): its HTML, JavaScript
and CSS do not depend on the CPU architecture.

### `release.sh`

Prepares the release bump: bump → sync → commit → build (local only). Refuses
dirty trees. Does **not** push, and does not tag unless you pass `--tag`.
Run it on a release branch cut from `origin/main` (§4). The release workflow
is the only supported way to publish a release image: it tags and publishes
after the bump merges (§4, "Unattended release"). `release.sh` only prepares
the release-bump PR. If the workflow is disabled, wait until it is enabled.

```bash
scripts/release.sh patch                # 0.2.2 → 0.2.3
scripts/release.sh minor                # 0.2.2 → 0.3.0
scripts/release.sh major                # reserve for 1.0
scripts/release.sh 0.4.0                # explicit version
```

The script will:
1. Bump VERSION and propagate to all derived files
2. Commit the bump as `chore(release): v<NEW>` (signed off)
3. Build the Docker image locally as `registry.dmf.example.com/dmf-cms:<NEW>`

That image is a pre-merge build for local testing. The release workflow builds
the merged commit again; you never publish the local image.

`--tag` creates the `v<NEW>` tag at that point. Leave it off. `main` is
protected and merges are rebase-only, so a tag cut before the merge points at a
commit that never reaches `main`.

To complete the release, land the bump through a pull request. Cut the release branch from `origin/main` before you run
`release.sh`. After the previous feature PR is rebase-merged, you are usually
still on its pre-rebase branch, and `release.sh` commits on whatever branch is
checked out. The release PR would then carry that stale feature commit, or
conflict with `main`.

```bash
git fetch origin
git switch -c release/0.4.0 origin/main
scripts/release.sh 0.4.0
git push -u origin release/0.4.0
gh pr create --title "chore(release): v0.4.0" --body "Refs dmfdeploy/dmfdeploy#<N>"
```

After the merge, the release workflow takes over (§4). The PR title and body
matter: the workflow accepts only a commit whose subject is exactly
`chore(release): v<VERSION>` and that carries a fully qualified
`dmfdeploy/dmfdeploy#<N>` reference on the commit or on its merged pull
request.

**A release tag is one-shot.** Two rulesets guard tags on this repo:
`tags-nonrelease-block` blocks creating, updating or deleting any tag that does
not match `v*`, and `tags-release-protect` blocks updating or deleting a `v*`
tag once it exists. You cannot correct a wrong tag. You can only cut a new
version. The release workflow refuses to tag a version below an existing tag, or
over a tag at another commit.

**Do not publish a release image by hand.** Version tags are immutable. A
single-platform image published at `<VERSION>` would block the required
two-platform index for good, because the workflow never replaces a published
version tag. Only the release workflow publishes a release image, and only in
the form of the verified index.

After the workflow finishes, mirror and deploy:

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

Thin wrapper around `dmfdeploy/bin/publish-image-to-ghcr.sh`. Asserts
`IMAGE_TAG == VERSION`, then delegates the actual push. The release workflow
calls it with the job token on standard input and `IMAGE_TAG_SUFFIX` set to a
platform suffix (`-arm64`, `-amd64`). The script refuses to push the bare
version tag: it exits non-zero when `IMAGE_TAG_SUFFIX` is empty. The umbrella
helper handles secrets safely:

- Token via **stdin only**, never argv
- Isolated `DOCKER_CONFIG` (not `~/.docker/config.json`)
- Cleanup via `trap` even on failure

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

The release path has two registries. The unattended release workflow (§4)
publishes to GHCR; playbook 630 mirrors from there:

| Registry | Role | Auth |
|---|---|---|
| `ghcr.io/dmfdeploy/dmf-cms:<VERSION>` | Canonical public source | Release App token, held by the release workflow |
| `registry.dmf.example.com/dmf-cms:<VERSION>` | Cluster-internal Zot mirror | OpenBao-managed admin creds (used by playbook 630 only) |

The 2026-05-19 ADR-0025 convergence retired direct workstation→Zot pushes.
GHCR publication comes from the release workflow only; **playbook 630 mirrors GHCR → Zot** using credentials
it pulls from OpenBao. Playbook 650 only HEAD-checks Zot and Helm-deploys.

### Publishing to GHCR

The release workflow is the only supported way to publish a release image. It
pushes a staging image per platform through `scripts/publish-to-ghcr.sh` and
joins them into the index at `<VERSION>` (§4, "Unattended release"). Do not run
`publish-to-ghcr.sh` yourself to publish a release. The script refuses a push
without `IMAGE_TAG_SUFFIX`, and a staging push by hand does not produce the
index. If the workflow is disabled, wait until it is enabled.

For a local test build, run `scripts/build-image.sh --no-push`. It builds and
tags the image on your machine and pushes nothing.

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
| `docker push registry.dmf.example.com/dmf-cms:*` from workstation | Path removed 2026-05-19; no creds, will fail | The release workflow, then 630 |
| `docker login -u USER -p PASS …` | Password lands in shell history + `ps` | `--password-stdin` (umbrella helper already does this) |
| `curl -d '{"password":"..."}' …` | Same argv leak | `--data @<(jq …)` or skip — `get-admin-cred.sh` handles it |
| Curl OpenBao yourself for Zot creds | Burns the secret into the agent transcript | Let playbook 630 do it server-side |
| Re-run 650 when image is missing in Zot | 650 only HEAD-checks; it will fail the same way | Run 630 (or `bootstrap-provision-post-seed.yml --tags zot-seed`) |

---

## 4. The Release Procedure

> **`<env-name>` in the commands below** — substitute the current Hetzner test
> env id from the umbrella's `STATUS.md` (env ids rotate; this doc stays
> env-agnostic).

`VERSION` drives every release. Bump it with `scripts/release.sh`, land the bump
through a pull request, and the release follows. You do not start the release
run and you do not pass it a pull request number.

### Unattended release

The `release` workflow (`.github/workflows/release.yml`) starts when `CI`,
`guard`, `DCO` or `issue-link` completes on a push to `main`. It has no manual
trigger, no inputs and no user-selected ref. It reads the commit from the
completed run (`workflow_run.head_sha`), never from the head of `main`.

**The workflow is inert until you enable it.** It runs only when the repository
variable `RELEASE_ENABLED` is `true`. An owner sets that variable at the end of
the rollout in the exact-SHA release gate plan
([dmfdeploy/dmfdeploy#568](https://github.com/dmfdeploy/dmfdeploy/issues/568)),
after the release GitHub App, the `release` environment, its secrets and the
`tags-release-create` ruleset exist. While the variable is unset or has any
other value, every run is skipped and nothing is built, published or tagged.
Check it with:

```bash
gh variable get RELEASE_ENABLED -R dmfdeploy/dmf-cms
```

The workflow has two jobs:

1. `verify` has read-only permissions, no environment and no concurrency group.
   It decides whether the commit is ready. A push that is not a release bump
   ends here with a notice. So does a run that is not the last required
   workflow to complete, and the notice names the contexts still pending.
   The run that finishes last continues.
2. `release` runs only when `verify` reports ready. It is the only job with
   write permissions, the `release` environment and the job-level concurrency
   group, so releases run one at a time and a run in progress is never
   cancelled. It takes only the commit SHA from `verify`, then checks again:
   1. The commit is reachable from `main`.
   2. The commit is a release bump: the subject is `chore(release): v<VERSION>`,
      it changes `VERSION`, `VERSION` reads that version, and a qualified
      `dmfdeploy/dmfdeploy#<N>` reference is on the commit or its merged pull
      request.
   3. Every context in the live `main-protection` ruleset has exactly one
      completed `success` check run from GitHub Actions, produced by a push
      run of its workflow on this commit. Missing, skipped, neutral, stale,
      duplicate and foreign-app results fail.
   4. No existing `v*` tag is higher than `VERSION`. An equal tag is accepted
      only at this commit, and then tag creation is skipped.

   It then mints the release App token, builds the image from the exact commit
   with `scripts/build-image.sh`. The job runs on GitHub's hosted arm64 runner
   (`ubuntu-24.04-arm`, free and unlimited for public repositories), so arm64
   builds natively and amd64 builds under QEMU. For each platform it checks the
   image's platform, labels and start-up (`import dmf_cms`) before any push, then
   pushes it through `scripts/publish-to-ghcr.sh` under a staging tag
   (`<VERSION>-arm64`, `<VERSION>-amd64`). `scripts/publish-index-to-ghcr.sh`
   joins the two digests into the index at `<VERSION>`, and the gate verifies
   every child of the index: exactly the two platforms, each with the version,
   revision and source labels. It creates a build-provenance attestation for the
   index digest, and creates the `v<VERSION>` tag last, as the release App.

   A re-run replaces a staging tag with a rebuild of the same verified commit.
   It never replaces the version tag: if the index exists and passes, the push
   steps are skipped. The attestation covers the index digest, so verify the
   version tag. The per-platform digests have no attestation of their own, and
   copying the image to another registry must keep the whole index (for example
   `skopeo copy --all`) to keep that digest.

Recovery:

- The first unattended release, v0.40.1, was published as a single
  `linux/amd64` image because the job ran on an amd64 runner. That image stays
  as it is: the workflow never overwrites a published image, and a tag cannot
  move. The fix ships with the next release bump. Roll forward; do not re-run
  v0.40.1.
- A required check fails or is cancelled on a release commit: no tag and no
  image. The failed run shows in Actions. Fix forward with a new release PR.
- The App token cannot be minted: the run fails before any build or push.
  Re-running the failed run from the Actions page is safe, because a re-run
  repeats every check and takes no input.
- The image exists but the tag does not, or the tag exists but the image does
  not: re-run. The run verifies what exists, never overwrites a mismatched image
  and completes the missing half.
- A tag at another commit, or a higher tag: the run fails and changes nothing.
  Rollback is a new version, not a moved tag.

### While `RELEASE_ENABLED` is not `true`

There is no manual release. The release workflow is the only supported way to
publish a release image, and `scripts/release.sh` only prepares the release-bump
PR. If the workflow is disabled, land the bump and wait until an owner enables
it. Publication of a single-platform image at `<VERSION>` would block the
required two-platform index, because version tags are immutable.

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
6.  Merge the PR. The release workflow tags and publishes once it is enabled.
```

### Mirror and deploy

The workflow ends at GHCR. Mirroring and deploying stay operator-run:

```
7.  cd $DMFDEPLOY_UMBRELLA/dmf-env
    bin/run-playbook.sh <env-name> \
        ../dmf-infra/k3s-lab-bootstrap/playbooks/630-zot-seed-platform.yml
    bin/run-playbook.sh <env-name> \
        ../dmf-infra/k3s-lab-bootstrap/playbooks/650-dmf-cms.yml
8.  scripts/verify-cluster.sh
9.  curl -sk https://console.dmf.example.com/healthz
```

Steps 4–10 are not optional. Skipping any of them produces the drift this
document exists to prevent. Step 8 (publish) is the step introduced by
the 2026-05-19 ADR-0025 convergence; pre-pivot drafts of this doc that
combined push + deploy into a single playbook are stale. On the unattended path
the workflow replaces the tag, rebuild, label check and publish (steps 5 to 8).

### What can go wrong (and where)

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Pod still on old image after `helm upgrade` | Helm chart `image.tag` not bumped | `scripts/sync-version.sh --check` |
| `npm ci` fails in Docker build | `package-lock.json` not committed | Commit it; never `.gitignore` it |
| React app 404s; Jinja shell renders | `static/app/` missing or main.py routes shadow | Confirm `Dockerfile` `COPY --from=frontend-builder` line and main.py catch-all is last |
| Playbook re-run downgrades image | Hardcoded `cms_image_tag` in role | Use the `lookup('file', ...)` default that reads `dmf-cms/VERSION` |
| Playbook 650 fails on "image not in Zot" HEAD check | Step 8 or the step 9 mirror skipped | Re-run 630 (or `bootstrap-provision-post-seed.yml --tags zot-seed`) |
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
│   ├── release-gate.py               ← gate logic for the release workflow
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

A merge to `main` requires the PR to pass `sync-version.sh --check`. A `vX.Y.Z`
tag does not start a deploy; the operator runs playbooks 630 and 650 after the
tag exists.

### How pull requests merge

You do not merge a pull request by hand. The `automerge` workflow
(`.github/workflows/automerge.yml`) does it with a GitHub App, so the merge
starts the push workflows and the merged commit gets its own checks. A merge
made with `GITHUB_TOKEN` does not.

- **Triggers.** The workflow runs when `CI` completes (`workflow_run`) and on a
  sweep every 10 minutes (`schedule`). The sweep covers changes that start no
  `CI` run, such as a draft marked ready or a removed `hold` label. An eligible
  pull request waits at most one sweep interval, plus any delay GitHub adds to
  scheduled runs.
- **What it does.** For a pull request that is open, ready for review, based on
  `main`, from a branch in this repository, and without the `hold` label, the
  `dmf-cms-automerge` App arms rebase auto-merge. If all required checks and the
  review are already done, it merges the pull request directly. Both calls name
  the head commit they read, so a push that lands in between changes nothing.
  The ruleset still requires the checks and the code-owner review.
- **Key.** The App key lives only in the `automerge` environment, which is
  limited to `main`. The workflow checks out no code and never runs pull request
  code. The old `pull_request_target` flow is gone.
- **Stop a merge with `hold`.** Add the `hold` label. The `hold-disarm` workflow
  (`.github/workflows/hold-disarm.yml`) disarms auto-merge at once for a pull
  request from this repository. For any other pull request, the next sweep
  disarms it. Removing the label lets the next run arm the pull request again.

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
org.opencontainers.image.revision  = <git short sha>
org.opencontainers.image.source    = https://github.com/dmfdeploy/dmf-cms
```

`docker inspect <image>` exposes them; useful for forensics when a pod is on
a tag you don't recognize.

### Signing (deferred)

Cosign signing is not yet wired. When it is, `build-image.sh` gains a `cosign sign`
step after `docker push` and the cluster gates pulls on a verified signature.

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
   - **Image not on GHCR either** → check the `release` workflow run in
     Actions. Re-run it if it failed (§4, "Recovery"). Do not publish by hand.

   All three are idempotent and read `cms_image_tag` from `dmf-cms/VERSION`.

---

**Last updated:** 2026-05-23 — rewritten for ADR-0025 (GHCR canonical, 630 mirrors to Zot, 650 is Helm-only)
**Owner:** @dmfdeploy/maintainers
