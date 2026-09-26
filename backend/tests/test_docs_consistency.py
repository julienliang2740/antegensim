"""
Docs-vs-code consistency (the docs regime, CLAUDE.md "Docs rule"): runs every check of
``scripts/check_docs.py`` in-process so the normal ``pytest -q`` fails when the docs drift from
the code (paths, ``path::Symbol`` references, the route tables, registry keys, ``EMPYREAN_*``
variables, assumption ids, TEST_PLAN node ids, control labels, stale phrases, the docs index).
No model is called and nothing is written.
"""
# DOCS: a failure here prints the checker's problem list; fix the doc (or the code) in the same
# commit.  TEST_PLAN ids are resolved with ast here (a nested pytest --collect-only is slow);
# `scripts/check_docs.py` on the command line uses pytest's collection.

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "check_docs.py"


def load_checker():
    spec = importlib.util.spec_from_file_location("check_docs", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules.setdefault("check_docs", module)
    spec.loader.exec_module(module)
    return module


def test_docs_match_the_code():
    checker = load_checker()
    code, lines = checker.run(list(checker.CHECKS), use_pytest=False, quiet=True)
    assert code == 0, "docs drifted from the code:\n" + "\n".join(lines)


def test_checker_reports_problems_with_a_non_zero_exit(tmp_path, monkeypatch):
    """The checker is not vacuous: a doc naming a missing path fails the paths check."""
    checker = load_checker()
    doc = tmp_path / "BROKEN.md"
    doc.write_text("See `backend/empyrean/no_such_module.py` and `backend/empyrean/model.py::no_such_symbol`.\n")
    monkeypatch.setattr(checker, "checked_doc_files", lambda: [doc])
    code, lines = checker.run(["paths", "symbols"], use_pytest=False, quiet=True)
    text = "\n".join(lines)
    assert code == 1
    assert "no_such_module.py" in text and "no_such_symbol" in text
