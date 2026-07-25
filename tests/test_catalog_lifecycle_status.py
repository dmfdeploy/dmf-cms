"""catalog.get_lifecycle_status — NetBox lifecycle-tag lookup + N-service
aggregation (umbrella #201 WP5 ledger item: provision.netbox_service as a
list, mirroring drain.py's own N-service normalization for topology-carrying
entries that provision one NetBox service per source).

Single-dict-shape tests pin the pre-WP5 behavior byte-identical; the list
tests cover the new normalization + the aggregation policy (fail-closed on
any error, "unknown" — never a picked side — on genuine disagreement).
"""

import urllib.parse

from dmf_cms import netbox as netbox_module
from dmf_cms.catalog import CatalogEntry, get_lifecycle_status


def _entry(netbox_service) -> CatalogEntry:
    return CatalogEntry(
        key="k", display_name="d", summary="s",
        provision={"netbox_service": netbox_service},
    )


def _service(name: str, lifecycle: str | None) -> dict:
    tags = [{"name": "dmf-catalog"}]
    if lifecycle is not None:
        tags.append({"name": f"lifecycle:{lifecycle}"})
    return {"name": name, "tags": tags}


def _mock_netbox(monkeypatch, services_by_name: dict, errors: frozenset = frozenset()):
    def fake_request(api_url, api_token, path, ssl_context=None, method="GET", payload=None):
        assert method == "GET"
        qs = urllib.parse.urlparse(path).query
        name = urllib.parse.parse_qs(qs)["name"][0]
        if name in errors:
            raise netbox_module.NetboxAPIError(500, "boom")
        return {"results": services_by_name.get(name, [])}

    monkeypatch.setattr(netbox_module, "_request", fake_request)


# ── single-dict shape (pre-WP5) — must stay byte-identical ──────────────


def test_single_service_active(monkeypatch):
    entry = _entry({"name": "svc-a"})
    _mock_netbox(monkeypatch, {"svc-a": [_service("svc-a", "active")]})
    assert get_lifecycle_status(entry, "http://nb", "tok") == "active"


def test_single_service_no_match_is_unknown(monkeypatch):
    entry = _entry({"name": "svc-a"})
    _mock_netbox(monkeypatch, {})
    assert get_lifecycle_status(entry, "http://nb", "tok") == "unknown"


def test_single_service_no_lifecycle_tag_is_unknown(monkeypatch):
    entry = _entry({"name": "svc-a"})
    _mock_netbox(monkeypatch, {"svc-a": [_service("svc-a", None)]})
    assert get_lifecycle_status(entry, "http://nb", "tok") == "unknown"


def test_single_service_netbox_error_is_error(monkeypatch):
    entry = _entry({"name": "svc-a"})
    _mock_netbox(monkeypatch, {}, errors=frozenset({"svc-a"}))
    assert get_lifecycle_status(entry, "http://nb", "tok") == "error"


def test_no_provision_is_unknown():
    entry = CatalogEntry(key="k", display_name="d", summary="s")
    assert get_lifecycle_status(entry, "http://nb", "tok") == "unknown"


def test_no_netbox_service_field_is_unknown():
    entry = CatalogEntry(key="k", display_name="d", summary="s", provision={"namespace": "mxl"})
    assert get_lifecycle_status(entry, "http://nb", "tok") == "unknown"


# ── N-service list shape (umbrella #201 WP5) ─────────────────────────────


def test_list_all_active_aggregates_to_active(monkeypatch):
    entry = _entry([{"name": "svc-a"}, {"name": "svc-b"}])
    _mock_netbox(monkeypatch, {
        "svc-a": [_service("svc-a", "active")],
        "svc-b": [_service("svc-b", "active")],
    })
    assert get_lifecycle_status(entry, "http://nb", "tok") == "active"


def test_list_all_bootstrapped_aggregates_to_bootstrapped(monkeypatch):
    entry = _entry([{"name": "svc-a"}, {"name": "svc-b"}])
    _mock_netbox(monkeypatch, {
        "svc-a": [_service("svc-a", "bootstrapped")],
        "svc-b": [_service("svc-b", "bootstrapped")],
    })
    assert get_lifecycle_status(entry, "http://nb", "tok") == "bootstrapped"


def test_list_mixed_active_and_bootstrapped_is_unknown_not_a_partial_success(monkeypatch):
    # Never overclaim "active" when only SOME sources are up — a genuinely
    # partial deployment must surface as "unknown", never silently read as
    # a clean single state (drain.py's own _netbox_service_specs "no
    # partial declaration" precedent, applied here to the aggregated
    # STATUS rather than the service list itself).
    entry = _entry([{"name": "svc-a"}, {"name": "svc-b"}])
    _mock_netbox(monkeypatch, {
        "svc-a": [_service("svc-a", "active")],
        "svc-b": [_service("svc-b", "bootstrapped")],
    })
    assert get_lifecycle_status(entry, "http://nb", "tok") == "unknown"


def test_list_any_error_aggregates_to_error_even_if_others_succeed(monkeypatch):
    entry = _entry([{"name": "svc-a"}, {"name": "svc-b"}])
    _mock_netbox(monkeypatch, {"svc-b": [_service("svc-b", "active")]}, errors=frozenset({"svc-a"}))
    assert get_lifecycle_status(entry, "http://nb", "tok") == "error"


def test_list_with_non_dict_member_is_malformed_whole_declaration_unknown(monkeypatch):
    entry = _entry([{"name": "svc-a"}, "not-a-dict"])

    def boom(*a, **k):
        raise AssertionError("must not query NetBox for a malformed netbox_service declaration")

    monkeypatch.setattr(netbox_module, "_request", boom)
    assert get_lifecycle_status(entry, "http://nb", "tok") == "unknown"


def test_list_with_member_missing_name_is_malformed_whole_declaration_unknown(monkeypatch):
    entry = _entry([{"name": "svc-a"}, {"cluster_service": "x"}])

    def boom(*a, **k):
        raise AssertionError("must not query NetBox for a malformed netbox_service declaration")

    monkeypatch.setattr(netbox_module, "_request", boom)
    assert get_lifecycle_status(entry, "http://nb", "tok") == "unknown"


def test_empty_list_is_malformed_unknown(monkeypatch):
    entry = _entry([])

    def boom(*a, **k):
        raise AssertionError("must not query NetBox for an empty netbox_service list")

    monkeypatch.setattr(netbox_module, "_request", boom)
    assert get_lifecycle_status(entry, "http://nb", "tok") == "unknown"
