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
    # umbrella #320/#321 (0.4.3 switch play): grepped from the staged
    # dmf-runbooks tree's switch-specific task files + the demo playbook's
    # own final-readback assert (see _RUNBOOKS_SWITCH_DEMO_PLAYBOOK below —
    # that one is NOT under roles/l3_run_guard/tasks/).
    "switch-chart-metadata-mismatch",     # switch_resolve_chart.yml
    "switch-coordinator-missing",         # switch_read_coordinator.yml
    "switch-pre-values-missing-flow-id",  # switch_capture_baseline.yml
    "switch-receiver-instance-missing",   # switch_validate.yml
    "switch-source-instance-mismatch",    # switch_validate.yml
    "switch-final-readback-mismatch",     # playbooks/switch-mxl-fabrics-demo.yml
    "topology-facility-ambiguous",        # topology_validate.yml
    "topology-facility-mismatch",         # topology_validate.yml
    "topology-invalid",                   # switch_validate.yml, topology_validate.yml
    "topology-wrong-entry",               # topology_validate.yml
    # umbrella #334: the switch play's STAGE vocabulary, emitted through ONE
    # TEMPLATED site — `detail={{ _switch_stage | default('pre-lock') }}` in
    # playbooks/switch-mxl-fabrics-demo.yml. No literal `detail=<stage>`
    # exists anywhere, which is why a literal-only scan never saw these.
    # Seven `_switch_stage:` set_fact values plus that default.
    "baseline-capture",                   # switch-mxl-fabrics-demo.yml (_switch_stage)
    "chart-resolve",                      # switch-mxl-fabrics-demo.yml (_switch_stage)
    "coordinator-read",                   # switch-mxl-fabrics-demo.yml (_switch_stage)
    "final-readback",                     # switch-mxl-fabrics-demo.yml (_switch_stage)
    "pre-lock",                           # the templated site's own default
    "quiesce",                            # switch-mxl-fabrics-demo.yml (_switch_stage)
    "repoint",                            # switch-mxl-fabrics-demo.yml (_switch_stage)
    "select",                             # switch-mxl-fabrics-demo.yml (_switch_stage)
})

_DETAIL_KV_RE = re.compile(r"detail=([a-zA-Z0-9_-]+)")

# umbrella #334: the switch play sets this fact to name the stage in flight,
# and the ONE templated detail= site renders it. Scanned so the live check
# derives the stage vocabulary from the same source the playbook does.
_SWITCH_STAGE_RE = re.compile(r"^\s*_switch_stage:\s*([a-zA-Z0-9_-]+)\s*$", re.M)
# The default that site applies when a refusal fires before any stage was
# entered: `detail={{ _switch_stage | default('pre-lock') }}`.
_SWITCH_STAGE_DEFAULT_RE = re.compile(
    r"detail=\{\{\s*_switch_stage\s*\|\s*default\(\s*'([a-zA-Z0-9_-]+)'\s*\)"
)


def _emitting_lines(text: str) -> str:
    """Drop whole-line YAML comments before scanning (umbrella #334).

    The scan is plain-text, so it cannot tell an EMISSION from PROSE that
    happens to quote one — and dmf-runbooks' task files discuss their own
    token vocabulary in comments at length. That produced two distinct
    false positives, both real:

    * ``switch-final-readback-`` — a comment quoting
      ``detail=switch-final-readback-mismatch`` that WRAPS mid-token, so the
      regex matched the truncated prefix and stopped at the newline. The
      hypothesis that this was an emitter bug is refuted: the string exists
      nowhere in dmf-runbooks except two comments and one complete literal
      emission (umbrella #334 facet 2).
    * ``chart-resolve`` — a security comment in
      ``_emit_switch_refused_literal.yml`` giving an INJECTION EXAMPLE
      (a receiver_instance of ``"x detail=chart-resolve"``). It names a real
      stage, but that line emits nothing.

    Admitting either would put a token in the console's closed enum on the
    authority of a sentence. That is precisely what R5b removed
    ``snapshot=skipped`` for — it had never shipped as a real emission, only
    as a mention in dmf-runbooks' own comments — so the precedent here is
    established, not invented.

    Deliberately only whole-line comments: an inline ``#`` cannot be stripped
    safely without parsing YAML quoting, and no current false positive needs
    it. A task ``name:`` that discusses tokens in prose is likewise left
    alone — the two it contributes (``quiesce``, ``repoint``) are genuine
    stage values that the templated scan below derives independently, so
    they are correct by derivation rather than by that coincidence.
    """
    return "\n".join(
        line for line in text.splitlines() if not line.lstrip().startswith("#")
    )

# umbrella #202: component repos sit as SIBLINGS of dmf-cms under a common
# parent directory (post-public-release layout) — this file lives at
# dmf-cms/tests/test_l3_token_registry.py, so three parents up is the
# common parent, and dmf-runbooks/roles/l3_run_guard/tasks is the source
# of truth directory.
_RUNBOOKS_ROOT = Path(__file__).resolve().parent.parent.parent / "dmf-runbooks"
_RUNBOOKS_TASKS_DIR = _RUNBOOKS_ROOT / "roles" / "l3_run_guard" / "tasks"

# umbrella #320/#321: the switch play's PHASE 3 final-readback assert lives
# in the demo PLAYBOOK itself, not under roles/l3_run_guard/tasks/ (every
# other detail= emission does) — its own detail=switch-final-readback-mismatch
# would be invisible to a tasks-dir-only glob. Scanned in ADDITION to the
# tasks dir below, not instead of it.
_RUNBOOKS_SWITCH_DEMO_PLAYBOOK = _RUNBOOKS_ROOT / "playbooks" / "switch-mxl-fabrics-demo.yml"


def test_emitting_lines_drops_tokens_that_only_appear_in_comments():
    """Pin ``_emitting_lines`` directly, not through the live scan.

    Whether comment-stripping changes the SCANNED SET depends on what
    dmf-runbooks' comments happen to mention today: in the tasks directory
    every comment-borne token currently also happens to be a legitimate
    registry member, so disabling the strip there changes nothing right now.
    That makes the behaviour CONTINGENTLY inert, not correct-by-construction
    — the moment a comment mentions a token nothing emits, stripping becomes
    load-bearing again, and a check that only exercised today's source would
    not notice it had stopped working.

    So the helper is pinned on synthetic input instead, where the property is
    unconditional: a token appearing only in a comment must never reach the
    scan, and a real emission on an ordinary line must always survive.
    """
    text = "\n".join([
        "# a comment quoting detail=comment-only-token in prose",
        "        fail_msg: DMF_L3_REFUSED: detail=real-emission",
        "   # indented comment mentioning detail=also-comment-only",
    ])
    found = set(_DETAIL_KV_RE.findall(_emitting_lines(text)))
    assert found == {"real-emission"}, (
        f"comment-borne tokens leaked into the scan: {sorted(found)}"
    )


def test_emitting_lines_drops_a_comment_that_wraps_mid_token():
    """The exact umbrella #334 facet-2 shape, as a regression guard.

    dmf-runbooks' switch playbook quotes its own
    ``detail=switch-final-readback-mismatch`` inside a comment that WRAPS
    after the hyphen. A literal scan matched the truncated prefix and stopped
    at the newline, inventing a token no code path emits — which is what the
    issue suspected might be an emitter bug. It is not: the string exists
    nowhere in dmf-runbooks outside two comments and one complete literal
    emission.
    """
    text = "\n".join([
        '# ... the convention used one line away in "DMF_L3_SWITCH_REFUSED: detail=switch-final-readback-',
        '# mismatch". It is deliberately a SMALL, stable vocabulary.',
        "        fail_msg: DMF_L3_SWITCH_REFUSED: detail=switch-final-readback-mismatch",
    ])
    found = set(_DETAIL_KV_RE.findall(_emitting_lines(text)))
    assert "switch-final-readback-" not in found, (
        "the truncated comment-wrap artifact reached the scan"
    )
    assert found == {"switch-final-readback-mismatch"}


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
        found.update(_DETAIL_KV_RE.findall(_emitting_lines(path.read_text())))
    if _RUNBOOKS_SWITCH_DEMO_PLAYBOOK.is_file():
        demo = _RUNBOOKS_SWITCH_DEMO_PLAYBOOK.read_text()
        found.update(_DETAIL_KV_RE.findall(_emitting_lines(demo)))
        # umbrella #334: the stage vocabulary reaches the marker through a
        # TEMPLATE, so a literal scan is structurally blind to it. Derive it
        # from the same two places the playbook does — the `_switch_stage`
        # set_facts, and the default on the templated detail= site itself.
        # Without this the check would still pass while the console's enum
        # silently lacked every stage value it actually receives.
        found.update(_SWITCH_STAGE_RE.findall(demo))
        found.update(_SWITCH_STAGE_DEFAULT_RE.findall(demo))

    assert found == main._KV_DETAIL_TOKENS, (
        f"Live scan of {_RUNBOOKS_TASKS_DIR} found detail= values "
        f"{sorted(found)}, but main._KV_DETAIL_TOKENS is "
        f"{sorted(main._KV_DETAIL_TOKENS)}. dmf-runbooks' own emitted "
        "detail set has drifted from the console's enum — update "
        "main._KV_DETAIL_TOKENS (and _EXPECTED_RUNBOOKS_DETAIL_TOKENS in "
        "this file) to match."
    )
