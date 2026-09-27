"""Run archive and delete (Resume page): ``archive.json`` markers, the ``?archived=`` list filter,
``POST /runs/{id}/archive|unarchive`` and ``DELETE /runs/{id}`` against real storage with fake
models.  Deleting refuses (409 ``run_in_use``) while the run is open here, held by another
writer, or has a story job; it removes the run folder and an emptied world folder only."""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any

from empyrean import config, storage


def create_closed_run(client: Any, request: Any, name: str) -> dict[str, Any]:
    body = request.model_dump(mode="json")
    body["name"] = name
    created = client.post("/api/runs", json=body)
    assert created.status_code == 201, created.text
    summary = created.json()
    assert client.post(f"/api/runs/{summary['run_id']}/close").status_code == 200
    return summary


def wait_for_writer_lock(run_id: str, timeout: float = 10.0) -> Any:
    """Take the run's writer lock once the closed worker has let go of it.  POST /close returns
    at once while the worker finishes and exits (RunWorker.close), so the lock can still be held
    for a moment after the response; ``RunManager.delete_run`` waits for that worker itself."""
    deadline = time.monotonic() + timeout
    while True:
        lock = storage.acquire_writer_lock(run_id)
        if lock is not None or time.monotonic() >= deadline:
            return lock
        time.sleep(0.02)


def ids(response: Any) -> list[str]:
    assert response.status_code == 200, response.text
    return [r["run_id"] for r in response.json()]


def test_archive_unarchive_round_trip_and_listing_filters(client, default_request, worlds_dir: Path) -> None:
    first = create_closed_run(client, default_request, "first")
    second = create_closed_run(client, default_request, "second")
    assert set(ids(client.get("/api/runs"))) == {first["run_id"], second["run_id"]}
    assert ids(client.get("/api/runs?archived=1")) == []

    archived = client.post(f"/api/runs/{first['run_id']}/archive")
    assert archived.status_code == 200 and archived.json()["archived"] is True
    stamp = archived.json()["archived_at"]
    marker = Path(storage.find_run_dir(first["run_id"])) / storage.ARCHIVE_FILE
    assert json.loads(marker.read_text()) == {"archived_at": stamp, "note": ""}
    # idempotent: a second archive keeps the first timestamp
    assert client.post(f"/api/runs/{first['run_id']}/archive").json()["archived_at"] == stamp

    assert ids(client.get("/api/runs")) == [second["run_id"]]
    assert ids(client.get("/api/runs?archived=0")) == [second["run_id"]]
    assert ids(client.get("/api/runs?archived=1")) == [first["run_id"]]
    assert set(ids(client.get("/api/runs?archived=all"))) == {first["run_id"], second["run_id"]}
    assert client.get(f"/api/runs/{first['run_id']}").json()["archived"] is True

    restored = client.post(f"/api/runs/{first['run_id']}/unarchive")
    assert restored.status_code == 200 and restored.json()["archived"] is False and restored.json()["archived_at"] is None
    assert not marker.exists()
    assert client.post(f"/api/runs/{first['run_id']}/unarchive").status_code == 200  # idempotent
    assert set(ids(client.get("/api/runs"))) == {first["run_id"], second["run_id"]}


def test_open_run_can_be_archived_and_keeps_its_live_status(client, default_request) -> None:
    body = default_request.model_dump(mode="json")
    run_id = client.post("/api/runs", json=body).json()["run_id"]  # stays open (paused)
    assert client.post(f"/api/runs/{run_id}/archive").json()["archived"] is True
    (listed,) = client.get("/api/runs?archived=1").json()
    assert listed["run_id"] == run_id and listed["archived"] is True and listed["status"] == "paused"
    assert client.get("/api/runs").json() == []


def test_delete_closed_run_removes_its_folder_and_the_emptied_world(client, default_request, worlds_dir: Path) -> None:
    summary = create_closed_run(client, default_request, "doomed")
    rdir = Path(storage.find_run_dir(summary["run_id"]))
    world_dir = worlds_dir / summary["world_id"]
    assert client.post(f"/api/runs/{summary['run_id']}/archive").status_code == 200
    unrelated = worlds_dir / "_assistant" / "keep.txt"
    unrelated.parent.mkdir(parents=True)
    unrelated.write_text("x")

    response = client.delete(f"/api/runs/{summary['run_id']}")
    assert response.status_code == 204, response.text
    assert not rdir.exists() and not world_dir.exists()
    assert unrelated.read_text() == "x"
    assert client.get(f"/api/runs/{summary['run_id']}").json()["error"] == "not_found"
    assert client.get("/api/runs?archived=all").json() == []
    again = client.delete(f"/api/runs/{summary['run_id']}")
    assert again.status_code == 404 and again.json()["error"] == "not_found"


def test_delete_keeps_the_world_while_other_runs_remain_and_continuations_do_not_copy_the_marker(client, default_request, worlds_dir: Path) -> None:
    parent = create_closed_run(client, default_request, "parent")
    assert client.post(f"/api/runs/{parent['run_id']}/archive").status_code == 200
    child = client.post(f"/api/runs/{parent['run_id']}/continuations", json={"from_turn_id": "r00000_init"})
    assert child.status_code == 201, child.text
    child_id = child.json()["run_id"]
    assert child.json()["archived"] is False
    assert not (Path(storage.find_run_dir(child_id)) / storage.ARCHIVE_FILE).exists()
    assert client.post(f"/api/runs/{child_id}/close").status_code == 200

    assert client.delete(f"/api/runs/{parent['run_id']}").status_code == 204
    assert (worlds_dir / parent["world_id"] / "runs" / child_id / "manifest.json").is_file()
    assert ids(client.get("/api/runs")) == [child_id]


def test_delete_refuses_an_open_run_and_one_locked_by_another_writer(client, default_request) -> None:
    body = default_request.model_dump(mode="json")
    open_id = client.post("/api/runs", json=body).json()["run_id"]
    refused = client.delete(f"/api/runs/{open_id}")
    assert refused.status_code == 409 and refused.json()["error"] == "run_in_use"
    assert Path(storage.find_run_dir(open_id)).is_dir()

    closed = create_closed_run(client, default_request, "locked elsewhere")
    lock = wait_for_writer_lock(closed["run_id"])  # stands in for another backend process
    assert lock is not None
    try:
        held = client.delete(f"/api/runs/{closed['run_id']}")
        assert held.status_code == 409 and held.json()["error"] == "run_in_use"
        assert (Path(storage.find_run_dir(closed["run_id"])) / "manifest.json").is_file()
    finally:
        lock.release()
    assert client.delete(f"/api/runs/{closed['run_id']}").status_code == 204


def test_unknown_run_is_404_for_archive_unarchive_and_delete(client) -> None:
    for method, path in (("post", "/archive"), ("post", "/unarchive"), ("delete", "")):
        response = getattr(client, method)(f"/api/runs/run_20990101_000000_ffff{path}")
        assert response.status_code == 404 and response.json()["error"] == "not_found", path


def test_recover_run_keeps_the_archive_marker(client, default_request) -> None:
    summary = create_closed_run(client, default_request, "recover me")
    client.post(f"/api/runs/{summary['run_id']}/archive")
    rdir = Path(storage.find_run_dir(summary["run_id"]))
    before = (rdir / storage.ARCHIVE_FILE).read_text()
    (rdir / "turns" / ".partial_r00001_t01_a01").mkdir()  # something for recovery to clean up
    report = storage.recover_run(summary["run_id"])
    assert "turns/.partial_r00001_t01_a01" in report.deleted_dirs
    assert (rdir / storage.ARCHIVE_FILE).read_text() == before
    # opening (which runs recovery) keeps it archived too
    assert client.post(f"/api/runs/{summary['run_id']}/open").status_code == 200
    assert client.get(f"/api/runs/{summary['run_id']}").json()["archived"] is True


def test_corrupt_archive_marker_is_logged_and_the_run_listed_as_active(client, default_request, caplog) -> None:
    summary = create_closed_run(client, default_request, "corrupt marker")
    marker = Path(storage.find_run_dir(summary["run_id"])) / storage.ARCHIVE_FILE
    for text in ("{not json", '{"note": "no timestamp"}', "[1, 2]"):
        marker.write_text(text)
        caplog.clear()
        with caplog.at_level(logging.WARNING, logger="empyrean.storage"):
            listed = client.get("/api/runs").json()
        assert [(r["run_id"], r["archived"]) for r in listed] == [(summary["run_id"], False)], text
        assert any("archive marker" in r.getMessage() for r in caplog.records), text
    # archiving again rewrites the broken marker
    assert client.post(f"/api/runs/{summary['run_id']}/archive").json()["archived"] is True
    assert json.loads(marker.read_text())["archived_at"]


def test_delete_refuses_a_run_with_a_story_job(assistant_client, assistant, default_request, monkeypatch) -> None:
    monkeypatch.setattr(config, "STORYBOOK_AUTO", "off")  # no background opening entry job for this run
    summary = create_closed_run(assistant_client, default_request, "story in progress")
    assert assistant.run_writing_jobs(summary["run_id"]) == []
    job = assistant.new_job("story", run_id=summary["run_id"], story_id="s1")
    refused = assistant_client.delete(f"/api/runs/{summary['run_id']}")
    assert refused.status_code == 409 and refused.json()["error"] == "run_in_use" and "story" in refused.json()["detail"]
    assistant.update_job(job.job_id, status="done")
    chat = assistant.new_job("chat", run_id=summary["run_id"])  # reading jobs never block a delete
    assert chat.status == "queued"
    final = assistant_client.delete(f"/api/runs/{summary['run_id']}")
    assert final.status_code == 204, (final.text, assistant.jobs)
