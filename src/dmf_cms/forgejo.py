"""Forgejo API client — repositories, commits, and pull requests.

The client tells three outcomes of a call apart, because the console words
them differently:

* ``ForgejoNoAnswer``: no HTTP response arrived. Only the ``urlopen`` call can
  raise it.
* ``ForgejoAPIError``: a response arrived with an HTTP error status.
* ``ForgejoReadFailed``: a response arrived, but its body is unusable. The body
  read broke off, or the body is empty, is not JSON, or has the wrong shape.

Everything a caller later reads from a reply is validated here first, so the
routes never half-convert a list.
"""

from __future__ import annotations

import http.client
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import NamedTuple

# The search asks for this many repositories. A reply that fills the page may
# have left more behind.
SEARCH_LIMIT = 50

_TOTAL_HEADER = "X-Total-Count"
_DIGITS = re.compile(r"[0-9]+")


class ForgejoAPIError(Exception):
    """Raised when the Forgejo API returns a non-2xx response."""

    def __init__(self, status: int, body: str) -> None:
        self.status = status
        self.body = body
        super().__init__(f"Forgejo API {status}: {body}")


class ForgejoNoAnswer(Exception):
    """No HTTP response arrived: refused, timed out, DNS or handshake failure."""


class ForgejoReadFailed(Exception):
    """A response arrived, but no usable body: cut short, not JSON, or wrong shape."""


class RepoSearch(NamedTuple):
    """The search reply: its repositories and the validated total, if any."""

    repos: list[dict]
    total: int | None


def _request_with_headers(
    api_url: str,
    api_token: str,
    method: str,
    path: str,
) -> tuple[dict | list, object]:
    """Make an authenticated JSON request. Return the decoded body and headers."""
    url = api_url.rstrip("/") + path
    headers = {
        "Authorization": f"token {api_token}",
        "Accept": "application/json",
    }
    req = urllib.request.Request(url, headers=headers, method=method)

    # Only this call can prove that no reply arrived.
    try:
        resp = urllib.request.urlopen(req, timeout=30)
    except urllib.error.HTTPError as exc:
        raise ForgejoAPIError(exc.code, _error_body(exc)) from exc
    except (urllib.error.URLError, OSError, http.client.HTTPException) as exc:
        raise ForgejoNoAnswer(str(exc)) from exc

    try:
        with resp:
            raw = resp.read()
            reply_headers = getattr(resp, "headers", None)
        if not raw:
            raise ForgejoReadFailed("empty reply body")
        return json.loads(raw), reply_headers
    except ForgejoReadFailed:
        raise
    except (OSError, http.client.HTTPException, ValueError) as exc:
        raise ForgejoReadFailed(f"reply body unusable: {exc}") from exc


def _error_body(exc: urllib.error.HTTPError) -> str:
    """The error response's body, or an empty string when it cannot be read."""
    try:
        return exc.read().decode() if exc.fp else str(exc)
    except (OSError, http.client.HTTPException, ValueError):
        return ""


def _request(
    api_url: str,
    api_token: str,
    method: str,
    path: str,
) -> dict | list:
    """Make an authenticated JSON request to the Forgejo API."""
    return _request_with_headers(api_url, api_token, method, path)[0]


def _validated_total(headers: object, returned: int) -> int | None:
    """The ``X-Total-Count`` value, or None when it is absent or cannot be trusted.

    A value is trusted when exactly one header carries it, it is a plain
    non-negative integer, and it is not below the number of repositories
    returned.
    """
    get_all = getattr(headers, "get_all", None)
    if get_all is None:
        return None
    values = get_all(_TOTAL_HEADER) or []
    if len(values) != 1:
        return None
    text = str(values[0]).strip()
    if not _DIGITS.fullmatch(text):
        return None
    total = int(text)
    return total if total >= returned else None


def _is_str(value: object) -> bool:
    return isinstance(value, str)


def _string_fields(item: dict, names: tuple[str, ...], where: str) -> None:
    """Absent is fine. A present field must be a string (null is not a string)."""
    for name in names:
        if name in item and not _is_str(item[name]):
            raise ForgejoReadFailed(f"{where}: {name} is not a string")


def _object_field(item: dict, name: str, where: str) -> dict:
    """Absent reads as an empty object. A present field must be an object."""
    if name not in item:
        return {}
    value = item[name]
    if not isinstance(value, dict):
        raise ForgejoReadFailed(f"{where}: {name} is not an object")
    return value


def _validate_search(reply: object) -> list[dict]:
    if not isinstance(reply, dict) or reply.get("ok") is not True:
        raise ForgejoReadFailed("repository search reply indicates failure")
    data = reply.get("data")
    if not isinstance(data, list):
        raise ForgejoReadFailed("repository search reply has no data list")
    for element in data:
        if not isinstance(element, dict):
            raise ForgejoReadFailed("repository search element is not an object")
        for name in ("full_name", "name"):
            value = element.get(name)
            if not _is_str(value) or not value:
                raise ForgejoReadFailed(f"repository search element has no usable {name}")
        flag = element.get("has_pull_requests")
        if flag is not None and not isinstance(flag, bool):
            raise ForgejoReadFailed("repository search element has a non-boolean has_pull_requests")
    return data


def list_repos(
    *,
    api_url: str,
    api_token: str,
) -> RepoSearch:
    """List repositories visible to the service account, with the search total.

    Forgejo's search endpoint wraps the list: ``{"ok": true, "data": [...]}``.
    Any malformed element fails the whole reply, so no caller uses part of it.
    """
    reply, headers = _request_with_headers(
        api_url, api_token, "GET", f"/api/v1/repos/search?limit={SEARCH_LIMIT}"
    )
    repos = _validate_search(reply)
    return RepoSearch(repos=repos, total=_validated_total(headers, len(repos)))


def _validate_commits(reply: object) -> list[dict]:
    if not isinstance(reply, list):
        raise ForgejoReadFailed("commits reply is not a list")
    for item in reply:
        if not isinstance(item, dict):
            raise ForgejoReadFailed("commits reply has a non-object item")
        _string_fields(item, ("sha", "html_url"), "commit")
        commit = _object_field(item, "commit", "commit")
        _string_fields(commit, ("message",), "commit.commit")
        author = _object_field(commit, "author", "commit.commit")
        _string_fields(author, ("name", "date"), "commit.commit.author")
    return reply


def list_commits(
    *,
    api_url: str,
    api_token: str,
    owner: str,
    repo: str,
    limit: int = 20,
) -> list[dict]:
    """List recent commits in a repository."""
    return _validate_commits(
        _request(
            api_url,
            api_token,
            "GET",
            f"/api/v1/repos/{urllib.parse.quote(owner)}/{urllib.parse.quote(repo)}/commits?limit={limit}",
        )
    )


def _validate_pulls(reply: object) -> list[dict]:
    if not isinstance(reply, list):
        raise ForgejoReadFailed("pulls reply is not a list")
    for item in reply:
        if not isinstance(item, dict):
            raise ForgejoReadFailed("pulls reply has a non-object item")
        number = item.get("number")
        # bool is a subclass of int; a boolean is not a pull request number.
        if not isinstance(number, int) or isinstance(number, bool):
            raise ForgejoReadFailed("pull request number is not an integer")
        _string_fields(item, ("title", "state", "created_at", "html_url"), "pull")
        user = _object_field(item, "user", "pull")
        _string_fields(user, ("login",), "pull.user")
    return reply


def list_pulls(
    *,
    api_url: str,
    api_token: str,
    owner: str,
    repo: str,
    state: str = "open",
) -> list[dict]:
    """List pull requests in a repository."""
    return _validate_pulls(
        _request(
            api_url,
            api_token,
            "GET",
            f"/api/v1/repos/{urllib.parse.quote(owner)}/{urllib.parse.quote(repo)}/pulls?state={state}&limit=20",
        )
    )
