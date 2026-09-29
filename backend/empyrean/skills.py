"""
Skill block language: parser, validator, compiler and resumable interpreter.
OWNER: models/context/skills team.

Owns
----
* Parsing the text notation from the design document into a ``Block`` tree.
* Validation at save time: size counting, action vocabulary, argument arity,
  literal argument values, referenced skill names, recursion cycles, reserved
  names, the "action call only as a whole SET right-hand side or bare
  statement" rule (A-SKILL-1).
* Compilation to a flat ``Instruction`` list with jump targets.
* A resumable interpreter whose entire state is the JSON-serialisable
  ``SkillExecutionState`` (frames with pc/vars/loops).
* Counting interpreter operations and their compute cost (A-SKILL-13).

Must not
--------
* Execute world actions or touch balances.  It yields ONE ``WorldAction`` per
  turn through ``SkillStepOutcome.action``; the runner executes it through
  ``world.apply_action`` and hands the ``ActionResult`` back with
  ``deliver_result``.
* Import world.py, storage.py, model.py or runner.py.
* Evaluate arbitrary Python.  Values are JSON values only.

Error behaviour
---------------
``parse_skill`` raises ``SkillSyntaxError(line, message)``; ``validate_and_build``
raises ``SkillValidationError(message)``.  Runtime errors (division by zero,
missing field, unknown variable, bad operand types, bad REPEAT count, CALL of
a missing skill, call depth) do not raise: the returned state has
``status="error"`` and ``last_error="line N: ..."``, and the outcome ``error``
is filled.  Op-budget exhaustion is a yield, not an error (A-SKILL-2).

State handling
--------------
``run_until_action``, ``deliver_result`` and ``stop_execution`` update the state
object they are given and return that same object, so callers may either keep
their reference or use the returned value.  Between two calls the state holds
only JSON values: ``model_dump(mode="json")`` followed by ``model_validate``
restores an equivalent state, and execution continues identically.

Terminal states: ``finished`` and ``stopped`` clear the frame stack (the call
stack has unwound); ``error`` keeps the frames so an inspector can show the
skill, pc and variables where it failed.

Design references: "Imperative blocks and expressions", "Examples using only the
defined blocks", "Turns speed and skill execution" and "Saved skill compute
discount" (manual_lab/2026-09-25_llm_world_running_design.md); docs/INTERFACES.md section 4.2.
"""

from __future__ import annotations

import copy
import math
import re
import string
from typing import Any, Iterator, Optional

from pydantic import TypeAdapter, ValidationError

from .schemas import (
    DIRECTION_VECTORS,
    UPGRADE_ATTRIBUTES,
    ActionCallExpr,
    ActionResult,
    BinaryExpr,
    Block,
    CallBlock,
    CoordExpr,
    Expr,
    ExprBlock,
    FieldExpr,
    ForEachBlock,
    IfBlock,
    Instruction,
    InvalidSkillAction,
    LiteralExpr,
    LoopState,
    RepeatBlock,
    ReturnBlock,
    SetBlock,
    SkillDefinition,
    SkillEnv,
    SkillExecutionState,
    SkillFrame,
    SkillRules,
    SkillSaveRequest,
    SkillStepOutcome,
    StopBlock,
    UnaryExpr,
    VarExpr,
    WorldAction,
)

KEYWORDS: tuple[str, ...] = ("SET", "IF", "ELSE", "END", "REPEAT", "FOR_EACH", "IN", "CALL", "INTO", "RETURN", "STOP", "AND", "OR", "NOT")
RESERVED_NAMES: tuple[str, ...] = ("self", "here", "true", "false", "null")
ACTION_ARITY: dict[str, tuple[int, int]] = {  # name -> (min, max)
    "move": (1, 1),
    "observe": (1, 2),  # observe(point) or observe(point, page)
    "query": (1, 1),
    "send": (2, 2),
    "broadcast": (1, 1),
    "absorb": (2, 2),
    "transfer": (3, 3),
    "recover": (1, 1),
    "attack": (2, 2),
    "upgrade": (1, 1),
    "wait": (1, 1),
}

# Positional parameter names of each action, in call order.  They are the keys of the
# ``args`` object of the corresponding ``*Args`` model in schemas.py (docs/INTERFACES.md
# section 6), so ``move("up")`` becomes ``{"name": "move", "args": {"direction": "up"}}``.
ACTION_PARAMS: dict[str, tuple[str, ...]] = {
    "move": ("direction",),
    "observe": ("point", "page"),
    "query": ("entity",),
    "send": ("recipient", "message"),
    "broadcast": ("message",),
    "absorb": ("source", "resource"),
    "transfer": ("recipient", "resource", "amount"),
    "recover": ("compute_budget",),
    "attack": ("target", "compute_budget"),
    "upgrade": ("attribute",),
    "wait": ("rounds",),
}

# Representation limits of the interpreter.  These are not gameplay rules (the gameplay
# limits are the agent's block/count stats and ``RulesConfig.skills``); they only keep
# parsing and values bounded so a hostile or careless source cannot exhaust the host.
MAX_BLOCK_NESTING = 32  # IF/REPEAT/FOR_EACH nested inside each other
MAX_EXPR_NESTING = 32  # depth of one expression tree / parser nesting (parentheses, operator chains)
MAX_EXACT_INT = 2**53  # larger integer results continue as floats (JSON / JavaScript safe range)
MAX_STRING_CHARS = 4096  # longest string a skill may build with "+"

OP_BUDGET_EXHAUSTED = "op_budget_exhausted"
INSUFFICIENT_COMPUTE = "insufficient_compute"

_NAME_PATTERN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_NAME_START = frozenset(string.ascii_letters + "_")
_NAME_CHARS = frozenset(string.ascii_letters + string.digits + "_")
_DIGITS = frozenset(string.digits)
_TWO_CHAR_OPS = ("==", "!=", "<=", ">=")
_ONE_CHAR_OPS = frozenset("+-*/<>")
_PUNCTUATION = {"(": "LPAREN", ")": "RPAREN", ",": "COMMA", ".": "DOT"}
_COMPARISON_OPS = ("==", "!=", "<", "<=", ">", ">=")
_IDENTIFIER_TYPES = ("NAME", "KEYWORD", "BOOL", "NULL")
_RESOURCES = ("compute", "essence")

_WORLD_ACTION_ADAPTER: TypeAdapter[Any] = TypeAdapter(WorldAction)
_EXPR_ADAPTER: TypeAdapter[Any] = TypeAdapter(Expr)

Token = tuple[str, str, int]


class SkillSyntaxError(Exception):
    def __init__(self, line: int, message: str) -> None:
        super().__init__(f"line {line}: {message}")
        self.line = line
        self.message = message


class SkillValidationError(Exception):
    """Semantic problem found at save time (limits, unknown skill, recursion, ...)."""


class SkillRuntimeError(Exception):
    """Runtime failure inside a skill; converted to status="error" by the interpreter."""


# ---------------------------------------------------------------------------
# Tokenizer
# ---------------------------------------------------------------------------


def tokenize(source: str) -> list[list[tuple[str, str, int]]]:
    """Split ``source`` into lines of ``(token_type, text, line_no)`` tuples.

    Token types: KEYWORD (see KEYWORDS), NAME, NUMBER (UNSIGNED: ``[0-9]+(\\.[0-9]+)?``;
    negation is the unary ``-`` operator, so ``b -1`` lexes as NAME OP NUMBER), STRING,
    BOOL (true/false), NULL (null), OP (+ - * / == != < <= > >=), LPAREN, RPAREN, COMMA,
    DOT, ASSIGN (=).  Blank lines and ``#`` comments are dropped.  Keywords are
    case-sensitive uppercase; ``true``/``false``/``null`` lowercase.

    A STRING token's text is the decoded value (quotes removed, ``\\"`` and ``\\\\``
    unescaped).  Line numbers are 1-based source lines, so blank and comment lines still
    count.  Raises ``SkillSyntaxError`` for characters outside the notation, unterminated
    strings, unknown escapes, and number literals outside the representable range.
    """
    lines: list[list[Token]] = []
    for line_no, raw_line in enumerate(source.split("\n"), start=1):
        tokens = _tokenize_line(raw_line, line_no)
        if tokens:
            lines.append(tokens)
    return lines


def _tokenize_line(text: str, line_no: int) -> list[Token]:
    tokens: list[Token] = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch in " \t\r\f\v":
            i += 1
            continue
        if ch == "#":
            break
        if ch in _NAME_START:
            j = i + 1
            while j < n and text[j] in _NAME_CHARS:
                j += 1
            word = text[i:j]
            tokens.append((_word_type(word), word, line_no))
            i = j
            continue
        if ch in _DIGITS:
            j = i
            while j < n and text[j] in _DIGITS:
                j += 1
            if j + 1 < n and text[j] == "." and text[j + 1] in _DIGITS:
                j += 1
                while j < n and text[j] in _DIGITS:
                    j += 1
            if j < n and text[j] in _NAME_START:
                raise SkillSyntaxError(line_no, f"invalid number '{text[i:j + 1]}' (names cannot start with a digit)")
            number_text = text[i:j]
            _number_value(number_text, line_no)  # range check only
            tokens.append(("NUMBER", number_text, line_no))
            i = j
            continue
        if ch == '"':
            value, i = _read_string(text, i, line_no)
            tokens.append(("STRING", value, line_no))
            continue
        pair = text[i : i + 2]
        if pair in _TWO_CHAR_OPS:
            tokens.append(("OP", pair, line_no))
            i += 2
            continue
        if ch in _ONE_CHAR_OPS:
            tokens.append(("OP", ch, line_no))
            i += 1
            continue
        if ch == "=":
            tokens.append(("ASSIGN", ch, line_no))
            i += 1
            continue
        if ch in _PUNCTUATION:
            tokens.append((_PUNCTUATION[ch], ch, line_no))
            i += 1
            continue
        if ch == "'":
            raise SkillSyntaxError(line_no, 'strings use double quotes: "text"')
        if ch == "!":
            raise SkillSyntaxError(line_no, "use NOT for negation and != for inequality")
        raise SkillSyntaxError(line_no, f"unexpected character {ch!r}")
    return tokens


def _word_type(word: str) -> str:
    if word in KEYWORDS:
        return "KEYWORD"
    if word in ("true", "false"):
        return "BOOL"
    if word == "null":
        return "NULL"
    return "NAME"


def _read_string(text: str, start: int, line_no: int) -> tuple[str, int]:
    """Read a double-quoted string starting at ``text[start] == '"'``.  Returns the decoded
    value and the index after the closing quote.  Only ``\\"`` and ``\\\\`` are escapes."""
    chars: list[str] = []
    i = start + 1
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == '"':
            return "".join(chars), i + 1
        if ch == "\\":
            if i + 1 < n and text[i + 1] in ('"', "\\"):
                chars.append(text[i + 1])
                i += 2
                continue
            escape = text[i : i + 2]
            raise SkillSyntaxError(line_no, f"unsupported escape {escape!r} in string (only \\\" and \\\\ are allowed)")
        chars.append(ch)
        i += 1
    raise SkillSyntaxError(line_no, "unterminated string (strings end on the same line)")


def _number_value(text: str, line_no: int) -> int | float:
    """Value of an unsigned NUMBER token: int without a decimal point, float with one."""
    if "." in text:
        value = float(text)
        if not math.isfinite(value):
            raise SkillSyntaxError(line_no, f"number {text[:20]}... is too large")
        return value
    number = int(text)
    if number > MAX_EXACT_INT:
        raise SkillSyntaxError(line_no, f"number {text[:20]}... is too large (limit {MAX_EXACT_INT})")
    return number


# ---------------------------------------------------------------------------
# Parser (grammar in docs/INTERFACES.md section 4.2)
# ---------------------------------------------------------------------------


def parse_skill(source: str) -> list[Block]:
    """Parse the text notation (grammar in docs/INTERFACES.md) into a block list.

    Statement forms (one per line; blocks close with ``END``):
      SET name = expr
      action(args)                       (bare action statement)
      IF expr ... [ELSE ...] END
      REPEAT expr ... END
      FOR_EACH name IN expr ... END
      CALL skill(args) [INTO name]
      RETURN [expr]
      STOP
    ``SET``/``FOR_EACH``/``INTO`` targets may not be reserved names, keywords or action
    names.  Raises ``SkillSyntaxError`` on the first problem.  Each block records ``line``.

    The parser also enforces A-SKILL-1: an action call may only be the entire right-hand
    side of ``SET`` or a statement of its own.  Operator precedence, lowest first:
    OR, AND, NOT, comparison (not chainable), + -, * /, unary -, field access ``.``.
    """
    return _Parser(tokenize(source)).parse_program()


class _Parser:
    """Statement-level recursive descent over the tokenized lines."""

    def __init__(self, lines: list[list[Token]]) -> None:
        self.lines = lines
        self.index = 0

    def parse_program(self) -> list[Block]:
        body, _closer, _line = self._parse_body(depth=0, owner=None)
        return body

    def _parse_body(self, depth: int, owner: Optional[tuple[str, int]]) -> tuple[list[Block], Optional[str], int]:
        """Parse statements until an ``END``/``ELSE`` line (not consumed) or the end of the
        source.  Returns (statements, closer keyword or None, closer line)."""
        body: list[Block] = []
        while self.index < len(self.lines):
            tokens = self.lines[self.index]
            kind, text, line = tokens[0]
            if kind == "KEYWORD" and text in ("END", "ELSE"):
                if owner is None:
                    raise SkillSyntaxError(line, f"{text} without a matching IF, REPEAT or FOR_EACH")
                if len(tokens) > 1:
                    if text == "ELSE":
                        raise SkillSyntaxError(
                            line, "ELSE must be alone on its line; put a nested IF on the next line and close it with its own END"
                        )
                    raise SkillSyntaxError(line, "END must be alone on its line")
                return body, text, line
            body.append(self._parse_statement(tokens, depth))
        if owner is not None:
            raise SkillSyntaxError(owner[1], f"{owner[0]} has no matching END")
        return body, None, 0

    def _parse_nested(self, depth: int, keyword: str, line: int, allow_else: bool) -> tuple[list[Block], list[Block]]:
        """Parse the body of a compound statement opened on ``line`` through its END."""
        if depth + 1 > MAX_BLOCK_NESTING:
            raise SkillSyntaxError(line, f"blocks are nested more than {MAX_BLOCK_NESTING} levels deep")
        owner = (keyword, line)
        body, closer, closer_line = self._parse_body(depth + 1, owner)
        self.index += 1  # consume the ELSE / END line
        else_body: list[Block] = []
        if closer == "ELSE":
            if not allow_else:
                raise SkillSyntaxError(closer_line, f"ELSE inside {keyword} without an IF")
            else_body, closer, closer_line = self._parse_body(depth + 1, owner)
            self.index += 1
            if closer == "ELSE":
                raise SkillSyntaxError(closer_line, "IF has more than one ELSE")
        return body, else_body

    def _parse_statement(self, tokens: list[Token], depth: int) -> Block:
        kind, text, line = tokens[0]
        self.index += 1
        cursor = _LineParser(tokens, line)
        if kind == "KEYWORD":
            cursor.pos = 1
            if text == "SET":
                target = cursor.take_name("variable", after="SET")
                cursor.expect("ASSIGN", "'=' after the SET variable name")
                expr = cursor.expression()
                cursor.expect_end()
                _check_action_placement(expr, line, whole_statement=True)
                return SetBlock(type="set", var=target, expr=expr, line=line)
            if text == "IF":
                cond = cursor.expression()
                cursor.expect_end()
                _check_action_placement(cond, line, whole_statement=False)
                then, else_body = self._parse_nested(depth, "IF", line, allow_else=True)
                return IfBlock(type="if", cond=cond, then=then, else_body=else_body, line=line)
            if text == "REPEAT":
                count = cursor.expression()
                cursor.expect_end()
                _check_action_placement(count, line, whole_statement=False)
                body, _ = self._parse_nested(depth, "REPEAT", line, allow_else=False)
                return RepeatBlock(type="repeat", count=count, body=body, line=line)
            if text == "FOR_EACH":
                var = cursor.take_name("loop variable", after="FOR_EACH")
                cursor.expect_keyword("IN")
                items = cursor.expression()
                cursor.expect_end()
                _check_action_placement(items, line, whole_statement=False)
                body, _ = self._parse_nested(depth, "FOR_EACH", line, allow_else=False)
                return ForEachBlock(type="for_each", var=var, list=items, body=body, line=line)
            if text == "CALL":
                skill = cursor.take_name("skill", after="CALL")
                cursor.expect("LPAREN", f"'(' after CALL {skill}")
                args = cursor.arguments()
                into: Optional[str] = None
                if cursor.match_keyword("INTO"):
                    into = cursor.take_name("variable", after="INTO")
                cursor.expect_end()
                for arg in args:
                    _check_action_placement(arg, line, whole_statement=False)
                return CallBlock(type="call", skill=skill, args=args, into=into, line=line)
            if text == "RETURN":
                value: Optional[Any] = None
                if not cursor.at_end():
                    value = cursor.expression()
                    cursor.expect_end()
                    _check_action_placement(value, line, whole_statement=False)
                return ReturnBlock(type="return", expr=value, line=line)
            if text == "STOP":
                cursor.expect_end()
                return StopBlock(type="stop", line=line)
            raise SkillSyntaxError(line, f"a statement cannot start with {text}")
        if kind == "NAME" and text in ACTION_ARITY:
            expr = cursor.expression()
            cursor.expect_end()
            if not isinstance(expr, ActionCallExpr):
                raise SkillSyntaxError(
                    line, "an action call may only be the whole right-hand side of SET or a statement of its own (A-SKILL-1)"
                )
            _check_action_placement(expr, line, whole_statement=True)
            return ExprBlock(type="expr", expr=expr, line=line)
        raise SkillSyntaxError(line, _statement_hint(tokens))


def _statement_hint(tokens: list[Token]) -> str:
    kind, text, _line = tokens[0]
    following = tokens[1] if len(tokens) > 1 else None
    if kind == "NAME" and text.upper() in KEYWORDS:
        return f"keywords are uppercase: write {text.upper()} instead of {text}"
    if kind == "NAME" and following is not None and following[0] == "ASSIGN":
        return f"assignments need SET: SET {text} = ..."
    if kind == "NAME" and following is not None and following[0] == "LPAREN":
        return f"unknown action '{text}'; saved skills are run with CALL {text}(...)"
    return "a statement must start with SET, IF, REPEAT, FOR_EACH, CALL, RETURN, STOP or an action call"


def _name_problem(name: str, role: str) -> Optional[str]:
    """Why ``name`` cannot be used as a variable / parameter / skill name, or None."""
    if not _NAME_PATTERN.fullmatch(name):
        return f"'{name}' is not a valid {role} name"
    if name in KEYWORDS:
        return f"'{name}' is a keyword and cannot be used as a {role} name"
    if name in RESERVED_NAMES:
        return f"'{name}' is reserved and cannot be used as a {role} name"
    if name in ACTION_ARITY:
        return f"'{name}' is an action name and cannot be used as a {role} name"
    return None


def _describe_token(token: Optional[Token]) -> str:
    if token is None:
        return "end of line"
    kind, text, _line = token
    if kind == "STRING":
        return "a string"
    return f"'{text}'"


class _LineParser:
    """Expression-level recursive descent over the tokens of one source line."""

    def __init__(self, tokens: list[Token], line: int) -> None:
        self.tokens = tokens
        self.line = line
        self.pos = 0
        self.nesting = 0

    # -- token helpers ------------------------------------------------------
    def peek(self) -> Optional[Token]:
        return self.tokens[self.pos] if self.pos < len(self.tokens) else None

    def at_end(self) -> bool:
        return self.pos >= len(self.tokens)

    def advance(self) -> Optional[Token]:
        token = self.peek()
        if token is not None:
            self.pos += 1
        return token

    def error(self, message: str) -> SkillSyntaxError:
        return SkillSyntaxError(self.line, message)

    def expect(self, kind: str, what: str) -> Token:
        token = self.peek()
        if token is None or token[0] != kind:
            raise self.error(f"expected {what}, found {_describe_token(token)}")
        self.pos += 1
        return token

    def expect_keyword(self, word: str) -> None:
        if not self.match_keyword(word):
            raise self.error(f"expected {word}, found {_describe_token(self.peek())}")

    def match_keyword(self, word: str) -> bool:
        token = self.peek()
        if token is not None and token[0] == "KEYWORD" and token[1] == word:
            self.pos += 1
            return True
        return False

    def match_op(self, *ops: str) -> Optional[str]:
        token = self.peek()
        if token is not None and token[0] == "OP" and token[1] in ops:
            self.pos += 1
            return token[1]
        return None

    def expect_end(self) -> None:
        token = self.peek()
        if token is None:
            return
        if token[0] == "ASSIGN":
            raise self.error("use == to compare; '=' only appears in SET")
        raise self.error(f"unexpected {_describe_token(token)}")

    def take_name(self, role: str, after: str) -> str:
        token = self.peek()
        if token is None or token[0] not in _IDENTIFIER_TYPES:
            raise self.error(f"expected a {role} name after {after}, found {_describe_token(token)}")
        self.pos += 1
        problem = _name_problem(token[1], role)
        if problem:
            raise self.error(problem)
        return token[1]

    def _enter(self) -> None:
        self.nesting += 1
        if self.nesting > MAX_EXPR_NESTING:
            raise self.error(f"expression nested more than {MAX_EXPR_NESTING} levels deep")

    def _leave(self) -> None:
        self.nesting -= 1

    # -- grammar ------------------------------------------------------------
    def expression(self) -> Any:
        """expr = or_expr.  Also checks the depth of the resulting tree."""
        self._enter()
        try:
            node = self._or_expr()
        finally:
            self._leave()
        if _expr_depth(node) > MAX_EXPR_NESTING:
            raise self.error(f"expression nested more than {MAX_EXPR_NESTING} levels deep")
        return node

    def _or_expr(self) -> Any:
        left = self._and_expr()
        while self.match_keyword("OR"):
            right = self._and_expr()
            left = BinaryExpr(type="binary", op="OR", left=left, right=right)
        return left

    def _and_expr(self) -> Any:
        left = self._not_expr()
        while self.match_keyword("AND"):
            right = self._not_expr()
            left = BinaryExpr(type="binary", op="AND", left=left, right=right)
        return left

    def _not_expr(self) -> Any:
        if self.match_keyword("NOT"):
            self._enter()
            try:
                operand = self._not_expr()
            finally:
                self._leave()
            return UnaryExpr(type="unary", op="NOT", operand=operand)
        return self._comparison()

    def _comparison(self) -> Any:
        left = self._additive()
        op = self.match_op(*_COMPARISON_OPS)
        if op is None:
            return left
        right = self._additive()
        token = self.peek()
        if token is not None and token[0] == "OP" and token[1] in _COMPARISON_OPS:
            raise self.error("comparisons cannot be chained; combine them with AND")
        return BinaryExpr(type="binary", op=op, left=left, right=right)

    def _additive(self) -> Any:
        left = self._term()
        while True:
            op = self.match_op("+", "-")
            if op is None:
                return left
            left = BinaryExpr(type="binary", op=op, left=left, right=self._term())

    def _term(self) -> Any:
        left = self._unary()
        while True:
            op = self.match_op("*", "/")
            if op is None:
                return left
            left = BinaryExpr(type="binary", op=op, left=left, right=self._unary())

    def _unary(self) -> Any:
        if self.match_op("-"):
            self._enter()
            try:
                operand = self._unary()
            finally:
                self._leave()
            return UnaryExpr(type="unary", op="-", operand=operand)
        return self._postfix()

    def _postfix(self) -> Any:
        node = self._primary()
        while True:
            token = self.peek()
            if token is None or token[0] != "DOT":
                return node
            self.pos += 1
            name_token = self.peek()
            if name_token is None or name_token[0] not in _IDENTIFIER_TYPES:
                raise self.error(f"expected a field name after '.', found {_describe_token(name_token)}")
            self.pos += 1
            node = FieldExpr(type="field", obj=node, name=name_token[1])

    def _primary(self) -> Any:
        token = self.advance()
        if token is None:
            raise self.error("expected a value at the end of the line")
        kind, text, _line = token
        if kind == "NUMBER":
            return LiteralExpr(type="literal", value=_number_value(text, self.line))
        if kind == "STRING":
            return LiteralExpr(type="literal", value=text)
        if kind == "BOOL":
            return LiteralExpr(type="literal", value=(text == "true"))
        if kind == "NULL":
            return LiteralExpr(type="literal", value=None)
        if kind == "NAME":
            following = self.peek()
            calls = following is not None and following[0] == "LPAREN"
            if text in ACTION_ARITY:
                if not calls:
                    raise self.error(f"action '{text}' must be called with parentheses, e.g. {text}(...)")
                self.pos += 1
                return ActionCallExpr(type="action", action=text, args=self.arguments())
            if calls:
                raise self.error(f"unknown action '{text}'; saved skills are run with CALL {text}(...) on their own line")
            return VarExpr(type="var", name=text)
        if kind == "LPAREN":
            first = self.expression()
            separator = self.peek()
            if separator is not None and separator[0] == "COMMA":
                self.pos += 1
                second = self.expression()
                self.expect("RPAREN", "')' to close the coordinate pair")
                return CoordExpr(type="coord", x=first, y=second)
            self.expect("RPAREN", "')'")
            return first
        if kind == "KEYWORD":
            raise self.error(f"unexpected keyword {text} inside an expression")
        if kind == "ASSIGN":
            raise self.error("use == to compare; '=' only appears in SET")
        raise self.error(f"unexpected {_describe_token(token)}")

    def arguments(self) -> list[Any]:
        """Comma-separated expressions after an already consumed '(' through the ')'."""
        args: list[Any] = []
        token = self.peek()
        if token is not None and token[0] == "RPAREN":
            self.pos += 1
            return args
        while True:
            args.append(self.expression())
            token = self.peek()
            if token is not None and token[0] == "COMMA":
                self.pos += 1
                continue
            self.expect("RPAREN", "',' or ')' in the argument list")
            return args


def _expr_children(expr: Any) -> list[Any]:
    if isinstance(expr, FieldExpr):
        return [expr.obj]
    if isinstance(expr, CoordExpr):
        return [expr.x, expr.y]
    if isinstance(expr, BinaryExpr):
        return [expr.left, expr.right]
    if isinstance(expr, UnaryExpr):
        return [expr.operand]
    if isinstance(expr, ActionCallExpr):
        return list(expr.args)
    return []


def _expr_depth(expr: Any) -> int:
    """Depth of an expression tree, computed without recursion (operator chains such as
    ``1 + 1 + 1 ...`` build deep trees without deep parser recursion)."""
    deepest = 0
    stack = [(expr, 1)]
    while stack:
        node, depth = stack.pop()
        deepest = max(deepest, depth)
        for child in _expr_children(node):
            stack.append((child, depth + 1))
    return deepest


def _iter_expr_nodes(expr: Any) -> Iterator[Any]:
    """Every node of an expression tree in source (pre-)order."""
    yield expr
    for child in _expr_children(expr):
        yield from _iter_expr_nodes(child)


def _check_action_placement(expr: Any, line: int, whole_statement: bool) -> None:
    """A-SKILL-1: an action call may be only the entire SET right-hand side or a bare
    statement.  ``whole_statement`` is True when ``expr`` is in such a position."""
    nested = list(_expr_children(expr)) if (whole_statement and isinstance(expr, ActionCallExpr)) else [expr]
    for root in nested:
        for node in _iter_expr_nodes(root):
            if isinstance(node, ActionCallExpr):
                raise SkillSyntaxError(
                    line,
                    f"{node.action}(...) is used inside an expression; an action call may only be the whole "
                    "right-hand side of SET or a statement of its own (A-SKILL-1)",
                )


# ---------------------------------------------------------------------------
# Tree walking, counting and compilation
# ---------------------------------------------------------------------------


def _iter_blocks(blocks: list[Any]) -> Iterator[Any]:
    """Every statement in source order (a compound statement before its bodies)."""
    for block in blocks:
        yield block
        if isinstance(block, IfBlock):
            yield from _iter_blocks(block.then)
            yield from _iter_blocks(block.else_body)
        elif isinstance(block, (RepeatBlock, ForEachBlock)):
            yield from _iter_blocks(block.body)


def _block_expressions(block: Any) -> list[Any]:
    """The expressions written on a statement's own line (not those of nested bodies)."""
    if isinstance(block, (SetBlock, ExprBlock)):
        return [block.expr]
    if isinstance(block, IfBlock):
        return [block.cond]
    if isinstance(block, RepeatBlock):
        return [block.count]
    if isinstance(block, ForEachBlock):
        return [block.list]
    if isinstance(block, CallBlock):
        return list(block.args)
    if isinstance(block, ReturnBlock):
        return [block.expr] if block.expr is not None else []
    return []


def _expr_block_cost(expr: Any) -> int:
    """A-SKILL-4 size of an expression: 1 per binary/unary op, field access, coord and
    action call; literals and names are free."""
    return sum(1 for node in _iter_expr_nodes(expr) if not isinstance(node, (LiteralExpr, VarExpr)))


def _expr_max_ops(expr: Any) -> int:
    """A-SKILL-13 maximum op cost of an expression: like the block cost, except the
    action-call node itself is free (its arguments are not)."""
    return sum(1 for node in _iter_expr_nodes(expr) if not isinstance(node, (LiteralExpr, VarExpr, ActionCallExpr)))


def count_blocks(blocks: list[Block]) -> int:
    """Size per A-SKILL-4: every statement counts 1 (SET, expr, IF, REPEAT, FOR_EACH, CALL,
    RETURN, STOP), plus 1 per expression operation (binary/unary op, field access, coord,
    action call).  Literals, variable names, ELSE and END count 0.  Design example 2 = 48."""
    total = 0
    for block in _iter_blocks(blocks):
        total += 1 + sum(_expr_block_cost(expr) for expr in _block_expressions(block))
    return total


def compile_skill(blocks: list[Block]) -> list[Instruction]:
    """Flatten a block tree into instructions (set/eval/jump/jump_if_false/loop_start/
    loop_next/call/return/stop) with absolute pc targets; a trailing ``return`` (no expr)
    is appended so falling off the end returns null.  See docs/INTERFACES.md "Compiled
    instruction set" for the exact layout of IF/REPEAT/FOR_EACH.

    An IF without ELSE compiles to ``jump_if_false c -> end`` followed by the body (no
    jump).  The implicit trailing return carries the line of the last statement."""
    code: list[Instruction] = []
    _emit_body(blocks, code)
    last_line = max((block.line for block in _iter_blocks(blocks)), default=0)
    code.append(Instruction(op="return", line=last_line))
    return code


def _emit_body(blocks: list[Any], code: list[Instruction]) -> None:
    for block in blocks:
        _emit_block(block, code)


def _emit_block(block: Any, code: list[Instruction]) -> None:
    line = block.line
    if isinstance(block, SetBlock):
        code.append(Instruction(op="set", var=block.var, expr=block.expr, line=line))
    elif isinstance(block, ExprBlock):
        code.append(Instruction(op="eval", expr=block.expr, line=line))
    elif isinstance(block, IfBlock):
        branch = Instruction(op="jump_if_false", expr=block.cond, target=0, line=line)
        code.append(branch)
        _emit_body(block.then, code)
        if block.else_body:
            skip_else = Instruction(op="jump", target=0, line=line)
            code.append(skip_else)
            branch.target = len(code)
            _emit_body(block.else_body, code)
            skip_else.target = len(code)
        else:
            branch.target = len(code)
    elif isinstance(block, (RepeatBlock, ForEachBlock)):
        start_pc = len(code)
        if isinstance(block, RepeatBlock):
            start = Instruction(op="loop_start", loop_kind="repeat", expr=block.count, target=0, line=line)
        else:
            start = Instruction(op="loop_start", loop_kind="for_each", expr=block.list, var=block.var, target=0, line=line)
        code.append(start)
        _emit_body(block.body, code)
        code.append(Instruction(op="loop_next", target=start_pc, line=line))
        start.target = len(code)
    elif isinstance(block, CallBlock):
        code.append(Instruction(op="call", skill=block.skill, args=list(block.args), var=block.into, line=line))
    elif isinstance(block, ReturnBlock):
        code.append(Instruction(op="return", expr=block.expr, line=line))
    elif isinstance(block, StopBlock):
        code.append(Instruction(op="stop", line=line))
    else:  # pragma: no cover - the Block union is closed
        raise SkillValidationError(f"unknown block {type(block).__name__}")


def find_action_calls(blocks: list[Block]) -> list[tuple[int, str]]:
    """(line, action_name) for every action call, used for validation and the catalogue."""
    found: list[tuple[int, str]] = []
    for block in _iter_blocks(blocks):
        for expr in _block_expressions(block):
            for node in _iter_expr_nodes(expr):
                if isinstance(node, ActionCallExpr):
                    found.append((block.line, node.action))
    return found


def _called_skills(blocks: list[Any]) -> list[str]:
    """Distinct CALL targets in order of first appearance."""
    names: list[str] = []
    for block in _iter_blocks(blocks):
        if isinstance(block, CallBlock) and block.skill not in names:
            names.append(block.skill)
    return names


# ---------------------------------------------------------------------------
# Save-time validation
# ---------------------------------------------------------------------------


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _is_whole_number(value: Any) -> bool:
    return _is_number(value) and math.isfinite(value) and float(value).is_integer()


_NOT_LITERAL = object()


def _static_value(expr: Any) -> Any:
    """The value of a literal argument (``-`` applied to a number literal counts as a
    literal), or ``_NOT_LITERAL`` for anything computed at runtime."""
    if isinstance(expr, LiteralExpr):
        return expr.value
    if isinstance(expr, UnaryExpr) and expr.op == "-":
        inner = _static_value(expr.operand)
        if _is_number(inner):
            return -inner
    return _NOT_LITERAL


def _literal_argument_problem(action: str, param: str, expr: Any) -> Optional[str]:
    """A-SKILL-12 literal argument checks; computed arguments are checked at runtime."""
    if param == "point":
        if isinstance(expr, CoordExpr):
            for axis, part in (("x", expr.x), ("y", expr.y)):
                value = _static_value(part)
                if value is not _NOT_LITERAL and not _is_whole_number(value):
                    return f"{action} point {axis} must be a whole number"
            return None
        if _static_value(expr) is not _NOT_LITERAL:
            return f"{action} needs a coordinate such as (x, y) or here"
        return None
    value = _static_value(expr)
    if value is _NOT_LITERAL:
        return None
    if param == "direction":
        if value not in DIRECTION_VECTORS:
            return 'move direction must be one of "up", "down", "left", "right"'
    elif param == "resource":
        if value not in _RESOURCES:
            return f'{action} resource must be "compute" or "essence"'
    elif param == "attribute":
        if value not in UPGRADE_ATTRIBUTES:
            return f"upgrade attribute must be one of {', '.join(UPGRADE_ATTRIBUTES)}"
    elif param in ("amount", "compute_budget"):
        if not (_is_number(value) and math.isfinite(value) and value > 0):
            return f"{action} {param} must be a positive number"
    elif param == "rounds":
        if not (_is_whole_number(value) and value >= 1):
            return "wait rounds must be a positive whole number"
    elif param == "page":
        if not (_is_whole_number(value) and value >= 0):
            return "observe page must be a whole number >= 0"
    elif param in ("entity", "recipient", "source", "target", "message"):
        if not isinstance(value, str):
            return f"{action} {param} must be a string"
    return None


def _check_action_calls(blocks: list[Any]) -> None:
    """Arity per ACTION_ARITY and literal argument checks for every action call."""
    for block in _iter_blocks(blocks):
        for expr in _block_expressions(block):
            for node in _iter_expr_nodes(expr):
                if not isinstance(node, ActionCallExpr):
                    continue
                low, high = ACTION_ARITY[node.action]
                count = len(node.args)
                if not low <= count <= high:
                    expected = str(low) if low == high else f"{low} or {high}"
                    raise SkillValidationError(
                        f"line {block.line}: {node.action} takes {expected} argument(s) "
                        f"({', '.join(ACTION_PARAMS[node.action][:high])}), got {count}"
                    )
                for param, arg in zip(ACTION_PARAMS[node.action], node.args):
                    problem = _literal_argument_problem(node.action, param, arg)
                    if problem:
                        raise SkillValidationError(f"line {block.line}: {problem}")


def _check_loop_literals(blocks: list[Any], rules: SkillRules) -> None:
    """A literal REPEAT count must be a whole number 0..max_repeat_count (A-SKILL-12) and a
    literal can never be a FOR_EACH list; both would be certain runtime errors."""
    for block in _iter_blocks(blocks):
        if isinstance(block, RepeatBlock):
            value = _static_value(block.count)
            if value is not _NOT_LITERAL and not (_is_whole_number(value) and 0 <= value <= rules.max_repeat_count):
                raise SkillValidationError(
                    f"line {block.line}: REPEAT count must be a whole number from 0 to {rules.max_repeat_count}"
                )
        elif isinstance(block, ForEachBlock):
            if _static_value(block.list) is not _NOT_LITERAL:
                raise SkillValidationError(f"line {block.line}: FOR_EACH needs a list, such as observation.data.entities")


def _check_calls(request: SkillSaveRequest, blocks: list[Any], existing: dict[str, SkillDefinition], rules: SkillRules) -> None:
    """Every CALL target exists (or is the skill itself) with the exact arity; call cycles
    are rejected unless ``rules.allow_recursion`` (A-SKILL-8, A-SKILL-14)."""
    for block in _iter_blocks(blocks):
        if not isinstance(block, CallBlock):
            continue
        if block.skill == request.name:
            params = list(request.params)
        elif block.skill in existing:
            params = list(existing[block.skill].params)
        else:
            raise SkillValidationError(
                f"line {block.line}: CALL of unknown skill '{block.skill}' (save it first, earlier in save_skills)"
            )
        if len(block.args) != len(params):
            raise SkillValidationError(
                f"line {block.line}: {block.skill} takes {len(params)} argument(s), got {len(block.args)}"
            )
    if rules.allow_recursion:
        return
    cycle = _find_call_cycle(request.name, _called_skills(blocks), existing)
    if cycle:
        raise SkillValidationError(f"recursive skill calls are not allowed: {' -> '.join(cycle)}")


def _find_call_cycle(name: str, new_calls: list[str], existing: dict[str, SkillDefinition]) -> Optional[list[str]]:
    """A call path from ``name`` back to itself through the saved skills (with ``name``'s
    calls replaced by ``new_calls``), or None."""
    graph: dict[str, list[str]] = {other: list(defn.calls or _called_skills(defn.blocks)) for other, defn in existing.items()}
    graph[name] = list(new_calls)
    visited: set[str] = set()

    def walk(current: str, path: list[str]) -> Optional[list[str]]:
        for callee in graph.get(current, []):
            if callee == name:
                return path + [callee]
            if callee not in visited:
                visited.add(callee)
                found = walk(callee, path + [callee])
                if found:
                    return found
        return None

    return walk(name, [name])


def _check_callers_arity(request: SkillSaveRequest, existing: dict[str, SkillDefinition]) -> None:
    """Re-saving a called skill must keep every existing caller's argument count
    (A-SKILL-14)."""
    for caller_name in sorted(existing):
        if caller_name == request.name:
            continue
        for block in _iter_blocks(existing[caller_name].blocks):
            if isinstance(block, CallBlock) and block.skill == request.name and len(block.args) != len(request.params):
                raise SkillValidationError(f"caller {caller_name} expects {len(block.args)} arguments")


def validate_and_build(
    request: SkillSaveRequest,
    existing: dict[str, SkillDefinition],
    skill_count_limit: int,
    skill_block_limit: int,
    rules: SkillRules,
    round_no: int,
) -> SkillDefinition:
    """Parse, validate and compile one ``SkillSaveRequest`` into a ``SkillDefinition``.

    Checks, in order (first failure raises ``SkillValidationError`` with the line):
      * ``request.name`` is not a keyword, action name or reserved name
      * ``len(source) <= rules.max_source_chars``
      * syntax (``SkillSyntaxError`` is re-raised as SkillValidationError with the line)
      * the source has at least one statement
      * params are unique valid names, none reserved/keyword/action
      * action calls appear only as a whole SET rhs or a bare statement; arity per
        ``ACTION_ARITY`` (observe 1-2)
      * literal arguments (A-SKILL-12): direction in {up,down,left,right}; resource in
        {compute,essence}; attribute in UPGRADE_ATTRIBUTES; literal budgets/amounts > 0
        and finite; literal wait a positive integer; literal page an integer >= 0; literal
        coordinates integers; literal ids/messages strings.  A literal REPEAT count must be
        a whole number 0..max_repeat_count and a literal cannot be a FOR_EACH list.
        Non-literal expressions are checked at runtime (A-ACT-13).
      * every CALL target exists in ``existing`` or is ``request.name`` (self-call) and the
        argument count equals its params; recursion (direct or via ``calls`` chains) is
        rejected unless ``rules.allow_recursion``
      * ``count_blocks(blocks) <= skill_block_limit``
      * saving a NEW name must keep ``len(existing) + 1 <= skill_count_limit``
        (overwriting an existing name is always allowed)
      * when overwriting: every existing skill that CALLs ``request.name`` must still
        match the new arity ("caller X expects N arguments") (A-SKILL-14)
    The runner processes ``Decision.save_skills`` in list order against the growing dict.
    ``existing`` is not modified.
    """
    name = request.name
    problem = _name_problem(name, "skill")
    if problem:
        raise SkillValidationError(problem)
    if len(request.source) > rules.max_source_chars:
        raise SkillValidationError(
            f"source is {len(request.source)} characters; the limit is {rules.max_source_chars}"
        )
    try:
        blocks = parse_skill(request.source)
    except SkillSyntaxError as exc:
        raise SkillValidationError(str(exc)) from None
    if not blocks:
        raise SkillValidationError("the skill has no statements")
    seen: set[str] = set()
    for param in request.params:
        problem = _name_problem(param, "parameter")
        if problem:
            raise SkillValidationError(problem)
        if param in seen:
            raise SkillValidationError(f"parameter '{param}' is listed twice")
        seen.add(param)
    _check_action_calls(blocks)
    _check_loop_literals(blocks, rules)
    _check_calls(request, blocks, existing, rules)
    size = count_blocks(blocks)
    if size > skill_block_limit:
        raise SkillValidationError(f"the skill has {size} blocks; your per-skill block limit is {skill_block_limit}")
    if name not in existing and len(existing) + 1 > skill_count_limit:
        raise SkillValidationError(
            f"you already have {len(existing)} saved skills and your limit is {skill_count_limit}; "
            "delete one or overwrite an existing name"
        )
    _check_callers_arity(request, existing)
    return SkillDefinition(
        name=name,
        params=list(request.params),
        source=request.source,
        blocks=blocks,
        compiled=compile_skill(blocks),
        block_count=size,
        saved_round=round_no,
        calls=_called_skills(blocks),
    )


def check_delete(name: str, existing: dict[str, SkillDefinition]) -> Optional[str]:
    """None when ``name`` may be deleted; otherwise "referenced by X, Y" (A-SKILL-14) or
    "unknown skill".  A skill that only calls itself (recursion enabled) may be deleted."""
    if name not in existing:
        return "unknown skill"
    callers = sorted(
        other
        for other, defn in existing.items()
        if other != name and name in (defn.calls or _called_skills(defn.blocks))
    )
    if callers:
        return "referenced by " + ", ".join(callers)
    return None


# ---------------------------------------------------------------------------
# Interpreter
# ---------------------------------------------------------------------------


def start_execution(
    skill_name: str, arguments: list[Any], skills: dict[str, SkillDefinition], round_no: int
) -> SkillExecutionState:
    """Create the initial state: one frame for ``skill_name`` with params bound to
    ``arguments``.  Raises ``SkillValidationError`` if the skill does not exist or the
    argument count differs from its params (exact arity, A-SKILL-14)."""
    skill = skills.get(skill_name)
    if skill is None:
        raise SkillValidationError(f"unknown skill '{skill_name}'")
    if len(arguments) != len(skill.params):
        listed = ", ".join(skill.params) or "none"
        raise SkillValidationError(
            f"{skill_name} takes {len(skill.params)} argument(s) ({listed}), got {len(arguments)}"
        )
    values = copy.deepcopy(list(arguments))
    frame = SkillFrame(skill=skill_name, pc=0, vars=dict(zip(skill.params, copy.deepcopy(values))))
    return SkillExecutionState(
        root_skill=skill_name,
        arguments=values,
        frames=[frame],
        status="running",
        started_round=round_no,
    )


def frames_use(state: SkillExecutionState) -> set[str]:
    """Names of every skill in ``state.frames`` (the running call stack)."""
    return {frame.skill for frame in state.frames}


def stop_execution(state: SkillExecutionState, reason: str) -> SkillExecutionState:
    """Mark the execution ``status="stopped"`` with ``last_error=reason`` ("interrupted",
    "skill_modified", "replaced", "operator") and clear pending fields and the frame
    stack.  No-op when already finished/stopped/error."""
    if state.status in ("finished", "stopped", "error"):
        return state
    state.status = "stopped"
    state.last_error = reason
    state.pending_action = None
    state.pending_result_var = None
    state.frames = []
    return state


def _instruction_max_ops(instruction: Instruction) -> int:
    """Static (maximum) op cost of one instruction: 1 + every counted node of its
    expressions, assuming no short-circuit (A-SKILL-13)."""
    cost = 1
    if instruction.expr is not None:
        cost += _expr_max_ops(instruction.expr)
    for arg in instruction.args:
        cost += _expr_max_ops(arg)
    return cost


def run_until_action(
    state: SkillExecutionState,
    skills: dict[str, SkillDefinition],
    rules: SkillRules,
    env: SkillEnv,
    compute_available: float,
) -> SkillStepOutcome:
    """Execute local logic until a world action is reached, the skill finishes/stops,
    an error occurs, or the per-turn op budget is exhausted.

    * Op accounting (A-SKILL-13): 1 op per executed instruction + 1 per evaluated
      operator / field access / coord node (literals, variable reads and the action-call
      node are free).  ``AND``/``OR`` short-circuit left to right: when the left operand
      decides the result, neither the right operand nor the ``AND``/``OR`` node itself is
      counted (the contract's worked number: ``IF a.ok == true AND b > 1`` with a false
      ``a.ok`` costs 1 + 2 = 3 ops; fully evaluated it costs 5, its static maximum).
      Before each instruction its maximum static cost is computed;
      if ``ops_this_turn + cost > rules.max_ops_per_turn`` the instruction is NOT started
      and the step yields: status stays "running", ``last_error="op_budget_exhausted"``,
      no action this turn (A-SKILL-2).  An instruction whose static cost alone exceeds
      ``max_ops_per_turn`` could never run, so it is a runtime error instead of an endless
      yield.  If the op cost of this step would exceed ``compute_available`` the state
      becomes "error" with ``"insufficient_compute"``.
      ``cost_compute = ops_used * rules.interpreter_cost_per_op`` (unrounded).
    * On reaching an action call the argument expressions are evaluated and converted
      (coords from ``{x,y}`` records or ``[x, y]`` pairs; whole-number floats become ints
      where the action needs an integer: coordinates, ``page``, ``rounds``;
      ``observe(p)`` -> page 0) and validated with the same strict ``WorldAction``
      TypeAdapter as LLM decisions.  Valid: the outcome carries
      ``action``, the state has ``status="awaiting_action_result"``, ``pending_action`` and
      ``pending_result_var`` (SET target or None).  Invalid (A-ACT-13): the interpreter
      stores ``ActionResult(ok=False, reason="invalid_argument", cost 0, round=env.round,
      data={"error": msg})`` into the SET variable, advances the pc, keeps status
      "running" and returns ``invalid_action`` (the runner uses the turn).  An argument
      expression that itself fails (missing field, division by zero) is a runtime error.
    * ``self`` evaluates to the string ``env.agent_id`` (``query(self)`` is a self-query in
      world.py because the id equals the caller's); ``here`` to ``{"x":..,"y":..}``.
    * ``REPEAT`` count: an integer-valued number >= 0 up to ``rules.max_repeat_count``,
      else a runtime error (A-SKILL-12).  ``CALL`` of a missing skill or beyond
      ``rules.max_call_depth`` is a runtime error.
    * Equality is type-strict: booleans never equal numbers; ``3 == 3.0`` is true; lists
      and records compare structurally.
    * ``ops_this_turn`` is reset to 0 by the caller at the start of each turn.
    The caller must call ``deliver_result`` before the next ``run_until_action`` when an
    ``action`` was returned (calling it on an awaiting state raises SkillValidationError).
    A state that is already finished/stopped/error is returned unchanged with 0 ops.
    """
    if state.status == "awaiting_action_result":
        raise SkillValidationError("the skill is waiting for an action result; call deliver_result first")
    if state.status != "running":
        return SkillStepOutcome(state=state)
    if state.last_error == OP_BUDGET_EXHAUSTED:
        state.last_error = None

    ops_used = 0
    action: Optional[Any] = None
    invalid: Optional[InvalidSkillAction] = None
    error: Optional[str] = None
    while True:
        if not state.frames:
            state.status = "finished"
            break
        frame = state.frames[-1]
        skill = skills.get(frame.skill)
        if skill is None:
            error = _fail(state, f"skill '{frame.skill}' no longer exists")
            break
        if not 0 <= frame.pc < len(skill.compiled):
            error = _fail(state, f"internal error: position {frame.pc} is outside skill '{frame.skill}'")
            break
        instruction = skill.compiled[frame.pc]
        cost = _instruction_max_ops(instruction)
        if cost > rules.max_ops_per_turn:
            error = _fail(
                state,
                f"line {instruction.line}: this statement needs up to {cost} ops but at most "
                f"{rules.max_ops_per_turn} run per turn",
            )
            break
        if state.ops_this_turn + cost > rules.max_ops_per_turn:
            state.last_error = OP_BUDGET_EXHAUSTED
            break
        if (ops_used + cost) * rules.interpreter_cost_per_op > compute_available:
            error = _fail(state, INSUFFICIENT_COMPUTE)
            break
        counter = [0]
        try:
            kind, payload = _execute(instruction, state, frame, skills, rules, env, counter)
        except SkillRuntimeError as exc:
            kind, payload = "error", f"line {instruction.line}: {exc}"
        spent = 1 + counter[0]
        ops_used += spent
        state.ops_this_turn += spent
        state.total_ops += spent
        if kind == "continue":
            continue
        if kind == "action":
            action = payload
        elif kind == "invalid":
            invalid = payload
        elif kind == "error":
            error = _fail(state, payload)
        break

    cost_compute = ops_used * rules.interpreter_cost_per_op
    state.total_interpreter_cost += cost_compute
    return SkillStepOutcome(
        state=state,
        action=action,
        invalid_action=invalid,
        ops_used=ops_used,
        cost_compute=cost_compute,
        error=error,
    )


def _fail(state: SkillExecutionState, message: str) -> str:
    """Put the state into "error" (frames kept for inspection) and return the message."""
    state.status = "error"
    state.last_error = message
    state.pending_action = None
    state.pending_result_var = None
    return message


def _execute(
    instruction: Instruction,
    state: SkillExecutionState,
    frame: SkillFrame,
    skills: dict[str, SkillDefinition],
    rules: SkillRules,
    env: SkillEnv,
    counter: list[int],
) -> tuple[str, Any]:
    """Run one instruction.  Returns ("continue", None), ("action", WorldAction),
    ("invalid", InvalidSkillAction) or ("ended", None) (finished or stopped)."""
    op = instruction.op
    if op in ("set", "eval"):
        if isinstance(instruction.expr, ActionCallExpr):
            return _begin_action(instruction, state, frame, rules, env, counter)
        value = evaluate(instruction.expr, frame.vars, env, counter, rules)
        if op == "set" and instruction.var is not None:
            frame.vars[instruction.var] = value
        frame.pc += 1
        return "continue", None
    if op == "jump":
        frame.pc = _target(instruction)
        return "continue", None
    if op == "jump_if_false":
        condition = evaluate(instruction.expr, frame.vars, env, counter, rules)
        if not isinstance(condition, bool):
            raise SkillRuntimeError(f"IF condition must be true or false, got {_type_name(condition)}")
        frame.pc = frame.pc + 1 if condition else _target(instruction)
        return "continue", None
    if op == "loop_start":
        _loop_start(instruction, frame, rules, env, counter)
        return "continue", None
    if op == "loop_next":
        _loop_next(instruction, frame)
        return "continue", None
    if op == "call":
        _call(instruction, state, frame, skills, rules, env, counter)
        return "continue", None
    if op == "return":
        value = evaluate(instruction.expr, frame.vars, env, counter, rules) if instruction.expr is not None else None
        return _return(state, value)
    if op == "stop":
        state.status = "stopped"
        state.last_error = "stopped"
        state.frames = []
        return "ended", None
    raise SkillRuntimeError(f"unknown instruction '{op}'")


def _target(instruction: Instruction) -> int:
    if instruction.target is None:
        raise SkillRuntimeError(f"internal error: {instruction.op} has no target")
    return instruction.target


def _loop_start(instruction: Instruction, frame: SkillFrame, rules: SkillRules, env: SkillEnv, counter: list[int]) -> None:
    """Evaluate the count/list once, push a LoopState and enter the body, or jump to the
    exit target when there are zero iterations."""
    value = evaluate(instruction.expr, frame.vars, env, counter, rules)
    exit_pc = _target(instruction)
    if instruction.loop_kind == "repeat":
        count = _repeat_count(value, rules.max_repeat_count)
        if count == 0:
            frame.pc = exit_pc
            return
        frame.loops.append(LoopState(kind="repeat", start_pc=frame.pc, end_pc=exit_pc, remaining=count))
    else:
        if not isinstance(value, list):
            raise SkillRuntimeError(f"FOR_EACH needs a list, got {_type_name(value)}")
        if not value:
            frame.pc = exit_pc
            return
        items = list(value)
        var = instruction.var or ""
        frame.loops.append(LoopState(kind="for_each", start_pc=frame.pc, end_pc=exit_pc, var=var, items=items, index=0))
        frame.vars[var] = items[0]
    frame.pc += 1


def _repeat_count(value: Any, maximum: int) -> int:
    if not _is_whole_number(value) or not 0 <= value <= maximum:
        shown = value if _is_number(value) else _type_name(value)
        raise SkillRuntimeError(f"REPEAT count must be a whole number from 0 to {maximum}, got {shown}")
    return int(value)


def _loop_next(instruction: Instruction, frame: SkillFrame) -> None:
    """Advance the innermost loop: back to the first body instruction if iterations
    remain (rebinding the FOR_EACH variable), else pop it and continue at its exit."""
    if not frame.loops or frame.loops[-1].start_pc != instruction.target:
        raise SkillRuntimeError("internal error: loop state does not match the compiled code")
    loop = frame.loops[-1]
    if loop.kind == "repeat":
        loop.remaining -= 1
        more = loop.remaining > 0
    else:
        loop.index += 1
        more = loop.index < len(loop.items)
        if more and loop.var:
            frame.vars[loop.var] = loop.items[loop.index]
    if more:
        frame.pc = loop.start_pc + 1
    else:
        frame.loops.pop()
        frame.pc = loop.end_pc


def _call(
    instruction: Instruction,
    state: SkillExecutionState,
    frame: SkillFrame,
    skills: dict[str, SkillDefinition],
    rules: SkillRules,
    env: SkillEnv,
    counter: list[int],
) -> None:
    """Push a frame for the called skill with its params bound; the caller resumes after
    the CALL when the callee returns."""
    name = instruction.skill or ""
    callee = skills.get(name)
    if callee is None:
        raise SkillRuntimeError(f"CALL of missing skill '{name}'")
    args = [evaluate(arg, frame.vars, env, counter, rules) for arg in instruction.args]
    if len(args) != len(callee.params):
        raise SkillRuntimeError(f"{name} takes {len(callee.params)} argument(s), got {len(args)}")
    if len(state.frames) + 1 > rules.max_call_depth:
        raise SkillRuntimeError(f"CALL depth limit of {rules.max_call_depth} reached")
    frame.pc += 1
    state.frames.append(SkillFrame(skill=name, pc=0, vars=dict(zip(callee.params, args)), return_into=instruction.var))


def _return(state: SkillExecutionState, value: Any) -> tuple[str, Any]:
    """Pop the current frame; hand ``value`` to the caller's INTO variable, or finish the
    root skill with ``return_value``."""
    finished = state.frames.pop()
    if not state.frames:
        state.status = "finished"
        state.return_value = value
        state.last_error = None
        return "ended", None
    if finished.return_into:
        state.frames[-1].vars[finished.return_into] = value
    return "continue", None


def _begin_action(
    instruction: Instruction,
    state: SkillExecutionState,
    frame: SkillFrame,
    rules: SkillRules,
    env: SkillEnv,
    counter: list[int],
) -> tuple[str, Any]:
    """Evaluate an action call's arguments and either yield the validated WorldAction or
    store the synthetic invalid_argument result (A-ACT-13)."""
    call = instruction.expr
    assert isinstance(call, ActionCallExpr)
    values = [evaluate(arg, frame.vars, env, counter, rules) for arg in call.args]
    raw_args, converted, problem = _action_arguments(call.action, values)
    action: Optional[Any] = None
    if problem is None:
        try:
            action = _WORLD_ACTION_ADAPTER.validate_python({"name": call.action, "args": converted})
        except ValidationError as exc:
            problem = _validation_message(call.action, exc)
    if problem is not None:
        result = ActionResult(
            ok=False,
            reason="invalid_argument",
            cost_compute=0.0,
            cost_essence=0.0,
            round=env.round,
            data={"error": problem},
        )
        if instruction.op == "set" and instruction.var is not None:
            frame.vars[instruction.var] = result.model_dump(mode="json")
        frame.pc += 1
        return "invalid", InvalidSkillAction(name=call.action, args=raw_args, error=problem, result=result)
    state.status = "awaiting_action_result"
    state.pending_action = action
    state.pending_result_var = instruction.var if instruction.op == "set" else None
    return "action", action


def _action_arguments(action: str, values: list[Any]) -> tuple[dict[str, Any], dict[str, Any], Optional[str]]:
    """Map positional values to the action's argument names.  Returns (raw args for
    reporting, converted args for validation, problem or None)."""
    params = ACTION_PARAMS[action]
    low, high = ACTION_ARITY[action]
    raw = {params[i] if i < len(params) else f"arg{i + 1}": value for i, value in enumerate(values)}
    if not low <= len(values) <= high:
        return raw, {}, f"{action} takes {low}-{high} arguments, got {len(values)}"
    converted: dict[str, Any] = {}
    for param, value in zip(params, values):
        if param == "point":
            point = _as_point(value)
            if point is None:
                return raw, {}, "point must be a coordinate record {x, y} with whole-number parts"
            converted[param] = point
        elif param in ("page", "rounds") and _is_whole_number(value):
            converted[param] = int(value)
        else:
            converted[param] = value
    return raw, converted, None


def _as_point(value: Any) -> Optional[dict[str, int]]:
    """A ``{x, y}`` record (or an ``[x, y]`` pair from run_skill arguments) with
    whole-number parts, as ``{"x": int, "y": int}``; None otherwise."""
    if isinstance(value, dict) and set(value) == {"x", "y"}:
        x, y = value["x"], value["y"]
    elif isinstance(value, list) and len(value) == 2:
        x, y = value
    else:
        return None
    if not (_is_whole_number(x) and _is_whole_number(y)):
        return None
    return {"x": int(x), "y": int(y)}


def _validation_message(action: str, exc: ValidationError) -> str:
    parts: list[str] = []
    for err in exc.errors():
        loc = [str(part) for part in err.get("loc", ())]
        if loc and loc[0] == action:
            loc = loc[1:]
        if loc and loc[0] == "args":
            loc = loc[1:]
        field = ".".join(loc) or "arguments"
        parts.append(f"{field}: {err.get('msg', 'invalid')}")
    return f"{action}: " + "; ".join(parts)


def deliver_result(state: SkillExecutionState, result: ActionResult) -> SkillExecutionState:
    """Store ``result`` (as a plain dict) into ``pending_result_var`` of the top frame
    (if any), clear the pending fields, increment ``actions_executed``, advance pc past
    the action instruction and set ``status="running"``.  Nothing else runs until the next
    ``run_until_action`` (the next turn, or the same turn when the runner falls through,
    A-SKILL-11).  Raises ``SkillValidationError`` if the state is not awaiting a result."""
    if state.status != "awaiting_action_result" or not state.frames:
        raise SkillValidationError(f"the skill is not waiting for an action result (status {state.status})")
    if isinstance(result, dict):
        result = ActionResult.model_validate(result)
    frame = state.frames[-1]
    if state.pending_result_var:
        frame.vars[state.pending_result_var] = result.model_dump(mode="json")
    state.pending_action = None
    state.pending_result_var = None
    state.actions_executed += 1
    frame.pc += 1
    state.status = "running"
    return state


# ---------------------------------------------------------------------------
# Expression evaluation
# ---------------------------------------------------------------------------


def _string_limit(rules: Optional[SkillRules]) -> int:
    """``rules.skills.max_string_chars`` (the schema default when no rules are given)."""
    return rules.max_string_chars if rules is not None else MAX_STRING_CHARS


def evaluate(
    expr: Any, frame_vars: dict[str, Any], env: SkillEnv, counter: list[int], rules: Optional[SkillRules] = None
) -> Any:
    """Evaluate an ``Expr`` against local variables.  ``counter[0]`` is incremented per
    counted node (operators, field accesses, coords).  Raises ``SkillRuntimeError`` for
    division by zero, unknown variable, missing field, or type mismatch (``AND``/``OR``/
    ``NOT`` need booleans; ``< <= > >=`` need numbers; ``+`` numbers or strings).  Action
    calls are NOT evaluated here (the interpreter intercepts them at statement level).

    ``AND``/``OR`` short-circuit: when the left operand decides, the right operand is not
    evaluated and the node is not counted.  Arithmetic keeps integers exact up to 2**53
    and continues as floats beyond; a non-finite result is a runtime error, and so is a
    string longer than ``rules.max_string_chars`` (``MAX_STRING_CHARS`` when ``rules`` is
    None).  ``expr`` may also be a plain dict."""
    if isinstance(expr, dict):
        expr = _EXPR_ADAPTER.validate_python(expr)
    if isinstance(expr, LiteralExpr):
        return expr.value
    if isinstance(expr, VarExpr):
        return _read_variable(expr.name, frame_vars, env)
    if isinstance(expr, FieldExpr):
        counter[0] += 1
        return _read_field(evaluate(expr.obj, frame_vars, env, counter, rules), expr.name)
    if isinstance(expr, CoordExpr):
        counter[0] += 1
        x = evaluate(expr.x, frame_vars, env, counter, rules)
        y = evaluate(expr.y, frame_vars, env, counter, rules)
        return {"x": _coordinate_part(x, "x"), "y": _coordinate_part(y, "y")}
    if isinstance(expr, UnaryExpr):
        counter[0] += 1
        operand = evaluate(expr.operand, frame_vars, env, counter, rules)
        if expr.op == "NOT":
            if not isinstance(operand, bool):
                raise SkillRuntimeError(f"NOT needs true or false, got {_type_name(operand)}")
            return not operand
        if not _is_number(operand):
            raise SkillRuntimeError(f"'-' needs a number, got {_type_name(operand)}")
        return _checked_number(-operand)
    if isinstance(expr, BinaryExpr):
        if expr.op in ("AND", "OR"):
            return _evaluate_logical(expr, frame_vars, env, counter, rules)
        counter[0] += 1
        left = evaluate(expr.left, frame_vars, env, counter, rules)
        right = evaluate(expr.right, frame_vars, env, counter, rules)
        return _apply_binary(expr.op, left, right, _string_limit(rules))
    if isinstance(expr, ActionCallExpr):
        raise SkillRuntimeError(
            f"{expr.action}(...) can only be the whole right-hand side of SET or a statement of its own"
        )
    raise SkillRuntimeError(f"cannot evaluate {type(expr).__name__}")


def _evaluate_logical(
    expr: BinaryExpr, frame_vars: dict[str, Any], env: SkillEnv, counter: list[int], rules: Optional[SkillRules]
) -> bool:
    left = evaluate(expr.left, frame_vars, env, counter, rules)
    if not isinstance(left, bool):
        raise SkillRuntimeError(f"{expr.op} needs true or false on the left, got {_type_name(left)}")
    if expr.op == "AND" and left is False:
        return False
    if expr.op == "OR" and left is True:
        return True
    counter[0] += 1
    right = evaluate(expr.right, frame_vars, env, counter, rules)
    if not isinstance(right, bool):
        raise SkillRuntimeError(f"{expr.op} needs true or false on the right, got {_type_name(right)}")
    return right


def _read_variable(name: str, frame_vars: dict[str, Any], env: SkillEnv) -> Any:
    if name == "self":
        return env.agent_id
    if name == "here":
        return {"x": env.here.x, "y": env.here.y}
    if name not in frame_vars:
        raise SkillRuntimeError(f"unknown variable '{name}'")
    return frame_vars[name]


def _read_field(obj: Any, name: str) -> Any:
    if not isinstance(obj, dict):
        raise SkillRuntimeError(f"cannot read field '{name}' of a {_type_name(obj)}")
    if name not in obj:
        available = ", ".join(sorted(str(key) for key in obj)[:12]) or "none"
        raise SkillRuntimeError(f"missing field '{name}' (fields: {available})")
    return obj[name]


def _coordinate_part(value: Any, axis: str) -> Any:
    if not _is_number(value):
        raise SkillRuntimeError(f"coordinate {axis} must be a number, got {_type_name(value)}")
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def _apply_binary(op: str, left: Any, right: Any, max_string_chars: int = MAX_STRING_CHARS) -> Any:
    if op == "==":
        return _values_equal(left, right)
    if op == "!=":
        return not _values_equal(left, right)
    if op in ("<", "<=", ">", ">="):
        if not (_is_number(left) and _is_number(right)):
            raise SkillRuntimeError(f"'{op}' needs two numbers, got {_type_name(left)} and {_type_name(right)}")
        if op == "<":
            return left < right
        if op == "<=":
            return left <= right
        if op == ">":
            return left > right
        return left >= right
    if op == "+":
        if isinstance(left, str) and isinstance(right, str):
            joined = left + right
            if len(joined) > max_string_chars:
                raise SkillRuntimeError(f"string longer than {max_string_chars} characters")
            return joined
        if _is_number(left) and _is_number(right):
            return _checked_number(left + right)
        raise SkillRuntimeError(
            f"'+' needs two numbers or two strings, got {_type_name(left)} and {_type_name(right)}"
        )
    if not (_is_number(left) and _is_number(right)):
        raise SkillRuntimeError(f"'{op}' needs two numbers, got {_type_name(left)} and {_type_name(right)}")
    if op == "-":
        return _checked_number(left - right)
    if op == "*":
        return _checked_number(left * right)
    if op == "/":
        if right == 0:
            raise SkillRuntimeError("division by zero")
        return _checked_number(left / right)
    raise SkillRuntimeError(f"unknown operator '{op}'")


def _checked_number(value: int | float) -> int | float:
    """Keep numbers JSON-safe: integers beyond 2**53 continue as floats; non-finite
    results are a runtime error rather than an invented value."""
    if isinstance(value, int) and abs(value) > MAX_EXACT_INT:
        value = float(value)
    if isinstance(value, float) and not math.isfinite(value):
        raise SkillRuntimeError("number too large")
    return value


def _values_equal(left: Any, right: Any) -> bool:
    """Structural, type-strict equality: booleans only equal booleans, numbers compare by
    value across int/float, null only equals null, lists and records element-wise."""
    if isinstance(left, bool) or isinstance(right, bool):
        return isinstance(left, bool) and isinstance(right, bool) and left == right
    if _is_number(left) or _is_number(right):
        return _is_number(left) and _is_number(right) and left == right
    if left is None or right is None:
        return left is None and right is None
    if isinstance(left, str) or isinstance(right, str):
        return isinstance(left, str) and isinstance(right, str) and left == right
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(_values_equal(a, b) for a, b in zip(left, right))
    if isinstance(left, dict) and isinstance(right, dict):
        return left.keys() == right.keys() and all(_values_equal(left[key], right[key]) for key in left)
    return False


def _type_name(value: Any) -> str:
    if isinstance(value, bool):
        return "boolean"
    if _is_number(value):
        return "number"
    if isinstance(value, str):
        return "string"
    if value is None:
        return "null"
    if isinstance(value, list):
        return "list"
    if isinstance(value, dict):
        return "record"
    return type(value).__name__


# ---------------------------------------------------------------------------
# Catalogue for the decision packet
# ---------------------------------------------------------------------------


def skill_catalogue(skills: dict[str, SkillDefinition], include_source: bool, source_for: Optional[set[str]] = None) -> str:
    """One line per skill for the decision packet: ``name(params) - N blocks, actions: ...``;
    the source follows in a fenced block for every skill when ``include_source`` and for the
    names in ``source_for`` (skills that errored or were rejected last turn) otherwise.

    Skills are listed by name.  ``actions`` lists the distinct action names in source
    order ("none" when the skill only calls others); ``calls: ...`` is appended when the
    skill CALLs other skills.  An empty dict renders as "(no saved skills)"."""
    if not skills:
        return "(no saved skills)"
    wanted = set(source_for or ())
    lines: list[str] = []
    for name in sorted(skills):
        definition = skills[name]
        actions: list[str] = []
        for _line, action in find_action_calls(definition.blocks):
            if action not in actions:
                actions.append(action)
        entry = f"{name}({', '.join(definition.params)}) - {definition.block_count} blocks, actions: {', '.join(actions) or 'none'}"
        calls = definition.calls or _called_skills(definition.blocks)
        if calls:
            entry += f", calls: {', '.join(calls)}"
        lines.append(entry)
        if include_source or name in wanted:
            lines.append("```")
            lines.append(definition.source.rstrip("\n"))
            lines.append("```")
    return "\n".join(lines)
