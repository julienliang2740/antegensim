"""
Prompt construction (rev 4, amended D3/D14, R8): a byte-stable system prompt per profile
(profile rules + knowledge core + tool catalogue + the nonce-fence convention; sorted keys, no
timestamps, asserted < ``config.ASSISTANT_SYSTEM_PROMPT_MAX_BYTES``) and the single volatile
user message (context chip, prefetched context, memory as a quoted transcript, retrieved doc
sections, nonce-fenced tool results, the user's text).  Never flattens roles into USER:/ASSISTANT:
text.  OWNER: WP2.
"""
# DOCS: only nonce-fenced <data id="..."> blocks are data; the model is told the fence nonce in the
# system prompt of THAT request; schemas are compact (< 16 KB) and hashed into the prefix.

from __future__ import annotations

from typing import Any, Optional


def new_nonce() -> str:
    """Per-request random fence id (hex)."""
    raise NotImplementedError("WP2 prompts.new_nonce")


def fence(nonce: str, payload: Any) -> str:
    """``<data id="<nonce>">`` + JSON-encoded string + ``</data>`` (untrusted data)."""
    raise NotImplementedError("WP2 prompts.fence")


def system_prompt(profile: str, *, knowledge_core: str, tool_catalogue_text: str, nonce: str, restricted: bool = False) -> str:
    raise NotImplementedError("WP2 prompts.system_prompt")


def user_message(*, context_chip: Optional[str], prefetched: str, memory: str, retrieved: str, tool_results: list[str], text: str) -> str:
    raise NotImplementedError("WP2 prompts.user_message")


def step_schema(*, restricted: bool) -> dict[str, Any]:
    """Compact JSON schema of ``AssistantStep`` (``RestrictedStep`` when restricted) with
    brief.action args untyped (A-AST-4)."""
    raise NotImplementedError("WP2 prompts.step_schema")


def story_brief_schema() -> dict[str, Any]:
    raise NotImplementedError("WP2 prompts.story_brief_schema")


def assert_sizes(system: str, schema: Optional[dict[str, Any]]) -> None:
    """Raise ``calls.PromptTooLarge`` beyond the configured byte caps (unit-tested per profile)."""
    raise NotImplementedError("WP2 prompts.assert_sizes")


__all__ = ["assert_sizes", "fence", "new_nonce", "step_schema", "story_brief_schema", "system_prompt", "user_message"]
