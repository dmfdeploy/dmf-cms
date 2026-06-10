from dmf_cms.mxl import fetch_status
from dmf_cms.settings import MXLEndpoint


def test_fetch_status_skips_unreachable_endpoints(monkeypatch):
    def fake_get_json(url: str, path: str, timeout: float = 2.0):
        if "reachable" in url:
            return {
                "node": "node-a",
                "preview": True,
                "transport": {"provider": "tcp"},
                "flow": {"id": "flow-1", "format": "Video", "active": True},
            }
        raise TimeoutError("timed out")

    monkeypatch.setattr("dmf_cms.mxl._get_json", fake_get_json)

    data = fetch_status(
        (
            MXLEndpoint(role="source", provider="aliyun", url="http://reachable:9000"),
            MXLEndpoint(role="view", provider="aliyun", url="http://offline:9000"),
        )
    )

    assert data["reachable"] is True
    assert len(data["nodes"]) == 1
    assert data["nodes"][0]["role"] == "source"
    assert data["nodes"][0]["online"] is True
    assert data["flow"]["id"] == "flow-1"
