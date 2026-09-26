"""
Deterministic digests of run history (rev 4): compact, model-free summaries that the read tools,
the storybook narrator and Story Mode all build on, computed from storage / manager views only.
A digest never invents intent: agent thoughts are quoted as beliefs, killers come from damage
events, lost turns (malformed / skipped) are stated as such.  OWNER: WP3.
"""
# DOCS: digests are the single source for "what happened" text in tools, storybook and story;
# every number in them comes from stored events / records, never from a model.

from __future__ import annotations

from typing import Any, Optional

from .models import StoryRunCard


def turn_digest(run_id: str, turn_id: str, *, max_chars: int = 2000) -> dict[str, Any]:
    """{turn_id, kind, round, actor, decision_source, action, result, thought (belief), events[],
    deaths[], messages[], lost: bool, text} for one committed turn."""
    raise NotImplementedError("WP3 digest.turn_digest")


def round_digest(run_id: str, round_no: int, *, detail: str = "normal") -> dict[str, Any]:
    """Per-round summary: order, actions by agent, deaths/kills, resources, notable events."""
    raise NotImplementedError("WP3 digest.round_digest")


def last_round_digest(run_id: str) -> dict[str, Any]:
    raise NotImplementedError("WP3 digest.last_round_digest")


def agent_dossier(run_id: str, agent_id: str, turn_id: Optional[str] = None) -> dict[str, Any]:
    """Operator truth (stats, position, alive, kills, deaths) and the agent's own beliefs
    (notebook, believed self) labelled separately."""
    raise NotImplementedError("WP3 digest.agent_dossier")


def trends(run_id: str, last_n_rounds: int = 5) -> dict[str, Any]:
    """Population, compute/essence totals, deaths, messages per round for the last N rounds."""
    raise NotImplementedError("WP3 digest.trends")


def get_highlights(run_id: str, *, from_turn_id: Optional[str] = None, to_turn_id: Optional[str] = None, limit: int = 10) -> list[dict[str, Any]]:
    """Salience-ranked notable events (deaths, kills, first messages, skill saves, starvation ...)."""
    raise NotImplementedError("WP3 digest.get_highlights")


def run_card(run_id: str) -> StoryRunCard:
    """Story Mode step 0 (deterministic): cast, rounds, deaths/kills, highlights, suggested picks."""
    raise NotImplementedError("WP3 digest.run_card")


def digest_sha(payload: Any) -> str:
    """Stable sha256 prefix of a digest (StorybookEntry.digest_sha)."""
    raise NotImplementedError("WP3 digest.digest_sha")


__all__ = ["agent_dossier", "digest_sha", "get_highlights", "last_round_digest", "round_digest", "run_card", "trends", "turn_digest"]
