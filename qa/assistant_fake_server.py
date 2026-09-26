"""QA-only launcher: the served Empyrean backend with every assistant profile on the free
``fake-assistant`` key, plus one test hook so the browser check can script the fake chat model.

Why: the fake adapter answers from ``AssistantService.fake_metadata`` (a test hook the unit tests
set in-process).  ``python -m empyrean.main`` has no way to reach it over HTTP, so with the plain
server the fake chat model only ever returns its deterministic default answer and brief cards can
not be exercised in a browser.  This launcher builds the same app as ``empyrean.main.build_app``
and adds

    GET  /api/_qa/fake_metadata          -> the current per-profile fake metadata
    PUT  /api/_qa/fake_metadata {profile: {...}}  -> replace it (e.g. {"chat": {"fake_script": [step]}})

The chat and summarizer calls merge that metadata themselves; this launcher also merges it into
the story author's and the storybook narrator's calls (their own ``fake_reply`` wins), so
``{"author": {"fake_options": {"sleep_ms": 8000}}}`` makes the author slow enough to see the
working indicator in a browser.

Never use it against real data: it forces the fake assistant keys and a QA worlds dir.

Usage (from the repo root):
    EMPYREAN_API_PORT=8020 EMPYREAN_WORLDS_DIR=qa/worlds-assistant \
        backend/../.venv/bin/python qa/assistant_fake_server.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
FAKE = "fake-assistant"
for profile in ("CHAT", "NARRATOR", "AUTHOR", "SUMMARIZER"):
    os.environ[f"EMPYREAN_ASSISTANT_MODEL_{profile}"] = FAKE  # forced: this launcher never spends
os.environ["EMPYREAN_DEFAULT_MODEL"] = "fake-heuristic"  # forced: runs created from the defaults never use a paid agent model
os.environ.setdefault("EMPYREAN_WHISPER_PRELOAD", "0")
os.environ.setdefault("EMPYREAN_API_PORT", "8020")
os.environ.setdefault("EMPYREAN_WORLDS_DIR", str(REPO / "qa" / "worlds-assistant"))
sys.path.insert(0, str(REPO / "backend"))

import logging  # noqa: E402

import uvicorn  # noqa: E402
from fastapi import Body  # noqa: E402

from empyrean import config  # noqa: E402
from empyrean.main import build_app  # noqa: E402


def main() -> None:
    """Build the served app, add the fake-metadata hook, serve on EMPYREAN_API_PORT."""
    logging.basicConfig(level="INFO")
    app = build_app(whisper_preload=False)
    assistant = app.state.assistant
    if assistant is None:
        raise SystemExit("no AssistantService in the app")
    for profile in ("chat", "narrator", "author", "summarizer"):
        if not assistant.profile_is_fake(profile):
            raise SystemExit(f"profile {profile} is not on a fake key; refusing to start")

    def get_fake_metadata() -> dict:
        return assistant.fake_metadata

    def put_fake_metadata(body: dict = Body(...)) -> dict:
        assistant.fake_metadata.clear()
        assistant.fake_metadata.update({k: v for k, v in body.items() if isinstance(v, dict)})
        return assistant.fake_metadata

    plain_call_profile = assistant.call_profile

    def call_profile(profile: str, **kwargs):  # noqa: ANN202 - same signature as AssistantService.call_profile
        extra = assistant.fake_metadata.get(profile) if profile in ("author", "narrator") else None
        if extra:
            kwargs["metadata"] = {**extra, **(kwargs.get("metadata") or {})}
        return plain_call_profile(profile, **kwargs)

    assistant.call_profile = call_profile

    app.add_api_route("/api/_qa/fake_metadata", get_fake_metadata, methods=["GET"])
    app.add_api_route("/api/_qa/fake_metadata", put_fake_metadata, methods=["PUT"])
    logging.getLogger("empyrean").info("QA fake-assistant backend on %s:%s, worlds %s", config.API_HOST, config.API_PORT, config.WORLDS_DIR)
    uvicorn.run(app, host=config.API_HOST, port=config.API_PORT, log_level="info")


if __name__ == "__main__":
    main()
