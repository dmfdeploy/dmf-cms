import pytest

from dmf_cms import media_workloads


def _reset() -> None:
    reset = getattr(media_workloads, "_reset_read_grace", None)
    if reset is not None:
        reset()


@pytest.fixture(autouse=True)
def _fresh_media_workloads_read_grace():
    """The last-good inventory cache is process-wide; keep tests independent."""
    _reset()
    yield
    _reset()
