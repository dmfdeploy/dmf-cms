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
import re

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


_ACTION_TOKEN_RE = re.compile(r"\baction=(\S+)")
_OUTCOME_TOKEN_RE = re.compile(r"\boutcome=([^\s%]+)")


def _sweep_outcome_tokens() -> tuple[dict[str, set[str]], dict[str, bool]]:
    """Every literal ``(action, outcome)`` pair ``_audit_awx_write(...)`` is
    called with in main.py, for the covered watched actions, plus the
    auto-rollback dispatch's two direct module-logger calls (same
    ``"awx write:"`` shape, hand-assembled with the action/outcome LITERAL
    substrings embedded in the format string rather than passed as ``%s``
    args to ``_audit_awx_write``).

    dmfdeploy/dmf-cms#140 (codex F2, 2026-09-03): the direct-emission
    branch used to key on the literal substring ``"awx write:
    action=rollback"`` — which broke SILENTLY, with the guard staying
    green, the moment the writer fix inserted an `fmt=2 ` token between
    "awx write:" and "action=rollback" and that exact adjacency stopped
    existing. A completeness guard that goes blind without failing is the
    precise failure it exists to prevent, happening in the guard itself.
    Fixed to key on STRUCTURE, not on a substring of the rendered
    message that this guard does not control:

    - WHICH LOGGER: ``logger.info(...)``, not ``audit_logger.info(...)``
      — main.py's own convention (see its module-top comment) is that
      only ``_audit_awx_write``'s own calls route through the dedicated
      ``audit_logger``; the auto-rollback dispatch's two hand-assembled
      calls use the plain module ``logger`` specifically because they
      run from a background task with no ``Request`` object, which is
      what makes them a SEPARATE emission path this sweep has to find a
      second way for in the first place. That distinction is a property
      of the CODE (which logger object is called), not of any message
      text, and is exactly as stable as `_audit_awx_write` calls being
      found by their own function name above.
    - WHICH PREFIX: the message literal must start with "awx write:" —
      the one substring this guard is entitled to depend on, because the
      REAL reader (``audit_events.parse_awx_write_line``) depends on the
      exact same literal to find the line at all (``line.find("awx
      write:")``). If that prefix ever silently changed, the whole
      feature — not just this guard — would already be broken in a
      whole-pipeline way, so anchoring on it is the most stable anchor
      available, unlike depending on the adjacency of two field markers
      to each other.
    - THE ACTION ITSELF, extracted mechanically (``action=(\\S+)``) from
      wherever it actually sits in the message, rather than assumed to
      be ``rollback`` by a hardcoded substring check. A future direct
      emission for a different action, or a reordered field sequence,
      is found the same way action/outcome tokens from ``_audit_awx_
      write`` calls already are — by reading what the code actually
      says, not by matching last round's rendered shape.

    Mutation-verified against the EXACT failure this replaces (see
    ``test_guard_finds_the_direct_emitters_even_if_their_message_text_
    changes`` below): the message text is mutated in-memory and the
    sweep is re-run against the mutated source, confirming it still
    finds both tokens.

    Returns (literal tokens found per action, whether a dynamic
    ``f"awx-error:{...}"`` site was seen per action) — the second is
    checked separately since it's not a single literal token but a known,
    already-handled dynamic pattern (``_describe_failure``'s
    ``_AWX_ERROR_PREFIX`` branch), not something this guard can enumerate.
    """
    source = _MAIN_PY.read_text()
    return _sweep_outcome_tokens_from_source(source)


def _sweep_outcome_tokens_from_source(source: str) -> tuple[dict[str, set[str]], dict[str, bool]]:
    """The actual AST walk, over arbitrary SOURCE TEXT rather than always
    reading main.py from disk — split out so the mutation-verification
    test below can feed it a deliberately altered copy of main.py's
    source without touching the real file."""
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
            and func.value.id == "logger"  # structural: the module logger, not audit_logger
            and node.args
            and isinstance(node.args[0], ast.Constant)
            and isinstance(node.args[0].value, str)
            and node.args[0].value.startswith("awx write:")  # the one anchor the real reader shares
        ):
            msg = node.args[0].value
            action_match = _ACTION_TOKEN_RE.search(msg)
            if action_match is None:
                continue
            action = action_match.group(1)
            if action not in _COVERED_WATCHED_ACTIONS:
                continue
            outcome_match = _OUTCOME_TOKEN_RE.search(msg)
            if outcome_match:
                found[action].add(outcome_match.group(1))

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


def test_the_sweep_finds_the_auto_rollback_dispatchs_own_direct_emitters():
    # dmfdeploy/dmf-cms#140 (codex F2, 2026-09-03): this is the SPECIFIC
    # regression the "realistic number" test above cannot be trusted to
    # catch on its own — main.py's _audit_awx_write-routed rollback calls
    # alone already clear the >=5 threshold, so the sweep going blind to
    # ONLY these two tokens (as it silently did the moment the writer fix
    # inserted `fmt=2 ` into the message text) would not have failed that
    # test either. Pin the exact tokens the two hand-assembled auto-
    # rollback module-logger calls emit, so any future regression on
    # THESE specific sites is caught regardless of what the aggregate
    # count happens to be.
    found, _ = _sweep_outcome_tokens()
    assert "already-in-progress" in found["rollback"]
    assert "auto-triggered" in found["rollback"]


def test_guard_still_finds_the_direct_emitters_after_their_message_text_changes():
    # MUTATION-VERIFICATION against the EXACT failure codex found: the
    # sweep used to key on the literal substring "awx write:
    # action=rollback" and went silently blind the moment a token was
    # inserted between the two halves. Exercises the sweep against SYNTHETIC
    # source snippets (never sliced from the real file — main.py's own
    # emission strings are split across adjacent string literals at
    # different source lines, so raw-text substring surgery on the file
    # itself is its own trap; a small standalone snippet in the exact call
    # shape the real sweep matches is both simpler and more direct) under
    # three distinct changes a future round could plausibly make to the
    # message text — proving the structural key (which logger, the "awx
    # write:" prefix, action= extracted from wherever it sits) does not
    # share the old brittleness, not just that it happens to work on
    # today's exact text.
    def _snippet(message: str) -> str:
        return (
            "def _fake():\n"
            f"    logger.info(\n        {message!r},\n"
            "        rollback_op.request_id, run_id, reason, deploy_op.request_id,\n"
            "    )\n"
        )

    mutations = {
        "another marker inserted between the prefix and action=": (
            "awx write: ver=9 action=rollback actor='system:auto-rollback' role=system "
            "real_role= request_id=%s target=%r reason=%r outcome=already-in-progress "
            "workload='' capacity='' linked_request_id=%s"
        ),
        "fields reordered, action moved later in the message": (
            "awx write: fmt=2 actor='system:auto-rollback' role=system real_role= "
            "request_id=%s target=%r reason=%r action=rollback outcome=already-in-progress "
            "workload='' capacity='' linked_request_id=%s"
        ),
        "extra whitespace inserted around the marker text": (
            "awx write:  fmt=2  action=rollback actor='system:auto-rollback' role=system "
            "real_role= request_id=%s target=%r reason=%r outcome=already-in-progress "
            "workload='' capacity='' linked_request_id=%s"
        ),
    }

    for label, message in mutations.items():
        found, _ = _sweep_outcome_tokens_from_source(_snippet(message))
        assert "already-in-progress" in found["rollback"], (
            f"guard went blind to already-in-progress under mutation {label!r} — "
            "the structural key is not actually robust to this shape change"
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
