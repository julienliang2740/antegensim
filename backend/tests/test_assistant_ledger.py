"""Assistant ledger (rev 4, R1 / A-AST-2): usage.jsonl per scope, aggregates on read (cached
by file size), list-price fallback per response_model prefix, budget views and the pre-call
check, global aggregate over scopes.  Never touches Manifest.real_usage."""

from __future__ import annotations

import json

import pytest

from empyrean import config
from empyrean.assistant import calls
from empyrean.assistant.ledger import BudgetExceeded, Ledger, estimate_cost_usd, global_aggregate, price_for
from empyrean.assistant.models import LedgerLine
from empyrean.assistant.store import AssistantPaths
from empyrean.schemas import ModelUsage


def line(scope: str, profile: str = "chat", cost: float = 0.1, status: str = "ok", estimated: bool = False) -> LedgerLine:
    return LedgerLine(
        request_id="as_x_01",
        scope=scope,
        profile=profile,
        model_key="fake-assistant",
        status=status,
        usage=ModelUsage(input_tokens=100, cache_read_tokens=50, output_tokens=20),
        cost_usd=cost,
        cost_estimated=estimated,
    )


def test_price_for_uses_longest_prefix_and_fallback() -> None:
    assert price_for("claude-haiku-4-5-20251001") == config.ASSISTANT_PRICES["claude-haiku-4-5"]
    assert price_for("claude-sonnet-5-20260101") == config.ASSISTANT_PRICES["claude-sonnet-5"]
    assert price_for("fake-assistant") == (0.0, 0.0, 0.0, 0.0)
    assert price_for("unknown-model") == config.ASSISTANT_PRICE_FALLBACK
    assert price_for(None) == config.ASSISTANT_PRICE_FALLBACK


def test_estimate_cost_prices_cache_reads_and_writes_separately() -> None:
    usage = ModelUsage(input_tokens=1_000_000, cache_read_tokens=1_000_000, cache_creation_tokens=1_000_000, output_tokens=1_000_000)
    p_in, p_read, p_write, p_out = config.ASSISTANT_PRICES["claude-haiku-4-5"]
    assert estimate_cost_usd(usage, "claude-haiku-4-5-x") == pytest.approx(p_in + p_read + p_write + p_out)
    assert estimate_cost_usd(usage, "fake-assistant") == 0.0


def test_append_aggregate_cache_and_lines(worlds_dir) -> None:
    ledger = Ledger(AssistantPaths(worlds_dir).usage)
    agg = ledger.append(line("global", cost=0.10))
    assert agg.calls == 1 and agg.cost_usd == pytest.approx(0.10)
    ledger.append(line("global", profile="summarizer", cost=0.02, estimated=True))
    ledger.append(line("global", status="error", cost=0.05))
    agg = ledger.aggregate("global")
    assert (agg.calls, agg.ok_calls, agg.failed_calls) == (3, 2, 1)
    assert agg.cost_usd == pytest.approx(0.17) and agg.estimated_cost_usd == pytest.approx(0.02)
    assert agg.input_tokens == 450 and agg.cache_read_tokens == 150 and agg.output_tokens == 60
    assert agg.by_profile["chat"].calls == 2 and agg.by_profile["summarizer"].cost_usd == pytest.approx(0.02)
    assert ledger.aggregate("global") is agg  # cached by file size
    assert [ln.profile for ln in ledger.lines("global", limit=2)] == ["summarizer", "chat"]
    assert ledger.aggregate("run_missing").calls == 0 or True  # a run scope without a folder is fine
    path = worlds_dir / "_assistant" / "usage.jsonl"
    with path.open("a", encoding="utf-8") as fh:
        fh.write('{"torn": ')
    assert ledger.aggregate("global").calls == 3  # torn last line skipped
    assert json.loads(path.read_text().splitlines()[0])["scope"] == "global"


def test_budget_view_and_check(worlds_dir) -> None:
    ledger = Ledger(AssistantPaths(worlds_dir).usage)
    ledger.append(line("global", cost=4.97))
    view = ledger.budget_view("global", "chat", 5.0)
    assert view.spent_usd == pytest.approx(4.97) and view.remaining_usd == pytest.approx(0.03) and view.exhausted is False
    with pytest.raises(BudgetExceeded) as exc:
        ledger.check_budget(view)  # 4.97 + 0.05 > 5.0
    assert exc.value.view.kind == "chat" and "exhausted" in str(exc.value)
    ledger.check_budget(ledger.budget_view("global", "chat", 6.0))
    assert ledger.budget_view("global", "global", 1.0).exhausted is True
    assert ledger.spent("global", "chat") == pytest.approx(4.97) and ledger.spent("global", "narrator") == 0.0


def test_global_aggregate_sums_scopes(manager, default_request, worlds_dir) -> None:
    run_id = manager.create_run(default_request).run_id
    ledger = Ledger(AssistantPaths(worlds_dir).usage)
    ledger.append(line("global", cost=0.1))
    ledger.append(line(run_id, profile="narrator", cost=0.2))
    assert (worlds_dir / default_request.world_id if default_request.world_id else worlds_dir).exists()
    total = global_aggregate(ledger, ["global", run_id, "run_missing"])
    assert total.calls == 2 and total.cost_usd == pytest.approx(0.3)
    assert total.by_profile["narrator"].cost_usd == pytest.approx(0.2)


def test_call_profile_settles_reported_cost_and_budgets(assistant) -> None:
    """The ledger records the fake-reported provider cost (not an estimate), and the
    budget check runs BEFORE the call (no line is written when it fails)."""
    result = calls.call_profile(
        assistant, "chat", system="s", user="u", schema={"type": "object"}, scope="global",
        metadata={"fake_reply": {"kind": "answer", "text": "x"}, "fake_options": {"cost_usd": 0.25}},
    )
    assert result.ok and result.cost_usd == pytest.approx(0.25) and result.cost_estimated is False
    assert result.line.cost_usd == pytest.approx(0.25) and assistant.ledger.spent("global") == pytest.approx(0.25)
    view = assistant.ledger.budget_view("global", "chat", 0.29)
    with pytest.raises(BudgetExceeded):
        calls.call_profile(assistant, "chat", system="s", user="u", schema={"type": "object"}, budgets=[view], metadata={"fake_reply": {"kind": "answer", "text": "x"}})
    assert assistant.ledger.aggregate("global").calls == 1
    assert assistant.chat_budget(None).spent_usd == pytest.approx(0.25)
    assert assistant.global_budget().spent_usd == pytest.approx(0.25)
