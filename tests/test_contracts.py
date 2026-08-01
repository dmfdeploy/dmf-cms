from pathlib import Path

import pytest
import yaml

from dmf_cms.contracts import load_app_contract


def test_load_app_contract_fixture():
    contract = load_app_contract(Path("config/app-contracts.yaml"))

    assert contract.product_name == "DMF Console"
    assert contract.facility_name == "Lab"
    assert len(contract.apps) == 7
    assert contract.public_app_count == 3
    assert contract.private_app_count == 4
    assert contract.apps[0].key == "auth"


def test_shipped_contract_declares_where_every_service_runs():
    """The Facility Detail page looks for each service's containers in the
    namespace declared here (umbrella #339 item 1). An entry that ships
    without a `cluster:` block is never claimed absent — it renders as
    unchecked, which is honest but useless, so the shipped config must
    actually declare all 7. The namespace values mirror dmf-infra's role
    defaults; see the YAML's own comment."""
    contract = load_app_contract(Path("config/app-contracts.yaml"))
    declared = {a.key: (a.cluster_namespace, a.cluster_image_repositories) for a in contract.apps}
    assert declared == {
        "auth": ("authentik", ("goauthentik/server",)),
        # Deliberately NOT ansible/awx-operator or ansible/awx-ee, which share
        # the namespace and are not AWX's own version (GATE-A P1).
        "awx": ("awx", ("ansible/awx",)),
        "forgejo": ("forgejo", ("forgejo/forgejo",)),
        # `monitoring` is shared with prometheus, loki, promtail and promsd.
        "grafana": ("monitoring", ("grafana/grafana",)),
        "librenms": ("librenms", ("librenms/librenms",)),
        "netbox": ("netbox", ("netboxcommunity/netbox",)),
        # dmf-infra pins the arch in the image name and does not template it.
        "registry": ("zot", ("project-zot/zot-linux-arm64", "project-zot/zot-linux-amd64")),
    }


def test_cluster_block_without_a_namespace_is_rejected(tmp_path):
    """Half a declaration is worse than none: it would look declared while
    searching nowhere, so it fails the load instead of shipping."""
    path = tmp_path / "contract.yaml"
    path.write_text(
        yaml.safe_dump(
            {
                "apps": [
                    {
                        "key": "auth",
                        "display_name": "Authentik",
                        "lane": "public",
                        "summary": "Identity provider.",
                        "cluster": {"image_repositories": ["goauthentik/server"]},
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="requires a namespace"):
        load_app_contract(path)


def test_cluster_block_without_image_repositories_is_rejected(tmp_path):
    """A namespace with nothing to match would report every neighbouring
    container as this service's own version — the misattribution GATE-A P1
    exists to stop."""
    path = tmp_path / "contract.yaml"
    path.write_text(
        yaml.safe_dump(
            {
                "apps": [
                    {
                        "key": "auth",
                        "display_name": "Authentik",
                        "lane": "public",
                        "summary": "Identity provider.",
                        "cluster": {"namespace": "authentik"},
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="non-empty image_repositories"):
        load_app_contract(path)


def test_entry_without_a_cluster_block_still_loads(tmp_path):
    """Optional, deliberately: an undeclared service is reported as unchecked
    rather than blocking the whole contract from loading."""
    path = tmp_path / "contract.yaml"
    path.write_text(
        yaml.safe_dump(
            {
                "apps": [
                    {
                        "key": "auth",
                        "display_name": "Authentik",
                        "lane": "public",
                        "summary": "Identity provider.",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    entry = load_app_contract(path).apps[0]
    assert (entry.cluster_namespace, entry.cluster_image_repositories) == (None, ())
