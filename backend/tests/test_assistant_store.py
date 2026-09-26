"""ConversationStore (rev 4, amended D5): files under <worlds>/_assistant/conversations, the
per-conversation RLock, message and brief mutations, CAS, supersede, delete and restart
recovery (pending/running -> interrupted, executing brief -> failed)."""

from __future__ import annotations

import threading

import pytest

from empyrean import storage
from empyrean.assistant.models import Brief, Message
from empyrean.assistant.store import (
    INTERRUPTED_BRIEF,
    INTERRUPTED_MESSAGE,
    AssistantPaths,
    ConversationStore,
    default_run_settings,
    read_run_settings,
    write_run_settings,
)


@pytest.fixture()
def store(worlds_dir):
    return ConversationStore(AssistantPaths(worlds_dir))


def test_create_list_and_scope(store: ConversationStore, worlds_dir) -> None:
    a = store.create(None)
    b = store.create("run_x", title="About run x")
    assert (worlds_dir / "_assistant" / "conversations" / a.conversation_id / "meta.json").exists()
    assert [m.conversation_id for m in store.list(None)] == [a.conversation_id]
    assert [m.conversation_id for m in store.list("run_x")] == [b.conversation_id]
    assert {m.conversation_id for m in store.list(all_scopes=True)} == {a.conversation_id, b.conversation_id}
    assert store.meta(b.conversation_id).title == "About run x"
    assert store.meta(a.conversation_id).run_id is None


def test_unknown_or_malformed_ids_are_storage_errors(store: ConversationStore) -> None:
    with pytest.raises(storage.StorageError):
        store.meta("0" * 32)
    with pytest.raises(storage.StorageError):
        store.meta("../etc/passwd")
    with pytest.raises(storage.StorageError):
        store.delete("not-an-id")


def test_messages_append_update_and_count(store: ConversationStore) -> None:
    conv = store.create(None)
    cid = conv.conversation_id
    user = store.append_message(cid, Message(message_id="m1", role="user", text="hi"))
    pending = store.append_message(cid, Message(message_id="m2", role="assistant", status="pending"))
    assert store.meta(cid).message_count == 2
    store.update_message(cid, pending.message_id, lambda m: (setattr(m, "status", "done"), setattr(m, "text", "hello")))
    view = store.load(cid)
    assert [m.message_id for m in view.messages] == [user.message_id, "m2"]
    assert view.messages[1].status == "done" and view.messages[1].text == "hello"
    assert view.messages[1].updated_at >= view.messages[1].created_at
    with pytest.raises(storage.StorageError):
        store.update_message(cid, "nope", lambda m: None)
    assert store.message(cid, "m1").text == "hi"


def test_briefs_put_cas_and_supersede(store: ConversationStore) -> None:
    cid = store.create("run_x").conversation_id
    b1 = store.put_brief(cid, Brief(brief_id="b1", conversation_id=cid, message_id="m", title="one"))
    assert store.meta(cid).last_brief_id == "b1"
    assert store.cas_brief(cid, "b1", "executed", lambda b: None) is None  # wrong expected status
    moved = store.cas_brief(cid, "b1", "pending", lambda b: setattr(b, "status", "executing"))
    assert moved is not None and moved.status == "executing"
    assert store.brief(cid, "b1").status == "executing"
    # replace by id keeps one record
    store.put_brief(cid, store.brief(cid, "b1").model_copy(update={"title": "one again"}))
    assert [b.brief_id for b in store.briefs(cid)] == ["b1"]
    store.put_brief(cid, Brief(brief_id="b2", conversation_id=cid, message_id="m", status="pending"))
    store.put_brief(cid, Brief(brief_id="b3", conversation_id=cid, message_id="m", status="pending"))
    assert store.supersede_pending(cid, "b3") == ["b2"]
    assert store.brief(cid, "b2").status == "superseded" and store.brief(cid, "b2").superseded_by == "b3"
    assert store.brief(cid, "b3").status == "pending"
    with pytest.raises(storage.StorageError):
        store.brief(cid, "zz")


def test_lock_is_reentrant_and_delete_removes_folder(store: ConversationStore, worlds_dir) -> None:
    cid = store.create(None).conversation_id
    lock = store.lock(cid)
    assert isinstance(lock, type(threading.RLock()))
    with lock:
        store.append_message(cid, Message(message_id="m1", role="user", text="x"))  # would deadlock with a plain Lock
        with lock:
            assert store.meta(cid).message_count == 1
    store.delete(cid)
    assert not (worlds_dir / "_assistant" / "conversations" / cid).exists()
    with pytest.raises(storage.StorageError):
        store.meta(cid)


def test_recover_interrupted_rewrites_pending_records(store: ConversationStore) -> None:
    cid = store.create(None).conversation_id
    store.append_message(cid, Message(message_id="m1", role="user", text="q"))
    store.append_message(cid, Message(message_id="m2", role="assistant", status="running", progress="step 2/4"))
    store.append_message(cid, Message(message_id="m3", role="assistant", status="done", text="fine"))
    store.put_brief(cid, Brief(brief_id="b1", conversation_id=cid, message_id="m3", status="executing"))
    store.update_meta(cid, lambda m: setattr(m, "active_job_id", "job-1"))
    assert store.recover_interrupted() == 3
    view = store.load(cid)
    by_id = {m.message_id: m for m in view.messages}
    assert by_id["m2"].status == "interrupted" and by_id["m2"].error == INTERRUPTED_MESSAGE and by_id["m2"].progress is None
    assert by_id["m3"].status == "done"
    assert view.briefs[0].status == "failed" and view.briefs[0].error == INTERRUPTED_BRIEF
    assert view.meta.active_job_id is None
    assert store.recover_interrupted() == 0


def test_torn_message_line_never_hides_the_conversation(store: ConversationStore) -> None:
    cid = store.create(None).conversation_id
    store.append_message(cid, Message(message_id="m1", role="user", text="q"))
    path = store.paths.conversation_messages(cid)
    with path.open("a", encoding="utf-8") as fh:
        fh.write('{"message_id": "m2", "role": "assist')  # torn
    assert [m.message_id for m in store.messages(cid)] == ["m1"]


def test_run_settings_roundtrip(manager, default_request, worlds_dir) -> None:
    run_id = manager.create_run(default_request).run_id
    paths = AssistantPaths(worlds_dir)
    assert read_run_settings(paths, run_id) is None
    settings = default_run_settings()
    settings.chat_budget_usd = 1.5
    write_run_settings(paths, run_id, settings)
    loaded = read_run_settings(paths, run_id)
    assert loaded is not None and loaded.chat_budget_usd == 1.5 and loaded.storybook_auto is False
    with pytest.raises(storage.StorageError):
        read_run_settings(paths, "run_missing")
