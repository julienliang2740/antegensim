"""
Shared pytest fixtures for the Empyrean backend.

Run with:  cd backend && ../.venv/bin/pytest -q

Every test writes run data under a temporary worlds directory (never the
repository's worlds/), uses the fake model adapters only unless marked
``live``, and never reads ``.env``.  Tests that need a live provider must
be marked ``@pytest.mark.live`` and are skipped by default.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


def pytest_configure(config):  # type: ignore[no-untyped-def]
    config.addinivalue_line("markers", "live: needs a configured real provider; skipped unless EMPYREAN_LIVE_TESTS=1")
    config.addinivalue_line("markers", "whisper: runs local faster-whisper; skipped unless the model is cached locally (never downloads)")


def pytest_collection_modifyitems(config, items):  # type: ignore[no-untyped-def]
    if os.environ.get("EMPYREAN_LIVE_TESTS") == "1":
        return
    skip = pytest.mark.skip(reason="live provider test; set EMPYREAN_LIVE_TESTS=1 to run")
    for item in items:
        if "live" in item.keywords:
            item.add_marker(skip)


@pytest.fixture()
def worlds_dir(tmp_path, monkeypatch):
    """Point storage at a temporary worlds directory."""
    from empyrean import config, storage

    target = tmp_path / "worlds"
    target.mkdir()
    monkeypatch.setattr(config, "WORLDS_DIR", target)
    monkeypatch.setattr(storage, "WORLDS_DIR", target, raising=False)
    return target


@pytest.fixture()
def registry():
    """Model registry containing at least the three fake models."""
    from empyrean.model import load_registry

    return load_registry()


@pytest.fixture()
def default_request():
    """Default RunCreateRequest with 8 fake-heuristic agents and seed 1."""
    from empyrean.config import default_run_request

    return default_run_request("fake-heuristic")


@pytest.fixture()
def rules():
    from empyrean.config import default_rules

    return default_rules()


@pytest.fixture()
def world(default_request, rules):
    """A generated round-0 WorldState (requires world.generate_world)."""
    from empyrean.world import generate_world

    return generate_world(default_request.world, rules, default_request.seed, default_request.agents)


@pytest.fixture()
def manager(worlds_dir, registry):
    """A RunManager writing to the temporary worlds dir."""
    from empyrean.runner import RunManager

    m = RunManager(registry)
    yield m
    m.shutdown()


@pytest.fixture()
def client(manager):
    """FastAPI TestClient bound to a fresh app and manager."""
    from fastapi.testclient import TestClient

    from empyrean.api import create_app

    app = create_app(manager)
    with TestClient(app) as c:
        yield c


# ---------------------------------------------------------------------------
# QA end-to-end fixtures (tests/test_e2e_*.py; helpers in tests/e2e_support.py)
# ---------------------------------------------------------------------------


@pytest.fixture()
def no_retry_sleep(monkeypatch):
    """Model retries without backoff sleeps, so a fake scheduled timeout (three attempts)
    costs milliseconds.  Patches the documented schedule (config.RETRY_BACKOFF_SECONDS)
    and model.py's backoff sleep hook."""
    from empyrean import config, model

    monkeypatch.setattr(config, "RETRY_BACKOFF_SECONDS", [0.0])
    monkeypatch.setattr(config, "RETRY_AFTER_MAX_SECONDS", 0.0)
    monkeypatch.setattr(model, "_sleep", lambda seconds: None, raising=False)


@pytest.fixture()
def api(client, worlds_dir, no_retry_sleep):
    """JSON helper around the ``client`` fixture (see tests/e2e_support.py)."""
    from e2e_support import E2EApi

    return E2EApi(client, worlds_dir)


# ---------------------------------------------------------------------------
# Assistant fixtures (tests/test_assistant_*.py; rev 4).  Every assistant test uses the
# ``fake-assistant`` model key; the guard below fails any assistant test that reaches the
# Claude CLI adapter.
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _never_live_in_assistant_tests(request, monkeypatch):
    """Fail any test in a test_assistant_* module that reaches ``ClaudeCliAdapter.attempt``
    (the only live route on this machine).  Other modules keep their own fake_cli fixtures."""
    if not Path(str(request.node.fspath)).name.startswith("test_assistant"):
        yield
        return
    from empyrean import model

    def forbidden(self, ref, req, attempt_no, **kwargs):  # noqa: ARG001
        raise AssertionError(f"live adapter reached in an assistant test (model key {ref.key})")

    monkeypatch.setattr(model.ClaudeCliAdapter, "attempt", forbidden)
    yield


@pytest.fixture()
def assistant(manager, worlds_dir):
    """An ``AssistantService`` over the temporary worlds dir with ``fake-assistant`` wired for all
    four profiles (auto_live_allowed stays False).  Tests feed scripts through
    ``assistant.fake_metadata[profile]``."""
    from empyrean.assistant import AssistantService

    service = AssistantService(manager, worlds_dir=worlds_dir)
    for profile in service.profile_keys:
        service.profile_keys[profile] = "fake-assistant"
    if service.engine is not None:
        service.engine.reset_prompts()
    yield service
    service.shutdown()


@pytest.fixture()
def assistant_client(manager, assistant):
    """TestClient of ``create_app(manager, assistant)``."""
    from fastapi.testclient import TestClient

    from empyrean.api import create_app

    app = create_app(manager, assistant)
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def assistant_api(assistant_client, worlds_dir, no_retry_sleep):
    """``E2EApi`` over the assistant-enabled client (run creation and commands)."""
    from e2e_support import E2EApi

    return E2EApi(assistant_client, worlds_dir)
