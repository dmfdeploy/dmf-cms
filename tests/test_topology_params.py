"""umbrella #201 WP3a — topology_params catalog-layer loader/validator.

Two things this file covers:
* ``load_topology_instance`` — the fail-closed loader for a topology_ref'd
  instance file (dmf-media catalog/topology-params.schema.yaml, WP1's frozen
  contract). Every malformed shape must refuse with a reason, never a
  partial object.
* ``load_catalog_entries`` skips topology_params schema/instance files
  cleanly (no ``key`` field) without the generic 'lacks key' warning —
  these are legitimate, expected files in the same catalog dir glob, not
  malformed entries.
"""

import logging
import textwrap
from pathlib import Path

from dmf_cms.catalog import CatalogEntry, load_catalog_entries, load_topology_instance


def _write(directory: Path, filename: str, body: str) -> Path:
    p = directory / filename
    p.write_text(textwrap.dedent(body))
    return p


J1_INSTANCE = """\
topology_params:
  schema_version: 1
  target_facility: dmf-example-site
  sources:
    - id: source-a
      flow_id: "5fbec3b1-1b0f-417d-9059-8b94a47197ed"
      pattern: smpte
    - id: source-b
      flow_id: "b0ae9cba-a989-4568-ac96-8bd19272c966"
      pattern: ball
  viewer:
    id: viewer-a
    source_selection: source-a
"""

SCHEMA_FILE = """\
schema_version: 1
fields:
  schema_version:
    type: int
"""


# ── load_topology_instance: happy path ──────────────────────────────────


EXPECTED_J1_TOPOLOGY_PARAMS = {
    "schema_version": 1,
    "target_facility": "dmf-example-site",
    "sources": [
        {"id": "source-a", "flow_id": "5fbec3b1-1b0f-417d-9059-8b94a47197ed", "pattern": "smpte"},
        {"id": "source-b", "flow_id": "b0ae9cba-a989-4568-ac96-8bd19272c966", "pattern": "ball"},
    ],
    "viewer": {"id": "viewer-a", "source_selection": "source-a"},
}


def test_load_valid_j1_instance(tmp_path: Path):
    _write(tmp_path, "topology-params.j1.yaml", J1_INSTANCE)
    tp, err = load_topology_instance(str(tmp_path), "topology-params.j1.yaml")
    assert err is None
    # Whole-object equality (codex P1): a loader that drops/rewrites any
    # field — a source's flow_id, its pattern, the viewer's id — must fail
    # this test. Field-sample assertions would miss that.
    assert tp == EXPECTED_J1_TOPOLOGY_PARAMS


# ── load_topology_instance: fail-closed on every malformed shape ────────


def test_missing_file_refused(tmp_path: Path):
    tp, err = load_topology_instance(str(tmp_path), "does-not-exist.yaml")
    assert tp is None
    assert "not found" in err


def test_unparseable_yaml_refused(tmp_path: Path):
    _write(tmp_path, "bad.yaml", "{not: valid: yaml: [")
    tp, err = load_topology_instance(str(tmp_path), "bad.yaml")
    assert tp is None
    assert "failed to parse" in err


def test_non_mapping_top_level_refused(tmp_path: Path):
    _write(tmp_path, "bad.yaml", "- just\n- a\n- list\n")
    tp, err = load_topology_instance(str(tmp_path), "bad.yaml")
    assert tp is None
    assert "did not yield a mapping" in err


def test_missing_topology_params_key_refused(tmp_path: Path):
    _write(tmp_path, "bad.yaml", "not_topology_params: {}\n")
    tp, err = load_topology_instance(str(tmp_path), "bad.yaml")
    assert tp is None
    assert "no top-level topology_params" in err


def test_wrong_schema_version_refused(tmp_path: Path):
    body = J1_INSTANCE.replace("schema_version: 1", "schema_version: 2")
    _write(tmp_path, "bad.yaml", body)
    tp, err = load_topology_instance(str(tmp_path), "bad.yaml")
    assert tp is None
    assert "schema_version must equal 1" in err


def test_empty_sources_refused(tmp_path: Path):
    body = """\
    topology_params:
      schema_version: 1
      target_facility: x
      sources: []
      viewer:
        id: v
        source_selection: source-a
    """
    _write(tmp_path, "bad.yaml", body)
    tp, err = load_topology_instance(str(tmp_path), "bad.yaml")
    assert tp is None
    assert "sources must be a non-empty list" in err


def test_sources_not_a_list_refused(tmp_path: Path):
    body = """\
    topology_params:
      schema_version: 1
      target_facility: x
      sources: "not-a-list"
      viewer:
        id: v
        source_selection: source-a
    """
    _write(tmp_path, "bad.yaml", body)
    tp, err = load_topology_instance(str(tmp_path), "bad.yaml")
    assert tp is None
    assert "sources must be a non-empty list" in err


def test_source_missing_id_refused(tmp_path: Path):
    body = """\
    topology_params:
      schema_version: 1
      target_facility: x
      sources:
        - flow_id: "11111111-1111-1111-1111-111111111111"
          pattern: smpte
      viewer:
        id: v
        source_selection: source-a
    """
    _write(tmp_path, "bad.yaml", body)
    tp, err = load_topology_instance(str(tmp_path), "bad.yaml")
    assert tp is None
    assert "sources[0].id missing/invalid" in err


def test_source_missing_flow_id_refused(tmp_path: Path):
    body = """\
    topology_params:
      schema_version: 1
      target_facility: x
      sources:
        - id: source-a
          pattern: smpte
      viewer:
        id: v
        source_selection: source-a
    """
    _write(tmp_path, "bad.yaml", body)
    tp, err = load_topology_instance(str(tmp_path), "bad.yaml")
    assert tp is None
    assert "sources[0].flow_id missing/invalid" in err


def test_source_missing_pattern_refused(tmp_path: Path):
    body = """\
    topology_params:
      schema_version: 1
      target_facility: x
      sources:
        - id: source-a
          flow_id: "11111111-1111-1111-1111-111111111111"
      viewer:
        id: v
        source_selection: source-a
    """
    _write(tmp_path, "bad.yaml", body)
    tp, err = load_topology_instance(str(tmp_path), "bad.yaml")
    assert tp is None
    assert "sources[0].pattern missing/invalid" in err


def test_duplicate_source_ids_refused(tmp_path: Path):
    body = """\
    topology_params:
      schema_version: 1
      target_facility: x
      sources:
        - id: source-a
          flow_id: "11111111-1111-1111-1111-111111111111"
          pattern: smpte
        - id: source-a
          flow_id: "22222222-2222-2222-2222-222222222222"
          pattern: ball
      viewer:
        id: v
        source_selection: source-a
    """
    _write(tmp_path, "bad.yaml", body)
    tp, err = load_topology_instance(str(tmp_path), "bad.yaml")
    assert tp is None
    assert "not unique" in err


def test_invalid_flow_id_uuid_refused(tmp_path: Path):
    # codex P1: flow_id must be a well-formed UUID, per the WP1 frozen
    # schema (dmf-media catalog/topology-params.schema.yaml).
    body = """\
    topology_params:
      schema_version: 1
      target_facility: x
      sources:
        - id: source-a
          flow_id: "not-a-real-uuid"
          pattern: smpte
      viewer:
        id: v
        source_selection: source-a
    """
    _write(tmp_path, "bad.yaml", body)
    tp, err = load_topology_instance(str(tmp_path), "bad.yaml")
    assert tp is None
    assert "not a well-formed UUID" in err


def test_duplicate_flow_ids_refused(tmp_path: Path):
    # codex P1: flow_id must be unique across sources[] — distinct source
    # ids with the SAME flow_id must still be refused.
    body = """\
    topology_params:
      schema_version: 1
      target_facility: x
      sources:
        - id: source-a
          flow_id: "11111111-1111-1111-1111-111111111111"
          pattern: smpte
        - id: source-b
          flow_id: "11111111-1111-1111-1111-111111111111"
          pattern: ball
      viewer:
        id: v
        source_selection: source-a
    """
    _write(tmp_path, "bad.yaml", body)
    tp, err = load_topology_instance(str(tmp_path), "bad.yaml")
    assert tp is None
    assert "flow_id values are not unique" in err


def test_duplicate_flow_ids_different_case_still_refused(tmp_path: Path):
    # codex P1 re-gate: the SAME UUID spelled in different case is the SAME
    # flow identity — uniqueness must compare parsed uuid.UUID values, not
    # raw strings, or a lowercase vs uppercase spelling of the identical
    # UUID would pass a naive string-set comparison while carrying one flow.
    # Must be a letter-bearing UUID: an all-digit one is byte-identical to
    # its own .upper(), which would ALSO pass the old (broken) naive
    # string-set comparison — making the test vacuous, not discriminating
    # (codex caught this exact gap on re-gate).
    lower = "5fbec3b1-1b0f-417d-9059-8b94a47197ed"
    upper = lower.upper()
    assert lower != upper  # guards against ever regressing to a vacuous probe
    body = f"""\
    topology_params:
      schema_version: 1
      target_facility: x
      sources:
        - id: source-a
          flow_id: "{lower}"
          pattern: smpte
        - id: source-b
          flow_id: "{upper}"
          pattern: ball
      viewer:
        id: v
        source_selection: source-a
    """
    _write(tmp_path, "bad.yaml", body)
    tp, err = load_topology_instance(str(tmp_path), "bad.yaml")
    assert tp is None
    assert "flow_id values are not unique" in err


def test_duplicate_patterns_refused(tmp_path: Path):
    # codex P1: pattern must be distinct across sources[] — the switch
    # must be visually unambiguous (spec §4).
    body = """\
    topology_params:
      schema_version: 1
      target_facility: x
      sources:
        - id: source-a
          flow_id: "11111111-1111-1111-1111-111111111111"
          pattern: smpte
        - id: source-b
          flow_id: "22222222-2222-2222-2222-222222222222"
          pattern: smpte
      viewer:
        id: v
        source_selection: source-a
    """
    _write(tmp_path, "bad.yaml", body)
    tp, err = load_topology_instance(str(tmp_path), "bad.yaml")
    assert tp is None
    assert "pattern values are not distinct" in err


# ── load_topology_instance: topology_ref containment (codex P2) ─────────


def test_topology_ref_parent_traversal_refused(tmp_path: Path):
    outside = tmp_path.parent / "escape.yaml"
    outside.write_text(J1_INSTANCE)
    try:
        tp, err = load_topology_instance(str(tmp_path), "../escape.yaml")
        assert tp is None
        assert "plain filename" in err
    finally:
        outside.unlink()


def test_topology_ref_absolute_path_refused(tmp_path: Path):
    absolute = tmp_path / "topology-params.j1.yaml"
    _write(tmp_path, "topology-params.j1.yaml", J1_INSTANCE)
    tp, err = load_topology_instance(str(tmp_path), str(absolute))
    assert tp is None
    assert "plain filename" in err


def test_topology_ref_subdir_refused(tmp_path: Path):
    subdir = tmp_path / "subdir"
    subdir.mkdir()
    (subdir / "topology-params.j1.yaml").write_text(J1_INSTANCE)
    tp, err = load_topology_instance(str(tmp_path), "subdir/topology-params.j1.yaml")
    assert tp is None
    assert "plain filename" in err


def test_viewer_missing_refused(tmp_path: Path):
    body = """\
    topology_params:
      schema_version: 1
      target_facility: x
      sources:
        - id: source-a
          flow_id: "11111111-1111-1111-1111-111111111111"
          pattern: smpte
    """
    _write(tmp_path, "bad.yaml", body)
    tp, err = load_topology_instance(str(tmp_path), "bad.yaml")
    assert tp is None
    assert "viewer must be a mapping" in err


def test_viewer_missing_id_refused(tmp_path: Path):
    body = """\
    topology_params:
      schema_version: 1
      target_facility: x
      sources:
        - id: source-a
          flow_id: "11111111-1111-1111-1111-111111111111"
          pattern: smpte
      viewer:
        source_selection: source-a
    """
    _write(tmp_path, "bad.yaml", body)
    tp, err = load_topology_instance(str(tmp_path), "bad.yaml")
    assert tp is None
    assert "viewer.id missing/invalid" in err


def test_viewer_missing_source_selection_refused(tmp_path: Path):
    body = """\
    topology_params:
      schema_version: 1
      target_facility: x
      sources:
        - id: source-a
          flow_id: "11111111-1111-1111-1111-111111111111"
          pattern: smpte
      viewer:
        id: v
    """
    _write(tmp_path, "bad.yaml", body)
    tp, err = load_topology_instance(str(tmp_path), "bad.yaml")
    assert tp is None
    assert "viewer.source_selection missing/invalid" in err


def test_viewer_source_selection_unknown_id_refused(tmp_path: Path):
    body = """\
    topology_params:
      schema_version: 1
      target_facility: x
      sources:
        - id: source-a
          flow_id: "11111111-1111-1111-1111-111111111111"
          pattern: smpte
        - id: source-b
          flow_id: "22222222-2222-2222-2222-222222222222"
          pattern: ball
      viewer:
        id: v
        source_selection: source-does-not-exist
    """
    _write(tmp_path, "bad.yaml", body)
    tp, err = load_topology_instance(str(tmp_path), "bad.yaml")
    assert tp is None
    assert "does not reference a known sources[].id" in err


def test_missing_target_facility_refused(tmp_path: Path):
    body = """\
    topology_params:
      schema_version: 1
      sources:
        - id: source-a
          flow_id: "11111111-1111-1111-1111-111111111111"
          pattern: smpte
      viewer:
        id: v
        source_selection: source-a
    """
    _write(tmp_path, "bad.yaml", body)
    tp, err = load_topology_instance(str(tmp_path), "bad.yaml")
    assert tp is None
    assert "target_facility missing/invalid" in err


# ── load_catalog_entries: topology files skip cleanly, no log spam ──────


def test_catalog_load_skips_topology_files_silently(tmp_path: Path, caplog):
    _write(tmp_path, "topology-params.schema.yaml", SCHEMA_FILE)
    _write(tmp_path, "topology-params.j1.yaml", J1_INSTANCE)
    _write(tmp_path, "real-entry.yaml", """\
        key: real-entry
        display_name: "Real Entry"
        summary: "x"
        ebu:
          layer: 5
          media_function_type: source
    """)
    with caplog.at_level(logging.WARNING, logger="dmf_cms.catalog"):
        entries = load_catalog_entries(str(tmp_path))
    assert [e.key for e in entries] == ["real-entry"]
    # The two topology files must not produce the generic "lacks 'key'"
    # warning — that would be log spam on every catalog load, since these
    # are legitimate, expected files, not malformed entries.
    assert not any("lacks 'key'" in r.getMessage() for r in caplog.records)


def test_catalog_load_topology_files_logged_at_debug_not_warning(tmp_path: Path, caplog):
    _write(tmp_path, "topology-params.j1.yaml", J1_INSTANCE)
    with caplog.at_level(logging.DEBUG, logger="dmf_cms.catalog"):
        load_catalog_entries(str(tmp_path))
    messages = [r.getMessage() for r in caplog.records]
    assert any("topology_params contract/instance file" in m for m in messages)
    debug_records = [r for r in caplog.records if "topology_params contract/instance file" in r.getMessage()]
    assert all(r.levelno == logging.DEBUG for r in debug_records)


# ── CatalogEntry.topology_ref plumbing ───────────────────────────────────


def test_entry_with_topology_ref_field(tmp_path: Path):
    _write(tmp_path, "entry.yaml", """\
        key: mxl-videotestsrc
        display_name: "Src"
        summary: "x"
        ebu:
          layer: 5
          media_function_type: source
        topology_ref: topology-params.j1.yaml
    """)
    entries = load_catalog_entries(str(tmp_path))
    assert entries[0].topology_ref == "topology-params.j1.yaml"


def test_entry_without_topology_ref_defaults_none(tmp_path: Path):
    _write(tmp_path, "entry.yaml", """\
        key: mxl-videotestsrc
        display_name: "Src"
        summary: "x"
        ebu:
          layer: 5
          media_function_type: source
    """)
    entries = load_catalog_entries(str(tmp_path))
    assert entries[0].topology_ref is None


def test_catalog_entry_dataclass_default_topology_ref_none():
    entry = CatalogEntry(key="k", display_name="d", summary="s")
    assert entry.topology_ref is None
