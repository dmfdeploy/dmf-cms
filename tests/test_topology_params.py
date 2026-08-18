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


J1_INSTANCE_WITH_SOURCE_PROFILE = J1_INSTANCE.replace(
    "topology_params:\n  schema_version: 1\n",
    "topology_params:\n  schema_version: 1\n"
    "  source_profile:\n"
    "    resources:\n"
    "      requests:\n"
    "        cpu: 450m\n"
    "        memory: 160Mi\n",
)


def test_source_profile_survives_load_unchanged(tmp_path: Path):
    # umbrella #347: source_profile is an additive field this loader's
    # explicit validation never mentions — load_topology_instance returns
    # the raw parsed topology_params object as-is (it validates a required
    # SUBSET, it does not reconstruct/filter the object), so an unknown
    # field must round-trip byte-for-byte. This is the discriminating proof:
    # a loader rewritten to build a new dict from only the fields it
    # validates would silently drop source_profile, and this is the one
    # test that would catch it.
    assert "source_profile" not in J1_INSTANCE  # guard: fixtures actually differ
    _write(tmp_path, "topology-params.j1.yaml", J1_INSTANCE_WITH_SOURCE_PROFILE)
    tp, err = load_topology_instance(str(tmp_path), "topology-params.j1.yaml")
    assert err is None, err
    assert tp["source_profile"] == {
        "resources": {"requests": {"cpu": "450m", "memory": "160Mi"}}
    }
    # Whole-object equality, same discipline as test_load_valid_j1_instance:
    # everything else must be unchanged too, not just source_profile present.
    expected = dict(EXPECTED_J1_TOPOLOGY_PARAMS)
    expected["source_profile"] = {"resources": {"requests": {"cpu": "450m", "memory": "160Mi"}}}
    assert tp == expected


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


# ── CatalogEntry.topology_source_noun (umbrella #401) — T4 ──────────────

J1_INSTANCE_WITH_SOURCE_NOUN = J1_INSTANCE.replace(
    "topology_params:\n  schema_version: 1\n",
    "topology_params:\n  schema_version: 1\n"
    '  source_noun: "MXL Test-Pattern Source"\n',
)

_ENTRY_WITH_TOPOLOGY_REF = """\
    key: mxl-videotest-view
    display_name: "Viewer"
    summary: "x"
    ebu:
      layer: 5
      media_function_type: view
    topology_ref: topology-params.j1.yaml
"""


def test_entry_exposes_topology_source_noun_from_instance(tmp_path: Path):
    """T4a: the catalog entry exposes the topology's declared source_noun."""
    assert "source_noun" not in J1_INSTANCE  # guard: fixtures actually differ
    _write(tmp_path, "entry.yaml", _ENTRY_WITH_TOPOLOGY_REF)
    _write(tmp_path, "topology-params.j1.yaml", J1_INSTANCE_WITH_SOURCE_NOUN)
    entries = load_catalog_entries(str(tmp_path))
    assert entries[0].topology_source_noun == "MXL Test-Pattern Source"


def test_entry_topology_source_noun_null_without_topology_ref(tmp_path: Path):
    """T4b: an entry with no topology at all exposes source_noun == None."""
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
    assert entries[0].topology_source_noun is None


def test_entry_topology_source_noun_null_when_instance_omits_it(tmp_path: Path):
    """A topology_ref entry whose instance simply has no source_noun field
    degrades to None — never a guess, never a fallback name invented here."""
    _write(tmp_path, "entry.yaml", _ENTRY_WITH_TOPOLOGY_REF)
    _write(tmp_path, "topology-params.j1.yaml", J1_INSTANCE)  # no source_noun
    entries = load_catalog_entries(str(tmp_path))
    assert entries[0].topology_ref == "topology-params.j1.yaml"
    assert entries[0].topology_source_noun is None


def test_entry_topology_source_noun_null_when_instance_missing(tmp_path: Path):
    """A topology_ref pointing at a file that doesn't exist must not reject
    the ENTRY itself (that's a deploy-time refusal, not a catalog-load-time
    one) — it only means the noun stays absent."""
    _write(tmp_path, "entry.yaml", _ENTRY_WITH_TOPOLOGY_REF)
    entries = load_catalog_entries(str(tmp_path))
    assert entries[0].topology_ref == "topology-params.j1.yaml"
    assert entries[0].topology_source_noun is None


def test_catalog_entry_dataclass_default_topology_source_noun_none():
    entry = CatalogEntry(key="k", display_name="d", summary="s")
    assert entry.topology_source_noun is None


def test_load_topology_instance_through_configmap_symlink_layout(tmp_path):
    """Kubernetes ConfigMap volumes serve files as symlinks into ..data/ —
    the containment backstop must not refuse legitimately-mounted refs
    (live incident 2026-07-27: resolve()-based parent check refused ALL
    ConfigMap files)."""
    from dmf_cms.catalog import load_topology_instance
    data_dir = tmp_path / "..2026_07_26_06_32_48.2616367988"
    data_dir.mkdir()
    real = data_dir / "topology-params.j1.yaml"
    real.write_text(J1_INSTANCE)
    dotdata = tmp_path / "..data"
    dotdata.symlink_to(data_dir.name)
    (tmp_path / "topology-params.j1.yaml").symlink_to("..data/topology-params.j1.yaml")
    topo, err = load_topology_instance(str(tmp_path), "topology-params.j1.yaml")
    assert err is None, err
    assert [s["id"] for s in topo["sources"]] == ["source-a", "source-b"]


def test_load_topology_instance_traversal_still_refused_after_symlink_fix(tmp_path):
    from dmf_cms.catalog import load_topology_instance
    for ref in ("../escape.yaml", "sub/dir.yaml", "/abs/path.yaml"):
        topo, err = load_topology_instance(str(tmp_path), ref)
        assert topo is None and err is not None


def test_load_topology_instance_symlink_escape_refused(tmp_path):
    """A plain-basename ref (passes every pre-check) whose on-disk target is
    a symlink pointing OUTSIDE the catalog dir must refuse — the containment
    backstop's real job (independent-review probe, 2026-07-27). Distinct from
    the ConfigMap layout, whose symlinks stay INSIDE the mount root."""
    from dmf_cms.catalog import load_topology_instance
    outside = tmp_path / "outside"
    outside.mkdir()
    secret = outside / "secret.yaml"
    secret.write_text(J1_INSTANCE)
    catalog = tmp_path / "catalog"
    catalog.mkdir()
    (catalog / "evil.yaml").symlink_to(secret)
    topo, err = load_topology_instance(str(catalog), "evil.yaml")
    assert topo is None
    assert err is not None and "outside" in err
