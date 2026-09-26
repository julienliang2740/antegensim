"""
Assistant spend ledger (rev 4, A-AST-2): one ``usage.jsonl`` per scope (run id or "global"),
appended under a per-scope lock, aggregated on read (cached by file size).  Never touches
``Manifest.real_usage``.  Prices: the CLI-reported ``provider_cost_usd`` when present, else a
list-price estimate from tokens (``config.ASSISTANT_PRICES`` by ``response_model`` prefix,
``cost_estimated=True``).  OWNER: WP2.
"""
# DOCS: spend is a list-price estimate; usage.jsonl is the only source of truth; budgets are
# checked BEFORE a call with spent + ASSISTANT_CALL_COST_ESTIMATE_USD (R1); ledger files live at
# <worlds>/_assistant/usage.jsonl (global) and <run>/assistant/usage.jsonl (per run).

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Optional

from .. import config
from ..schemas import ModelUsage
from .models import GLOBAL_SCOPE, BudgetView, LedgerAggregate, LedgerLine, ProfileSpend


class BudgetExceeded(Exception):
    """Raised by ``check_budget`` (routes map it to 409 ``assistant_budget_exhausted``)."""

    def __init__(self, view: BudgetView) -> None:
        super().__init__(f"{view.kind} budget of ${view.limit_usd:.2f} for {view.scope} is exhausted (spent ${view.spent_usd:.2f})")
        self.view = view


def price_for(response_model: Optional[str]) -> tuple[float, float, float, float]:
    """(input, cache_read, cache_write, output) USD per Mtok for the served model: the longest
    ``config.ASSISTANT_PRICES`` prefix of ``response_model``, else ``ASSISTANT_PRICE_FALLBACK``."""
    if response_model:
        best = ""
        for prefix in config.ASSISTANT_PRICES:
            if response_model.startswith(prefix) and len(prefix) > len(best):
                best = prefix
        if best:
            return config.ASSISTANT_PRICES[best]
    return config.ASSISTANT_PRICE_FALLBACK


def estimate_cost_usd(usage: ModelUsage, response_model: Optional[str]) -> float:
    """List-price estimate of one call from its normalised usage (input tokens are the UNCACHED
    part; cache reads and writes are priced separately)."""
    p_in, p_read, p_write, p_out = price_for(response_model)
    return (usage.input_tokens * p_in + usage.cache_read_tokens * p_read + usage.cache_creation_tokens * p_write + usage.output_tokens * p_out) / 1_000_000.0


class Ledger:
    """Append-only per-scope ledger with cached aggregates.  ``path_for(scope)`` is injected by
    the store (global vs run folder); a missing file aggregates to zero."""

    def __init__(self, path_for: "callable[[str], Path]") -> None:
        self._path_for = path_for
        self._locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()
        self._cache: dict[str, tuple[int, LedgerAggregate]] = {}  # scope -> (file size, aggregate)

    def _lock(self, scope: str) -> threading.Lock:
        with self._locks_guard:
            lock = self._locks.get(scope)
            if lock is None:
                lock = self._locks[scope] = threading.Lock()
            return lock

    def append(self, line: LedgerLine) -> LedgerAggregate:
        """Append one line (creating the folder) and return the scope's new aggregate."""
        path = self._path_for(line.scope)
        with self._lock(line.scope):
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(line.model_dump(mode="json"), ensure_ascii=False, sort_keys=True) + "\n")
            self._cache.pop(line.scope, None)
            return self._aggregate_locked(line.scope, path)

    def _path(self, scope: str) -> Optional[Path]:
        """The scope's file, or None when the scope cannot be resolved (unknown run): reads
        then aggregate to zero; only ``append`` raises for it."""
        try:
            return self._path_for(scope)
        except Exception:  # noqa: BLE001 - storage.StorageError for an unknown run
            return None

    def aggregate(self, scope: str) -> LedgerAggregate:
        path = self._path(scope)
        if path is None:
            return LedgerAggregate()
        with self._lock(scope):
            return self._aggregate_locked(scope, path)

    def _aggregate_locked(self, scope: str, path: Path) -> LedgerAggregate:
        try:
            size = path.stat().st_size
        except OSError:
            return LedgerAggregate()
        cached = self._cache.get(scope)
        if cached is not None and cached[0] == size:
            return cached[1]
        agg = LedgerAggregate()
        with path.open("r", encoding="utf-8") as fh:
            for raw in fh:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    line = LedgerLine.model_validate(json.loads(raw))
                except Exception:  # noqa: BLE001 - a torn last line never breaks accounting
                    continue
                _add(agg, line)
        self._cache[scope] = (size, agg)
        return agg

    def lines(self, scope: str, limit: Optional[int] = None) -> list[LedgerLine]:
        """The scope's lines in order (last ``limit`` when given)."""
        path = self._path(scope)
        out: list[LedgerLine] = []
        if path is None:
            return out
        try:
            with path.open("r", encoding="utf-8") as fh:
                for raw in fh:
                    raw = raw.strip()
                    if raw:
                        try:
                            out.append(LedgerLine.model_validate(json.loads(raw)))
                        except Exception:  # noqa: BLE001
                            continue
        except OSError:
            return []
        return out[-limit:] if limit else out

    def spent(self, scope: str, profile: Optional[str] = None) -> float:
        agg = self.aggregate(scope)
        if profile is None:
            return agg.cost_usd
        return agg.by_profile.get(profile, ProfileSpend()).cost_usd

    def budget_view(self, scope: str, kind: str, limit_usd: float, spent_usd: Optional[float] = None) -> BudgetView:
        spent_value = self.spent(scope) if spent_usd is None else spent_usd
        remaining = max(0.0, limit_usd - spent_value)
        return BudgetView(scope=scope, kind=kind, limit_usd=limit_usd, spent_usd=spent_value, remaining_usd=remaining, exhausted=spent_value >= limit_usd)

    def check_budget(self, view: BudgetView, estimate_usd: float = config.ASSISTANT_CALL_COST_ESTIMATE_USD) -> None:
        """Raise ``BudgetExceeded`` when ``spent + estimate`` would pass the limit (R1)."""
        if view.spent_usd + estimate_usd > view.limit_usd:
            raise BudgetExceeded(view)


def _add(agg: LedgerAggregate, line: LedgerLine) -> None:
    agg.calls += 1
    if line.status == "ok":
        agg.ok_calls += 1
    else:
        agg.failed_calls += 1
    agg.input_tokens += line.usage.billed_input_tokens
    agg.cache_read_tokens += line.usage.cache_read_tokens
    agg.output_tokens += line.usage.output_tokens
    agg.cost_usd += line.cost_usd
    if line.cost_estimated:
        agg.estimated_cost_usd += line.cost_usd
    spend = agg.by_profile.setdefault(line.profile, ProfileSpend())
    spend.calls += 1
    spend.cost_usd += line.cost_usd


def global_aggregate(ledger: Ledger, scopes: list[str]) -> LedgerAggregate:
    """Sum over the given scopes (the service passes "global" plus every run that has a ledger)."""
    total = LedgerAggregate()
    for scope in scopes:
        agg = ledger.aggregate(scope)
        total.calls += agg.calls
        total.ok_calls += agg.ok_calls
        total.failed_calls += agg.failed_calls
        total.input_tokens += agg.input_tokens
        total.cache_read_tokens += agg.cache_read_tokens
        total.output_tokens += agg.output_tokens
        total.cost_usd += agg.cost_usd
        total.estimated_cost_usd += agg.estimated_cost_usd
        for profile, spend in agg.by_profile.items():
            mine = total.by_profile.setdefault(profile, ProfileSpend())
            mine.calls += spend.calls
            mine.cost_usd += spend.cost_usd
    return total


__all__ = ["BudgetExceeded", "Ledger", "estimate_cost_usd", "global_aggregate", "price_for", "GLOBAL_SCOPE"]
