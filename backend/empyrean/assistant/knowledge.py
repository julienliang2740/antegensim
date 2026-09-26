"""
Knowledge = the repo docs (rev 4, D4 + A-AST-7): the curated docs (docs/INDEX.md ``assistant:
yes``) split by ``##`` headings into sections with ids; the byte-stable knowledge core (SYSTEM
overview, GLOSSARY, CONTROLS quick table, rules of engagement) for the system prompt and
keyword-overlap retrieval for the user message (no embeddings).  Numbers for a specific run come
from tools, never from docs.  OWNER: WP2.
"""
# DOCS: docs feed the assistant, so the docs regime is load-bearing; sections are addressed as
# <FILE>.md#<slug> (AnswerRef kind "doc").

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


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


class KnowledgeBase:
    def __init__(self, docs_dir: Optional[Path] = None) -> None:
        raise NotImplementedError("WP2 KnowledgeBase")

    def load(self) -> int:
        """(Re)read the manifest and docs; returns the section count."""
        raise NotImplementedError("WP2 KnowledgeBase.load")

    def core_text(self) -> str:
        """Byte-stable core (sorted, no timestamps) within ``config.KNOWLEDGE_CORE_TOKENS``."""
        raise NotImplementedError("WP2 KnowledgeBase.core_text")

    def retrieve(self, query: str, *, token_budget: int) -> list[DocSection]:
        raise NotImplementedError("WP2 KnowledgeBase.retrieve")

    def search(self, query: str, *, limit: int = 5) -> list[DocSection]:
        """The ``search_docs`` tool and the offline fallback answer."""
        raise NotImplementedError("WP2 KnowledgeBase.search")

    def section(self, ref: str) -> Optional[DocSection]:
        raise NotImplementedError("WP2 KnowledgeBase.section")


__all__ = ["DocSection", "KnowledgeBase"]
