"""
Assistant storage (rev 4): paths under the worlds dir and the run folders, the per-run
``assistant/settings.json`` and the ``ConversationStore`` (per-conversation lock, every
mutation, restart recovery).  Uses only storage.py's public helpers (``atomic_write_json``,
``read_json``, ``find_run_dir``, ``worlds_root``); recovery never touches ``<run>/assistant/``
and continuations do not copy it.  OWNER: WP2.

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

Locking: ``ConversationStore.lock(conv_id)`` is a re-entrant ``threading.RLock`` so the brief
approval path can hold it across validation, execution and the store writes it makes.  Every
store method takes the lock itself; callers may hold it around several calls.
"""
# DOCS: conversations live under <worlds>/_assistant (never inside a run) with a mutable run_id;
# ids are uuid4 hex; settings.json absent = storybook auto off; on service start every
# pending/running message becomes "interrupted" and an "executing" brief becomes "failed".

from __future__ import annotations

import json
import os
import re
import shutil
import threading
import uuid
from pathlib import Path
from typing import Callable, Optional

from .. import config, storage
from ..schemas import utc_now_iso
from .models import (
    GLOBAL_SCOPE,
    AssistantRunSettings,
    Brief,
    ConversationMeta,
    ConversationView,
    Message,
)

_ID_RE = re.compile(r"^[0-9a-f]{32}$")
INTERRUPTED_MESSAGE = "interrupted by a server restart; send the message again"
INTERRUPTED_BRIEF = "interrupted by a server restart while executing; check the run before retrying"


def new_id() -> str:
    """uuid4 hex (conversation, brief, job and story ids)."""
    return uuid.uuid4().hex


class ConversationBusy(Exception):
    """A job is still running for the conversation (routes: 409 ``assistant_busy`` for a new
    message, 409 ``conversation_busy`` for a delete)."""


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


def _check_id(conv_id: str) -> str:
    """Conversation ids are uuid4 hex; anything else is unknown (never a path component)."""
    if not isinstance(conv_id, str) or not _ID_RE.match(conv_id):
        raise storage.StorageError(f"unknown conversation {conv_id!r}")
    return conv_id


def _write_text_atomic(path: Path, text: str) -> None:
    """Temp file + ``os.replace`` (the jsonl rewrite path; storage.py keeps its text writer private)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp-{uuid.uuid4().hex[:8]}")
    try:
        with tmp.open("w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass


def _dump_line(record: Message) -> str:
    return json.dumps(record.model_dump(mode="json"), ensure_ascii=False, sort_keys=True)


class ConversationStore:
    """Owns every mutation of a conversation under a per-conversation ``threading.RLock``
    (append step, brief CAS, rename, rebind, delete).  Reads go through the same lock so a
    reader never sees a half-rewritten ``messages.jsonl``."""

    def __init__(self, paths: AssistantPaths) -> None:
        self.paths = paths
        self._locks: dict[str, threading.RLock] = {}
        self._guard = threading.Lock()

    def lock(self, conv_id: str) -> threading.RLock:
        with self._guard:
            lock = self._locks.get(conv_id)
            if lock is None:
                lock = self._locks[conv_id] = threading.RLock()
            return lock

    # -- raw files ---------------------------------------------------------------------

    def _read_meta(self, conv_id: str) -> ConversationMeta:
        path = self.paths.conversation_meta(_check_id(conv_id))
        if not path.exists():
            raise storage.StorageError(f"unknown conversation {conv_id}")
        return ConversationMeta.model_validate(storage.read_json(path))

    def _write_meta(self, meta: ConversationMeta) -> None:
        path = self.paths.conversation_meta(meta.conversation_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        storage.atomic_write_json(path, meta)

    def _read_messages(self, conv_id: str) -> list[Message]:
        path = self.paths.conversation_messages(conv_id)
        out: list[Message] = []
        if not path.exists():
            return out
        with path.open("r", encoding="utf-8") as fh:
            for raw in fh:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    out.append(Message.model_validate(json.loads(raw)))
                except Exception:  # noqa: BLE001 - a torn last line never hides the conversation
                    continue
        return out

    def _write_messages(self, conv_id: str, messages: list[Message]) -> None:
        text = "".join(_dump_line(m) + "\n" for m in messages)
        _write_text_atomic(self.paths.conversation_messages(conv_id), text)

    def _read_briefs(self, conv_id: str) -> list[Brief]:
        path = self.paths.conversation_briefs(conv_id)
        if not path.exists():
            return []
        raw = storage.read_json(path)
        if not isinstance(raw, list):
            return []
        out: list[Brief] = []
        for item in raw:
            try:
                out.append(Brief.model_validate(item))
            except Exception:  # noqa: BLE001
                continue
        return out

    def _write_briefs(self, conv_id: str, briefs: list[Brief]) -> None:
        path = self.paths.conversation_briefs(conv_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        storage.atomic_write_json(path, [b.model_dump(mode="json") for b in briefs])

    # -- conversations -------------------------------------------------------------------

    def list(self, run_id: Optional[str] = None, *, all_scopes: bool = False) -> list[ConversationMeta]:
        """Metas of the scope (``run_id`` or global), newest first; ``all_scopes`` ignores the scope."""
        root = self.paths.conversations_dir()
        if not root.is_dir():
            return []
        metas: list[ConversationMeta] = []
        for child in root.iterdir():
            if not child.is_dir() or not _ID_RE.match(child.name):
                continue
            try:
                meta = self._read_meta(child.name)
            except Exception:  # noqa: BLE001 - a broken meta never hides the others
                continue
            if all_scopes or meta.run_id == run_id:
                metas.append(meta)
        metas.sort(key=lambda m: (m.updated_at, m.conversation_id), reverse=True)
        return metas

    def create(self, run_id: Optional[str], title: Optional[str] = None) -> ConversationMeta:
        meta = ConversationMeta(conversation_id=new_id(), run_id=run_id, title=title or "New conversation")
        with self.lock(meta.conversation_id):
            self._write_meta(meta)
        return meta

    def meta(self, conv_id: str) -> ConversationMeta:
        """Raises ``storage.StorageError`` (404) for an unknown conversation."""
        with self.lock(conv_id):
            return self._read_meta(conv_id)

    def load(self, conv_id: str) -> ConversationView:
        with self.lock(conv_id):
            meta = self._read_meta(conv_id)
            return ConversationView(meta=meta, messages=self._read_messages(conv_id), briefs=self._read_briefs(conv_id), job=None)

    def messages(self, conv_id: str) -> list[Message]:
        with self.lock(conv_id):
            self._read_meta(conv_id)
            return self._read_messages(conv_id)

    def briefs(self, conv_id: str) -> list[Brief]:
        with self.lock(conv_id):
            self._read_meta(conv_id)
            return self._read_briefs(conv_id)

    def update_meta(self, conv_id: str, mutate: Callable[[ConversationMeta], None]) -> ConversationMeta:
        with self.lock(conv_id):
            meta = self._read_meta(conv_id)
            mutate(meta)
            meta.updated_at = utc_now_iso()
            self._write_meta(meta)
            return meta

    def append_message(self, conv_id: str, message: Message) -> Message:
        with self.lock(conv_id):
            meta = self._read_meta(conv_id)
            path = self.paths.conversation_messages(conv_id)
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as fh:
                fh.write(_dump_line(message) + "\n")
            meta.message_count += 1
            meta.updated_at = utc_now_iso()
            self._write_meta(meta)
            return message

    def update_message(self, conv_id: str, message_id: str, mutate: Callable[[Message], None]) -> Message:
        with self.lock(conv_id):
            self._read_meta(conv_id)
            messages = self._read_messages(conv_id)
            for i, message in enumerate(messages):
                if message.message_id == message_id:
                    mutate(message)
                    message.updated_at = utc_now_iso()
                    messages[i] = message
                    self._write_messages(conv_id, messages)
                    return message
        raise storage.StorageError(f"unknown message {message_id} in conversation {conv_id}")

    def message(self, conv_id: str, message_id: str) -> Message:
        with self.lock(conv_id):
            for message in self._read_messages(conv_id):
                if message.message_id == message_id:
                    return message
        raise storage.StorageError(f"unknown message {message_id} in conversation {conv_id}")

    # -- briefs ------------------------------------------------------------------------------

    def put_brief(self, conv_id: str, brief: Brief) -> Brief:
        """Insert or replace by ``brief_id``; ``meta.last_brief_id`` follows."""
        with self.lock(conv_id):
            meta = self._read_meta(conv_id)
            briefs = self._read_briefs(conv_id)
            brief.updated_at = utc_now_iso()
            for i, existing in enumerate(briefs):
                if existing.brief_id == brief.brief_id:
                    briefs[i] = brief
                    break
            else:
                briefs.append(brief)
            self._write_briefs(conv_id, briefs)
            meta.last_brief_id = brief.brief_id
            meta.updated_at = utc_now_iso()
            self._write_meta(meta)
            return brief

    def brief(self, conv_id: str, brief_id: str) -> Brief:
        with self.lock(conv_id):
            self._read_meta(conv_id)
            for brief in self._read_briefs(conv_id):
                if brief.brief_id == brief_id:
                    return brief
        raise storage.StorageError(f"unknown brief {brief_id} in conversation {conv_id}")

    def cas_brief(self, conv_id: str, brief_id: str, expected_status: str, mutate: Callable[[Brief], None]) -> Optional[Brief]:
        """Compare-and-set under the lock: None when the brief is not in ``expected_status``."""
        with self.lock(conv_id):
            self._read_meta(conv_id)
            briefs = self._read_briefs(conv_id)
            for i, brief in enumerate(briefs):
                if brief.brief_id == brief_id:
                    if brief.status != expected_status:
                        return None
                    mutate(brief)
                    brief.updated_at = utc_now_iso()
                    briefs[i] = brief
                    self._write_briefs(conv_id, briefs)
                    return brief
        raise storage.StorageError(f"unknown brief {brief_id} in conversation {conv_id}")

    def supersede_pending(self, conv_id: str, new_brief_id: str) -> list[str]:
        """Every other pending brief of the conversation becomes ``superseded`` (by the new one)."""
        with self.lock(conv_id):
            self._read_meta(conv_id)
            briefs = self._read_briefs(conv_id)
            changed: list[str] = []
            for brief in briefs:
                if brief.brief_id != new_brief_id and brief.status == "pending":
                    brief.status = "superseded"
                    brief.superseded_by = new_brief_id
                    brief.updated_at = utc_now_iso()
                    changed.append(brief.brief_id)
            if changed:
                self._write_briefs(conv_id, briefs)
            return changed

    # -- delete / recovery -------------------------------------------------------------------

    def delete(self, conv_id: str) -> None:
        """Remove the folder (the route answers 409 ``conversation_busy`` first while a job runs)."""
        with self.lock(conv_id):
            folder = self.paths.conversation_dir(_check_id(conv_id))
            if not folder.is_dir():
                raise storage.StorageError(f"unknown conversation {conv_id}")
            shutil.rmtree(folder)

    def recover_interrupted(self) -> int:
        """On service start: rewrite pending/running messages to ``interrupted`` (with the
        retry hint), ``executing`` briefs to ``failed`` and clear ``active_job_id``.  Returns
        the number of records changed."""
        changed = 0
        for meta in self.list(all_scopes=True):
            conv_id = meta.conversation_id
            with self.lock(conv_id):
                messages = self._read_messages(conv_id)
                dirty = False
                for message in messages:
                    if message.status in ("pending", "running"):
                        message.status = "interrupted"
                        message.error = INTERRUPTED_MESSAGE
                        message.progress = None
                        message.updated_at = utc_now_iso()
                        dirty = True
                        changed += 1
                if dirty:
                    self._write_messages(conv_id, messages)
                briefs = self._read_briefs(conv_id)
                dirty = False
                for brief in briefs:
                    if brief.status == "executing":
                        brief.status = "failed"
                        brief.error = INTERRUPTED_BRIEF
                        brief.updated_at = utc_now_iso()
                        dirty = True
                        changed += 1
                if dirty:
                    self._write_briefs(conv_id, briefs)
                if meta.active_job_id is not None:
                    meta.active_job_id = None
                    meta.updated_at = utc_now_iso()
                    self._write_meta(meta)
                    changed += 1
        return changed


__all__ = [
    "AssistantPaths",
    "ConversationBusy",
    "ConversationStore",
    "INTERRUPTED_BRIEF",
    "INTERRUPTED_MESSAGE",
    "default_run_settings",
    "new_id",
    "read_run_settings",
    "write_run_settings",
]
