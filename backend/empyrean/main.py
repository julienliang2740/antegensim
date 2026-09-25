"""
Process entry point: ``cd backend && python -m empyrean.main``.

* ``.env`` at the repository root is loaded by ``empyrean.config`` at import
  time (python-dotenv, never overriding variables already in the environment,
  empty values ignored), so ``EMPYREAN_*`` options take effect.  Secret values
  are only ever read by ``model.py`` adapters through ``os.environ``; nothing
  here prints them.
* Builds the model registry, the RunManager and the FastAPI app.
* Serves with uvicorn on ``EMPYREAN_API_HOST``:``EMPYREAN_API_PORT`` (default
  127.0.0.1:8000).  The Vite dev server (5173/5174) is allowed by CORS and the
  Vite config also proxies ``/api`` to this port.
"""

from __future__ import annotations

import logging
import os

from . import config  # loads .env first
from .api import create_app
from .model import load_registry
from .runner import RunManager


def build_app():
    """Create the app (used by uvicorn and by tests)."""
    registry = load_registry(config.MODELS_FILE)
    manager = RunManager(registry)
    app = create_app(manager)
    return app


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
