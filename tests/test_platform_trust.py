"""The platform-trust endpoint and the settings behind it."""

import pytest
from fastapi.testclient import TestClient

from dmf_cms.main import create_app
from dmf_cms.settings import PlatformTrustSettings, Settings, load_settings

TRUST_ENV = (
    "DMF_CONSOLE_NETWORK_MODE",
    "DMF_CONSOLE_APPROVAL_PAGE_NAME",
    "DMF_CONSOLE_CA_FINGERPRINT_SHA256",
    "DMF_CONSOLE_CA_NOT_AFTER",
)


def _signed_in_client(trust: PlatformTrustSettings) -> TestClient:
    client = TestClient(create_app(Settings(platform_trust=trust)))
    client.get("/auth/login", follow_redirects=False)
    assert client.get("/api/me").status_code == 200
    return client


def test_endpoint_requires_a_signed_in_user():
    client = TestClient(create_app(Settings()))

    response = client.get("/api/platform-trust")

    assert response.status_code == 401


def test_endpoint_returns_every_field_for_a_public_sandbox():
    client = _signed_in_client(
        PlatformTrustSettings(
            network_mode="public",
            approval_page_name="trust.example.invalid",
            ca_fingerprint_sha256="AA:BB:CC",
            ca_not_after="2036-01-01",
        )
    )

    assert client.get("/api/platform-trust").json() == {
        "network_mode": "public",
        "approval_page_name": "trust.example.invalid",
        "ca_fingerprint_sha256": "AA:BB:CC",
        "ca_not_after": "2036-01-01",
        "sandbox": True,
    }


def test_endpoint_reports_a_lan_sandbox():
    client = _signed_in_client(PlatformTrustSettings(network_mode="lan"))

    body = client.get("/api/platform-trust").json()

    assert body["network_mode"] == "lan"
    assert body["sandbox"] is True


def test_endpoint_is_empty_and_not_a_sandbox_when_unset():
    client = _signed_in_client(PlatformTrustSettings())

    assert client.get("/api/platform-trust").json() == {
        "network_mode": "",
        "approval_page_name": "",
        "ca_fingerprint_sha256": "",
        "ca_not_after": "",
        "sandbox": False,
    }


def test_settings_default_to_empty_when_no_variable_is_set(monkeypatch):
    for name in TRUST_ENV:
        monkeypatch.delenv(name, raising=False)

    assert load_settings().platform_trust == PlatformTrustSettings()


def test_settings_read_the_four_variables(monkeypatch):
    monkeypatch.setenv("DMF_CONSOLE_NETWORK_MODE", " Public ")
    monkeypatch.setenv("DMF_CONSOLE_APPROVAL_PAGE_NAME", "trust.example.invalid")
    monkeypatch.setenv("DMF_CONSOLE_CA_FINGERPRINT_SHA256", "AA:BB")
    monkeypatch.setenv("DMF_CONSOLE_CA_NOT_AFTER", "2036-01-01")

    trust = load_settings().platform_trust

    assert trust == PlatformTrustSettings("public", "trust.example.invalid", "AA:BB", "2036-01-01")


def test_settings_reject_an_unknown_network_mode(monkeypatch):
    monkeypatch.setenv("DMF_CONSOLE_NETWORK_MODE", "wan")

    with pytest.raises(ValueError, match="DMF_CONSOLE_NETWORK_MODE"):
        load_settings()
