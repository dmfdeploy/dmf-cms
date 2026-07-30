"""Shared ``detail=<x>`` token allowlist for dmf-runbooks' L3 outcome
vocabulary (umbrella #202 WP3 R5b enum, extended umbrella #320/#321).

Lives in its own leaf module (not ``main.py``, where the enum was
originally defined) so both ``main.py`` (the ``DMF_L3_OUTCOME`` marker's kv
``detail=`` sanitizer) and ``switch_source.py`` (the switch-outcome parser,
which validates a ``DMF_L3_SWITCH_REFUSED: detail=<x>`` value against this
SAME set) can import it without a circular import — ``main.py`` already
imports from ``switch_source.py``, so the reverse import isn't available.

See ``tests/test_l3_token_registry.py`` for the cross-repo drift test that
keeps this set in sync with dmf-runbooks' own emissions.
"""

from __future__ import annotations

KV_DETAIL_TOKENS = frozenset({
    "authority-constant-mismatch", "helm-values-fetch-failed", "lock-lost",
    "lock-race", "lock-verify-failed", "reserved-var", "reserved-var-run-id",
    "snapshot-collision", "snapshot-race", "snapshot-verify-failed",
    "switch-chart-metadata-mismatch", "switch-coordinator-missing",
    "switch-pre-values-missing-flow-id", "switch-receiver-instance-missing",
    "switch-source-instance-mismatch", "switch-final-readback-mismatch",
    "topology-facility-ambiguous", "topology-facility-mismatch",
    "topology-invalid", "topology-wrong-entry",
})
