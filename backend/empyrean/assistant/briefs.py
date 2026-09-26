"""
Execution briefs (rev 4, amended D6, A-AST-9): validation before the card is shown (never opens a
run), the deterministic setup diff and warnings, the approve path (conversation lock, CAS
pending->executing, revalidation, server-side execution, stored idempotent effect) and the
executors per action, including the step_round sequencer job.  Uses ``runner.command_allowed``
and ``runner.validate_intervention_on``.  OWNER: WP2.
"""
# DOCS: approval body {validated_against_turn_id}; run_command briefs are approvable only while
# that run is on screen; create_run opens the new run paused and rebinds the conversation.

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Optional

from ..schemas import RunCreateRequest
from .models import Brief, BriefDraft, BriefEffect, BriefValidation, SetupDiffEntry

if TYPE_CHECKING:  # pragma: no cover
    from .service import AssistantService


def deep_merge(base: Any, overlay: Any) -> Any:
    """Dicts merge recursively, everything else replaces (shared with scripts/run_sim.py)."""
    if isinstance(base, dict) and isinstance(overlay, dict):
        merged = dict(base)
        for key, value in overlay.items():
            merged[key] = deep_merge(base.get(key), value) if key in base else value
        return merged
    return overlay


def merge_create_run(service: "AssistantService", name: str, agent_count: int, overlay: dict[str, Any]) -> RunCreateRequest:
    """``config.default_run_request(chat-independent default model, agent_count)`` + overlay;
    agent cards merge by index, extra cards are dropped."""
    raise NotImplementedError("WP2 briefs.merge_create_run")


def setup_diff(request: RunCreateRequest) -> list[SetupDiffEntry]:
    """Non-default fields vs ``config.default_run_request`` (paths like ``agents[2].stats.attack``)."""
    raise NotImplementedError("WP2 briefs.setup_diff")


def validate_brief(service: "AssistantService", draft: BriefDraft, *, run_id_hint: Optional[str]) -> tuple[Optional[Any], BriefValidation]:
    """Envelope -> typed action (or None with the problems) -> deterministic problems, warnings
    (budget clear/increase, paid model, live model without real_budget_usd, spend so far) and
    setup diff.  Never opens a run (open worker's committed checkpoint, else
    ``storage.load_checkpoint`` read-only)."""
    raise NotImplementedError("WP2 briefs.validate_brief")


def approve_brief(service: "AssistantService", conv_id: str, brief_id: str, validated_against_turn_id: Optional[str]) -> Brief:
    """Under the conversation lock: CAS pending->executing (409 brief_not_pending), revalidate
    (new problems -> back to pending), execute, store the effect (idempotent on retry)."""
    raise NotImplementedError("WP2 briefs.approve_brief")


def reject_brief(service: "AssistantService", conv_id: str, brief_id: str, reason: str = "") -> Brief:
    raise NotImplementedError("WP2 briefs.reject_brief")


def execute_action(service: "AssistantService", brief: Brief) -> BriefEffect:
    """create_run (opens paused), run_command (+ sequencer job for rounds), stage_interventions
    (origin 'assistant', all-or-nothing), create_continuation, update_assistant_settings;
    open_run is UI-only."""
    raise NotImplementedError("WP2 briefs.execute_action")


__all__ = ["approve_brief", "deep_merge", "execute_action", "merge_create_run", "reject_brief", "setup_diff", "validate_brief"]
