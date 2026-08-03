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
    # ── Literal emissions ────────────────────────────────────────────────
    # Each of these appears verbatim in a dmf-runbooks fail_msg / marker
    # line: one call site, one fixed string.
    "authority-constant-mismatch", "helm-values-fetch-failed", "lock-lost",
    "lock-race", "lock-verify-failed", "reserved-var", "reserved-var-run-id",
    "snapshot-collision", "snapshot-race", "snapshot-verify-failed",
    "switch-chart-metadata-mismatch", "switch-coordinator-missing",
    "switch-pre-values-missing-flow-id", "switch-receiver-instance-missing",
    "switch-source-instance-mismatch", "switch-final-readback-mismatch",
    "topology-facility-ambiguous", "topology-facility-mismatch",
    "topology-invalid", "topology-wrong-entry",
    # ── The switch play's STAGE vocabulary (umbrella #334) ───────────────
    # These do NOT appear as literals anywhere. The switch play emits them
    # through ONE templated site — playbooks/switch-mxl-fabrics-demo.yml's
    #     detail={{ _switch_stage | default('pre-lock') }}
    # — so the value is whatever `_switch_stage` was set to when the refusal
    # fired, or the default when it fired before any stage was entered.
    # The members below are the seven `_switch_stage:` set_fact values in
    # that playbook plus that default; they are enumerated from the source
    # construction, not guessed, and the drift test re-derives them the same
    # way so this list cannot quietly fall behind.
    #
    # Why their absence mattered rather than being cosmetic: `detail` is a
    # CLOSED enum (``_kv_value_ok``), and ``_sanitize_kv`` DROPS any kv token
    # whose value is not a member. Until this addition the console silently
    # discarded the stage field on every real switch refusal — the one field
    # that distinguishes "nothing was touched" (pre-lock) from "the viewer's
    # release has already been re-pointed" (repoint).
    "pre-lock", "coordinator-read", "chart-resolve", "baseline-capture",
    "quiesce", "repoint", "select", "final-readback",
    # ── The finalise-purge play's STAGE vocabulary (umbrella #347) ────────
    # Same shape as the switch stage tokens above: emitted through ONE
    # templated site — playbooks/finalise-purge.yml's own
    #     detail={{ _purge_stage | default('pre-lock') }}
    # — enumerated from that play's `_purge_stage:` set_fact values plus its
    # own default, on dmf-runbooks branch arc2b-finalise-purge (PR #37).
    # 'pre-lock' is already a member (shared default with the switch play).
    "preflight", "member-purge", "tag-purge", "final-read",
})
