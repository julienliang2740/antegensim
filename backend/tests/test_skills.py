"""Unit tests for empyrean.skills: parser, save-time validation, compiler and the
resumable interpreter (docs/INTERFACES.md section 4.2; design "Imperative blocks and
expressions", "Examples using only the defined blocks", "Turns speed and skill execution").

The ``Driver`` below plays the runner's part: it resets ``ops_this_turn`` at the start of
each turn, executes the one yielded action against a scripted ActionResult feed, delivers
the result, and serialises the state (and the skills) to JSON and back between EVERY step.
"""

from __future__ import annotations

import json
from typing import Any, Callable, Optional

import pytest

from empyrean import skills as sk
from empyrean.schemas import (
    ActionResult,
    Point,
    SkillDefinition,
    SkillEnv,
    SkillExecutionState,
    SkillRules,
    SkillSaveRequest,
    SkillStepOutcome,
)

EXAMPLE_1 = """\
REPEAT 3
    SET movement_result = move("up")
    IF movement_result.ok == false
        RETURN movement_result.reason
    END
END
RETURN "completed"
"""

EXAMPLE_2 = """\
SET observation = observe(here)
IF observation.ok == false
    RETURN observation.reason
END
FOR_EACH entity IN observation.data.entities
    IF entity.kind == "fruit"
        SET fruit_details = query(entity.id)
        IF fruit_details.ok == true
            IF fruit_details.data.available_compute > 0
                SET absorption_result = absorb(entity.id, "compute")
                IF absorption_result.ok == true
                    SET own_details = query(self)
                    IF own_details.ok == true
                        IF own_details.data.health < own_details.data.max_health AND own_details.data.compute >= 10
                            SET recovery_result = recover(5)
                        END
                    END
                    RETURN absorption_result
                END
            END
        END
    END
END
RETURN "no_food_absorbed"
"""

EXAMPLE_3 = """\
SET own_details = query(self)
IF own_details.ok == false
    RETURN own_details.reason
END
SET upgrade_quote = own_details.data.upgrade_quotes.vision_range
IF upgrade_quote.allowed == true
    IF own_details.data.compute >= upgrade_quote.compute + 5 AND own_details.data.essence >= upgrade_quote.essence
        SET upgrade_result = upgrade("vision_range")
        RETURN upgrade_result
    END
END
RETURN "upgrade_not_affordable_or_unavailable"
"""

AGENT = "a03"


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def save(
    name: str,
    source: str,
    params: tuple[str, ...] = (),
    existing: Optional[dict[str, SkillDefinition]] = None,
    rules: Optional[SkillRules] = None,
    count_limit: int = 5,
    block_limit: int = 100,
) -> dict[str, SkillDefinition]:
    """validate_and_build then add to the dict (like the runner does); returns the dict."""
    existing = {} if existing is None else existing
    request = SkillSaveRequest(name=name, params=list(params), source=source)
    definition = sk.validate_and_build(request, existing, count_limit, block_limit, rules or SkillRules(), 1)
    existing[name] = definition
    return existing


def reject(source: str, match: str, **kwargs: Any) -> None:
    name = kwargs.pop("name", "s")
    with pytest.raises(sk.SkillValidationError, match=match):
        save(name, source, **kwargs)


def through_json(state: SkillExecutionState) -> SkillExecutionState:
    text = json.dumps(state.model_dump(mode="json"))
    restored = SkillExecutionState.model_validate(json.loads(text))
    assert restored.model_dump(mode="json") == state.model_dump(mode="json")
    return restored


def skills_through_json(skills: dict[str, SkillDefinition]) -> dict[str, SkillDefinition]:
    text = json.dumps({name: d.model_dump(mode="json") for name, d in skills.items()})
    return {name: SkillDefinition.model_validate(raw) for name, raw in json.loads(text).items()}


def ok(data: Optional[dict] = None, effects: Optional[dict] = None, cost: float = 0.8) -> ActionResult:
    return ActionResult(ok=True, reason="ok", cost_compute=cost, round=1, data=data or {}, effects=effects or {})


def failed(reason: str, cost: float = 0.8) -> ActionResult:
    return ActionResult(ok=False, reason=reason, cost_compute=cost, round=1)


def env(here: tuple[int, int] = (0, 0), round_no: int = 1) -> SkillEnv:
    return SkillEnv(agent_id=AGENT, here=Point(x=here[0], y=here[1]), round=round_no)


class Driver:
    """Plays the runner: one run_until_action per turn, JSON round trip between steps."""

    def __init__(
        self,
        skills: dict[str, SkillDefinition],
        name: str,
        args: list[Any] | None = None,
        rules: Optional[SkillRules] = None,
        compute: float = 200.0,
    ) -> None:
        self.skills = skills_through_json(skills)
        self.rules = rules or SkillRules()
        self.compute = compute
        self.state = through_json(sk.start_execution(name, list(args or []), self.skills, 1))
        self.actions: list[dict[str, Any]] = []
        self.outcomes: list[SkillStepOutcome] = []
        self.here = (0, 0)

    def turn(self, feed: Callable[[dict[str, Any]], ActionResult] | None = None) -> SkillStepOutcome:
        self.state = through_json(self.state)
        self.state.ops_this_turn = 0
        outcome = sk.run_until_action(self.state, self.skills, self.rules, env(self.here), self.compute)
        assert outcome.ops_used <= self.rules.max_ops_per_turn
        assert outcome.cost_compute == pytest.approx(outcome.ops_used * self.rules.interpreter_cost_per_op)
        self.state = through_json(outcome.state)
        if outcome.action is not None:
            assert feed is not None, f"unexpected action {outcome.action}"
            assert self.state.status == "awaiting_action_result"
            action = outcome.action.model_dump(mode="json")
            self.actions.append(action)
            result = feed(action)
            self.state = through_json(sk.deliver_result(self.state, result))
            assert self.state.status == "running"
        self.outcomes.append(outcome)
        return outcome

    def run(self, feed: Callable[[dict[str, Any]], ActionResult] | None = None, max_turns: int = 100) -> SkillExecutionState:
        for _ in range(max_turns):
            self.turn(feed)
            if self.state.status in ("finished", "stopped", "error"):
                return self.state
        raise AssertionError("skill did not end")


def scripted(*results: ActionResult) -> Callable[[dict[str, Any]], ActionResult]:
    queue = list(results)

    def feed(action: dict[str, Any]) -> ActionResult:
        assert queue, f"no scripted result left for {action}"
        return queue.pop(0)

    return feed


def compile_source(source: str) -> list:
    return sk.compile_skill(sk.parse_skill(source))


# ---------------------------------------------------------------------------
# tokenizer and parser
# ---------------------------------------------------------------------------


def test_tokenize_lines_comments_and_unsigned_numbers():
    lines = sk.tokenize('# header\n\nSET b = b -1  # trailing\nSET s = "a \\"q\\" \\\\ b"\n')
    assert len(lines) == 2
    assert [t[0] for t in lines[0]] == ["KEYWORD", "NAME", "ASSIGN", "NAME", "OP", "NUMBER"]
    assert lines[0][0][2] == 3  # line numbers count blank and comment lines
    assert lines[1][3] == ("STRING", 'a "q" \\ b', 4)
    kinds = [t[0] for t in sk.tokenize("IF x.ok == true AND y != null OR NOT z <= 2.5")[0]]
    assert kinds == ["KEYWORD", "NAME", "DOT", "NAME", "OP", "BOOL", "KEYWORD", "NAME", "OP", "NULL",
                     "KEYWORD", "KEYWORD", "NAME", "OP", "NUMBER"]


@pytest.mark.parametrize(
    "source, message",
    [
        ('SET s = "open', "unterminated string"),
        ("SET s = 'x'", "double quotes"),
        ('SET s = "a\\nb"', "unsupported escape"),
        ("SET x = 3 @ 4", "unexpected character"),
        ("SET x = 3abc", "invalid number"),
        ("SET x = 99999999999999999999", "too large"),
    ],
)
def test_tokenize_errors(source, message):
    with pytest.raises(sk.SkillSyntaxError, match=message):
        sk.tokenize(source)


def test_parse_precedence_and_shapes():
    [block] = sk.parse_skill("SET x = NOT a == 1 OR b AND c < -d.e * (2 + 3)")
    expr = block.expr
    assert expr.op == "OR"
    assert expr.left.op == "NOT" and expr.left.operand.op == "=="
    right = expr.right
    assert right.op == "AND" and right.right.op == "<"
    product = right.right.right
    assert product.op == "*"
    assert product.left.op == "-" and product.left.operand.type == "field"
    assert product.right.op == "+"  # parentheses group
    [coord] = sk.parse_skill("SET p = (here.x + 1, here.y)")
    assert coord.expr.type == "coord"
    [call] = sk.parse_skill("CALL helper(1, (2, 3)) INTO out")
    assert call.type == "call" and call.into == "out" and call.args[1].type == "coord"
    [bare] = sk.parse_skill('move("up")')
    assert bare.type == "expr" and bare.expr.action == "move"
    [ret] = sk.parse_skill("RETURN")
    assert ret.expr is None
    [upgrade_field] = sk.parse_skill("SET a = q.data.upgrade_quotes.attack")  # action names are fine as fields
    assert upgrade_field.expr.name == "attack"


@pytest.mark.parametrize(
    "source, message",
    [
        ("IF x == 1\nSET y = 2", "IF has no matching END"),
        ("END", "END without a matching"),
        ("IF a\nELSE IF b\nEND\nEND", "ELSE must be alone"),
        ("REPEAT 2\nELSE\nEND", "ELSE inside REPEAT"),
        ("IF a\nELSE\nELSE\nEND", "more than one ELSE"),
        ("SET x = a < b < c", "cannot be chained"),
        ("IF x = 1\nEND", "use =="),
        ("set x = 1", "keywords are uppercase"),
        ("x = 1", "assignments need SET"),
        ("jump(1)", "unknown action 'jump'"),
        ("SET x = move", "must be called with parentheses"),
        ("SET x = foo(1)", "unknown action 'foo'"),
        ("SET x = (1, 2, 3)", "close the coordinate pair"),
        ("SET x = 1 +", "expected a value"),
        ("STOP now", "unexpected 'now'"),
        ("x + 1", "a statement must start with"),
    ],
)
def test_parse_errors(source, message):
    with pytest.raises(sk.SkillSyntaxError, match=message):
        sk.parse_skill(source)


def test_parse_error_reports_line():
    with pytest.raises(sk.SkillSyntaxError) as info:
        sk.parse_skill("SET a = 1\n\n# comment\nSET b = (1 +\n")
    assert info.value.line == 4


def test_deep_nesting_is_a_syntax_error_not_a_crash():
    with pytest.raises(sk.SkillSyntaxError, match="nested"):
        sk.parse_skill("SET x = " + "(" * 300 + "1" + ")" * 300)
    with pytest.raises(sk.SkillSyntaxError, match="nested"):
        sk.parse_skill("SET x = " + " + ".join(["1"] * 200))
    with pytest.raises(sk.SkillSyntaxError, match="nested"):
        sk.parse_skill("SET x = " + "NOT " * 200 + "true")
    with pytest.raises(sk.SkillSyntaxError, match="nested"):
        sk.parse_skill("IF true\n" * 100 + "STOP\n" + "END\n" * 100)


@pytest.mark.parametrize(
    "source",
    [
        'SET x = move("up").ok',
        'IF move("up")\nEND',
        "RETURN observe(here)",
        "SET x = 1 + query(self).data.compute",
        'CALL helper(query(self))',
        'SET r = send(query(self), "hi")',
        'move("up").ok',
    ],
)
def test_action_call_only_as_whole_set_rhs_or_statement(source):
    with pytest.raises(sk.SkillSyntaxError, match="A-SKILL-1"):
        sk.parse_skill(source)


# ---------------------------------------------------------------------------
# block counting and compilation
# ---------------------------------------------------------------------------


def test_block_counts_of_design_examples_and_worked_numbers():
    assert sk.count_blocks(sk.parse_skill(EXAMPLE_1)) == 9
    assert sk.count_blocks(sk.parse_skill(EXAMPLE_2)) == 48  # contract A-SKILL-4
    assert sk.count_blocks(sk.parse_skill(EXAMPLE_3)) == 29
    assert sk.count_blocks(sk.parse_skill('move("up")')) == 2
    assert sk.count_blocks(sk.parse_skill("SET r = observe(here)")) == 2
    assert sk.count_blocks(sk.parse_skill("IF a.ok == true AND b > 1\nEND")) == 5
    assert sk.count_blocks(sk.parse_skill("CALL helper(1, x.y)")) == 2  # CALL 1 + field 1
    assert sk.count_blocks(sk.parse_skill("SET p = (here.x + 1, -2)")) == 5  # set, coord, field, +, unary -


def test_find_action_calls_in_source_order():
    assert sk.find_action_calls(sk.parse_skill(EXAMPLE_2)) == [
        (1, "observe"), (7, "query"), (10, "absorb"), (12, "query"), (15, "recover"),
    ]


def test_compile_if_else_layout_matches_contract():
    code = compile_source("IF c\nSET a = 1\nELSE\nSET a = 2\nEND\nSTOP")
    assert [i.op for i in code] == ["jump_if_false", "set", "jump", "set", "stop", "return"]
    assert code[0].target == 3 and code[2].target == 4


def test_compile_if_without_else_has_no_jump():
    code = compile_source("IF c\nSET a = 1\nEND")
    assert [i.op for i in code] == ["jump_if_false", "set", "return"]
    assert code[0].target == 2


def test_compile_loop_layouts_match_contract():
    repeat = compile_source("REPEAT n\nSET a = 1\nEND")
    assert [(i.op, i.target) for i in repeat] == [("loop_start", 3), ("set", None), ("loop_next", 0), ("return", None)]
    assert repeat[0].loop_kind == "repeat"
    each = compile_source("FOR_EACH v IN l\nSET a = v\nEND")
    assert [(i.op, i.target) for i in each] == [("loop_start", 3), ("set", None), ("loop_next", 0), ("return", None)]
    assert each[0].loop_kind == "for_each" and each[0].var == "v"
    example_1 = compile_source(EXAMPLE_1)
    assert [i.op for i in example_1] == ["loop_start", "set", "jump_if_false", "return", "loop_next", "return", "return"]
    assert example_1[0].target == 5 and example_1[2].target == 4 and example_1[4].target == 0
    call = compile_source("CALL helper(1) INTO v")
    assert call[0].op == "call" and call[0].skill == "helper" and call[0].var == "v" and len(call[0].args) == 1


# ---------------------------------------------------------------------------
# design examples, executed turn by turn with a JSON round trip between steps
# ---------------------------------------------------------------------------


def test_example_1_uses_three_turns_then_finishes_without_action():
    driver = Driver(save("up3", EXAMPLE_1), "up3")
    feed = scripted(ok(effects={"from": {"x": 0, "y": 0}, "to": {"x": 0, "y": 1}}), ok(), ok())
    for _ in range(3):
        outcome = driver.turn(feed)
        assert outcome.action is not None
        assert outcome.action.name == "move" and outcome.action.args.direction == "up"
    fourth = driver.turn(feed)
    assert fourth.action is None and fourth.invalid_action is None
    assert driver.state.status == "finished"
    assert driver.state.return_value == "completed"
    assert driver.state.actions_executed == 3
    assert driver.state.frames == []


def test_example_1_stops_at_failed_move_and_returns_reason():
    driver = Driver(save("up3", EXAMPLE_1), "up3")
    state = driver.run(scripted(ok(), failed("blocked", cost=0.8)))
    assert state.status == "finished"
    assert state.return_value == "blocked"
    assert [a["name"] for a in driver.actions] == ["move", "move"]


def test_example_2_finds_fruit_absorbs_and_recovers():
    driver = Driver(save("forage", EXAMPLE_2), "forage")
    driver.here = (2, -1)
    observation = ok(
        data={
            "point": {"x": 2, "y": -1},
            "terrain": "land",
            "entities": [
                {"id": AGENT, "kind": "agent", "position": {"x": 2, "y": -1}},
                {"id": "p0004", "kind": "plant", "position": {"x": 2, "y": -1}},
                {"id": "f0002", "kind": "fruit", "position": {"x": 2, "y": -1}},
            ],
            "observed_round": 1, "page": 0, "page_size": 40, "total_entities": 3, "has_more": False,
        }
    )
    fruit = ok(data={"id": "f0002", "kind": "fruit", "available_compute": 60.0, "available_essence": 0.0})
    absorbed = ok(effects={"processed": 60.0, "gained": 12.0, "lost": 48.0, "source": "f0002", "resource": "compute"}, cost=2.4)
    me = ok(data={"health": 90.0, "max_health": 100.0, "compute": 150.0, "essence": 20.0})
    recovered = ok(effects={"healed": 5.0, "health": 95.0}, cost=4.0)
    state = driver.run(scripted(observation, fruit, absorbed, me, recovered))
    assert [a["name"] for a in driver.actions] == ["observe", "query", "absorb", "query", "recover"]
    assert driver.actions[0]["args"] == {"point": {"x": 2, "y": -1}, "page": 0}
    assert driver.actions[1]["args"] == {"entity": "f0002"}
    assert driver.actions[2]["args"] == {"source": "f0002", "resource": "compute"}
    assert driver.actions[3]["args"] == {"entity": AGENT}  # query(self) -> own id
    assert driver.actions[4]["args"] == {"compute_budget": 5.0}
    assert state.status == "finished"
    assert state.return_value == absorbed.model_dump(mode="json")
    assert state.actions_executed == 5


def test_example_2_without_fruit_returns_no_food():
    driver = Driver(save("forage", EXAMPLE_2), "forage")
    observation = ok(data={"entities": [{"id": "p0001", "kind": "plant", "position": {"x": 0, "y": 0}}]})
    state = driver.run(scripted(observation))
    assert state.return_value == "no_food_absorbed"
    assert len(driver.actions) == 1


def test_example_2_failed_observe_returns_reason():
    driver = Driver(save("forage", EXAMPLE_2), "forage")
    state = driver.run(scripted(failed("insufficient_compute", cost=0.0)))
    assert state.return_value == "insufficient_compute"


def _self_query(compute: float, essence: float, allowed: bool = True) -> ActionResult:
    quote = {"base_compute": 25.0, "skill_compute": 20.0, "compute": 20.0, "essence": 2.0, "next_value": 1, "allowed": allowed}
    return ok(data={"compute": compute, "essence": essence, "upgrade_quotes": {"vision_range": quote}, "quote_mode": "skill"})


def test_example_3_reads_quotes_and_upgrades():
    driver = Driver(save("see_further", EXAMPLE_3), "see_further")
    upgraded = ok(data={"attribute": "vision_range", "new_value": 1, "purchase_count": 1},
                  effects={"purchased": "vision_range", "new_value": 1, "compute": 20.0, "essence": 2.0}, cost=20.0)
    state = driver.run(scripted(_self_query(200.0, 20.0), upgraded))
    assert driver.actions == [
        {"name": "query", "args": {"entity": AGENT}},
        {"name": "upgrade", "args": {"attribute": "vision_range"}},
    ]
    assert state.status == "finished"
    assert state.return_value["ok"] is True
    assert state.return_value["data"]["new_value"] == 1


def test_example_3_unaffordable_quote_skips_upgrade():
    driver = Driver(save("see_further", EXAMPLE_3), "see_further")
    state = driver.run(scripted(_self_query(24.0, 20.0)))  # needs 20 + 5 compute
    assert state.return_value == "upgrade_not_affordable_or_unavailable"
    assert [a["name"] for a in driver.actions] == ["query"]
    driver = Driver(save("see_further", EXAMPLE_3), "see_further")
    state = driver.run(scripted(_self_query(500.0, 20.0, allowed=False)))
    assert state.return_value == "upgrade_not_affordable_or_unavailable"


# ---------------------------------------------------------------------------
# op accounting, yields and loops
# ---------------------------------------------------------------------------


def test_op_budget_yield_mid_loop_and_resume():
    source = "SET i = 0\nREPEAT 60\nSET i = i + 1\nEND\nSET r = wait(1)\nRETURN i"
    driver = Driver(save("count", source), "count")
    first = driver.turn()
    # SET 1 + loop_start 1 + 32 iterations x (SET 2 + loop_next 1) + one more SET 2 = 100
    assert first.ops_used == 100
    assert first.action is None and first.invalid_action is None
    assert driver.state.status == "running"
    assert driver.state.last_error == "op_budget_exhausted"
    assert driver.state.frames[0].vars["i"] == 33
    assert driver.state.frames[0].loops[0].remaining == 28
    second = driver.turn(scripted(ok(effects={"waiting_turns": 1}, cost=0.0)))
    assert second.action is not None and second.action.name == "wait"
    assert second.ops_used == 83  # remaining: 27 x 3 + final loop_next 1 + wait SET 1
    assert driver.state.last_error is None
    assert driver.state.total_ops == 183
    assert driver.state.total_interpreter_cost == pytest.approx(1.83)
    third = driver.turn()
    assert third.ops_used == 1
    assert driver.state.status == "finished" and driver.state.return_value == 60


def test_large_repeat_is_bounded_by_ops_per_turn():
    source = "SET n = 0\nREPEAT 10000\nSET n = n + 1\nEND\nRETURN n"
    rules = SkillRules(max_ops_per_turn=50)
    driver = Driver(save("spin", source), "spin", rules=rules)
    previous = 0
    for _ in range(5):
        outcome = driver.turn()
        assert outcome.ops_used <= 50
        assert outcome.action is None
        assert driver.state.status == "running"
        assert driver.state.last_error == "op_budget_exhausted"
        progress = driver.state.frames[0].vars["n"]
        assert progress > previous
        previous = progress
    assert driver.state.frames[0].loops[0].remaining > 9000


def test_statement_that_can_never_fit_the_budget_is_an_error():
    driver = Driver(save("big", "SET x = 1 + 2 + 3 + 4 + 5"), "big", rules=SkillRules(max_ops_per_turn=3))
    outcome = driver.turn()
    assert driver.state.status == "error"
    assert "at most 3 run per turn" in outcome.error


def test_insufficient_compute_for_interpreter_ops_is_an_error():
    driver = Driver(save("think", "SET a = 1 + 1\nSET b = a * 2\nRETURN b"), "think", compute=0.03)
    outcome = driver.turn()
    assert driver.state.status == "error"
    assert driver.state.last_error == "insufficient_compute"
    assert outcome.error == "insufficient_compute"
    assert outcome.ops_used == 2  # the first SET ran; the second would push cost past 0.03
    assert outcome.cost_compute == pytest.approx(0.02)


def test_repeat_zero_and_for_each_empty_skip_the_body():
    source = "SET hits = 0\nREPEAT 0\nSET hits = hits + 1\nEND\nFOR_EACH e IN items\nSET hits = hits + 1\nEND\nRETURN hits"
    driver = Driver(save("skip", source, params=("items",)), "skip", args=[[]])
    assert driver.run().return_value == 0


def test_for_each_binds_each_item_in_order():
    source = 'SET text = ""\nFOR_EACH e IN items\nSET text = text + e.id\nEND\nRETURN text'
    items = [{"id": "a"}, {"id": "b"}, {"id": "c"}]
    driver = Driver(save("join", source, params=("items",)), "join", args=[items])
    assert driver.run().return_value == "abc"


@pytest.mark.parametrize("count, message", [(-1, "whole number"), (2.5, "whole number"), ("3", "string"), (20001, "0 to 10000")])
def test_bad_runtime_repeat_count_is_error(count, message):
    driver = Driver(save("rep", "REPEAT n\nSET x = 1\nEND", params=("n",)), "rep", args=[count])
    driver.run()
    assert driver.state.status == "error"
    assert message in driver.state.last_error
    assert driver.state.last_error.startswith("line 1:")


def test_repeat_accepts_integer_valued_float():
    driver = Driver(save("rep", "SET k = 0\nREPEAT n / 2\nSET k = k + 1\nEND\nRETURN k", params=("n",)), "rep", args=[6])
    assert driver.run().return_value == 3


# ---------------------------------------------------------------------------
# CALL, RETURN INTO, STOP
# ---------------------------------------------------------------------------


def test_nested_call_with_return_into_and_action_inside_callee():
    skills = save("step", 'SET r = move(direction)\nIF r.ok == false\nRETURN 0\nEND\nRETURN amount + 1', params=("direction", "amount"))
    save("walk", 'CALL step("left", 10) INTO first\nCALL step("up", first) INTO second\nRETURN second * 2', existing=skills)
    driver = Driver(skills, "walk")
    first = driver.turn(scripted(ok()))
    assert first.action.args.direction == "left"
    assert [f.skill for f in driver.state.frames] == ["walk", "step"]
    assert sk.frames_use(driver.state) == {"walk", "step"}
    second = driver.turn(scripted(ok()))
    assert second.action.args.direction == "up"
    assert driver.state.frames[0].vars["first"] == 11
    driver.turn()
    assert driver.state.status == "finished"
    assert driver.state.return_value == 24


def test_call_without_into_discards_value_and_continues():
    skills = save("noop", "RETURN 5")
    save("outer", "CALL noop()\nRETURN 1", existing=skills)
    driver = Driver(skills, "outer")
    assert driver.run().return_value == 1


def test_stop_unwinds_all_frames():
    skills = save("inner", 'SET r = move("down")\nSTOP\nRETURN "unreachable"')
    save("middle", 'CALL inner() INTO z\nRETURN "unreachable"', existing=skills)
    save("outer", 'CALL middle() INTO y\nSET after = move("up")\nRETURN y', existing=skills)
    driver = Driver(skills, "outer")
    driver.turn(scripted(ok()))
    assert [f.skill for f in driver.state.frames] == ["outer", "middle", "inner"]
    outcome = driver.turn()
    assert outcome.action is None
    assert driver.state.status == "stopped"
    assert driver.state.last_error == "stopped"
    assert driver.state.frames == []
    assert sk.frames_use(driver.state) == set()
    assert [a["args"]["direction"] for a in driver.actions] == ["down"]


def test_call_depth_limit_with_recursion_enabled():
    rules = SkillRules(allow_recursion=True, max_call_depth=4)
    skills = save("dive", "CALL dive(n + 1) INTO m\nRETURN m", params=("n",), rules=rules)
    driver = Driver(skills, "dive", args=[0], rules=rules)
    driver.run()
    assert driver.state.status == "error"
    assert "depth limit of 4" in driver.state.last_error
    assert len(driver.state.frames) == 4  # frames kept for inspection on error


def test_call_of_deleted_skill_is_runtime_error():
    skills = save("helper", "RETURN 1")
    save("main", "CALL helper() INTO v\nRETURN v", existing=skills)
    state = sk.start_execution("main", [], skills, 1)
    del skills["helper"]
    outcome = sk.run_until_action(state, skills, SkillRules(), env(), 100.0)
    assert outcome.state.status == "error"
    assert "missing skill 'helper'" in outcome.error


# ---------------------------------------------------------------------------
# save-time validation
# ---------------------------------------------------------------------------


def test_recursion_rejected_at_save():
    reject("CALL loop()", "recursive skill calls are not allowed: loop -> loop", name="loop")
    skills = save("b", "RETURN 1")
    save("a", "CALL b() INTO x\nRETURN x", existing=skills)
    with pytest.raises(sk.SkillValidationError, match="b -> a -> b"):
        save("b", "CALL a() INTO y\nRETURN y", existing=skills)
    assert skills["b"].source == "RETURN 1"  # rejected save leaves the dict untouched
    rules = SkillRules(allow_recursion=True)
    assert "loop" in save("loop", "CALL loop()", rules=rules)


@pytest.mark.parametrize(
    "source, message",
    [
        ('move("up", "down")', "move takes 1 argument"),
        ("SET r = observe()", "observe takes 1 or 2 argument"),
        ("SET r = observe(here, 0, 1)", "observe takes 1 or 2 argument"),
        ('SET r = send("a01")', "send takes 2 argument"),
        ('SET r = transfer("a01", "compute")', "transfer takes 3 argument"),
        ("SET r = attack(5)", "attack takes 2 argument"),
    ],
)
def test_action_arity_errors(source, message):
    reject(source, message)


def test_observe_accepts_one_or_two_arguments():
    skills = save("look", "SET a = observe(here)\nSET b = observe((here.x + 1, here.y), 1)")
    assert skills["look"].block_count == 2 + 6  # second: set, action, coord, field, +, field


def test_call_arity_and_unknown_target():
    skills = save("helper", "RETURN a", params=("a",))
    reject("CALL helper()", "helper takes 1 argument", existing=skills)
    reject("CALL helper(1, 2)", "helper takes 1 argument", existing=skills)
    reject("CALL ghost()", "unknown skill 'ghost'")
    with pytest.raises(sk.SkillValidationError, match="takes 1 argument"):
        sk.start_execution("helper", [], skills, 1)
    with pytest.raises(sk.SkillValidationError, match="unknown skill"):
        sk.start_execution("ghost", [], skills, 1)


def test_resaving_callee_rechecks_callers_arity():
    skills = save("helper", "RETURN a", params=("a",))
    save("main", "CALL helper(1) INTO v\nRETURN v", existing=skills)
    with pytest.raises(sk.SkillValidationError, match="caller main expects 1 arguments"):
        save("helper", "RETURN 0", existing=skills)
    save("helper", "RETURN b * 2", params=("b",), existing=skills)  # same arity is fine


@pytest.mark.parametrize(
    "source, message",
    [
        ('move("sideways")', "move direction"),
        ('SET r = absorb("f0001", "gold")', "resource must be"),
        ('SET r = upgrade("wings")', "upgrade attribute"),
        ("SET r = recover(0)", "compute_budget must be a positive number"),
        ("SET r = recover(-5)", "compute_budget must be a positive number"),
        ('SET r = attack("a02", true)', "compute_budget must be a positive number"),
        ('SET r = transfer("a02", "compute", 0)', "amount must be a positive number"),
        ("SET r = wait(0)", "wait rounds"),
        ("SET r = wait(1.5)", "wait rounds"),
        ("SET r = observe((1.5, 0))", "point x must be a whole number"),
        ("SET r = observe((0, -2.5))", "point y must be a whole number"),
        ('SET r = observe("1,2")', "needs a coordinate"),
        ("SET r = observe(here, -1)", "page must be"),
        ("SET r = query(3)", "entity must be a string"),
        ("SET r = broadcast(null)", "message must be a string"),
        ("REPEAT -1\nEND", "REPEAT count"),
        ("REPEAT 2.5\nEND", "REPEAT count"),
        ("REPEAT 10001\nEND", "REPEAT count"),
        ("FOR_EACH e IN 3\nEND", "FOR_EACH needs a list"),
    ],
)
def test_literal_argument_checks(source, message):
    reject(source, message)


def test_literal_checks_accept_valid_and_computed_values():
    skills = save(
        "fine",
        'SET a = move("left")\nSET b = observe((1, -2), 0)\nSET c = wait(2)\nSET d = recover(2.5)\n'
        'SET e = upgrade("attack")\nSET f = move(dir)\nSET g = recover(0 - 1)\nREPEAT 0\nEND',
        params=("dir",),
    )
    assert "fine" in skills


def test_size_limits():
    reject("\n".join(["SET x = 1"] * 11), "11 blocks; your per-skill block limit is 10", block_limit=10)
    reject("SET x = 1", "source is", rules=SkillRules(max_source_chars=5))
    skills: dict[str, SkillDefinition] = {}
    for index in range(3):
        save(f"s{index}", "RETURN 1", existing=skills, count_limit=3)
    with pytest.raises(sk.SkillValidationError, match="limit is 3"):
        save("s3", "RETURN 1", existing=skills, count_limit=3)
    save("s1", "RETURN 2", existing=skills, count_limit=3)  # overwriting at the limit is allowed
    assert skills["s1"].source == "RETURN 2"
    reject("# only a comment\n", "no statements")


@pytest.mark.parametrize(
    "source, message",
    [
        ("SET self = 1", "reserved"),
        ("SET here = 1", "reserved"),
        ("SET true = 1", "reserved"),
        ("SET move = 1", "action name"),
        ("SET IF = 1", "keyword"),
        ("FOR_EACH null IN xs\nEND", "reserved"),
        ("FOR_EACH wait IN xs\nEND", "action name"),
        ("CALL helper() INTO self", "reserved"),
        ("CALL move()", "action name"),
    ],
)
def test_reserved_names_rejected_in_source(source, message):
    reject(source, message)


@pytest.mark.parametrize("name", ["move", "IF", "self", "here", "null", "observe", "END"])
def test_reserved_skill_names_rejected(name):
    with pytest.raises(sk.SkillValidationError, match="cannot be used as a skill name"):
        sk.validate_and_build(SkillSaveRequest(name=name, source="RETURN 1"), {}, 5, 100, SkillRules(), 1)


@pytest.mark.parametrize("params, message", [(["self"], "reserved"), (["attack"], "action name"), (["a", "a"], "twice"), (["1x"], "not a valid")])
def test_bad_params_rejected(params, message):
    reject("RETURN 1", message, params=tuple(params))


def test_skill_definition_fields():
    skills = save("helper", "RETURN 1")
    save("main", 'CALL helper() INTO v\nSET r = move("up")\nRETURN v', existing=skills)
    main = skills["main"]
    assert main.calls == ["helper"]
    assert main.block_count == 4
    assert main.saved_round == 1
    assert main.compiled[-1].op == "return"
    restored = skills_through_json(skills)["main"]
    assert restored.model_dump() == main.model_dump()


def test_check_delete():
    skills = save("helper", "RETURN 1")
    save("a", "CALL helper() INTO v", existing=skills)
    save("b", "CALL helper()", existing=skills)
    assert sk.check_delete("helper", skills) == "referenced by a, b"
    assert sk.check_delete("a", skills) is None
    assert sk.check_delete("ghost", skills) == "unknown skill"


# ---------------------------------------------------------------------------
# runtime semantics
# ---------------------------------------------------------------------------


def test_runtime_error_on_missing_field():
    driver = Driver(save("peek", 'SET r = query("f0001")\nSET x = r.data.available_compute\nRETURN x'), "peek")
    driver.run(scripted(failed("target_gone", cost=0.8)))
    assert driver.state.status == "error"
    assert driver.state.last_error.startswith("line 2: missing field 'available_compute'")
    assert driver.outcomes[-1].error == driver.state.last_error
    assert driver.state.frames and driver.state.frames[0].pc == 1  # kept for inspection


def test_runtime_error_on_division_by_zero():
    driver = Driver(save("div", "SET a = 1\nSET b = a / (a - 1)\nRETURN b"), "div")
    driver.run()
    assert driver.state.status == "error"
    assert driver.state.last_error == "line 2: division by zero"


@pytest.mark.parametrize(
    "expression, message",
    [
        ("missing + 1", "unknown variable 'missing'"),
        ('1 + "a"', "'+' needs two numbers or two strings"),
        ('"a" < "b"', "'<' needs two numbers"),
        ("true AND 1", "AND needs true or false on the right"),
        ("1 OR true", "OR needs true or false on the left"),
        ("NOT 0", "NOT needs true or false"),
        ("-true", "'-' needs a number"),
        ("self.x", "cannot read field 'x' of a string"),
        ('("a", 1)', "coordinate x must be a number"),
    ],
)
def test_runtime_type_errors(expression, message):
    driver = Driver(save("bad", f"SET v = {expression}\nRETURN v"), "bad")
    driver.run()
    assert driver.state.status == "error"
    assert message in driver.state.last_error


def test_if_condition_must_be_boolean():
    driver = Driver(save("cond", "IF 1\nRETURN 1\nEND"), "cond")
    driver.run()
    assert "IF condition must be true or false" in driver.state.last_error


def test_and_short_circuit_on_failed_result():
    source = 'SET r = query("f0001")\nIF r.ok == true AND r.data.x > 0\nRETURN "yes"\nEND\nRETURN "no"'
    driver = Driver(save("guard", source), "guard")
    driver.turn(scripted(failed("target_gone")))
    outcome = driver.turn()
    assert driver.state.status == "finished"
    assert driver.state.return_value == "no"
    assert outcome.error is None
    # IF: 1 + field + == (AND and its right side skipped) = 3; RETURN "no" = 1
    assert outcome.ops_used == 4
    driver = Driver(save("guard", source), "guard")
    driver.turn(scripted(ok(data={"x": 2})))
    outcome = driver.turn()
    assert driver.state.return_value == "yes"
    assert outcome.ops_used == 1 + 7  # fully evaluated: field, ==, AND, field, field, > (+1 instruction) + RETURN


def test_contract_worked_op_numbers():
    counter = [0]
    expr = sk.parse_skill("IF a.ok == true AND b > 1\nEND")[0].cond
    assert sk.evaluate(expr, {"a": {"ok": False}, "b": 5}, env(), counter) is False
    assert 1 + counter[0] == 3  # contract: "when a.ok is false, 1 + 2 = 3 ops"
    counter = [0]
    assert sk.evaluate(expr, {"a": {"ok": True}, "b": 5}, env(), counter) is True
    assert 1 + counter[0] == 5
    driver = Driver(save("one", 'move("up")'), "one")
    assert driver.turn(scripted(ok())).ops_used == 1  # bare action statement = 1 op
    driver = Driver(save("look", "SET r = observe(here)"), "look")
    assert driver.turn(scripted(ok())).ops_used == 1


def test_or_short_circuit_skips_right_side():
    counter = [0]
    expr = sk.parse_skill("SET v = true OR missing.field")[0].expr
    assert sk.evaluate(expr, {}, env(), counter) is True
    assert counter[0] == 0


def test_type_strict_structural_equality():
    def value(text: str, variables: dict | None = None) -> Any:
        return sk.evaluate(sk.parse_skill(f"SET v = {text}")[0].expr, variables or {}, env((4, 5)), [0])

    assert value("true == 1") is False
    assert value("false == 0") is False
    assert value("3 == 3.0") is True
    assert value('"3" == 3') is False
    assert value("null == false") is False
    assert value("null == null") is True
    assert value("here == (4, 5)") is True
    assert value("here != (4, 6)") is True
    assert value("p == q", {"p": [1, {"a": True}], "q": [1.0, {"a": True}]}) is True
    assert value("p == q", {"p": [1, {"a": True}], "q": [1, {"a": 1}]}) is False
    assert value("self") == AGENT
    assert value("(here.x + 1, here.y - 1)") == {"x": 5, "y": 4}
    assert value("7 / 2") == 3.5
    assert value('"a" + "b"') == "ab"


def test_evaluate_accepts_plain_dict_expressions():
    expr = {"type": "binary", "op": "+", "left": {"type": "literal", "value": 2}, "right": {"type": "var", "name": "n"}}
    counter = [0]
    assert sk.evaluate(expr, {"n": 3}, env(), counter) == 5
    assert counter[0] == 1


def test_numbers_stay_bounded():
    driver = Driver(save("grow", "SET x = 10\nREPEAT 20\nSET x = x * x\nEND\nRETURN x"), "grow")
    driver.run()
    assert driver.state.status == "error"
    assert "number too large" in driver.state.last_error
    driver = Driver(save("text", 'SET s = "abcdefgh"\nREPEAT 20\nSET s = s + s\nEND\nRETURN s'), "text")
    driver.run()
    assert driver.state.status == "error"
    assert "string longer than" in driver.state.last_error


def test_invalid_computed_argument_gives_synthetic_result_and_uses_turn():
    source = 'SET d = "side" + "ways"\nSET r = move(d)\nRETURN r.reason'
    driver = Driver(save("odd", source), "odd")
    outcome = driver.turn()
    assert outcome.action is None
    invalid = outcome.invalid_action
    assert invalid is not None
    assert invalid.name == "move" and invalid.args == {"direction": "sideways"}
    assert invalid.result.ok is False and invalid.result.reason == "invalid_argument"
    assert invalid.result.cost_compute == 0 and invalid.result.round == 1
    assert "direction" in invalid.error
    assert driver.state.status == "running"
    assert driver.state.frames[0].vars["r"]["reason"] == "invalid_argument"
    assert driver.state.actions_executed == 0
    driver.turn()
    assert driver.state.status == "finished"
    assert driver.state.return_value == "invalid_argument"


@pytest.mark.parametrize(
    "call, args, error_part",
    [
        ("recover(n)", [-3], "compute_budget"),
        ("wait(n)", [0], "rounds"),
        ("observe(n)", [{"x": 1}], "point must be a coordinate"),
        ("observe(n)", [{"x": 1.5, "y": 0}], "point must be a coordinate"),
        ("observe(n)", [{"x": True, "y": 0}], "point must be a coordinate"),
        ('send("a01", n)', [42], "message"),
        ("upgrade(n)", ["wings"], "attribute"),
        ('transfer("a01", "compute", n)', [False], "amount"),
    ],
)
def test_invalid_runtime_arguments(call, args, error_part):
    driver = Driver(save("act", f"SET r = {call}\nRETURN r.ok", params=("n",)), "act", args=args)
    outcome = driver.turn()
    assert outcome.invalid_action is not None
    assert error_part in outcome.invalid_action.error


def test_runtime_arguments_are_converted():
    source = "SET a = observe(p, n / 2)\nSET b = wait(n / 2)\nSET c = observe((here.x / 1, here.y))\nmove(dir)"
    driver = Driver(save("conv", source, params=("p", "n", "dir")), "conv", args=[[3, -4], 4, "right"])
    feed = scripted(ok(), ok(), ok(), ok())
    driver.run(feed)
    assert driver.actions == [
        {"name": "observe", "args": {"point": {"x": 3, "y": -4}, "page": 2}},
        {"name": "wait", "args": {"rounds": 2}},
        {"name": "observe", "args": {"point": {"x": 0, "y": 0}, "page": 0}},
        {"name": "move", "args": {"direction": "right"}},
    ]
    assert driver.state.return_value is None  # falling off the end returns null


def test_bare_action_result_is_discarded():
    driver = Driver(save("go", 'move("up")\nRETURN 1'), "go")
    driver.turn(scripted(ok()))
    assert driver.state.frames[0].vars == {}
    driver.turn()
    assert driver.state.return_value == 1


def test_here_is_read_when_evaluated():
    driver = Driver(save("where", 'move("up")\nRETURN here'), "where")
    driver.turn(scripted(ok()))
    driver.here = (0, 1)
    driver.turn()
    assert driver.state.return_value == {"x": 0, "y": 1}


# ---------------------------------------------------------------------------
# state lifecycle helpers
# ---------------------------------------------------------------------------


def test_deliver_result_and_run_order_are_enforced():
    skills = save("go", 'SET r = move("up")')
    state = sk.start_execution("go", [], skills, 1)
    with pytest.raises(sk.SkillValidationError, match="not waiting"):
        sk.deliver_result(state, ok())
    outcome = sk.run_until_action(state, skills, SkillRules(), env(), 10.0)
    assert outcome.state is state  # the same object is updated and returned
    assert state.pending_action is not None and state.pending_result_var == "r"
    with pytest.raises(sk.SkillValidationError, match="deliver_result first"):
        sk.run_until_action(state, skills, SkillRules(), env(), 10.0)
    returned = sk.deliver_result(state, ok(data={"k": 1}))
    assert returned is state
    assert state.frames[0].vars["r"]["data"] == {"k": 1}
    assert state.pending_action is None and state.pending_result_var is None
    assert state.actions_executed == 1 and state.frames[0].pc == 1


def test_stop_execution():
    skills = save("go", 'SET r = move("up")\nSET s = move("up")')
    state = sk.start_execution("go", [], skills, 1)
    sk.run_until_action(state, skills, SkillRules(), env(), 10.0)
    assert sk.frames_use(state) == {"go"}
    stopped = sk.stop_execution(state, "interrupted")
    assert stopped.status == "stopped" and stopped.last_error == "interrupted"
    assert stopped.pending_action is None and stopped.pending_result_var is None
    assert stopped.frames == []
    again = sk.stop_execution(stopped, "operator")
    assert again.last_error == "interrupted"  # no-op once ended
    outcome = sk.run_until_action(stopped, skills, SkillRules(), env(), 10.0)
    assert outcome.ops_used == 0 and outcome.action is None


def test_start_execution_binds_params_and_copies_arguments():
    skills = save("echo", "RETURN a", params=("a",))
    argument = {"x": 1, "y": 2}
    state = sk.start_execution("echo", [argument], skills, 7)
    argument["x"] = 99
    assert state.root_skill == "echo" and state.started_round == 7
    assert state.arguments == [{"x": 1, "y": 2}]
    assert state.frames[0].vars == {"a": {"x": 1, "y": 2}}
    assert state.status == "running" and state.ops_this_turn == 0


def test_skill_catalogue():
    skills = save("helper", 'SET r = observe(here)\nRETURN r', params=())
    save("forage", EXAMPLE_2, existing=skills)
    save("main", "CALL helper() INTO v\nRETURN v", params=(), existing=skills)
    text = sk.skill_catalogue(skills, include_source=False)
    lines = text.splitlines()
    assert lines == [
        "forage() - 48 blocks, actions: observe, query, absorb, recover",
        "helper() - 3 blocks, actions: observe",
        "main() - 2 blocks, actions: none, calls: helper",
    ]
    with_one = sk.skill_catalogue(skills, include_source=False, source_for={"helper"})
    assert "```\nSET r = observe(here)\nRETURN r\n```" in with_one
    assert "FOR_EACH" not in with_one
    everything = sk.skill_catalogue(skills, include_source=True)
    assert everything.count("```") == 6
    assert sk.skill_catalogue({}, include_source=True) == "(no saved skills)"
