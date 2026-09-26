"""
Chat engine (rev 4, amended D3/D4): per user message up to ``config.ASSISTANT_MAX_STEPS`` model
calls on the chat executor; step 1 is prefetched with deterministic context; a tool step runs up
to 3 read tools whose nonce-fenced results feed the next step; the last step gets the restricted
answer|ask schema; malformed JSON goes through ``calls.salvage`` then one repair step; a brief
step is validated by ``briefs`` before it is shown; wall clock and message budget are enforced;
the summarizer refreshes the rolling memory after the answer.  OWNER: WP2.
"""
# DOCS: progress line 'step 2/4 · 18 s · $0.03'; answers stamped 'as of turn <id>'; offline
# fallback answers from docs search when no model is available.

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Optional

from .models import ContextChip, JobView, Message

if TYPE_CHECKING:  # pragma: no cover
    from .service import AssistantService


class ChatEngine:
    """Attached as ``service.engine``."""

    def __init__(self, service: "AssistantService") -> None:
        self.service = service
        raise NotImplementedError("WP2 ChatEngine")

    def start_message(self, conv_id: str, text: str, context: Optional[ContextChip], *, in_reply_to_brief_id: Optional[str] = None) -> tuple[Message, Message, JobView]:
        """Append the user message and a pending assistant message, create the job, submit
        ``run_message`` to the chat executor.  Returns (user message, assistant message, job)."""
        raise NotImplementedError("WP2 ChatEngine.start_message")

    def run_message(self, conv_id: str, message_id: str, job_id: str) -> None:
        """The step loop (executor thread).  Never raises; failures land on the message."""
        raise NotImplementedError("WP2 ChatEngine.run_message")

    def prefetch_context(self, chip: Optional[ContextChip]) -> str:
        """Deterministic step-1 context: run status, viewed turn digest, selected entity dossier,
        last round digest, highlights."""
        raise NotImplementedError("WP2 ChatEngine.prefetch_context")

    def offline_answer(self, text: str) -> Message:
        """Docs-search answer labelled 'Docs search (AI offline)'."""
        raise NotImplementedError("WP2 ChatEngine.offline_answer")

    def refresh_memory(self, conv_id: str) -> None:
        """Summarizer profile: rolling summary within ``config.MEMORY_TOKEN_BUDGET``."""
        raise NotImplementedError("WP2 ChatEngine.refresh_memory")


def parse_step(parsed: dict[str, Any], *, restricted: bool) -> Any:
    """``AssistantStep`` / ``RestrictedStep`` validation (raises ``ValidationError``)."""
    raise NotImplementedError("WP2 engine.parse_step")


__all__ = ["ChatEngine", "parse_step"]
