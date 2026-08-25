# dmf-cms

**DMF Console** — the operator-facing surface of the
[DMF Platform](https://github.com/dmfdeploy/dmfdeploy), an open prototype of the
[EBU](https://tech.ebu.ch/) *Dynamic Media Facility* Reference Architecture V2.0.

It is where an operator sees facility inventory, launches and watches
automation, takes a media workload through its lifecycle, and reads what the
platform observed — with provenance on the state it shows.

## Status

**Running, and deployed on the project's own environments.** `VERSION` is the
source of truth; the console is released as a container image and deployed by
Helm through `dmf-infra`.

This is a **prototype**, deliberately. Read the platform's
[thesis](https://github.com/dmfdeploy/dmfdeploy/blob/main/docs/THESIS.md) for
what is and is not claimed. In particular this console does **not** claim
production ST-2110/PTP/multicast correctness, real-time media-plant behaviour,
multi-node HA, cross-site federation, or performance numbers.

Two properties worth knowing before you evaluate it:

- **There is no database.** The runtime dependencies are FastAPI, Uvicorn,
  PyYAML and itsdangerous. The console holds no persistent store of its own — it
  reads from NetBox (inventory source of truth), AWX (automation), Prometheus
  (observed health) and the media nodes, and writes through them.
- **Async operation tracking is in-memory and assumes a single replica**
  (`src/dmf_cms/operations.py`). It is not replicated, which is one concrete
  reason the no-HA non-claim above is real rather than cautious.

## Stack

- **Frontend:** React 19 + TypeScript + Vite + Tailwind CSS + React Router v7 +
  TanStack Query + Zustand. Single-page app; the backend serves JSON only.
- **Backend:** FastAPI serving JSON APIs.
- **Live updates:** TanStack Query polling, tuned per surface rather than a
  single global interval — 200ms for the MXL flow counter, 2–5s for in-flight
  jobs, 15–60s for inventory and health. Two properties matter more than the
  numbers: operation polling is **dynamic and stops at a terminal state**, and
  the fastest poll is **bounded** — it stops on a hidden tab or under reduced
  motion. No server-push.
- **Auth:** Authentik OIDC, passkey-first, session cookies via
  `starlette.middleware.sessions`.
- **Deploy:** Helm chart → `dmf-infra` `stack/operator/cms` role, invoked by
  `playbooks/650-dmf-cms.yml`.
- **Registry:** `registry.dmf.example.com/dmf-cms:<VERSION>` (Zot).
- **Versioning:** the `VERSION` file is the single source of truth;
  `scripts/sync-version.sh` propagates it to every derived file.

## What it does today

Implemented and running:

- **Facility inventory** from NetBox — devices, interfaces, services, and the
  per-environment Site/Cluster identity, with a detail view per facility.
- **Media workload lifecycle** — the console's centre of gravity. A workload is
  taken through **Design → Plan → Provision → Configure → Finalise**, each stage
  gated on observed state rather than on a wizard counter. Includes catalog
  template selection, facility placement, deployment, source switching, teardown
  and permanent deletion.
- **Automation launch and progress** — AWX job templates launched from the
  console, with job progress and history.
- **Catalog** of media functions, deployable per ADR-0013's YAML-intent +
  NetBox-runtime-tag model.
- **Observed health** — Prometheus alerts surfaced as current problems, with an
  explicit "monitoring is reporting all quiet" signal rather than silent
  emptiness.
- **MXL flows view** — aggregates the per-node status sidecars published by the
  MXL fabrics demo chart. See the caveat below before reading anything into it.
- **Graduated friction on dangerous actions** — destructive operations require a
  recorded reason, and irreversible ones additionally require typing the
  workload identifier. Every automated write records actor, role, request id and
  reason to the audit log (ADR-0028 C5).
- **Admin** — passkey enrolment invitations via the Authentik API.

### Built but not proven

- **MXL (Media eXchange Layer).** The console flows view is implemented, the
  spike's single-node control chain is code-complete, and the catalog entry has
  been deployed and torn down repeatedly on a sandbox environment through the
  console's own lifecycle, with the viewer's preview rendering live.

  It is listed as unproven anyway, because the question it exists to answer —
  *does the EBU taxonomy survive a genuinely two-function, shared-data-plane
  case?* — has **not been assessed**. Nobody has judged the running case against
  the taxonomy and written down whether it held. So this is open for want of
  analysis, not for want of an environment. Treat the view as a working
  demonstration, not as evidence about the media plane.

### Not started

Named here because earlier versions of this file listed them as though they were
imminent:

- Virtual X-Y routing matrix (NMOS IS-05)
- Flow-level monitoring of RTP/PTP metrics
- Tally display
- The PR-gated *configuration* lane of the two-lane change-control model. The
  **operations** lane — direct, audited actions — is implemented; the
  config-as-pull-request lane is not.

## Local development

**Backend** — editable install with dev extras, then Uvicorn:

```sh
pip install -e '.[dev]'
uvicorn dmf_cms.main:app --reload
```

**Frontend** — from `frontend/`:

```sh
npm install
npm run dev      # vite dev server
npm run build    # tsc && vite build
npm test         # vitest run
```

The built SPA is served by the backend from `static/app`. The default app
contract fixture lives at `config/app-contracts.yaml`.

Build and release are **VERSION-driven and scripted** — see
`docs/DEVELOPMENT-AND-BUILD-RULES.md`. Do not hand-build or hand-tag images.

## Design constraints worth knowing

The console is bound by a
[UX constitution](https://github.com/dmfdeploy/dmfdeploy/blob/main/docs/design/)
with hard gates, not merely guidelines. The two that most shape the code:

- **State carries provenance.** Observed, requested, stale and last-known are
  never rendered as the same thing. Where the console cannot tell, it says so
  rather than guessing.
- **No dead controls.** A control that cannot be used is replaced by inert text
  naming the reason — never a greyed-out button with no explanation.

## License

Apache License, Version 2.0 — see [LICENSE](LICENSE).
Third-party components are listed in [NOTICE](NOTICE).
