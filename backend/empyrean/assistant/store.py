"""
Assistant storage (rev 4): paths under the worlds dir and the run folders, the per-run
``assistant/settings.json`` and the ``ConversationStore`` (per-conversation lock, every
mutation, restart recovery).  Uses only storage.py's public helpers (``atomic_write_json``,
``read_json``, ``find_run_dir``, ``worlds_root``); recovery never touches ``<run>/assistant/``
and continuations do not copy it.  OWNER: WP2 (paths and settings below are final; the
conversation methods are signatures until WP2 lands).

Layout
------
<worlds>/_assistant/usage.jsonl                                   global ledger
<worlds>/_assistant/conversations/<conv_id>/meta.json            ConversationMeta (mutable run_id)
<worlds>/_assistant/conversations/<conv_id>/messages.jsonl       Message per line (append; rewrite on update)
<worlds>/_assistant/conversations/<conv_id>/briefs.json          list[Brief]
<run>/assistant/settings.json                                    AssistantRunSettings
<run>/assistant/usage.jsonl                                      per-run ledger
<run>/assistant/storybook/entries/<turn_id>.json  + opening.json StorybookEntry
<run>/assistant/.storybook.lock                                  flock against a second process
<run>/assistant/stories/<story_id>/story.json + chapters/<n>.json
"""
# DOCS: conversations live under <worlds>/_assistant (never inside a run) with a mutable run_id;
# ids are uuid4; settings.json absent = storybook auto off.

from __future__ import annotations

import threading
import uuid
from pathlib import Path
from typing import Callable, Optional

from .. import config, storage
from .models import (
    GLOBAL_SCOPE,
    AssistantRunSettings,
    Brief,
    ConversationMeta,
    ConversationView,
    Message,
)


def new_id() -> str:
    """uuid4 hex (conversation, brief, job and story ids)."""
    return uuid.uuid4().hex


class AssistantPaths:
    """Every assistant path in one place.  ``worlds_dir`` None = ``storage.worlds_root()`` at
    call time (tests monkeypatch config.WORLDS_DIR)."""

    def __init__(self, worlds_dir: Optional[Path] = None) -> None:
        self._worlds_dir = Path(worlds_dir) if worlds_dir is not None else None

    def worlds_root(self) -> Path:
        return self._worlds_dir if self._worlds_dir is not None else storage.worlds_root()

    # -- global scope --------------------------------------------------------------
    def global_dir(self) -> Path:
        return self.worlds_root() / config.ASSISTANT_GLOBAL_DIR_NAME

    def conversations_dir(self) -> Path:
        return self.global_dir() / "conversations"

    def conversation_dir(self, conv_id: str) -> Path:
        return self.conversations_dir() / conv_id

    def conversation_meta(self, conv_id: str) -> Path:
        return self.conversation_dir(conv_id) / "meta.json"

    def conversation_messages(self, conv_id: str) -> Path:
        return self.conversation_dir(conv_id) / "messages.jsonl"

    def conversation_briefs(self, conv_id: str) -> Path:
        return self.conversation_dir(conv_id) / "briefs.json"

    # -- run scope -----------------------------------------------------------------
    def run_assistant_dir(self, run_id: str) -> Path:
        """``<run>/assistant`` (raises StorageError for an unknown run)."""
        return storage.find_run_dir(run_id) / "assistant"

    def run_settings(self, run_id: str) -> Path:
        return self.run_assistant_dir(run_id) / "settings.json"

    def usage(self, scope: str) -> Path:
        """Ledger file of a scope ("global" or a run id)."""
        if scope == GLOBAL_SCOPE:
            return self.global_dir() / "usage.jsonl"
        return self.run_assistant_dir(scope) / "usage.jsonl"

    def storybook_dir(self, run_id: str) -> Path:
        return self.run_assistant_dir(run_id) / "storybook"

    def storybook_entries_dir(self, run_id: str) -> Path:
        return self.storybook_dir(run_id) / "entries"

    def storybook_entry(self, run_id: str, turn_id: str) -> Path:
        return self.storybook_entries_dir(run_id) / f"{turn_id}.json"

    def storybook_opening(self, run_id: str) -> Path:
        return self.storybook_entries_dir(run_id) / "opening.json"

    def storybook_lock(self, run_id: str) -> Path:
        return self.run_assistant_dir(run_id) / ".storybook.lock"

    def stories_dir(self, run_id: str) -> Path:
        return self.run_assistant_dir(run_id) / "stories"

    def story_dir(self, run_id: str, story_id: str) -> Path:
        return self.stories_dir(run_id) / story_id

    def story_file(self, run_id: str, story_id: str) -> Path:
        return self.story_dir(run_id, story_id) / "story.json"

    def chapter_file(self, run_id: str, story_id: str, number: int) -> Path:
        return self.story_dir(run_id, story_id) / "chapters" / f"{number:04d}.json"


def read_run_settings(paths: AssistantPaths, run_id: str) -> Optional[AssistantRunSettings]:
    """``settings.json`` of a run, or None when the run has none (existing runs: auto off)."""
    path = paths.run_settings(run_id)
    if not path.exists():
        return None
    return AssistantRunSettings.model_validate(storage.read_json(path))


def write_run_settings(paths: AssistantPaths, run_id: str, settings: AssistantRunSettings) -> AssistantRunSettings:
    path = paths.run_settings(run_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    storage.atomic_write_json(path, settings)
    return settings


def default_run_settings() -> AssistantRunSettings:
    """Config defaults with ``storybook_auto`` False (storybook.default_auto decides the flag)."""
    return AssistantRunSettings(
        storybook_auto=False,
        auto_since_turn_id=None,
        storybook_budget_usd=config.ASSISTANT_STORYBOOK_BUDGET_USD,
        chat_budget_usd=config.ASSISTANT_CHAT_BUDGET_USD,
    )


class ConversationStore:
    """Owns every mutation of a conversation under a per-conversation ``threading.Lock``
    (append step, brief CAS, rename, rebind, delete).  Bodies land with WP2."""

    def __init__(self, paths: AssistantPaths) -> None:
        self.paths = paths
        self._locks: dict[str, threading.Lock] = {}
        self._guard = threading.Lock()

    def lock(self, conv_id: str) -> threading.Lock:
        with self._guard:
            lock = self._locks.get(conv_id)
            if lock is None:
                lock = self._locks[conv_id] = threading.Lock()
            return lock

    def list(self, run_id: Optional[str] = None, *, all_scopes: bool = False) -> list[ConversationMeta]:
        """Metas of the scope (``run_id`` or global), newest first; ``all_scopes`` ignores the scope."""
        raise NotImplementedError("WP2: ConversationStore.list")

    def create(self, run_id: Optional[str], title: Optional[str] = None) -> ConversationMeta:
        raise NotImplementedError("WP2: ConversationStore.create")

    def meta(self, conv_id: str) -> ConversationMeta:
        """Raises ``storage.StorageError`` (404) for an unknown conversation."""
        raise NotImplementedError("WP2: ConversationStore.meta")

    def load(self, conv_id: str) -> ConversationView:
        raise NotImplementedError("WP2: ConversationStore.load")

    def update_meta(self, conv_id: str, mutate: Callable[[ConversationMeta], None]) -> ConversationMeta:
        raise NotImplementedError("WP2: ConversationStore.update_meta")

    def append_message(self, conv_id: str, message: Message) -> Message:
        raise NotImplementedError("WP2: ConversationStore.append_message")

    def update_message(self, conv_id: str, message_id: str, mutate: Callable[[Message], None]) -> Message:
        raise NotImplementedError("WP2: ConversationStore.update_message")

    def put_brief(self, conv_id: str, brief: Brief) -> Brief:
        raise NotImplementedError("WP2: ConversationStore.put_brief")

    def brief(self, conv_id: str, brief_id: str) -> Brief:
        raise NotImplementedError("WP2: ConversationStore.brief")

    def cas_brief(self, conv_id: str, brief_id: str, expected_status: str, mutate: Callable[[Brief], None]) -> Optional[Brief]:
        """Compare-and-set under the lock: None when the brief is not in ``expected_status``."""
        raise NotImplementedError("WP2: ConversationStore.cas_brief")

    def delete(self, conv_id: str) -> None:
        """409 ``conversation_busy`` (raised by the route) while a job runs."""
        raise NotImplementedError("WP2: ConversationStore.delete")

    def recover_interrupted(self) -> int:
        """On service start: rewrite pending/running messages and jobs to ``interrupted``.
        Returns the number of records changed."""
        raise NotImplementedError("WP2: ConversationStore.recover_interrupted")


__all__ = [
    "AssistantPaths",
    "ConversationStore",
    "default_run_settings",
    "new_id",
    "read_run_settings",
    "write_run_settings",
]
