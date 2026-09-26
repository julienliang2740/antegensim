"""
Process entry point: ``cd backend && python -m empyrean.main``.

* ``.env`` at the repository root is loaded by ``empyrean.config`` at import
  time (python-dotenv, never overriding variables already in the environment,
  empty values ignored), so ``EMPYREAN_*`` options take effect.  Secret values
  are only ever read by ``model.py`` adapters through ``os.environ``; nothing
  here prints them.
* Builds the model registry, the RunManager, the AssistantService (rev 4;
  ``auto_live_allowed=True`` here and only here: unrequested paid generation such
  as storybook auto is allowed in the served process, never in tests or headless
  runs) and the FastAPI app.  When ``config.WHISPER_PRELOAD`` the Whisper preload
  thread starts here (``model.preload_whisper`` on a daemon thread).
* Serves with uvicorn on ``EMPYREAN_API_HOST``:``EMPYREAN_API_PORT`` (default
  127.0.0.1:8000).  The Vite dev server (5173/5174) is allowed by CORS and the
  Vite config also proxies ``/api`` to this port.
"""

from __future__ import annotations

import logging
import os
import threading

from . import config  # loads .env first
from . import model
from .api import create_app
from .assistant import AssistantService
from .model import load_registry
from .runner import RunManager

log = logging.getLogger("empyrean")


def build_app(*, whisper_preload: bool | None = None):
    """Create the served app: registry -> RunManager -> AssistantService(auto_live_allowed=True)
    -> create_app.  ``whisper_preload`` defaults to ``config.WHISPER_PRELOAD``; when on, a daemon
    thread runs ``model.preload_whisper`` so the first Dictate does not pay the cold start.
    Tests build their own app with ``create_app(manager)`` (no assistant, no preload)."""
    registry = load_registry(config.MODELS_FILE)
    manager = RunManager(registry)
    assistant = AssistantService(manager, registry, auto_live_allowed=True)
    app = create_app(manager, assistant)
    if config.WHISPER_PRELOAD if whisper_preload is None else whisper_preload:
        start_whisper_preload()
    return app


def start_whisper_preload() -> threading.Thread:
    """Daemon thread calling ``model.preload_whisper()`` (never raises)."""
    thread = threading.Thread(target=model.preload_whisper, name="whisper-preload", daemon=True)
    thread.start()
    return thread


def main() -> None:
    import uvicorn

    logging.basicConfig(level=os.environ.get("EMPYREAN_LOG_LEVEL") or "INFO")
    logging.getLogger("empyrean").info(
        "starting Empyrean backend on %s:%s (worlds dir %s, models file %s)",
        config.API_HOST,
        config.API_PORT,
        config.WORLDS_DIR,
        config.MODELS_FILE,
    )
    uvicorn.run(build_app(), host=config.API_HOST, port=config.API_PORT, log_level="info")


if __name__ == "__main__":
    main()
