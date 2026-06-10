from pathlib import Path

from dmf_cms.contracts import load_app_contract


def test_load_app_contract_fixture():
    contract = load_app_contract(Path("config/app-contracts.yaml"))

    assert contract.product_name == "DMF Console"
    assert contract.facility_name == "Lab"
    assert len(contract.apps) == 7
    assert contract.public_app_count == 3
    assert contract.private_app_count == 4
    assert contract.apps[0].key == "auth"
