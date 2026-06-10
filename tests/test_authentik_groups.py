"""add_user_to_group must PATCH the full member list, not POST add_users.

Authentik's group detail endpoint returns 405 for POST/add_users; membership is
set by PATCHing the `users` list. This pins the fixed behaviour.
"""

from dmf_cms import authentik


def test_add_user_to_group_patches_full_member_list(monkeypatch):
    calls = []

    def fake_request(api_url, api_token, method, path, body=None):
        calls.append((method, path, body))
        if method == "GET" and path.startswith("/api/v3/core/groups/?"):
            return {"results": [{"name": "dmf-console-admin", "pk": 5}]}
        if method == "GET" and path.startswith("/api/v3/core/users/"):
            return {"results": [{"username": "lorenz", "pk": 7}]}
        if method == "GET" and path == "/api/v3/core/groups/5/?page_size=100":
            return {"users": [{"pk": 3}]}  # existing member
        return {}

    monkeypatch.setattr(authentik, "_request", fake_request)
    added = authentik.add_user_to_group(
        api_url="http://authentik-server.authentik.svc.cluster.local",
        api_token="t",
        username="lorenz",
        group_name="dmf-console-admin",
    )
    assert added is True
    method, path, body = calls[-1]
    assert method == "PATCH"                      # not POST
    assert path == "/api/v3/core/groups/5/"
    assert "add_users" not in body               # the 405 shape is gone
    assert sorted(body["users"]) == [3, 7]        # existing + new, as ints


def test_add_user_to_group_noop_when_already_member(monkeypatch):
    def fake_request(api_url, api_token, method, path, body=None):
        if method == "GET" and path.startswith("/api/v3/core/groups/?"):
            return {"results": [{"name": "g", "pk": 1}]}
        if method == "GET" and path.startswith("/api/v3/core/users/"):
            return {"results": [{"username": "u", "pk": 7}]}
        if method == "GET" and path == "/api/v3/core/groups/1/?page_size=100":
            return {"users": [{"pk": 7}]}  # already a member
        raise AssertionError("must not write when already a member")

    monkeypatch.setattr(authentik, "_request", fake_request)
    assert authentik.add_user_to_group(
        api_url="x", api_token="t", username="u", group_name="g"
    ) is False
