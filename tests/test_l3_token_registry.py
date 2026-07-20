"""umbrella #202 WP3 R5b (codex round-4 P2-2) — cross-repo L3 outcome-token
registry test.

Codex round-4's exact finding: the console's ``_KV_DETAIL_TOKENS`` enum
(``src/dmf_cms/main.py``) had SILENTLY drifted behind dmf-runbooks' own
emitted ``detail=<x>`` kv values twice in a row now — first missing
snapshot-race/helm-values-fetch-failed/reserved-var-run-id after R4a, then
(if this test hadn't been added) it would have silently missed R5a's own
new detail values (authority-constant-mismatch, lock-verify-failed,
snapshot-verify-failed) too. A hand-maintained enum in ONE repo, kept in
sync with emissions in a SEPARATE repo purely by developer memory, is
structurally the same class of bug the reserved-var blocklist meta-test
(dmf-runbooks' own tests/scripts/check_reserved_vars.py, umbrella #202 WP3
R5a) fixed for THAT repo's own internal drift — this is the cross-repo
version of the identical problem.

MECHANISM (two tests, deliberately layered):

1. ``test_kv_detail_tokens_matches_documented_expected_set`` — ALWAYS
   runs, CI-safe, no cross-repo filesystem access. Compares
   ``main._KV_DETAIL_TOKENS`` against ``_EXPECTED_RUNBOOKS_DETAIL_TOKENS``,
   a hardcoded constant in THIS file with an explicit comment pointing at
   the runbooks source of truth (every ``l3_outcome_token:``/
   ``detail=<x>`` call site in
   ``roles/l3_run_guard/tasks/*.yml``) and an instruction to update BOTH
   this constant and ``main._KV_DETAIL_TOKENS`` together whenever
   dmf-runbooks adds/removes a detail value. This is the test that
   actually runs in CI (dmf-cms's own CI job has no reason to check out
   the sibling dmf-runbooks repo) and the one the R5b discrimination proof
   exercises.

2. ``test_kv_detail_tokens_matches_live_runbooks_source_when_sibling_present``
   — BEST-EFFORT, live cross-repo check, for local development where the
   two repos sit as siblings under a common parent (dmf-runbooks'
   documented layout, see its own README / umbrella CLAUDE.md — since
   umbrella #202's public-release restructure, the 8 component repos are
   siblings of each other and of the umbrella, not nested). Greps
   dmf-runbooks' actual task files for every literal ``detail=<x>``
   substring (deliberately a plain-text scan — a Python regex over
   ``detail=[a-zA-Z0-9_-]+``, no PyYAML dependency, no attempt to fully
   parse Ansible task semantics; this test's job is "did the source
   strings change", not "is the YAML well-formed", and a plain-text scan
   is far more resilient to task-file refactors changing indentation/
   structure than a structural parse would be) and asserts the scanned
   set matches ``main._KV_DETAIL_TOKENS`` EXACTLY (catches BOTH
   directions of drift: a new runbooks detail value with no console
   consumer, AND a stale console enum member no runbooks code path emits
   any more). SKIPPED, loudly, if the sibling path does not exist — e.g.
   in a CI job that only checks out dmf-cms alone — rather than silently
   passing or failing; this is a strictly-better-when-available check,
   never a hard requirement.

Why not a single committed manifest file both repos read? Considered and
rejected for this round: it would require dmf-runbooks to EXPORT a
generated artifact dmf-cms then imports, adding a build/sync step neither
repo currently has, for a benefit (avoiding the two-test layering above)
that's mostly stylistic — the operator's own standing guidance (this
codebase's memory) is wary of script-monster sprawl and prefers reducing
bespoke tooling over adding it. The two-test approach here needs zero new
infrastructure: it's plain Python regex + a hardcoded constant + an
optional filesystem check, using only what pytest/stdlib already provide.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

from dmf_cms import main

# ---------------------------------------------------------------------------
# Source of truth: dmf-runbooks' own roles/l3_run_guard/tasks/*.yml, every
# `detail=<x>` kv value actually emitted (grepped from the STAGED tree,
# umbrella #202 WP3, dmf-runbooks branch feat/l3-launcher-gate, as of R5a).
# Update this set (AND main._KV_DETAIL_TOKENS) together whenever
# dmf-runbooks adds, removes, or renames a detail= value.
# ---------------------------------------------------------------------------
_EXPECTED_RUNBOOKS_DETAIL_TOKENS = frozenset({
    "authority-constant-mismatch",  # _assert_authority.yml (R5a/P1-2)
    "helm-values-fetch-failed",     # snapshot.yml (R4a/P1-8)
    "lock-lost",                    # lock_checkpoint.yml, _lock_fenced_check.yml callers (R4a/R5a P1-4)
    "lock-race",                    # lock.yml (R4a/P1-1)
    "lock-verify-failed",           # _lock_acquire_one_attempt.yml (R5a/P1-1)
    "reserved-var",                 # _assert_reserved_vars.yml (R4a/P1-2)
    "reserved-var-run-id",          # identity.yml (R4a/P1-2)
    "snapshot-collision",           # _snapshot_create_one_attempt.yml (R4a/P1-6)
    "snapshot-race",                # snapshot.yml (R4a/P2-4)
    "snapshot-verify-failed",       # _snapshot_create_one_attempt.yml (R5a/P1-1)
})

_DETAIL_KV_RE = re.compile(r"detail=([a-zA-Z0-9_-]+)")

# umbrella #202: component repos sit as SIBLINGS of dmf-cms under a common
# parent directory (post-public-release layout) — this file lives at
# dmf-cms/tests/test_l3_token_registry.py, so three parents up is the
# common parent, and dmf-runbooks/roles/l3_run_guard/tasks is the source
# of truth directory.
_RUNBOOKS_TASKS_DIR = (
    Path(__file__).resolve().parent.parent.parent / "dmf-runbooks"
    / "roles" / "l3_run_guard" / "tasks"
)


def test_kv_detail_tokens_matches_documented_expected_set():
    """CI-safe: main._KV_DETAIL_TOKENS must exactly match the hardcoded
    set documented at the top of this file as mirroring dmf-runbooks'
    own emissions. This is what the R5b discrimination proof exercises —
    it's the test that actually runs in CI (dmf-cms's own pipeline has no
    reason to check out the sibling dmf-runbooks repo)."""
    assert main._KV_DETAIL_TOKENS == _EXPECTED_RUNBOOKS_DETAIL_TOKENS, (
        "main._KV_DETAIL_TOKENS has drifted from the documented expected "
        "set in this file. If dmf-runbooks genuinely added/removed/renamed "
        "a detail= value, update BOTH main._KV_DETAIL_TOKENS and "
        "_EXPECTED_RUNBOOKS_DETAIL_TOKENS in this file together — do not "
        "silently accept a mismatch."
    )


def test_kv_detail_tokens_matches_live_runbooks_source_when_sibling_present():
    """Best-effort live cross-repo check: when dmf-runbooks sits as a
    sibling directory (the standard local dev layout), scan its actual
    task files for every detail= value it emits and assert an EXACT match
    against main._KV_DETAIL_TOKENS — catches drift in BOTH directions
    (missing token, or a stale console enum member nothing emits any
    more). Skips loudly (not silently) when the sibling isn't present,
    e.g. a CI job checking out only this repo."""
    if not _RUNBOOKS_TASKS_DIR.is_dir():
        pytest.skip(
            f"dmf-runbooks sibling repo not found at {_RUNBOOKS_TASKS_DIR} "
            "— skipping the live cross-repo registry check (this is "
            "expected in a CI job that only checks out dmf-cms; the "
            "CI-safe test_kv_detail_tokens_matches_documented_expected_set "
            "above is what actually gates this repo's own pipeline)."
        )

    found: set[str] = set()
    for path in _RUNBOOKS_TASKS_DIR.glob("*.yml"):
        found.update(_DETAIL_KV_RE.findall(path.read_text()))

    assert found == main._KV_DETAIL_TOKENS, (
        f"Live scan of {_RUNBOOKS_TASKS_DIR} found detail= values "
        f"{sorted(found)}, but main._KV_DETAIL_TOKENS is "
        f"{sorted(main._KV_DETAIL_TOKENS)}. dmf-runbooks' own emitted "
        "detail set has drifted from the console's enum — update "
        "main._KV_DETAIL_TOKENS (and _EXPECTED_RUNBOOKS_DETAIL_TOKENS in "
        "this file) to match."
    )
