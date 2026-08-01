"""GET /api/catalog — provision_demand payload field (umbrella #285 S3).

The Plan stage's capacity comparison (frontend) needs each catalog entry's
declared demand alongside everything else `/api/catalog` already returns.
`_entry_to_dict` (main.py) is the ONLY thing under test here — it is a
closure nested inside `create_app`, so the only reachable seam is the real
endpoint through `TestClient`, same idiom as test_capacity_gate.py (which
already exercises this exact endpoint family this way).

Three cases, matching capacity.read_entry_demand's own two-way refusal
(collapsed to one signal here, by design — see main.py's comment): a
well-formed declaration parses to a concrete `{cpu_m, mem_b}`; a missing
`resources` block is `None`; and a malformed quantity is ALSO `None` and,
critically, never raises out of the endpoint — a single bad catalog entry
must degrade its own `provision_demand` field, not the whole /api/catalog
response for every other entry.
"""

from fastapi.testclient import TestClient

from dmf_cms.catalog import CatalogEntry
from dmf_cms.main import create_app
from dmf_cms.settings import Settings

MI = 1024**2


def _client() -> TestClient:
    # Defaults are enough: dev_login_enabled=True, netbox unconfigured (so
    # lifecycle_status stays "unknown" without a NetBox call — irrelevant to
    # what this test checks), no L3/prometheus config needed since GET
    # /api/catalog never touches the capacity gate itself.
    client = TestClient(create_app(settings=Settings()))
    client.get("/auth/login", follow_redirects=False)
    return client


def _entries(*entries: CatalogEntry):
    return lambda: list(entries)


def test_well_formed_entry_exposes_parsed_provision_demand(monkeypatch):
    entry = CatalogEntry(
        key="mxl-videotest-view",
        display_name="MXL Test-Pattern View",
        summary="Renders a test-pattern flow.",
        provision={"resources": {"requests": {"cpu": "225m", "memory": "128Mi"}}},
    )
    monkeypatch.setattr("dmf_cms.main.load_catalog_entries", _entries(entry))
    resp = _client().get("/api/catalog")
    assert resp.status_code == 200, resp.text
    body = next(e for e in resp.json()["entries"] if e["key"] == "mxl-videotest-view")
    assert body["provision_demand"] == {"cpu_m": 225, "mem_b": 128 * MI}


def test_entry_without_resources_block_is_null_not_zero(monkeypatch):
    entry = CatalogEntry(
        key="nmos-cpp",
        display_name="NMOS IS-04/05",
        summary="NMOS registry and nodes.",
        provision={"namespace": "mxl"},  # provision present, but no resources block at all
    )
    monkeypatch.setattr("dmf_cms.main.load_catalog_entries", _entries(entry))
    resp = _client().get("/api/catalog")
    assert resp.status_code == 200, resp.text
    body = next(e for e in resp.json()["entries"] if e["key"] == "nmos-cpp")
    assert body["provision_demand"] is None


def test_entry_with_no_provision_block_at_all_is_null(monkeypatch):
    # entry.provision itself is None (the dataclass default) — the coarsest
    # form of "nothing declared", must degrade the same way as a present-
    # but-empty resources block, never raise on the None -> {} normalisation.
    entry = CatalogEntry(
        key="bare-entry",
        display_name="Bare Entry",
        summary="No provision block whatsoever.",
    )
    monkeypatch.setattr("dmf_cms.main.load_catalog_entries", _entries(entry))
    resp = _client().get("/api/catalog")
    assert resp.status_code == 200, resp.text
    body = next(e for e in resp.json()["entries"] if e["key"] == "bare-entry")
    assert body["provision_demand"] is None


def test_malformed_quantity_is_null_and_does_not_raise(monkeypatch):
    # "9999" (bare integer, no 'm' suffix) is refused catalog grammar per
    # capacity.parse_catalog_cpu — a likely-forgotten-suffix author error,
    # not a value to silently coerce to millicores or to zero.
    bad_entry = CatalogEntry(
        key="malformed-cpu",
        display_name="Malformed CPU",
        summary="cpu quantity missing its m suffix.",
        provision={"resources": {"requests": {"cpu": "9999", "memory": "128Mi"}}},
    )
    good_entry = CatalogEntry(
        key="well-formed",
        display_name="Well Formed",
        summary="A normal entry alongside the bad one.",
        provision={"resources": {"requests": {"cpu": "450m", "memory": "160Mi"}}},
    )
    monkeypatch.setattr("dmf_cms.main.load_catalog_entries", _entries(bad_entry, good_entry))
    resp = _client().get("/api/catalog")
    assert resp.status_code == 200, resp.text
    entries = {e["key"]: e for e in resp.json()["entries"]}
    # The malformed entry's OWN field goes null...
    assert entries["malformed-cpu"]["provision_demand"] is None
    # ...but never at the cost of a 500 that would take the well-formed
    # sibling entry's own correct reading down with it.
    assert entries["well-formed"]["provision_demand"] == {"cpu_m": 450, "mem_b": 160 * MI}


def test_malformed_memory_quantity_is_also_null(monkeypatch):
    # Same refusal on the memory side: "128" (bare, no Ki/Mi/Gi) is not
    # accepted catalog grammar per capacity.parse_catalog_memory.
    entry = CatalogEntry(
        key="malformed-mem",
        display_name="Malformed Memory",
        summary="memory quantity missing its binary-unit suffix.",
        provision={"resources": {"requests": {"cpu": "225m", "memory": "128"}}},
    )
    monkeypatch.setattr("dmf_cms.main.load_catalog_entries", _entries(entry))
    resp = _client().get("/api/catalog")
    assert resp.status_code == 200, resp.text
    body = next(e for e in resp.json()["entries"] if e["key"] == "malformed-mem")
    assert body["provision_demand"] is None
