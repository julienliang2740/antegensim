"""
Knowledge = the repo docs (rev 4, D4 + A-AST-7): the curated docs (docs/INDEX.md rows flagged
``assistant: yes``) split by ``##`` headings into sections with stable slugs; the byte-stable
knowledge core (SYSTEM.md#overview, GLOSSARY.md, CONTROLS.md#quick-reference,
ASSISTANT.md#rules-of-engagement) for the system prompt and keyword-overlap retrieval (no
embeddings) for the user message.  Numbers for a specific run come from tools, never from docs.
OWNER: WP2.

Manifest format (from WP7): one markdown table row per doc in ``docs/INDEX.md``::

    | `docs/SYSTEM.md` | purpose | audience | assistant: yes |

Paths are relative to the repo root.  When INDEX.md is missing or has no parsable rows the
hard-coded ``FALLBACK_DOCS`` list is used, and docs that do not exist yet are skipped.
"""
# DOCS: docs feed the assistant, so the docs regime is load-bearing; sections are addressed as
# <FILE>.md#<slug> (AnswerRef kind "doc"); slug = lowercase heading, only [a-z0-9 -], spaces -> '-'.

from __future__ import annotations

import re
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from .. import config

INDEX_ROW = re.compile(r"^\|\s*`(?P<path>[^`]+\.md)`\s*\|.*\|\s*assistant:\s*(?P<flag>yes|no)\s*\|\s*$", re.IGNORECASE)
HEADING = re.compile(r"^(#{1,3})\s+(.*?)\s*#*\s*$")
_WORD = re.compile(r"[a-z0-9][a-z0-9_]{1,}")
_SLUG_DROP = re.compile(r"[^a-z0-9 -]")

# Docs the assistant reads when INDEX.md is absent or unparsable (repo-relative).
FALLBACK_DOCS: tuple[str, ...] = (
    "docs/SYSTEM.md",
    "docs/GLOSSARY.md",
    "docs/CONTROLS.md",
    "docs/ASSISTANT.md",
    "docs/ASSUMPTIONS.md",
    "docs/LIMITATIONS.md",
    "README.md",
)

# (doc file name, slug or None for the whole doc) in prompt order.  Byte-stable.
CORE_ANCHORS: tuple[tuple[str, Optional[str]], ...] = (
    ("SYSTEM.md", "overview"),
    ("GLOSSARY.md", None),
    ("CONTROLS.md", "quick-reference"),
    ("ASSISTANT.md", "rules-of-engagement"),
)

STOPWORDS = frozenset(
    "the a an and or of to in on for with is are was were be been it its this that these those as at by from "
    "into about what how why when where which who does do did can could should would will not no yes you your "
    "me my we our they their them he she his her i if then than there here also any all some more most very "
    "just only over under up down out so such has have had one two three".split()
)


def slugify(heading: str) -> str:
    """WP7 slug rule: lowercase, drop characters other than [a-z0-9 -], spaces -> '-'."""
    text = _SLUG_DROP.sub("", heading.strip().lower())
    text = re.sub(r"\s+", "-", text.strip())
    return re.sub(r"-{2,}", "-", text).strip("-")


def keywords_of(text: str) -> set[str]:
    """Lowercased alphanumeric tokens (2+ chars) minus stopwords; ids like ``a03`` survive."""
    return {w for w in _WORD.findall(text.lower()) if w not in STOPWORDS}


@dataclass
class DocSection:
    doc: str  # "SYSTEM.md"
    slug: str  # "economy"
    heading: str
    text: str
    tokens: int
    keywords: set[str] = field(default_factory=set)

    @property
    def ref(self) -> str:
        return f"{self.doc}#{self.slug}"

    def render(self) -> str:
        return f"### {self.ref}: {self.heading}\n{self.text}".rstrip()


def parse_index(text: str) -> list[tuple[str, bool]]:
    """``[(repo-relative path, assistant flag)]`` from INDEX.md rows (order kept)."""
    rows: list[tuple[str, bool]] = []
    for line in text.splitlines():
        m = INDEX_ROW.match(line.strip())
        if m:
            rows.append((m.group("path").strip(), m.group("flag").lower() == "yes"))
    return rows


def split_sections(doc_name: str, text: str) -> list[DocSection]:
    """Split a markdown document by ``##`` headings (``#`` and ``###`` are folded into the
    current section; text before the first ``##`` is the ``intro`` section).  Slugs are made
    unique with a numeric suffix."""
    sections: list[DocSection] = []
    seen: dict[str, int] = {}
    heading, buf = "Introduction", []
    slug = "intro"

    def flush() -> None:
        body = "\n".join(buf).strip()
        if not body and not sections:
            return
        if not body:
            return
        key = slug
        n = seen.get(key, 0)
        seen[key] = n + 1
        final = key if n == 0 else f"{key}-{n + 1}"
        sections.append(
            DocSection(doc=doc_name, slug=final, heading=heading, text=body, tokens=config.estimate_tokens(body), keywords=keywords_of(heading + " " + body))
        )

    in_fence = False
    for line in text.splitlines():
        if line.strip().startswith("```"):
            in_fence = not in_fence
        m = None if in_fence else HEADING.match(line)
        if m and len(m.group(1)) == 2:
            flush()
            heading = m.group(2).strip()
            slug = slugify(heading) or "section"
            buf = []
            continue
        buf.append(line)
    flush()
    return sections


class KnowledgeBase:
    """Loaded once per process (``load`` re-reads); every method is safe to call before
    ``load`` (empty results).  ``docs_dir`` is the ``docs/`` folder; INDEX.md paths are
    resolved against its parent (the repo root)."""

    def __init__(self, docs_dir: Optional[Path] = None) -> None:
        self.docs_dir = Path(docs_dir) if docs_dir is not None else config.REPO_DIR / "docs"
        self.repo_dir = self.docs_dir.parent
        self.sections: list[DocSection] = []
        self.docs: list[str] = []  # doc file names in manifest order
        self.manifest_source = "none"  # "index" | "fallback" | "none"
        self._core_cache: Optional[str] = None
        self._lock = threading.Lock()

    # -- loading ------------------------------------------------------------------------

    def manifest(self) -> list[Path]:
        """Doc paths flagged for the assistant, from INDEX.md or the fallback list (existing files only)."""
        index = self.docs_dir / "INDEX.md"
        paths: list[Path] = []
        rows: list[tuple[str, bool]] = []
        if index.exists():
            try:
                rows = parse_index(index.read_text(encoding="utf-8"))
            except OSError:
                rows = []
        if rows:
            self.manifest_source = "index"
            for rel, flag in rows:
                if flag:
                    paths.append(self.repo_dir / rel)
        else:
            self.manifest_source = "fallback"
            paths = [self.repo_dir / rel for rel in FALLBACK_DOCS]
        out: list[Path] = []
        for p in paths:
            if p.is_file() and p not in out:
                out.append(p)
        return out

    def load(self) -> int:
        """(Re)read the manifest and docs; returns the section count."""
        with self._lock:
            sections: list[DocSection] = []
            docs: list[str] = []
            for path in self.manifest():
                try:
                    text = path.read_text(encoding="utf-8")
                except OSError:
                    continue
                docs.append(path.name)
                sections.extend(split_sections(path.name, text))
            self.sections = sections
            self.docs = docs
            self._core_cache = None
            return len(sections)

    def _ensure(self) -> None:
        if not self.sections and self.manifest_source == "none":
            self.load()

    # -- core ------------------------------------------------------------------------------

    def core_sections(self) -> list[DocSection]:
        out: list[DocSection] = []
        for doc, slug in CORE_ANCHORS:
            if slug is None:
                out.extend(s for s in self.sections if s.doc == doc)
            else:
                out.extend(s for s in self.sections if s.doc == doc and s.slug == slug)
        return out

    def core_text(self) -> str:
        """Byte-stable core (manifest order, no timestamps) within ``config.KNOWLEDGE_CORE_TOKENS``;
        a section that would overflow the budget is cut with a note."""
        self._ensure()
        if self._core_cache is not None:
            return self._core_cache
        parts: list[str] = []
        used = 0
        for section in self.core_sections():
            budget_left = config.KNOWLEDGE_CORE_TOKENS - used
            if budget_left <= 50:
                break
            body = section.render()
            if section.tokens > budget_left:
                body = body[: budget_left * config.TOKEN_CHARS_PER_TOKEN].rstrip() + "\n[section cut to fit the knowledge core]"
                used = config.KNOWLEDGE_CORE_TOKENS
            else:
                used += section.tokens
            parts.append(body)
        text = "\n\n".join(parts)
        if not text:
            text = "(no documentation is loaded in this process; answer from tools and say the docs were unavailable)"
        self._core_cache = text
        return text

    # -- retrieval -----------------------------------------------------------------------------

    def _score(self, query_words: set[str], section: DocSection) -> float:
        if not query_words or not section.keywords:
            return 0.0
        overlap = query_words & section.keywords
        if not overlap:
            return 0.0
        heading_words = keywords_of(section.heading)
        bonus = 0.5 * len(overlap & heading_words)
        return len(overlap) / (len(query_words) ** 0.5) + bonus

    def rank(self, query: str, *, exclude_core: bool = True) -> list[tuple[float, DocSection]]:
        self._ensure()
        words = keywords_of(query)
        core = set(id(s) for s in self.core_sections()) if exclude_core else set()
        scored = [(self._score(words, s), s) for s in self.sections if id(s) not in core]
        scored = [(score, s) for score, s in scored if score > 0]
        scored.sort(key=lambda pair: (-pair[0], pair[1].doc, pair[1].slug))
        return scored

    def retrieve(self, query: str, *, token_budget: int) -> list[DocSection]:
        """Top sections by keyword overlap (core sections excluded: they are already in the
        system prompt) within ``token_budget`` tokens."""
        out: list[DocSection] = []
        used = 0
        for _score, section in self.rank(query):
            if used + section.tokens > token_budget:
                continue
            out.append(section)
            used += section.tokens
            if used >= token_budget:
                break
        return out

    def search(self, query: str, *, limit: int = 5) -> list[DocSection]:
        """The ``search_docs`` tool and the offline fallback answer (core included)."""
        return [s for _score, s in self.rank(query, exclude_core=False)[: max(1, limit)]]

    def section(self, ref: str) -> Optional[DocSection]:
        self._ensure()
        doc, _, slug = ref.partition("#")
        for s in self.sections:
            if s.doc == doc and (not slug or s.slug == slug):
                return s
        return None


__all__ = ["CORE_ANCHORS", "DocSection", "FALLBACK_DOCS", "KnowledgeBase", "keywords_of", "parse_index", "slugify", "split_sections"]
