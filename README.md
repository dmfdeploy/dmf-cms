# dmf-cms

Operator-facing CMS for the DMF Platform.

## Product Direction

DMF Console is the visible operator surface for facility health, workflows,
monitoring, changes, and admin.

Initial stack:

- FastAPI backend
- server-rendered HTML with Jinja templates + HTMX
- Server-Sent Events for live updates
- PostgreSQL
- Authentik OIDC
- Helm deployment into the `650-dmf-cms.yml` slot

## Planned Capabilities

- NetBox SoT browser (devices, senders, receivers, flows)
- AWX Job Template launcher + status viewer
- Prometheus alerts dashboard
- Virtual X-Y routing matrix (NMOS IS-05)
- Flow-level monitoring view (RTP/PTP metrics)
- Tally display
- Two-lane change control: config (PR-gated) + operations (direct, audited)

## Status

Scaffold only. The initial implementation contract is recorded in
`dmfdeploy/docs/plans/DMF Console Initial Implementation Plan 2026-04-26.md`.
Do not write production code until the release-0 plan and app contracts are in
place.

## Release 0 Checklist

- authenticated console shell with Authentik OIDC
- base layout and navigation for Overview, Facility, Workflows, Monitoring,
  Changes, and Admin
- static app catalog loaded from config or app-contract fixture
- Kubernetes health endpoint for probes
- Helm values updated for deployment, ingress, and environment wiring
- support for `console.<domain>` and `/console` exposure patterns

## Local Development

Install the package in editable mode with the `dev` extras, then run Uvicorn:

```sh
pip install -e '.[dev]'
uvicorn dmf_cms.main:app --reload
```

The default app contract fixture lives at `config/app-contracts.yaml`.

## License

Apache License, Version 2.0 — see [LICENSE](LICENSE).
Third-party components are listed in [NOTICE](NOTICE).
