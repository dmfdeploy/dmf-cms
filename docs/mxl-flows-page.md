# MXL Flows page (demo evaluation)

The **MXL Flows** page (`/mxl-flows`) is an evaluation surface for the MXL fabrics
spike: it shows the active MXL media nodes, the flow + grain activity, and a small
live preview of the transferred test pattern, with copy framing it as a
**libfabric / tcp** cross-host demo.

## What it shows
- **Active MXL nodes** — one card per node with a **cloud-provider logo** and role
  (Producer / Receiver). **No IP/host information is shown** (provider logo only).
- **Flow** — flow id, format (`video/v210`, 1080p29.97), grain rate, transport
  (`libfabric · tcp · :1234`), an `Active` pill, and a **live grain head-index
  counter** (the receiver's head index, polled every 200 ms so it visibly ticks),
  plus cross-host latency (grains / ms).
- **Live preview** — a JPEG snapshot of the *received* flow on the receiver node
  (SMPTE test pattern + ticking clock overlay), refreshed ~5/s.

## How the data flows
dmf-cms has **no Kubernetes access** — it only talks to HTTP APIs. So each MXL node
runs a small **status sidecar** (in the `mxl-fabrics-demo` Helm chart, dmf-media):

```
mxl pod (hostNetwork) ── status sidecar :9000 ──┐  GET /status     (mxl-info → JSON)
                                                 │  GET /preview.jpg (mxl-gst-sink → JPEG)
                                                 ▼
            dmf-cms backend  src/dmf_cms/mxl.py  → /api/mxl/status  (aggregated JSON)
                                                 → /api/mxl/preview/{role} (proxied JPEG)
                                                 ▲
                          React page  useMxlStatus()  (TanStack Query, 200 ms poll)
```

- The sidecar parses `mxl-info` for the flow stats and (receiver side, `PREVIEW=1`)
  drives `mxl-gst-sink` with an env-configurable video sink (`MXL_GST_VIDEO_SINK`)
  to overwrite a JPEG every ~200 ms.
- The console reaches the sidecars over the node **tailnet IP** (Hetzner↔Aliyun
  tailnet is direct, sidestepping the cross-cloud flannel limitation). These URLs
  are **runtime config only** — never committed (gitleaks-enforced) and never shown.

## Configuration
Set the status endpoints via env (empty by default → the page shows a friendly
"not configured" note):

```
DMF_CONSOLE_MXL_ENDPOINTS="producer|aliyun|http://<producer-tailnet-ip>:9000,receiver|aliyun|http://<receiver-tailnet-ip>:9000"
```

Each entry is `role|provider|url` (`role` ∈ producer/receiver; `provider` is the UI
logo slug). Backend: `src/dmf_cms/settings.py` (`MXLSettings`), `src/dmf_cms/mxl.py`,
and the `/api/mxl/*` routes in `src/dmf_cms/main.py`. Frontend:
`frontend/src/pages/MxlFlows.tsx` + `useMxlStatus()`.

## Roadmap — Prometheus metrics integration (future investigation)
The current sidecar is a **direct-poll** source, chosen for a self-contained spike.
The more durable integration is to expose MXL flow state as **Prometheus metrics**
and read them through the console's existing `prometheus.py` client:

- Add an **MXL exporter** (or extend the sidecar) serving `/metrics`, e.g.
  `mxl_flow_head_index` (counter), `mxl_flow_active` (gauge),
  `mxl_flow_latency_ms` / `mxl_flow_latency_grains` (gauges), labelled by
  `flow_id`, `node`, `role`, `provider`, `transport`.
- Add a **Prometheus scrape config / ServiceMonitor** for the MXL nodes (the cluster
  Prometheus already scrapes the media nodes' node-exporter, so the path exists —
  this is a `dmf-infra` change).
- Read via `prometheus.query(...)` in a new `/api/mxl/metrics` route; the page then
  gets **history + sparklines** (grains/sec trend, latency over time) for free and
  no longer needs the bespoke sidecar JSON for the numeric series.

**Pros:** reuses existing monitoring infra, gives time-series/alerting, decouples the
console from per-node HTTP reachability. **Cost:** an exporter + a scrape-config
change, and the live JPEG preview still needs its own path (metrics ≠ frames).
Tracked for a later iteration; the direct-poll sidecar is sufficient for the
evaluation demo.
