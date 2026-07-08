"""ADR-0046 decision 6 — discriminating catalog schema validation test.

Exercises the fail-closed ebu classification rule: exactly one of
``vertical`` or ``media_function_type`` must be present per entry,
each within its enum.

MUST FAIL on the old silent-skip loader (which accepted any ebu block)
and PASS on the fail-closed ``_validate_ebu`` enforcement.
"""

import textwrap
from pathlib import Path

from dmf_cms.catalog import (
    VALID_MEDIA_FUNCTION_TYPES,
    VALID_VERTICALS,
    _load_one_yaml,
    _validate_ebu,
    load_catalog_entries,
)


# ── Helpers ──────────────────────────────────────────────────────────


def _write_entry(directory: Path, filename: str, body: str) -> Path:
    """Write a synthetic catalog YAML file and return its path."""
    p = directory / filename
    p.write_text(textwrap.dedent(body))
    return p


# ── _validate_ebu unit tests ─────────────────────────────────────────


def test_valid_vertical_orchestration():
    assert _validate_ebu("test", {"vertical": "orchestration", "layer": 5}) is True


def test_valid_vertical_control():
    assert _validate_ebu("test", {"vertical": "control"}) is True


def test_valid_vertical_monitoring():
    assert _validate_ebu("test", {"vertical": "monitoring"}) is True


def test_valid_vertical_security():
    assert _validate_ebu("test", {"vertical": "security"}) is True


def test_valid_media_function_type_source():
    assert _validate_ebu("test", {"media_function_type": "source", "layer": 5}) is True


def test_valid_media_function_type_view():
    assert _validate_ebu("test", {"media_function_type": "view"}) is True


def test_valid_media_function_type_all_enum_values():
    for val in VALID_MEDIA_FUNCTION_TYPES:
        assert _validate_ebu("test", {"media_function_type": val}) is True


def test_both_present_rejected():
    """Both vertical AND media_function_type → REJECTED."""
    ebu = {"vertical": "orchestration", "media_function_type": "source", "layer": 5}
    assert _validate_ebu("test", ebu) is False


def test_neither_present_rejected():
    """Neither vertical nor media_function_type → REJECTED."""
    assert _validate_ebu("test", {"layer": 5, "lifecycle_owner": "configure"}) is False


def test_ebu_missing_entirely_rejected():
    """No ebu block at all → REJECTED."""
    assert _validate_ebu("test", None) is False


def test_ebu_not_a_dict_rejected():
    """ebu is a string instead of a mapping → REJECTED."""
    assert _validate_ebu("test", "orchestration") is False


def test_invalid_vertical_value_rejected():
    """Legacy pseudo-value 'media-functions' is not in the enum."""
    assert _validate_ebu("test", {"vertical": "media-functions"}) is False


def test_invalid_vertical_media_processing_rejected():
    """Legacy pseudo-value 'media-processing' is not in the enum."""
    assert _validate_ebu("test", {"vertical": "media-processing"}) is False


def test_invalid_media_function_type_rejected():
    """Out-of-enum media_function_type → REJECTED."""
    assert _validate_ebu("test", {"media_function_type": "transcoder"}) is False


# ── _load_one_yaml integration tests ─────────────────────────────────


def test_load_valid_vertical_entry(tmp_path: Path):
    """A valid vertical entry loads successfully."""
    _write_entry(tmp_path, "nmos-cpp.yaml", """\
        key: nmos-cpp
        display_name: NMOS IS-04/05
        summary: NMOS registry and nodes.
        ebu:
          layer: 5
          vertical: orchestration
          lifecycle_owner: configure
    """)
    entry = _load_one_yaml(tmp_path / "nmos-cpp.yaml")
    assert entry is not None
    assert entry.key == "nmos-cpp"
    assert entry.ebu["vertical"] == "orchestration"


def test_load_valid_media_function_type_entry(tmp_path: Path):
    """A valid media_function_type entry loads successfully."""
    _write_entry(tmp_path, "mxl-videotestsrc.yaml", """\
        key: mxl-videotestsrc
        display_name: MXL Test-Pattern Source
        summary: Fabrics demo source.
        ebu:
          layer: 5
          media_function_type: source
          lifecycle_owner: configure
    """)
    entry = _load_one_yaml(tmp_path / "mxl-videotestsrc.yaml")
    assert entry is not None
    assert entry.key == "mxl-videotestsrc"
    assert entry.ebu["media_function_type"] == "source"
    assert "vertical" not in entry.ebu


def test_load_both_present_rejected(tmp_path: Path):
    """An entry with BOTH vertical + media_function_type is REJECTED (None)."""
    _write_entry(tmp_path, "bad-both.yaml", """\
        key: bad-both
        display_name: Bad Both
        summary: Has both fields.
        ebu:
          layer: 5
          vertical: orchestration
          media_function_type: source
          lifecycle_owner: configure
    """)
    entry = _load_one_yaml(tmp_path / "bad-both.yaml")
    assert entry is None


def test_load_neither_present_rejected(tmp_path: Path):
    """An entry with NEITHER vertical nor media_function_type is REJECTED."""
    _write_entry(tmp_path, "bad-neither.yaml", """\
        key: bad-neither
        display_name: Bad Neither
        summary: Missing classification.
        ebu:
          layer: 5
          lifecycle_owner: configure
    """)
    entry = _load_one_yaml(tmp_path / "bad-neither.yaml")
    assert entry is None


def test_load_invalid_vertical_rejected(tmp_path: Path):
    """Legacy pseudo-vertical 'media-functions' → REJECTED."""
    _write_entry(tmp_path, "bad-vertical.yaml", """\
        key: bad-vertical
        display_name: Bad Vertical
        summary: Legacy pseudo-vertical.
        ebu:
          layer: 5
          vertical: media-functions
          lifecycle_owner: configure
    """)
    entry = _load_one_yaml(tmp_path / "bad-vertical.yaml")
    assert entry is None


def test_load_invalid_media_function_type_rejected(tmp_path: Path):
    """Out-of-enum media_function_type → REJECTED."""
    _write_entry(tmp_path, "bad-mft.yaml", """\
        key: bad-mft
        display_name: Bad MFT
        summary: Invalid type.
        ebu:
          layer: 5
          media_function_type: encoder
          lifecycle_owner: configure
    """)
    entry = _load_one_yaml(tmp_path / "bad-mft.yaml")
    assert entry is None


def test_load_catalog_entries_mixed(tmp_path: Path):
    """load_catalog_entries includes valid, excludes invalid entries."""
    _write_entry(tmp_path, "good.yaml", """\
        key: good
        display_name: Good
        summary: Valid entry.
        ebu:
          layer: 5
          media_function_type: view
          lifecycle_owner: configure
    """)
    _write_entry(tmp_path, "bad.yaml", """\
        key: bad
        display_name: Bad
        summary: Both fields set.
        ebu:
          layer: 5
          vertical: orchestration
          media_function_type: source
          lifecycle_owner: configure
    """)
    entries = load_catalog_entries(str(tmp_path))
    keys = [e.key for e in entries]
    assert "good" in keys
    assert "bad" not in keys
    assert len(entries) == 1


def test_load_no_ebu_block_rejected(tmp_path: Path):
    """An entry with no ebu block at all is REJECTED."""
    _write_entry(tmp_path, "no-ebu.yaml", """\
        key: no-ebu
        display_name: No EBU
        summary: Missing ebu block entirely.
    """)
    entry = _load_one_yaml(tmp_path / "no-ebu.yaml")
    assert entry is None


# ── P1 unhashable / non-string value tests (codex gate) ──────────────


def test_validate_vertical_list_rejected_no_crash():
    """vertical: [] must reject cleanly, not raise TypeError."""
    assert _validate_ebu("test", {"vertical": []}) is False


def test_validate_media_function_type_dict_rejected_no_crash():
    """media_function_type: {} must reject cleanly, not raise TypeError."""
    assert _validate_ebu("test", {"media_function_type": {}}) is False


def test_validate_vertical_int_rejected_no_crash():
    """vertical: 5 (int) must reject cleanly."""
    assert _validate_ebu("test", {"vertical": 5}) is False


def test_validate_vertical_none_rejected_no_crash():
    """vertical: null must reject cleanly."""
    assert _validate_ebu("test", {"vertical": None}) is False


def test_validate_rejection_logs_error(caplog, tmp_path: Path):
    """Rejections must log at ERROR level (loud, not silent)."""
    import logging

    _write_entry(tmp_path, "bad.yaml", """\
        key: bad-unhashable
        display_name: Bad Unhashable
        summary: vertical is a list.
        ebu:
          layer: 5
          vertical: []
          lifecycle_owner: configure
    """)
    with caplog.at_level(logging.ERROR, logger="dmf_cms.catalog"):
        entry = _load_one_yaml(tmp_path / "bad.yaml")
    assert entry is None
    assert any("REJECTED" in r.message for r in caplog.records)
    assert any(r.levelno == logging.ERROR for r in caplog.records)


def test_load_mixed_dir_unhashable_does_not_crash(tmp_path: Path):
    """One good + one malformed (vertical:[]) entry → returns exactly the good one.

    This is the discriminating repro for the P1 crash path: the old code
    would raise TypeError on `[] not in frozenset(...)`. The fix rejects
    cleanly and the good entry still loads.
    """
    _write_entry(tmp_path, "good.yaml", """\
        key: good
        display_name: Good
        summary: Valid entry.
        ebu:
          layer: 5
          media_function_type: view
          lifecycle_owner: configure
    """)
    _write_entry(tmp_path, "bad-unhashable.yaml", """\
        key: bad-unhashable
        display_name: Bad Unhashable
        summary: vertical is a list.
        ebu:
          layer: 5
          vertical: []
          lifecycle_owner: configure
    """)
    # Must NOT raise
    entries = load_catalog_entries(str(tmp_path))
    keys = [e.key for e in entries]
    assert "good" in keys
    assert "bad-unhashable" not in keys
    assert len(entries) == 1
