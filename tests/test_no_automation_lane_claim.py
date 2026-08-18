"""Guard: no source string claims a nonexistent automatic converger
(dmfdeploy/dmfdeploy#411).

"Clear for deployment"'s confirm panel and the
``/api/media-workloads/{instance}/clear`` response used to tell the operator
that "the platform's automation lane" converges cleared desired state onto
the cluster. It does not exist: zero AWX schedules are registered anywhere
in dmf-infra, and the one playbook that could reconcile drift
(``operate-catalog-drift.yml``) has no job template, so nothing ever runs it
automatically. The false claim was also persisted verbatim into the
console's own Activity audit record (frontend/src/store/activity.ts),
outliving the page that wrote it.

Fix-round 1 widened this from a single literal-phrase grep after a survivor
was found: a docstring in ``media_workloads.py`` named a *different* actor
("the AWX lane") and a *different* claim shape ("convergence is the ...
drift-detection loop's job") that the original single-phrase guard could not
see. Fix-round 2 widened it again after the gate found four more evasions
against fix-round 1's matcher — a modal ("AWX will converge it"), a bare
verb with a different object ("... will converge the desired state"), an
unlisted verb ("the AWX service applies it automatically"), and a
negation-window blind spot (a negation word sitting in an earlier CLAUSE of
the same sentence, e.g. "It is not the check; AWX converges it.", read as
negated by a window that didn't know about the ";"). This module now checks
the CLAIM CLASS with clause-aware negation, not the exact conjugations the
retired copy happened to use.

WHAT THIS GUARD IS, AND WHAT IT IS NOT — stated here so a future reader (or
a future gate) does not mistake one for the other, which would itself be
the same defect this issue is about: a claim that outruns what is actually
established.

  IS: a regression guard against the SPECIFIC retired phrasings of this
  defect and their near variants (modal forms, alternate verbs, alternate
  objects, semicolon/dash-separated negation). That is a real, useful,
  narrow claim — it stops the exact false statement (or a small mutation of
  it) from coming back silently.

  IS NOT, and cannot be: a general honesty detector, or proof that no
  string anywhere claims a nonexistent automatic actor. Prose is
  unbounded; a sufficiently different novel phrasing — a new verb, a
  different clause shape, a paraphrase with no verb this file's regex knows
  about — will pass this guard uncaught. Regex-over-prose is evadable by
  construction. The actual defence against a NOVEL false claim is code
  review, not this file, and this file does not substitute for it.

  This is FIX-ROUND 2's LAST widening for this issue, by the gate's own
  ruling: further evasions are known-possible and are not being chased
  here. Three acknowledged, deliberately uncovered examples: a claim spread
  across more than two clauses with the negation in a THIRD clause back
  (this guard only looks one clause back); a claim where the actor noun
  itself implies automatic action without any of this file's listed verbs
  ("the reconciler" + a verb never enumerated here, e.g. "settles" or
  "syncs"); and — fix-round 3 — the verb forms "apply"/"handles"/
  "resolves"/"reconciles" specifically. Fix-round 2 briefly included all
  four; none of the four evasions the gate actually demonstrated needed
  them, and keeping them cost four unrelated prose edits in files this
  issue has no business touching (DNS-resolution comments in an AWX
  client, an operator-resolves-it note in the operations store) — collateral
  a reviewer then has to explain. Narrowed back to exactly the verbs the
  demonstrated evasions used ("converges?", "converge", "applies") rather
  than the full plausible set. "handles"/"resolves"/"reconciles" are
  plausibly in-class phrasings a truly novel claim could still use — noting
  that here is more honest than covering it at that cost.

  Fix-round 4: a LIVE instance of this defect survived rounds 1–3 in a file
  this branch had already touched — media_workloads.py's reconcile_pending
  comment said "the AWX drift lane exists to converge (ADR-0037 §4)",
  contradicting reconcile_pending's own derivation two lines below it, the
  one thing the original issue calls already honest. It was found by a
  MANUAL read of application source, not by this guard, and the guard was
  provably blind to it for two structural reasons, not a missing literal:
  the actor phrase was NON-CONTIGUOUS ("awx" ... "lane" with "drift" between
  them, where every prior ban checked for adjacency), and the sentence
  supplied no object ("exists to converge (ADR-0037 §4)." has no "it" / "the
  desired state" / "automatically" for the verb-shape pattern to anchor on).
  Fixed with the minimal addition the demonstrated phrasing needed — an
  "awx ... lane" check tolerating exactly one intervening word — not a
  redesign of either shape. The general lesson stands as its own
  known-uncovered case: a claim spread across a whole clause with its actor
  and its verb non-adjacent, and no object at all, is a shape this guard's
  patterns do not reach for on their own. What actually closed this
  instance was a human reading the source with the defect's own vocabulary
  in mind (lane, converge, reconcile, drift, automatic, loop, scheduled),
  not a wider regex — that is the honest account of how it was found, and
  it is why review, not this file, stays the real defence (see IS NOT,
  above).

KNOWN GAP, stated rather than silently accepted: this sweeps SOURCE only.
The built frontend bundle under ``src/dmf_cms/static/app/`` is excluded (a
generated artifact this repo does not commit rebuilt, so editing it here
would be pointless) — but that also means a stale local build can still
SERVE the old copy to a browser until it is rebuilt. This guard cannot see
that; only a rebuild + redeploy actually retires the string in production.
``__tests__``/``tests`` are excluded too: the regression tests for this very
defect (this file included) legitimately name the retired phrases in
negative assertions, parametrized fixtures, and comments.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]

SWEPT_DIRS = [
    REPO_ROOT / "src" / "dmf_cms",
    REPO_ROOT / "frontend" / "src",
]
SOURCE_SUFFIXES = {".py", ".ts", ".tsx"}
EXCLUDED_DIR_PARTS = {"static", "__pycache__", "node_modules", "__tests__", "tests"}

# Bare bans: each of these must never appear anywhere in application
# source, in ANY framing — even a NEGATED sentence still names the phantom
# actor, which is itself the defect. (Fix-round 1's first attempt at the
# main.py docstring wrote "there is no automation lane" and tripped the
# original guard on exactly this — negating the phrase is not the fix,
# retiring it is.) The drift-check/drift-loop entries are deliberately verb-
# scoped ("... will", "... runs", "'s job"), not a bare "drift check" ban —
# this fix's OWN corrected prose truthfully SAYS "the catalog-drift check
# has no job template", and that sentence must stay legal.
_BARE_BANS: tuple[str, ...] = (
    "automation lane",
    "will deploy it",
    "drift check will",
    "drift-detection loop will",
    "drift check runs",
    "drift-detection loop runs",
    "loop's job",
)

# "awx ... lane", tolerating exactly ONE intervening word (fix-round 4):
# media_workloads.py's reconcile_pending comment survived every guard round
# so far — "the AWX drift lane exists to converge (ADR-0037 §4)" — because
# "awx" and "lane" were never adjacent, so the plain "awx lane" substring
# ban never matched it, and the verb-shape pattern needs an object ("it" /
# "the desired state" / "automatically") within its span, which "exists to
# converge (ADR-0037 §4)." never supplies. Found by a manual source
# read, not by this guard — recorded in the module docstring. A ONE-word
# gap is deliberate, not an unbounded "awx ... lane" search anywhere in a
# file: this covers the demonstrated phrasing ("AWX drift lane"), not a
# speculative family.
_AWX_LANE_RE = re.compile(r"\bawx(?:\s+\w+)?\s+lane\b", re.IGNORECASE)

# General claim-verb shape (fix-round 2, narrowed fix-round 3): every
# retired phrasing, AND every evasion the gate found against fix-round 1's
# exact-phrase check, has this skeleton — some actor, optionally a "will"
# modal, one of these verbs, then either "it", "the desired state", or
# "automatically" within a short span: "AWX converges it", "AWX will
# converge it", "a scheduled reconciler will converge the desired state",
# "the AWX service applies it automatically". Exactly the three verb forms
# the demonstrated evasions actually used ("converges?", "converge",
# "applies") — fix-round 2 briefly also matched "apply"/"handles?"/
# "resolves?"/"reconciles?", which caught nothing the four gate examples
# below didn't already catch, but did trip on ordinary, unrelated true
# sentences elsewhere in the codebase ("the Service still resolves" — DNS
# resolution; "an operator must resolve it" — a different subsystem's busy
# check; "the onError placeholder handles it uniformly") and forced
# rewording files this issue has no business touching. Narrowed back;
# those verb forms are noted as known-uncovered above rather than covered
# at that cost. Deliberately excludes "deploy(s)" for the same kind of
# reason — Provision is a real, named actor that legitimately "deploys it"
# in this fix's OWN corrected prose; the one retired shape that used that
# verb ("... will deploy it") is still caught by the bare ban above, which
# has no such exception to carve out.
_CLAIM_VERB_RE = re.compile(
    r"\b(?:will\s+)?(?:converges?|converge|applies)\b"
    r"[^.;:—\n]{0,30}?"
    r"\b(?:it\b|the desired state\b|automatically\b)",
    re.IGNORECASE,
)

# Negation-guarded, CLAUSE-aware: every retired phrasing (and reintroduced
# evasion) that used this verb shape used it as an unqualified, present-tense
# claim. This fix's OWN corrected prose legitimately says "Nothing ...
# converges it automatically" — a true, negated claim — so a bare ban on the
# verb shape would fail the fix itself. Flag a match unless a negation cue
# sits in the SAME CLAUSE, i.e. since the last clause boundary (. ; : — or
# newline) before it — fix-round 1's plain character-count window read
# "It is not the check; AWX converges it." as negated, because "not" was
# only 20-odd characters back, in an entirely different clause.
_NEGATION_CUES: tuple[str, ...] = ("nothing", "no one", "never", "not ")
_CLAUSE_BOUNDARY_RE = re.compile(r"[.;:—\n]")


def _clause_prefix(lowered: str, match_start: int) -> str:
    """Text from the last clause boundary before `match_start` up to it."""
    start = 0
    for boundary in _CLAUSE_BOUNDARY_RE.finditer(lowered, 0, match_start):
        start = boundary.end()
    return lowered[start:match_start]


def find_claim_violations(text: str) -> list[str]:
    """Returns one label per claim-class violation found in `text`.

    Pure string function, no file I/O — kept separate from the sweep below
    so the discrimination tests can assert on it directly with synthetic
    strings, not just observe "the repo sweep is currently green" (which
    proves the patterns don't false-positive on today's tree, but nothing
    about whether they'd actually catch a reintroduced claim).
    """
    lowered = text.lower()
    hits: list[str] = []
    for phrase in _BARE_BANS:
        if phrase in lowered:
            hits.append(phrase)
    if _AWX_LANE_RE.search(lowered):
        hits.append("awx ... lane (within one word)")
    for match in _CLAIM_VERB_RE.finditer(lowered):
        clause = _clause_prefix(lowered, match.start())
        if not any(cue in clause for cue in _NEGATION_CUES):
            hits.append(f"{match.group(0)!r} (unnegated claim verb)")
    return hits


def _source_files():
    for base in SWEPT_DIRS:
        for path in base.rglob("*"):
            if not path.is_file() or path.suffix not in SOURCE_SUFFIXES:
                continue
            rel_parts = set(path.relative_to(REPO_ROOT).parts)
            if EXCLUDED_DIR_PARTS & rel_parts:
                continue
            yield path


def test_no_automation_lane_claim_in_source():
    hits: dict[str, list[str]] = {}
    for path in _source_files():
        violations = find_claim_violations(path.read_text(encoding="utf-8"))
        if violations:
            hits[str(path.relative_to(REPO_ROOT))] = violations
    assert hits == {}, f"claim-class violations found: {hits}"


# ---------------------------------------------------------------------------
# Discrimination proof. Two parametrized sets, run every time this suite
# runs (not a one-off manual check): every phrasing this defect has ACTUALLY
# used, verbatim, must be caught; every sentence the fix ACTUALLY committed,
# verbatim, must pass clean. A pattern set that can't tell these apart is
# worse than no guard — it either misses real regressions or blocks honest
# fixes.
# ---------------------------------------------------------------------------

RETIRED_PHRASINGS: list[tuple[str, str]] = [
    ("ClearForDeployment.tsx panel (pre-fix)",
     "This records the intent to run in the facility source of truth; the "
     "platform's automation lane will deploy it. The console does not start "
     "anything directly."),
    ("main.py reconcile.expectation (pre-fix)",
     "Desired state recorded in the facility source of truth. The "
     "platform's automation lane converges it (catalog launch); the "
     "drift check will flag the gap until then."),
    ("main.py endpoint docstring (pre-fix)",
     "Flips the instance's NetBox lifecycle tag to active (desired state); "
     "the AWX lane converges it (ADR-0037 §4)."),
    ("workloadLifecycle.ts comment (pre-fix)",
     "Flip an instance's desired state bootstrapped -> active in NetBox, so "
     "the automation lane may deploy it."),
    ("hooks.ts comment (pre-fix)",
     "The ONE consequential media-workloads write (ADR-0037): flips desired "
     "state in NetBox; convergence belongs to the automation lane."),
    ("media_workloads.py docstring (pre-fix)",
     "\"Clear for deployment\" IS the desired-state flip: ``lifecycle:active`` is "
     "the intent signal the AWX lane understands (the tag taxonomy is binary, "
     "ADR-0013). NetBox is the ONLY thing the console writes; convergence is "
     "the catalog launch / drift-detection loop's job — never k3s from here."),
    ("a hypothetical unnamed actor (never actually shipped, guards the general shape)",
     "The reconciliation service converges it automatically within minutes."),
    # fix-round 2 (dmfdeploy/dmfdeploy#411 gate): four evasions the gate
    # found against fix-round 1's exact-phrase matcher, verified by hand
    # against the committed matcher before this round's fix.
    ("clause-blind negation (gate example)",
     "It is not the check; AWX converges it."),
    ("modal variant, no trailing s (gate example)",
     "AWX will converge it."),
    ("actor + object variant, no 'it' (gate example)",
     "a scheduled reconciler will converge the desired state"),
    ("unlisted verb, automatic-adverb shape (gate example)",
     "the AWX service applies it automatically"),
    # fix-round 4 (dmfdeploy/dmfdeploy#411 gate): a LIVE instance found by
    # manual source read, not by this guard — media_workloads.py's
    # reconcile_pending comment, unchanged by every prior round because
    # "awx" and "lane" were never adjacent and the sentence has no object
    # this file's verb-shape pattern requires.
    ("media_workloads.py reconcile_pending comment (pre-fix, found live in source)",
     "Intent says active but runtime proof is absent/failing -> the gap "
     "the AWX drift lane exists to converge (ADR-0037 §4)."),
]


@pytest.mark.parametrize("label,phrasing", RETIRED_PHRASINGS)
def test_guard_flags_every_retired_phrasing(label: str, phrasing: str) -> None:
    assert find_claim_violations(phrasing), f"guard failed to catch [{label}]: {phrasing!r}"


CORRECTED_PROSE: list[tuple[str, str]] = [
    ("ClearForDeployment.tsx panel (committed)",
     "This records the intent to run in the facility source of truth. It "
     "shows as pending reconciliation until something deploys it — today, "
     "that's Provision. This action does not deploy anything itself."),
    ("main.py reconcile.expectation (committed)",
     "Desired state recorded in the facility source of truth. It shows as "
     "pending reconciliation until something deploys it — today, that's "
     "Provision."),
    ("main.py endpoint docstring (committed)",
     "Flips the instance's NetBox lifecycle tag to active (desired state). "
     "Nothing here converges it automatically — see "
     "``reconcile.expectation`` on the response for what the operator is "
     "actually told (dmfdeploy#411); Provision is what deploys it today."),
    ("workloadLifecycle.ts comment (committed)",
     "Flip an instance's desired state bootstrapped -> active in NetBox. "
     "Nothing converges it automatically (dmfdeploy#411: no such lane "
     "exists) — Provision deploys it, when run."),
    ("hooks.ts comment (committed)",
     "The ONE consequential media-workloads write (ADR-0037): flips desired "
     "state in NetBox; nothing converges it automatically (dmfdeploy#411) — "
     "Provision does, when run."),
    ("media_workloads.py docstring (committed)",
     "\"Clear for deployment\" IS the desired-state flip: ``lifecycle:active`` is "
     "the intent signal the binary tag taxonomy defines (ADR-0013) for a "
     "future converger. No such converger runs today — nothing is "
     "scheduled, and the catalog-drift check has no job template either, so "
     "it never flags the gap on its own (dmfdeploy#411). An operator-run "
     "Provision deploy is what deploys it, today. NetBox is the ONLY thing "
     "the console writes — never k3s from here."),
    ("media_workloads.py reconcile_pending comment (committed, fix-round 4)",
     "Intent says active but runtime proof is absent/failing — the two "
     "disagree. This flags that gap; it does not name, or claim exists, "
     "anything that closes it automatically (dmfdeploy#411)."),
]


@pytest.mark.parametrize("label,prose", CORRECTED_PROSE)
def test_guard_does_not_flag_the_corrected_prose(label: str, prose: str) -> None:
    assert find_claim_violations(prose) == [], f"guard false-positived on corrected [{label}]: {prose!r}"
