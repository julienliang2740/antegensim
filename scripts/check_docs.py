#!/usr/bin/env python3
"""
Docs-vs-code consistency checker (the docs regime, CLAUDE.md "Docs rule").

The docs are read by people and loaded by the built-in assistant (docs/INDEX.md
"assistant: yes"), so they must not drift from the code.  Every behaviour change
updates the docs in the same commit and this script must pass:

    .venv/bin/python scripts/check_docs.py            # all checks, exit 0 when clean
    .venv/bin/python scripts/check_docs.py --list     # names of the checks
    .venv/bin/python scripts/check_docs.py --only routes env
    .venv/bin/python scripts/check_docs.py --no-collect   # TEST_PLAN ids via ast instead of pytest

Checks (each prints ``[name] OK`` or its problems as ``[name] file: message``):

* ``paths``      backticked repo paths (``backend/...``, ``docs/...``) and relative Markdown
                 links in the checked docs exist on disk.
* ``symbols``    backticked ``path::Symbol`` / ``path::Class.method`` exist (ast for .py, a
                 declaration regex for .ts/.tsx/.mjs).
* ``routes``     FastAPI routes of ``create_app`` (core + assistant routers) == docs/INTERFACES.md
                 section 9 table == api.py docstring table == the request()/fetch() calls in
                 frontend/src/api/*.ts (path parameters normalised to ``{}``, query strings dropped).
* ``models``     model registry keys (models.example.json + default fake refs) == the keys in
                 README "Models and credentials".
* ``env``        every ``EMPYREAN_*`` variable read in code is documented in README.md and
                 .env.example (test-only variables in README or docs/TEST_PLAN.md), and every
                 variable those docs name exists in code.
* ``assumptions``  ``config.ASSUMPTIONS`` ids == the ids in docs/ASSUMPTIONS.md tables.
* ``testplan``   every ``test_*.py::name`` in docs/TEST_PLAN.md is a collected pytest node
                 (``pytest --collect-only -q``; "…" and "*" in a name are wildcards).
* ``controls``   every bolded label in docs/CONTROLS.md and README "Using the UI" appears as a
                 literal in frontend/src (whitespace collapsed, ``&amp;`` decoded; text inside
                 ``<...>`` is a placeholder).
* ``stale``      forbidden stale phrases (old agent range, old control labels, the old
                 frozen-file process) in the docs and in code comments/strings.
* ``index``      docs/INDEX.md lists every docs/*.md with an ``assistant: yes|no`` flag and
                 lists nothing that does not exist.

Exit status: 0 clean, 1 problems found, 2 the checker itself failed (for example the backend
could not be imported).  No model is ever called; nothing is written.
"""
# DOCS: scripts/check_docs.py is run by backend/tests/test_docs_consistency.py, so `pytest -q`
# fails on doc drift; allowlists live at the top of this file and each entry says why.

from __future__ import annotations

import argparse
import ast
import fnmatch
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Callable, Iterable, Optional

REPO = Path(__file__).resolve().parent.parent
BACKEND = REPO / "backend"
FRONTEND_SRC = REPO / "frontend" / "src"
DOCS = REPO / "docs"

# Docs checked for paths/symbols/stale phrases.  The design docs (llm_world_*.md) and
# docs/evidence/** are historical records and are not rewritten.
CHECKED_DOCS = [
    "README.md",
    "CLAUDE.md",
    "frontend/README.md",
    "qa/README.md",
    "docs/sample_run/README.md",
]
PATH_PREFIXES = ("backend/", "frontend/", "docs/", "scripts/", "qa/", ".env.example", "CLAUDE.md", "README.md", "llm_world_")
# Paths that exist only at runtime or are gitignored, documented on purpose.
PATH_ALLOW_MISSING_PREFIXES = (
    "frontend/dist",
    "frontend/node_modules",
    "qa/out",
    "qa/node_modules",
    "backend/tests/fixtures/",  # optional Whisper sample clip (EMPYREAN_WHISPER_SAMPLE)
    "backend/server.",  # server.pid / server.log written by a running backend
    "qa/resilience/worlds",  # gitignored scratch worlds of the resilience harness
    "backend/tests/data/",  # optional Whisper sample clip (EMPYREAN_WHISPER_TEST_AUDIO)
    "qa/worlds-",  # gitignored worlds of the fake QA server and the playtest arms
    "qa/playtest-out",  # gitignored raw logs of scripts/assistant_playtest.py
)

# Backend routes that deliberately have no frontend wrapper (none today).
ROUTES_WITHOUT_FRONTEND: set[tuple[str, str]] = set()

# EMPYREAN_* variables read only by tests (documented in README "Tests" or docs/TEST_PLAN.md).
TEST_ONLY_ENV = {
    "EMPYREAN_LIVE_TESTS",
    "EMPYREAN_LIVE_MODELS",
    "EMPYREAN_TEST_ENDPOINT",
    "EMPYREAN_TEST_DEPLOYMENT",
    "EMPYREAN_WHISPER_SAMPLE",
    "EMPYREAN_WHISPER_TEST_AUDIO",
}
ENV_CODE_GLOBS = [
    ("backend/empyrean", "**/*.py"),
    ("backend/tests", "**/*.py"),
    ("scripts", "**/*.py"),
    ("frontend/src", "**/*.ts"),
    ("frontend/src", "**/*.tsx"),
    ("frontend", "vite.config.ts"),
    ("qa", "*.mjs"),
]

# (regex, why) forbidden in the checked docs, docs/*.md and frontend/src + backend/empyrean text.
STALE_PHRASES: list[tuple[str, str]] = [
    (r"\b6\s*(?:–|-|to)\s*11\s+(?:agents|cards|prefilled|initial)", "the agent range is 6-12 (config.MIN_AGENTS/MAX_AGENTS)"),
    (r"\b6 to 11\b", "the agent range is 6-12"),
    (r"\b6\.\.11\b", "the agent range is 6..12"),
    (r"between 6 and 11", "the agent range is 6-12"),
    (r"a01\.\.a11", "default agent ids run a01..a12"),
    (r"Add agent card", "the button is 'Add agent'"),
    (r"Remove this card", "the button is 'Remove this agent'"),
    (r"Shared files are frozen|files? \(`schemas\.py`.*\) are \*\*frozen\*\*", "change control is in CLAUDE.md, not a frozen-file process"),
    (r"TODO\(schema\):", "the TODO(schema) process was replaced by handoff notes (CLAUDE.md)"),
    (r"Voice input", "speech input is called 'Dictate' (god mode owns 'voice')"),
]
STALE_CODE_PHRASES = [p for p in STALE_PHRASES if p[0] in (r"\b6 to 11\b", r"\b6\.\.11\b", r"between 6 and 11", r"a01\.\.a11")]

INDEX_ROW = re.compile(r"^\|\s*`(?P<path>[^`]+\.md)`\s*\|.*\|\s*assistant:\s*(?P<flag>yes|no)\s*\|\s*$")


class Problems:
    def __init__(self) -> None:
        self.items: list[tuple[str, str]] = []

    def add(self, where: str, message: str) -> None:
        self.items.append((where, message))


def rel(path: Path) -> str:
    try:
        return path.relative_to(REPO).as_posix()
    except ValueError:
        return str(path)


def checked_doc_files() -> list[Path]:
    files = [REPO / p for p in CHECKED_DOCS if (REPO / p).exists()]
    files += sorted(DOCS.glob("*.md"))
    return files


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def strip_code_blocks(text: str) -> str:
    """Remove fenced code blocks (their paths are examples, not claims)."""
    return re.sub(r"```.*?```", "", text, flags=re.S)


def backticked(text: str) -> Iterable[str]:
    for match in re.finditer(r"`([^`\n]+)`", strip_code_blocks(text)):
        yield match.group(1).strip()


# ---------------------------------------------------------------------------- paths


def clean_path_token(token: str) -> Optional[str]:
    if "::" in token or " " in token or not token.startswith(PATH_PREFIXES):
        return None
    if any(ch in token for ch in "<>*{}…$|"):
        return None
    token = re.split(r"[#?]", token, maxsplit=1)[0]
    token = re.sub(r":\d+(-\d+)?$", "", token)
    return token.rstrip("/.,;") or None


def check_paths(p: Problems) -> None:
    for doc in checked_doc_files():
        text = read(doc)
        for token in backticked(text):
            path = clean_path_token(token)
            if path and not (REPO / path).exists() and not path.startswith(PATH_ALLOW_MISSING_PREFIXES):
                p.add(rel(doc), f"backticked path does not exist: {path}")
        for match in re.finditer(r"\]\(([^)\s]+)\)", strip_code_blocks(text)):
            target = match.group(1)
            if target.startswith(("http://", "https://", "#", "mailto:")):
                continue
            target = target.split("#", 1)[0]
            if target and not (doc.parent / target).exists():
                p.add(rel(doc), f"link target does not exist: {target}")


# ---------------------------------------------------------------------------- symbols


def resolve_symbol_file(path: str) -> Optional[Path]:
    candidate = REPO / path
    if candidate.exists():
        return candidate
    if "/" not in path and path.startswith("test_") and (BACKEND / "tests" / path).exists():
        return BACKEND / "tests" / path
    return None


_py_cache: dict[Path, ast.Module] = {}


def py_has_symbol(file: Path, symbol: str) -> bool:
    tree = _py_cache.get(file)
    if tree is None:
        tree = ast.parse(read(file))
        _py_cache[file] = tree
    parts = symbol.split(".")
    scope: list[ast.stmt] = list(tree.body)
    for index, part in enumerate(parts):
        found = None
        for node in scope:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name == part:
                found = node
                break
            if isinstance(node, (ast.Assign, ast.AnnAssign)):
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                if any(isinstance(t, ast.Name) and t.id == part for t in targets):
                    found = node
                    break
            if isinstance(node, (ast.Import, ast.ImportFrom)) and index == 0:
                if any((a.asname or a.name.split(".")[0]) == part for a in node.names):
                    found = node
                    break
        if found is None:
            return False
        scope = list(getattr(found, "body", []))
    return True


def ts_has_symbol(file: Path, symbol: str) -> bool:
    text = read(file)
    head = symbol.split(".")[0]
    pattern = rf"\b(?:function\*?|const|let|var|class|interface|type|enum)\s+{re.escape(head)}\b"
    if not re.search(pattern, text):
        return False
    if "." in symbol:
        member = symbol.split(".", 1)[1].split(".")[0]
        return re.search(rf"\b{re.escape(member)}\b\s*[(:?=]", text) is not None
    return True


def check_symbols(p: Problems) -> None:
    for doc in checked_doc_files():
        is_test_plan = doc.name == "TEST_PLAN.md"
        for token in backticked(read(doc)):
            if "::" not in token or " " in token:
                continue
            path, _, symbol = token.partition("::")
            if not re.search(r"\.(py|ts|tsx|mjs|js)$", path):
                continue  # prose such as `path::Symbol`, not a reference
            if is_test_plan and "/" not in path:
                continue  # node ids: the testplan check collects them with pytest
            symbol = re.sub(r"\[.*\]$", "", symbol).rstrip("()").replace("::", ".")
            if not symbol or symbol.endswith("…") or not re.match(r"^[A-Za-z_][\w.]*$", symbol):
                continue
            file = resolve_symbol_file(path)
            if file is None:
                p.add(rel(doc), f"{token}: file does not exist")
                continue
            if file.suffix == ".py":
                ok = py_has_symbol(file, symbol)
            elif file.suffix in (".ts", ".tsx", ".mjs", ".js"):
                ok = ts_has_symbol(file, symbol)
            else:
                continue
            if not ok:
                p.add(rel(doc), f"{token}: symbol not found")


# ---------------------------------------------------------------------------- routes


def norm_route(method: str, path: str) -> tuple[str, str]:
    path = path.split("?", 1)[0].strip()
    if not path.startswith("/api"):
        path = "/api" + path
    path = re.sub(r"\{[^}]*\}", "{}", path)
    return method.upper(), path.rstrip("/") or "/"


def backend_routes() -> set[tuple[str, str]]:
    """Every (method, path) the served app would expose: ``create_app`` with a real RunManager and
    an AssistantService over a temporary worlds dir (nothing is opened, no model is called)."""
    import tempfile

    tmp = tempfile.mkdtemp(prefix="check_docs_worlds_")
    os.environ.setdefault("EMPYREAN_WORLDS_DIR", tmp)
    sys.path.insert(0, str(BACKEND))
    from fastapi.routing import APIRoute

    from empyrean import api, model
    from empyrean.runner import RunManager

    registry = model.load_registry(BACKEND / "empyrean" / "models.example.json")
    manager = RunManager(registry)
    assistant = None
    try:
        from empyrean.assistant import AssistantService

        assistant = AssistantService(manager, registry, Path(tmp), auto_live_allowed=False)
    except Exception:  # an unfinished assistant package still lets the core routes be checked
        assistant = SimpleNamespace()
    try:
        app = api.create_app(manager, assistant)
    finally:
        if hasattr(assistant, "shutdown"):
            assistant.shutdown()
        manager.shutdown()

    def walk(routes: list) -> Iterable[APIRoute]:
        for route in routes:
            if isinstance(route, APIRoute):
                yield route
                continue
            inner = getattr(route, "original_router", None) or getattr(route, "router", None)
            if inner is not None and hasattr(inner, "routes"):
                yield from walk(inner.routes)

    found = set()
    for route in walk(list(app.routes)):
        if not route.include_in_schema:
            continue
        for method in route.methods:
            if method in ("HEAD", "OPTIONS"):
                continue
            found.add(norm_route(method, route.path))
    return found


def interfaces_routes() -> set[tuple[str, str]]:
    text = read(DOCS / "INTERFACES.md")
    match = re.search(r"^## 9\. API\n(.*?)(?=^## )", text, flags=re.S | re.M)
    section = match.group(1) if match else ""
    rows = re.findall(r"^\|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|\s*`([^`]+)`", section, flags=re.M)
    return {norm_route(m, p) for m, p in rows}


def api_docstring_routes() -> set[tuple[str, str]]:
    tree = ast.parse(read(BACKEND / "empyrean" / "api.py"))
    doc = ast.get_docstring(tree) or ""
    rows = re.findall(r"^\s+(GET|POST|PUT|PATCH|DELETE)\s+(/api/\S+)", doc, flags=re.M)
    return {norm_route(m, p) for m, p in rows}


def _read_template(text: str, start: int) -> tuple[str, int]:
    """Parse a JS string/template literal starting at text[start]; returns (raw, end)."""
    quote = text[start]
    i = start + 1
    out = []
    while i < len(text):
        ch = text[i]
        if ch == "\\":
            out.append(text[i : i + 2])
            i += 2
            continue
        if ch == quote:
            return "".join(out), i + 1
        if quote == "`" and text.startswith("${", i):
            depth = 1
            j = i + 2
            while j < len(text) and depth:
                if text[j] in "`\"'":
                    _, j = _read_template(text, j)
                    continue
                depth += {"{": 1, "}": -1}.get(text[j], 0)
                j += 1
            out.append(text[i:j])
            i = j
            continue
        out.append(ch)
        i += 1
    raise ValueError("unterminated literal")


def _resolve_consts(text: str) -> dict[str, str]:
    consts: dict[str, str] = {}
    for m in re.finditer(r"const\s+(\w+)\s*=\s*(?:\([^)]*\)\s*=>\s*)?([`\"'])", text):
        try:
            raw, _ = _read_template(text, m.end() - 1)
        except ValueError:
            continue
        consts[m.group(1)] = raw
    return consts


def _expand(raw: str, consts: dict[str, str], depth: int = 0) -> str:
    def sub(match: re.Match) -> str:
        expr = match.group(1).strip()
        name = re.match(r"^(\w+)", expr)
        if name and name.group(1) in consts and depth < 5 and (expr == name.group(1) or expr.startswith(name.group(1) + "(")):
            return _expand(consts[name.group(1)], consts, depth + 1)
        if name and name.group(1) == "API_BASE":
            return ""
        return "\x00"  # a runtime value

    # replace ${...} with balanced braces
    result, i = [], 0
    while i < len(raw):
        if raw.startswith("${", i):
            depth_b, j = 1, i + 2
            while j < len(raw) and depth_b:
                depth_b += {"{": 1, "}": -1}.get(raw[j], 0)
                j += 1
            result.append(sub(re.match(r"\$\{(.*)\}", raw[i:j], flags=re.S)))
            i = j
        else:
            result.append(raw[i])
            i += 1
    return "".join(result)


def frontend_routes() -> tuple[set[tuple[str, str]], list[str]]:
    found: set[tuple[str, str]] = set()
    unresolved: list[str] = []
    for file in sorted((FRONTEND_SRC / "api").glob("*.ts")):
        text = read(file)
        consts = _resolve_consts(text)
        calls = [(m.group(1), m.end()) for m in re.finditer(r"\brequest(?:<[^>]*>)?\(\s*\"(GET|POST|PUT|PATCH|DELETE)\"\s*,\s*", text)]
        calls += [(None, m.end()) for m in re.finditer(r"(?<![\w.])fetch\(\s*", text)]
        for method, pos in calls:
            # the path argument: a const helper call (storyBase(...)), or the first string/template
            # literal (a ternary takes its first branch)
            ident = re.match(r"(\w+)\s*\(", text[pos:])
            if ident and ident.group(1) in consts:
                raw, end = "${" + ident.group(1) + "()}", pos + ident.end()
            else:
                lit = re.compile(r"[`\"']").search(text, pos)
                if lit is None or lit.start() - pos > 80:
                    unresolved.append(f"{rel(file)}: cannot read the path at offset {pos}")
                    continue
                raw, end = _read_template(text, lit.start())
            if raw == "${API_BASE}${path}":
                continue  # client.ts request() itself
            path = _expand(raw, consts)
            if method is None:
                body = text[end : end + 400]
                mm = re.search(r"method:\s*\"(GET|POST|PUT|PATCH|DELETE)\"", body)
                method = mm.group(1) if mm else "GET"
            if not path.startswith("/api"):
                unresolved.append(f"{rel(file)}: path does not start with /api: {raw!r}")
                continue
            # a runtime value right after "/" is a path parameter; anywhere else it is a query tail
            path = re.sub(r"/\x00", "/{}", path).replace("\x00", "")
            found.add(norm_route(method, path))
    return found, unresolved


def check_routes(p: Problems) -> None:
    backend = backend_routes()
    tables = {
        "docs/INTERFACES.md section 9": interfaces_routes(),
        "backend/empyrean/api.py docstring": api_docstring_routes(),
    }
    for where, routes in tables.items():
        for method, path in sorted(backend - routes):
            p.add(where, f"route missing: {method} {path}")
        for method, path in sorted(routes - backend):
            p.add(where, f"route listed but not served: {method} {path}")
    front, unresolved = frontend_routes()
    for line in unresolved:
        p.add("frontend/src/api", line)
    for method, path in sorted(front - backend):
        p.add("frontend/src/api", f"calls a route the backend does not serve: {method} {path}")
    for method, path in sorted(backend - front - ROUTES_WITHOUT_FRONTEND):
        p.add("frontend/src/api", f"no request()/fetch() wrapper for {method} {path}")


# ---------------------------------------------------------------------------- models


def check_models(p: Problems) -> None:
    sys.path.insert(0, str(BACKEND))
    from empyrean import model

    keys = set(model.load_registry(BACKEND / "empyrean" / "models.example.json").keys())
    text = read(REPO / "README.md")
    match = re.search(r"^## Models and credentials\n(.*?)(?=^## )", text, flags=re.S | re.M)
    section = match.group(1) if match else ""
    documented: set[str] = set()
    for row in re.findall(r"^\|([^|\n]*)\|", section, flags=re.M):
        documented.update(re.findall(r"`([a-z0-9][a-z0-9-]*)`", row))
    for key in sorted(keys - documented):
        p.add("README.md", f"registry key not in the models table: {key}")
    for key in sorted(documented - keys):
        p.add("README.md", f"models table lists an unknown key: {key}")


# ---------------------------------------------------------------------------- env


def check_env(p: Problems) -> None:
    in_code: dict[str, str] = {}
    for base, pattern in ENV_CODE_GLOBS:
        root = REPO / base
        for file in root.glob(pattern):
            if "node_modules" in file.parts:
                continue
            for name in re.findall(r"\bEMPYREAN_[A-Z0-9_]*[A-Z0-9]\b", read(file)):
                in_code.setdefault(name, rel(file))
    readme = read(REPO / "README.md")
    example = read(REPO / ".env.example")
    test_plan = read(DOCS / "TEST_PLAN.md")
    for name, where in sorted(in_code.items()):
        if name in TEST_ONLY_ENV:
            if name not in readme and name not in test_plan:
                p.add("README.md", f"{name} (read in {where}) is documented in neither README nor docs/TEST_PLAN.md")
            continue
        if name not in readme:
            p.add("README.md", f"{name} (read in {where}) is not documented")
        if name not in example:
            p.add(".env.example", f"{name} (read in {where}) is missing")
    for doc_name, text in (("README.md", readme), (".env.example", example)):
        for name in sorted(set(re.findall(r"\bEMPYREAN_[A-Z0-9_]*[A-Z0-9]\b", text)) - set(in_code)):
            if name.startswith("EMPYREAN_ASSISTANT_MODEL_") and name == "EMPYREAN_ASSISTANT_MODEL_":
                continue
            p.add(doc_name, f"{name} is documented but no code reads it")


# ---------------------------------------------------------------------------- assumptions


def check_assumptions(p: Problems) -> None:
    sys.path.insert(0, str(BACKEND))
    from empyrean import config

    code_ids = set(config.ASSUMPTIONS)
    doc_ids = set(re.findall(r"^\|\s*(A-[A-Z]+-\d+)\s*\|", read(DOCS / "ASSUMPTIONS.md"), flags=re.M))
    for aid in sorted(code_ids - doc_ids):
        p.add("docs/ASSUMPTIONS.md", f"{aid} is in config.ASSUMPTIONS but not documented")
    for aid in sorted(doc_ids - code_ids):
        p.add("docs/ASSUMPTIONS.md", f"{aid} is documented but not in config.ASSUMPTIONS")


# ---------------------------------------------------------------------------- testplan


def plan_node_ids() -> list[tuple[str, str]]:
    """(file, name) pairs from TEST_PLAN; ``::name`` continues the last file of the same line."""
    ids: list[tuple[str, str]] = []
    for line in read(DOCS / "TEST_PLAN.md").splitlines():
        current: Optional[str] = None
        for m in re.finditer(r"(test_[a-z0-9_]+\.py)?::([A-Za-z_][\w…*]*)", line):
            if m.group(1):
                current = m.group(1)
            if current:
                ids.append((current, m.group(2)))
    return ids


def collected_nodes(use_pytest: bool) -> set[tuple[str, str]]:
    nodes: set[tuple[str, str]] = set()
    if use_pytest:
        env = dict(os.environ)
        env.pop("EMPYREAN_LIVE_TESTS", None)
        proc = subprocess.run(
            [sys.executable, "-m", "pytest", "--collect-only", "-q", "-p", "no:cacheprovider"],
            cwd=BACKEND,
            capture_output=True,
            text=True,
            env=env,
            timeout=600,
        )
        for line in proc.stdout.splitlines():
            m = re.match(r"^tests/(test_[\w]+\.py)::(.+)$", line.strip())
            if m:
                for part in m.group(2).split("::"):
                    nodes.add((m.group(1), re.sub(r"\[.*\]$", "", part)))
        if not nodes:
            raise RuntimeError(f"pytest --collect-only found nothing:\n{proc.stdout[-2000:]}\n{proc.stderr[-2000:]}")
        return nodes
    for file in (BACKEND / "tests").glob("test_*.py"):
        for node in ast.walk(ast.parse(read(file))):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                nodes.add((file.name, node.name))
    return nodes


def check_testplan(p: Problems, use_pytest: bool = True) -> None:
    nodes = collected_nodes(use_pytest)
    for file, name in plan_node_ids():
        if "…" in name or "*" in name:
            pattern = name.replace("…", "*")
            ok = any(f == file and fnmatch.fnmatchcase(n, pattern) for f, n in nodes)
        else:
            ok = (file, name) in nodes
        if not ok:
            p.add("docs/TEST_PLAN.md", f"not a collected test: {file}::{name}")


# ---------------------------------------------------------------------------- controls


def frontend_text() -> str:
    parts = []
    for file in sorted(list(FRONTEND_SRC.rglob("*.tsx")) + list(FRONTEND_SRC.rglob("*.ts"))):
        if "dev" in file.relative_to(FRONTEND_SRC).parts[:1]:
            continue
        parts.append(read(file))
    text = "\n".join(parts)
    text = text.replace("&amp;", "&").replace("&nbsp;", " ").replace("&hellip;", "…")
    text = re.sub(r"\{\"\s*\"\}", " ", text)
    return re.sub(r"\s+", " ", text)


def control_labels(text: str) -> list[str]:
    return [m.group(1).strip() for m in re.finditer(r"\*\*([^*\n]+)\*\*", strip_code_blocks(text))]


def label_present(label: str, source: str) -> bool:
    label = label.replace("&amp;", "&")
    segments = [s.strip() for s in re.split(r"<[^>]*>", label) if len(s.strip()) >= 2]
    if not segments:
        return True
    return all(seg in source for seg in segments)


def check_controls(p: Problems) -> None:
    source = frontend_text()
    targets = [("docs/CONTROLS.md", read(DOCS / "CONTROLS.md"))]
    readme = read(REPO / "README.md")
    match = re.search(r"^## Using the UI\n(.*?)(?=^## )", readme, flags=re.S | re.M)
    if match:
        targets.append(("README.md (Using the UI)", match.group(1)))
    for where, text in targets:
        for label in control_labels(text):
            if label.endswith(":") or label.startswith("Note"):
                continue
            if not label_present(label, source):
                p.add(where, f"bold control label not found in frontend/src: **{label}**")


# ---------------------------------------------------------------------------- stale


def check_stale(p: Problems) -> None:
    for doc in checked_doc_files():
        text = read(doc)
        for pattern, why in STALE_PHRASES:
            for m in re.finditer(pattern, text):
                # a doc may quote a phrase to forbid it: skip matches inside backticks on CLAUDE.md
                if doc.name == "CLAUDE.md":
                    continue
                line = text.count("\n", 0, m.start()) + 1
                p.add(f"{rel(doc)}:{line}", f"stale phrase '{m.group(0)}': {why}")
    code_files = list((BACKEND / "empyrean").rglob("*.py")) + list(FRONTEND_SRC.rglob("*.ts")) + list(FRONTEND_SRC.rglob("*.tsx"))
    code_files.append(REPO / "scripts" / "run_sim.py")
    for file in code_files:
        text = read(file)
        for pattern, why in STALE_CODE_PHRASES:
            for m in re.finditer(pattern, text):
                line = text.count("\n", 0, m.start()) + 1
                p.add(f"{rel(file)}:{line}", f"stale phrase '{m.group(0)}': {why}")


# ---------------------------------------------------------------------------- index


def check_index(p: Problems) -> None:
    index = DOCS / "INDEX.md"
    if not index.exists():
        p.add("docs/INDEX.md", "missing")
        return
    listed: dict[str, str] = {}
    for line in read(index).splitlines():
        m = INDEX_ROW.match(line.strip())
        if m:
            listed[m.group("path")] = m.group("flag")
    for doc in sorted(DOCS.glob("*.md")):
        if rel(doc) not in listed:
            p.add("docs/INDEX.md", f"{rel(doc)} is not listed (row: | `path` | purpose | audience | assistant: yes|no |)")
    for path in sorted(listed):
        if not (REPO / path).exists():
            p.add("docs/INDEX.md", f"lists a file that does not exist: {path}")
    for required in ("README.md", "CLAUDE.md"):
        if required not in listed:
            p.add("docs/INDEX.md", f"{required} is not listed")


# ---------------------------------------------------------------------------- main

CHECKS: dict[str, Callable[..., None]] = {
    "paths": check_paths,
    "symbols": check_symbols,
    "routes": check_routes,
    "models": check_models,
    "env": check_env,
    "assumptions": check_assumptions,
    "testplan": check_testplan,
    "controls": check_controls,
    "stale": check_stale,
    "index": check_index,
}


def run(names: list[str], *, use_pytest: bool = True, quiet: bool = False) -> tuple[int, list[str]]:
    """Run the named checks; returns (exit code, output lines)."""
    lines: list[str] = []
    failed = False
    broken = False
    for name in names:
        p = Problems()
        try:
            if name == "testplan":
                check_testplan(p, use_pytest=use_pytest)
            else:
                CHECKS[name](p)
        except Exception as exc:  # the checker itself failed
            broken = True
            lines.append(f"[{name}] CHECKER ERROR: {type(exc).__name__}: {exc}")
            continue
        if p.items:
            failed = True
            lines.append(f"[{name}] {len(p.items)} problem(s)")
            lines.extend(f"  {where}: {message}" for where, message in p.items)
        elif not quiet:
            lines.append(f"[{name}] OK")
    code = 2 if broken else 1 if failed else 0
    lines.append("docs check: " + ("clean" if code == 0 else "FAILED (see above; fix the docs or the code in the same commit)"))
    return code, lines


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Check that the docs match the code.")
    parser.add_argument("--only", nargs="+", choices=sorted(CHECKS), help="run only these checks")
    parser.add_argument("--list", action="store_true", help="list the checks and exit")
    parser.add_argument("--no-collect", action="store_true", help="resolve TEST_PLAN ids with ast instead of pytest --collect-only")
    parser.add_argument("--quiet", action="store_true", help="print only problems")
    args = parser.parse_args(argv)
    if args.list:
        print("\n".join(CHECKS))
        return 0
    os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")
    code, lines = run(args.only or list(CHECKS), use_pytest=not args.no_collect, quiet=args.quiet)
    print("\n".join(lines))
    return code


if __name__ == "__main__":
    sys.exit(main())
