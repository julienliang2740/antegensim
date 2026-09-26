"""
Built-in assistant (rev 4): one engine with four model profiles (chat, narrator, author,
summarizer) behind ``AssistantService``.  Everything here calls models only through
``empyrean.model.call_model`` (via ``calls.call_profile``), reads runs only through
``RunManager`` / ``storage``, mutates runs only through approved briefs, and meters its spend
in its own ledger (never ``Manifest.real_usage``).

Modules: models (pydantic shapes), service (executors, wiring), calls (the one model-call path),
ledger, store (paths, conversations, settings), engine (chat step loop), prompts, knowledge
(docs sections), tools (read tools), briefs (validation + approval), digest (deterministic
summaries), storybook, story, speech, logbuffer, routes / routes_storybook / routes_story /
routes_speech (FastAPI routers composed by ``routes.build_routers``).
"""
# DOCS: create_app(manager, assistant) includes routes.build_routers(assistant); with assistant=None
# every /api/assistant/* and /api/runs/{id}/assistant/* route answers 503 assistant_unavailable.

from .service import AssistantService

__all__ = ["AssistantService"]
