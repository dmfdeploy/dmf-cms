"""Forgejo API client — repositories, commits, and pull requests."""

from __future__ import annotations

import json
import urllib.parse
import urllib.request
import urllib.error


class ForgejoAPIError(Exception):
    """Raised when the Forgejo API returns a non-2xx response."""

    def __init__(self, status: int, body: str) -> None:
        self.status = status
        self.body = body
        super().__init__(f"Forgejo API {status}: {body}")


def _request(
    api_url: str,
    api_token: str,
    method: str,
    path: str,
) -> dict | list:
    """Make an authenticated JSON request to the Forgejo API."""
    url = api_url.rstrip("/") + path
    headers = {
        "Authorization": f"token {api_token}",
        "Accept": "application/json",
    }
    req = urllib.request.Request(url, headers=headers, method=method)

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode() if exc.fp else str(exc)
        raise ForgejoAPIError(exc.code, error_body) from exc


def list_repos(
    *,
    api_url: str,
    api_token: str,
) -> list[dict]:
    """List all repositories visible to the service account."""
    return _request(api_url, api_token, "GET", "/api/v1/repos/search?limit=50")


def list_commits(
    *,
    api_url: str,
    api_token: str,
    owner: str,
    repo: str,
    limit: int = 20,
) -> list[dict]:
    """List recent commits in a repository."""
    return _request(
        api_url,
        api_token,
        "GET",
        f"/api/v1/repos/{urllib.parse.quote(owner)}/{urllib.parse.quote(repo)}/commits?limit={limit}",
    )


def list_pulls(
    *,
    api_url: str,
    api_token: str,
    owner: str,
    repo: str,
    state: str = "open",
) -> list[dict]:
    """List pull requests in a repository."""
    return _request(
        api_url,
        api_token,
        "GET",
        f"/api/v1/repos/{urllib.parse.quote(owner)}/{urllib.parse.quote(repo)}/pulls?state={state}&limit=20",
    )
