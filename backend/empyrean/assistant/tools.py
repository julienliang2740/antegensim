"""
Read-only tools the chat profile may call (rev 4, D3): pure functions over storage / manager
views with compact outputs (digests, not raw files), each capped at
``config.ASSISTANT_TOOL_OUTPUT_MAX_CHARS`` with a truncation note.  Tool failures are returned
as ``{"error": ...}`` so the model can recover.  Runs need not be open for history reads; live
tools report "run not open".  OWNER: WP2 (uses digest.py from WP3).
"""
# DOCS: tools: list_runs, get_run_status, get_rules_and_settings, list_turns, get_turn_digest,
# get_round_digest, get_trends, get_agent_dossier, search_events, get_model_call,
# get_decision_packet_summary, get_staged_interventions, get_storybook, search_docs, get_defaults,
# get_server_log (get_context was dropped: step 1 is prefetched).

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover
    from .service import AssistantService

TOOL_NAMES: tuple[str, ...] = (
    "list_runs",
    "get_run_status",
    "get_rules_and_settings",
    "list_turns",
    "get_turn_digest",
    "get_round_digest",
    "get_trends",
    "get_agent_dossier",
    "search_events",
    "get_model_call",
    "get_decision_packet_summary",
    "get_staged_interventions",
    "get_storybook",
    "search_docs",
    "get_defaults",
    "get_server_log",
)


@dataclass
class ToolResult:
    name: str
    args: dict[str, Any]
    ok: bool
    payload: Any  # JSON-serialisable; {"error": str} when not ok
    summary: str  # one line for the UI
    truncated: bool = False
    sources: list[str] | None = None  # "turns r00003_t02_a05", "docs SYSTEM.md#economy"


def tool_catalogue() -> list[dict[str, Any]]:
    """[{name, description, params (JSON schema)}] in a stable order (part of the system prompt)."""
    raise NotImplementedError("WP2 tools.tool_catalogue")


def run_tool(service: "AssistantService", name: str, args: dict[str, Any]) -> ToolResult:
    """Dispatch one tool call; never raises (errors become ``ToolResult(ok=False)``)."""
    raise NotImplementedError("WP2 tools.run_tool")


__all__ = ["TOOL_NAMES", "ToolResult", "run_tool", "tool_catalogue"]
