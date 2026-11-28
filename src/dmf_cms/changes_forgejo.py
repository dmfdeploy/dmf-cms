"""Read-state rules for the History lane's commits and pull request panels.

Both routes (``/api/changes/commits`` and ``/api/changes/pulls``) report one
``reason`` token for a whole read. The rules live here so the two ladders
cannot drift apart. The route handlers stay in ``main.py``.

The page may say source control is unreachable only when the repository search
got no HTTP reply. Once the search replied, a repository whose own call fails
is a failed read, never "unreachable".
"""

from __future__ import annotations

from .forgejo import SEARCH_LIMIT, RepoSearch

# How many repositories one read asks for.
REPO_CAP = 5

REASON_UNREACHABLE = "forgejo-unreachable"
REASON_READ_FAILED = "forgejo-read-failed"
REASON_PARTIAL = "forgejo-partial"
REASON_PULLS_DISABLED = "forgejo-pulls-disabled"
REASON_UNCONFIGURED = "forgejo-unconfigured"

# Fields every fail-soft reply carries, so the console never reads an absent
# field as a claim.
READ_FIELD_DEFAULTS = {"skipped_repos": 0, "repos_maybe_incomplete": False}


def repos_maybe_incomplete(search: RepoSearch) -> bool:
    """True when the search may have left repositories out of its reply.

    With a trusted total, the reply is incomplete when the total is larger than
    what came back. Without one, a reply that fills the requested page may have
    left more behind.
    """
    if search.total is not None:
        return search.total > len(search.repos)
    return len(search.repos) >= SEARCH_LIMIT


def read_state(*, failed: int, read: int, other_read: int = 0) -> str:
    """The reason for the repositories asked, after the search replied.

    ``read`` counts repositories read in full. ``other_read`` counts repositories
    the search reply already accounted for without asking (pull requests turned
    off), which still show that source control answered.
    """
    if failed == 0:
        return ""
    if read > 0 or other_read > 0:
        return REASON_PARTIAL
    return REASON_READ_FAILED
