# Contributing to dmf-cms

The DMF operator console (React + FastAPI).

This repo is part of the **dmfdeploy platform**. GitHub is the canonical home and the
single source of truth: all changes land via **Pull Request** against `main`.

## Quick start

1. Read the platform overview in the [dmfdeploy/dmfdeploy](https://github.com/dmfdeploy/dmfdeploy) umbrella repo
   (`docs/architecture/dmfdeploy-platform-plan.md`) and apply any relevant ADRs from
   `docs/decisions/INDEX.md`.
2. Set up your machine and run the tests (see [Develop and test](#develop-and-test)).
3. Fork or branch, make your change on a topic branch, open a PR against `main`.
4. Ensure CI is green, your commits are **signed off** (see DCO below), and the
   PR body links its issue (see [What a pull request needs](#what-a-pull-request-needs)).

## Develop and test

This section is the one place for development and test commands. The README and
`AGENTS.md` point here. The commands match what CI runs in
`.github/workflows/ci.yml`.

### Prerequisites

- **Python 3.12 or later.** CI tests 3.12 and 3.13.
- **Node.js 22.** CI uses Node 22, which includes npm 10.
- **A checkout of the dmfdeploy umbrella repo**, for one backend test file. See
  [Run the backend tests](#run-the-backend-tests).
- **Optional tools.** [Helm](https://helm.sh/) renders the chart the way CI does.
  [gitleaks](https://github.com/gitleaks/gitleaks) powers the commit hook.

### Set up the backend

Run these commands from the repository root:

```bash
python3.12 -m venv .venv
. .venv/bin/activate
pip install -e '.[dev]'
```

### Run the backend tests

The test `tests/test_publisher_handoff.py` runs the shared publish script from
the umbrella repo. It fails, and does not skip, when it can't find that script.
Clone the umbrella repo next to this one, in a directory named `dmfdeploy`.
The test finds it there. If your umbrella checkout lives somewhere else, set
`DMFDEPLOY_UMBRELLA` to its path.

```bash
git clone --depth 1 https://github.com/dmfdeploy/dmfdeploy.git ../dmfdeploy
rm -rf src/dmf_cms/static/app
pytest -q
```

The `rm -rf` step matches CI, which runs the tests with no built frontend so
the result doesn't depend on an earlier `npm run build`. The step deletes only
build output, and `npm run build` creates it again.

The suite has about 2,000 tests and takes about a minute.

### Run the frontend checks

Run these commands from `frontend/`:

```bash
npm ci
npm run lint
npm test
npm run build
```

| Command | What it does | Time |
| --- | --- | --- |
| `npm ci` | Installs the locked dependencies | Up to half a minute |
| `npm run lint` | Runs ESLint, including the `jsx-a11y` rules | A few seconds |
| `npm test` | Runs the Vitest unit tests (about 1,200) | About a minute |
| `npm run build` | Type-checks, then builds into `src/dmf_cms/static/app/` | A few seconds |

Before you push, run the backend tests, then `npm run lint`, `npm test` and
`npm run build`. These are the checks most pull requests need to pass.

CI also runs these checks. You can run them locally if your change touches them:

- `python -m compileall src tests` and `python -m pip check`.
- `helm template dmf-cms charts/dmf-cms` with the `--set` values in the `test`
  job, when you change `charts/`.
- `npm run test:e2e` in `frontend/`, which runs the Playwright suite for layout
  and accessibility. Run `npx playwright install chromium` once first. The
  suite takes about two minutes.
- `scripts/sync-version.sh --check`, which confirms that every version file
  matches `VERSION`. Run it when you change any of those files.
- `bin/check-review-comments.sh`, which rejects code comments that cite review
  history.

### Run the console locally

Start the backend from the repository root. The command reads
`config/app-contracts.yaml` by a relative path, so it fails from any other
directory.

```bash
DMF_CONSOLE_DEV_LOGIN_ENABLED=true uvicorn dmf_cms.main:app --reload
```

In local mode, which is the default, the backend serves a dev login. It needs no
Authentik instance. The environment variable makes this choice explicit. The
backend refuses to start with dev login enabled when
`DMF_CONSOLE_RUNTIME_MODE=cluster`.

In a second terminal, start the Vite dev server from `frontend/`:

```bash
npm run dev
```

Open <http://localhost:5173>. Vite redirects you to `/static/app/`, where the
console runs. Vite proxies `/api` and `/auth` requests to the
backend on port 8000. To check the backend alone, open
<http://localhost:8000/healthz>. With dev login on, it reports
`"auth_mode": "dev-login"`.

The backend serves the built single-page app from `src/dmf_cms/static/app/`
after `npm run build`. For frontend work, use the Vite dev server instead.

### Install the hooks

Run this once in each clone:

```bash
bin/install-hooks.sh
```

The script sets `core.hooksPath` to `.githooks/`. The `pre-commit` and
`pre-push` hooks scan your changes with gitleaks. They skip the scan with a
warning when gitleaks isn't installed. CI runs the same scan.

## Branch & PR model

- **GitHub Pull Requests only.** Direct push to `main` is blocked; force-push is
  banned; linear history is required.
- Topic branches: **`<handle>/<short-slug>`** (for example `jdoe/fix-probe-path`). One
  logical change per branch; rebase onto `main` rather than long-lived branches.
- A reviewer (per `CODEOWNERS`) and green required checks are needed to merge.

## What a pull request needs

CI checks each of these.

- **An issue link in the PR body.** Write a fully qualified reference to an issue
  in the [dmfdeploy/dmfdeploy](https://github.com/dmfdeploy/dmfdeploy/issues)
  backlog, such as `Refs dmfdeploy/dmfdeploy#912`. Use `Closes dmfdeploy/dmfdeploy#N`
  if the pull request finishes the issue. A bare `#N` doesn't count, because it
  points at this repo. If your change has no issue, such as a typo fix, a
  maintainer can add the `no-issue` label. Only maintainers can add labels, so
  if you open the pull request from a fork, ask in the PR. The check runs again
  when you edit the body or when a label changes.
- **A DCO sign-off on every commit.** Use `git commit -s`. See the next section.
- **Conventional commit subjects.** Use `type(scope): summary`, with one
  optional scope in lowercase. The types are `feat`, `fix`, `docs`, `chore`,
  `refactor`, `test`, `build`, `ci`, `perf`, `revert` and `style`. Other types,
  such as `wip`, are rejected, and so is a scope list such as `(api,ui)`.
- **Passing CI.** The `CI` workflow runs the checks in
  [Develop and test](#develop-and-test). The `guard` workflow adds secret and
  vulnerability scans.

Also leave agent session links out of commit messages and the PR body. No check
enforces this, so reviewers look for it.

## Developer Certificate of Origin (DCO)

This project uses the [Developer Certificate of Origin](https://developercertificate.org/)
instead of a CLA. **Every commit must be signed off:**

```bash
git commit -s -m "fix: correct the probe path"
```

This appends a `Signed-off-by: Your Name <you@example.com>` trailer certifying you
have the right to submit the work under the project license. A **DCO check** runs
on every PR and fails if any commit is missing the trailer. Amend with
`git commit --amend -s` or rebase with `git rebase --signoff main` to fix. PRs are
**rebase-merged** by default so your signed-off commits land on `main` unchanged.

## Versioning & releases

This repo carries a `VERSION` file (single semver line). Per **ADR-0005**,
`VERSION` is the single source of truth. Any release-tagged change must update it
in the same commit. **No VERSION bump → no release.** Release tags are `v<VERSION>`,
created by release automation, never by hand.

## Secrets & public-safety posture

**Secrets stay in OpenBao.** Never commit, track, or reference credentials, tokens,
keys, kubeconfigs, or Terraform state. A "remove later" TODO is no exception. Use
**placeholder syntax** for any IPs, DNS names, or operator identity in code, docs,
PR descriptions, or issues (`<control-node-public-ip>`, `dmf.example.com`,
`<handle>`). A local pre-commit gitleaks hook runs on commit, and CI runs
secret-scanning + scrub gates on every PR, but redaction is your responsibility
first. If you need a secret, ask a maintainer. Do not improvise a transport.

## Must / Must not

### MUST
- Open changes as **GitHub PRs against `main`** with **signed-off** commits.
- Use Conventional Commit messages and `<handle>/<short-slug>` topic branches.
- Update `VERSION` in the same commit as any release-tagged change.
- Use **placeholder syntax** for all IPs / DNS / operator identity in every artifact.

### MUST NOT
- Commit secrets, tokens, keys, kubeconfigs, or Terraform state.
- Push directly to `main`, force-push, or use `--no-verify` / `--no-gpg-sign`.
- Paste secrets, real IPs/DNS, or operator identity into issues, PRs, or CI logs.

## AI agent contract

Much of this platform is built by AI agents. Agents contribute the same way:
**PRs against `main`, signed off, CI green.** Additionally, agents must run cluster
mutation only via `bin/run-playbook.sh` (ADR-0010), must not use
`--no-verify`/`--force`/`--no-gpg-sign`, and must stop and ask before modifying a
sub-repo with uncommitted state.

## Reporting security issues

See [`SECURITY.md`](SECURITY.md). **Do not** open a public issue for a vulnerability.

## License & spec

Contributions are licensed under [Apache 2.0](LICENSE). The canonical governance
model is **ADR-0041: DMF Release and Contribution Model** in the
[dmfdeploy/dmfdeploy](https://github.com/dmfdeploy/dmfdeploy)
umbrella repo (`docs/decisions/`).
