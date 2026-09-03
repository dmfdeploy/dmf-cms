"""Mechanical completeness guard for the outcome-acceptance allowlist
(dmfdeploy/dmfdeploy#496, codex R496-A NEW-1).

An enumerated ACCEPTANCE set is only as trustworthy as its completeness,
and "did we list enough" has already been wrong twice on this exact
property: the original denylist (F3), then the allowlist that replaced it
still missed two real acceptance tokens on its first pass
(capacity-skipped, capacity-override — a successful deploy preflight
rendering as a failed action, the precise inverse of the defect F3 fixed).
This file converts "did we list enough" from a judgement call into a
property the suite enforces mechanically: every ``outcome=`` token
main.py's emitter actually produces for a covered watched action must be
deliberately classified somewhere — in ``audit_events._ACCEPTANCE_OUTCOMES``
or in this file's own explicit terminal registry. An unclassified token
fails the build; it is never silently defaulted either way.

AST over grep, deliberately (umbrella dmf-cms#108's own lesson: grep missed
multi-line-wrapped calls that an AST walk does not).
"""

from __future__ import annotations

import ast
from pathlib import Path

import dmf_cms.audit_events as audit_events

_MAIN_PY = Path(__file__).resolve().parent.parent / "src" / "dmf_cms" / "main.py"

# The watched actions this lane renders an in-flight/failed decision for.
# finalise-purge shares the same _audit_awx_write acceptance vocabulary but
# is excluded from the lane's covered set entirely (plan §4.3) — its
# tokens never reach a user via this lane, so completeness there is
# hygiene, not a user-facing property; not asserted here.
_COVERED_WATCHED_ACTIONS = frozenset({"deploy", "teardown", "rollback"})

# Explicit, human-verified terminal (refusal) vocabulary. NOT consumed by
# resolve_outcome_state (that stays allowlist-only, per F3 — this registry
# exists only so this guard can tell "deliberately terminal" apart from
# "never looked at"). Every entry below was read at its main.py call site
# before being added here; extend this file, never the production
# allowlist, when the guard below finds a genuine refusal it hasn't seen.
_KNOWN_TERMINAL_OUTCOMES: dict[str, frozenset[str]] = {
    "deploy": frozenset({
        "invalid-workload", "awx-not-configured", "entry-not-found", "no-job-template",
        "autoscale-misconfigured", "conflict-active-operation", "template-not-found",
        "conflict-active-job", "facility-busy",
        # L3 preflight refusals (main.py:443-634) — capacity-denied
        # (Prometheus unconfigured, no supply data, or demand read
        # failure), invalid-override (malformed override flag),
        # topology-invalid/topology-facility-* (topology resolution
        # failures, all paired with an error JSONResponse at their call
        # site). capacity-skipped/capacity-override are NOT here — they
        # are genuine acceptances (see audit_events.py's own comment).
        "capacity-denied", "invalid-override", "topology-invalid",
        "topology-facility-ambiguous", "topology-facility-error", "topology-facility-unavailable",
    }),
    "teardown": frozenset({
        "awx-not-configured", "entry-not-found", "no-job-template", "autoscale-misconfigured",
        "conflict-active-operation", "template-not-found", "conflict-active-job", "facility-busy",
    }),
    "rollback": frozenset({
        "invalid-run-id", "awx-not-configured", "autoscale-misconfigured", "facility-busy",
        "jt-not-registered", "already-active-other-run",
    }),
}

_AWX_ERROR_STATIC_PREFIX = "awx-error:"


def _sweep_outcome_tokens() -> tuple[dict[str, set[str]], dict[str, bool]]:
    """Every literal ``(action, outcome)`` pair ``_audit_awx_write(...)`` is
    called with in main.py, for the covered watched actions, plus the
    auto-rollback dispatch's two direct module-logger calls (same
    ``"awx write:"`` shape, ``action=rollback``, with the outcome a LITERAL
    substring embedded in the format string rather than a ``%s`` arg).

    Returns (literal tokens found per action, whether a dynamic
    ``f"awx-error:{...}"`` site was seen per action) — the second is
    checked separately since it's not a single literal token but a known,
    already-handled dynamic pattern (``_describe_failure``'s
    ``_AWX_ERROR_PREFIX`` branch), not something this guard can enumerate.
    """
    source = _MAIN_PY.read_text()
    tree = ast.parse(source)

    found: dict[str, set[str]] = {a: set() for a in _COVERED_WATCHED_ACTIONS}
    saw_awx_error: dict[str, bool] = {a: False for a in _COVERED_WATCHED_ACTIONS}

    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = func.id if isinstance(func, ast.Name) else getattr(func, "attr", None)

        if name == "_audit_awx_write":
            kwargs = {kw.arg: kw.value for kw in node.keywords}
            action_node = kwargs.get("action")
            outcome_node = kwargs.get("outcome")
            if not isinstance(action_node, ast.Constant) or not isinstance(action_node.value, str):
                continue
            action = action_node.value
            if action not in _COVERED_WATCHED_ACTIONS:
                continue

            if isinstance(outcome_node, ast.Constant) and isinstance(outcome_node.value, str):
                found[action].add(outcome_node.value)
                continue

            # Known dynamic shape: f"awx-error:{exc.status}" (a JoinedStr
            # whose first, static part is the awx-error: prefix). Anything
            # else non-literal is a genuine gap this guard cannot verify
            # statically — fail loudly rather than skip silently.
            if (
                isinstance(outcome_node, ast.JoinedStr)
                and outcome_node.values
                and isinstance(outcome_node.values[0], ast.Constant)
                and isinstance(outcome_node.values[0].value, str)
                and outcome_node.values[0].value.startswith(_AWX_ERROR_STATIC_PREFIX)
            ):
                saw_awx_error[action] = True
                continue

            raise AssertionError(
                f"main.py:{node.lineno}: _audit_awx_write(action={action!r}, ...) has a "
                "non-literal outcome= this guard cannot verify statically — resolve by hand "
                "and extend this sweep's handling explicitly (do not just skip it)."
            )

        elif (
            name == "info"
            and isinstance(func, ast.Attribute)
            and isinstance(func.value, ast.Name)
            and func.value.id == "logger"
            and node.args
            and isinstance(node.args[0], ast.Constant)
            and isinstance(node.args[0].value, str)
            and "awx write: action=rollback" in node.args[0].value
        ):
            import re

            m = re.search(r"\boutcome=([^\s%]+)", node.args[0].value)
            if m:
                found["rollback"].add(m.group(1))

    return found, saw_awx_error


def test_every_emitted_outcome_token_is_deliberately_classified():
    found, saw_awx_error = _sweep_outcome_tokens()
    unclassified: list[str] = []
    for action, tokens in found.items():
        acceptance = audit_events._ACCEPTANCE_OUTCOMES.get(action, frozenset())
        terminal = _KNOWN_TERMINAL_OUTCOMES.get(action, frozenset())
        for token in tokens:
            if token not in acceptance and token not in terminal:
                unclassified.append(f"{action}={token}")
    assert unclassified == [], (
        "Outcome token(s) emitted by main.py for a covered watched action but not "
        "deliberately classified in audit_events._ACCEPTANCE_OUTCOMES (if it's a genuine "
        "acceptance) or this file's _KNOWN_TERMINAL_OUTCOMES (if it's a genuine refusal): "
        f"{unclassified}. Read the call site before classifying it either way — do not guess "
        "from the token's name."
    )
    # The awx-error: dynamic pattern must actually be PRESENT for every
    # action that's supposed to have it — if a future refactor renamed the
    # variable or changed the f-string shape, this guard's own recognition
    # of it would silently stop firing, which would be a false pass on the
    # property above (an unrecognised dynamic outcome would then fall
    # through as "no non-literal site found" rather than raising).
    for action in _COVERED_WATCHED_ACTIONS:
        assert saw_awx_error[action], (
            f"expected an f'awx-error:{{...}}' outcome= site for action={action!r} — "
            "none matched this guard's recognition pattern; main.py's shape may have changed."
        )


def test_the_sweep_itself_finds_a_realistic_number_of_tokens_per_action():
    # Guards against the sweep silently finding nothing (e.g. a helper
    # rename breaking the AST match), which would make the test above pass
    # vacuously — an empty `found` dict has no unclassified tokens either.
    found, _ = _sweep_outcome_tokens()
    for action in _COVERED_WATCHED_ACTIONS:
        assert len(found[action]) >= 5, (
            f"sweep found suspiciously few outcome tokens for {action!r}: {found[action]!r} "
            "— the AST match likely broke, not that main.py genuinely shrank"
        )


def test_capacity_skipped_and_capacity_override_are_acceptance_not_terminal():
    # codex R496-A NEW-1's concrete proof case, pinned directly: both are
    # deploy-only L3-preflight outcomes where the run proceeds regardless
    # (main.py:485-490 docstring "Skips with an audited capacity-skipped
    # outcome"; main.py:553-588 docstring "the run proceeds anyway").
    assert "capacity-skipped" in audit_events._ACCEPTANCE_OUTCOMES["deploy"]
    assert "capacity-override" in audit_events._ACCEPTANCE_OUTCOMES["deploy"]
    assert audit_events.resolve_outcome_state("deploy", "capacity-skipped") == "in_flight"
    assert audit_events.resolve_outcome_state("deploy", "capacity-override") == "in_flight"
