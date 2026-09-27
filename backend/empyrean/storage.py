"""
File storage and history.  OWNER: engine/storage team.

Layout (see docs/INTERFACES.md "Storage layout" for example contents):

    worlds/{world_id}/runs/{run_id}/
        manifest.json                    Manifest — the COMMIT POINT (atomic write)
        .writer.lock                     flock held by the one open worker (acquire_writer_lock)
        archive.json                     RunArchiveMarker, present only while the run is archived
                                         (archive_run / unarchive_run; hidden from the default list)
        run_request.json                 the RunCreateRequest used (reference only)
        assumptions.json                 [AssumptionEntry] recorded once at creation
        staged_snapshots/{iv_id}.json    WorkingState snapshot of a staged apply_working_files
        working/                         human-editable copy of the latest checkpoint
            README.txt
            BASE_TURN                    turn id the copy was made from
            map.json                     MapState
            rules.json                   RulesConfig
            settings.json                RunSettings
            world.json                   WorldState scalars: round, next_entity_seq, rng_state, observation_page_size, warnings,
                                         plus agent_order (storage addition, see below)
            entities/agents/{agent_id}.json        Agent
            entities/knowledge/{agent_id}.json     AgentKnowledge
            entities/plants.json         {id: Plant}
            entities/fruits.json         {id: Fruit}
            entities/seeds.json          {id: Seed}
            entities/residues.json       {id: Residue}
            entities/removed.json        {id: RemovedEntity}   (storage addition, see below)
            staged_edits.json            StagedEdits (survives commits until applied)
            pending_model_calls/{call_id}.json     ModelCallRecord (pending, then with result)
        turns/
            index.jsonl                  one TurnIndexEntry per line, append-only
            .partial_{turn_id}/          a checkpoint being written (never read)
            {turn_id}/
                state.json               TurnRecord
                map.json                 MapState (with occupants)
                rules.json               RulesConfig
                settings.json            RunSettings
                world.json               as in working/
                entities/...             same files as working/entities
                events.json              [Event]  (this turn's events, in seq order; may include
                                          carried events of a failed earlier attempt)
                model_calls/index.json   [ModelCallSummary]
                model_calls/{call_id}.json         ModelCallRecord
                decision_packets/{packet_id}.json  DecisionPacketRecord

Storage additions to the INTERFACES section 5 layout: ``world.json`` and
``entities/removed.json`` hold the WorldState fields that have no file there
(``round``, ``next_entity_seq``, ``rng_state``, ``observation_page_size``, ``warnings``, ``removed``) so every checkpoint
is complete and loadable (spec "What must be stored": seed/random state).
``world.json`` also records ``agent_order`` (the ``world.agents`` insertion
order) because one file per agent loses it and the engine emits per-agent
events in dict order; reloading must not reorder them (reproducibility).

JSON style: ``indent=2``, UTF-8, no NaN/Infinity.  Model fields keep their
schema order (ids and names first, as in the INTERFACES examples); id-keyed
maps keep the world's insertion order instead of being sorted, because the
engine iterates them in that order.

Knowledge files are written only when they changed (fix pass)
-------------------------------------------------------------
Every agent's knowledge grows for the whole run, and most agents' stores do not
change in a turn (only the actor's, plus recipients of messages / damage / voice),
so copying every store into every turn dir made history grow quadratically
(measured 128 KB -> 309 KB per agent turn between rounds 1 and 8 for 8 agents).
A turn dir therefore holds ``entities/knowledge/<id>.json`` only for the agents
whose store differs from the previous committed turn's, and its ``world.json``
carries ``knowledge_files`` = ``{agent_id: {"turn_id": <turn that holds the
file>, "sha256": <hash of its text>}}`` for EVERY agent (storage addition, popped
before ``WorldState`` is validated).  Loaders resolve a missing local file
through that map (``load_checkpoint``, ``read_knowledge``); ``working/`` and a
continuation's copied first turn always hold every file, so an operator and a
child run never depend on another turn dir.  Runs written before this change
have no map and every file local, which reads the same way.

Commit protocol (write_checkpoint)
----------------------------------
1. Write every file of the turn into ``turns/.partial_{turn_id}/`` (each file
   fsynced when ``FSYNC_TURN_FILES``); remove any stale ``turns/{turn_id}`` (a
   failed earlier attempt) and ``os.replace`` the partial dir to ``turns/{turn_id}``.
2. Write ``manifest.json`` atomically (temp + fsync + ``os.replace``).  THIS IS THE
   COMMIT POINT.
3. Append the TurnIndexEntry to ``turns/index.jsonl``.
4. Refresh ``working/`` (entity dir replaced wholesale via temp dir + swap; never touches
   ``staged_edits.json`` or ``pending_model_calls/``) and write ``working/BASE_TURN``.
5. Delete only the pending-call files whose call_id is in the committed turn.
Everything after step 2 is repaired on open if it did not happen, so failures in
steps 3-5 are logged and do not undo the commit.

Recovery (recover_run, called by RunManager.open_run)
-----------------------------------------------------
* The committed set is the chain from ``manifest.current_turn_id`` through
  ``previous_turn_id``; ``.partial_*`` and unreachable turn dirs are deleted (reported).
* ``index.jsonl`` is rebuilt when missing or when it does not list exactly the chain.
* If ``working/BASE_TURN`` != ``current_turn_id`` the working copy is rebuilt and the
  report says the stale copy was discarded.
* Leftover ``pending_model_calls/*.json`` are returned as records (status "failed",
  error "interrupted (outcome uncertain)", charged 0) for the runner to carry into the
  next committed turn; the files are deleted only after that commit (step 5).  A
  pending file whose call id is already in a committed turn (crash between steps 2
  and 5) is deleted instead: its usage is already in ``manifest.real_usage``.
* ``list_runs`` skips run dirs without a manifest.
* ``archive.json`` is never touched by recovery and never copied by ``create_continuation``.

Archive and delete (run archive)
--------------------------------
``archive_run`` writes ``archive.json`` (``RunArchiveMarker``; idempotent, the first
``archived_at`` is kept); ``unarchive_run`` removes it.  ``list_runs`` reports every run with
``archived``/``archived_at``; a marker that cannot be read or validated is logged and the run is
treated as active.  ``delete_run`` takes the writer lock (``RunInUseError`` when another worker
holds it), removes ``manifest.json`` first (the run disappears from every listing at once), then
the whole run folder, then ``runs/`` and the world folder only if they are left empty
(``os.rmdir``: nothing else is ever removed).

Real usage ledger
-----------------
``manifest.real_usage`` is persisted exactly as the runner hands it over in
``write_checkpoint``.  The runner adds a call's usage to the ledger only in the commit
that holds the call record (the manifest write is the commit point, and step 5 removes
the pending files of the committed calls), so a call's usage is counted either in the
ledger or through a leftover pending file, never both, whatever else (staging, working
reloads, crashes) writes the manifest in between.  ``add_call_usage`` is the pure
helper that adds one call record to a ledger.

One active writer
-----------------
``acquire_writer_lock`` takes an exclusive ``flock`` on ``.writer.lock`` for the whole
time a run is open; a second process gets None and must refuse to open the run.  As a
second line of defence ``write_checkpoint`` re-reads ``manifest.json`` and refuses to
commit when the chain head on disk is not the caller's.

Must not
--------
* Contain game logic or mutate state it loads (it validates only).
* Hold locks across calls; the runner serialises writes per run.  Read paths used by
  API threads (list_turns, read_events, load_checkpoint*) never write.

Error behaviour
---------------
``StorageError`` for missing runs/turns and corrupt files; ``load_working`` returns
its problems instead of raising.
"""

from __future__ import annotations

import copy
import fcntl
import hashlib
import json
import logging
import os
import re
import secrets
import shutil
import socket
import subprocess
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

from pydantic import BaseModel, ValidationError

from . import config
from . import world as world_engine
from .schemas import (
    Agent,
    AgentKnowledge,
    AssumptionEntry,
    Checkpoint,
    DecisionPacketRecord,
    Event,
    FieldChange,
    Fruit,
    Manifest,
    MapState,
    ModelCallRecord,
    ModelCallSummary,
    ParentRef,
    Plant,
    Point,
    RealUsageLedger,
    RemovedEntity,
    Residue,
    RulesConfig,
    RunArchiveMarker,
    RunCreateRequest,
    RunSettings,
    RunSummary,
    Seed,
    StagedEdits,
    TurnId,
    TurnIndexEntry,
    TurnRecord,
    WorkingState,
    WorldState,
    utc_now_iso,
)

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Layout names (INTERFACES section 5)
# ---------------------------------------------------------------------------

MANIFEST_FILE = "manifest.json"
RUN_REQUEST_FILE = "run_request.json"
ASSUMPTIONS_FILE = "assumptions.json"
WRITER_LOCK_FILE = ".writer.lock"  # exclusive advisory lock held by the one open worker (spec: one active writer)
ARCHIVE_FILE = "archive.json"  # RunArchiveMarker; present only while the run is archived
STAGED_SNAPSHOTS_DIR = "staged_snapshots"
WORKING_DIR = "working"
TURNS_DIR = "turns"
INDEX_FILE = "index.jsonl"
PARTIAL_PREFIX = ".partial_"
BASE_TURN_FILE = "BASE_TURN"
README_FILE = "README.txt"
STAGED_EDITS_FILE = "staged_edits.json"
PENDING_CALLS_DIR = "pending_model_calls"
ENTITIES_DIR = "entities"
AGENTS_SUBDIR = "agents"
KNOWLEDGE_SUBDIR = "knowledge"
MODEL_CALLS_DIR = "model_calls"
MODEL_CALLS_INDEX = "index.json"
PACKETS_DIR = "decision_packets"
STATE_FILE = "state.json"
EVENTS_FILE = "events.json"
MAP_FILE = "map.json"
RULES_FILE = "rules.json"
SETTINGS_FILE = "settings.json"
WORLD_FILE = "world.json"
AGENT_ORDER_KEY = "agent_order"
KNOWLEDGE_FILES_KEY = "knowledge_files"  # world.json (turn dirs only): {agent_id: {turn_id, sha256}}

# Entity maps stored as one {id: record} file each: WorldState attribute -> (file, model).
ENTITY_MAP_FILES: dict[str, tuple[str, type[BaseModel]]] = {
    "plants": ("plants.json", Plant),
    "fruits": ("fruits.json", Fruit),
    "seeds": ("seeds.json", Seed),
    "residues": ("residues.json", Residue),
    "removed": ("removed.json", RemovedEntity),
}

# WorldState attributes that live in their own files; everything else goes to world.json.
WORLD_FIELDS_WITH_OWN_FILES = frozenset({"map", "rules", "agents", *ENTITY_MAP_FILES})

# Temp files for atomic writes and the working/ entity swap.
TEMP_MARKER = ".tmp-"
WORKING_ENTITIES_NEW = ".entities_new"
WORKING_ENTITIES_OLD = ".entities_old"

# Durability policy.  The manifest (commit point), pending-call files, staged edits and
# snapshots are always fsynced.  Turn files are fsynced before the manifest points at
# them so a power loss cannot leave a committed turn with empty files; a process crash
# alone is already safe without it (the page cache survives).  An fsync costs about 3 ms per
# file on ext4 sequentially, so the turn files are flushed concurrently (FSYNC_WORKERS).
# working/ is never fsynced: recover_run rebuilds it from the chain.  Both values come from
# config (EMPYREAN_FSYNC / EMPYREAN_FSYNC_WORKERS); tests may monkeypatch them here.
FSYNC_TURN_FILES = config.FSYNC_TURN_FILES
FSYNC_WORKERS = config.FSYNC_WORKERS

# Stored error for leftover pending calls found at recovery (INTERFACES section 8).
INTERRUPTED_CALL_ERROR = "interrupted (outcome uncertain)"

# Validation messages kept per file in load_working (the rest are counted).
MAX_ERRORS_PER_FILE = 8

# Path components we accept for ids used in file names (run/world/turn/call/packet/
# agent/intervention ids).  Rejects separators, dots and glob characters.
_SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_\-]{0,127}$")
_SNAPSHOT_REF = re.compile(r"^staged_snapshots/([A-Za-z0-9][A-Za-z0-9_\-]{0,127})\.json$")


class RunInUseError(Exception):
    """``delete_run`` refused: another worker (this process or another) holds the run's
    writer lock.  The API answers 409 ``run_in_use``."""


class StorageError(Exception):
    """Missing run/turn, unreadable file, or a write that could not complete."""


class RecoveryReport:
    """What ``recover_run`` did: deleted partial/unreachable dirs, rebuilt index, discarded a
    stale working copy, leftover pending call records."""

    def __init__(self) -> None:
        self.deleted_dirs: list[str] = []  # relative to the run dir
        self.index_rebuilt: bool = False
        self.working_rebuilt: bool = False
        self.pending_calls: list[ModelCallRecord] = []  # interrupted calls for the runner to carry
        self.cleared_pending_calls: list[str] = []  # call ids already committed; files deleted
        self.warnings: list[str] = []

    def changed_anything(self) -> bool:
        return bool(
            self.deleted_dirs
            or self.index_rebuilt
            or self.working_rebuilt
            or self.pending_calls
            or self.cleared_pending_calls
            or self.warnings
        )


# ---------------------------------------------------------------------------
# Paths and primitives
# ---------------------------------------------------------------------------


def worlds_root() -> Path:
    """``config.WORLDS_DIR`` resolved at call time (tests monkeypatch it)."""
    return Path(config.WORLDS_DIR)


def run_dir(world_id: str, run_id: str) -> Path:
    return worlds_root() / _check_name(world_id, "world id") / "runs" / _check_name(run_id, "run id")


def run_dir_path(world_id: str, run_id: str) -> Optional[str]:
    """The absolute run folder as a string for ``RunSummary.run_dir`` (the operator opens
    ``<run_dir>/working/`` in an editor); None when an id is unsafe as a path component."""
    try:
        return str(run_dir(world_id, run_id).resolve())
    except (StorageError, OSError):
        return None


def find_run_dir(run_id: str) -> Path:
    """Locate a run by id across worlds (run ids are globally unique).  Only directories
    with a ``manifest.json`` are runs.  Raises StorageError."""
    _check_name(run_id, "run id")
    matches = [p for p in _run_dir_candidates(run_id) if (p / MANIFEST_FILE).is_file()]
    if not matches:
        raise StorageError(f"run {run_id} not found")
    if len(matches) > 1:
        raise StorageError(f"run id {run_id} exists in several worlds: {[str(p) for p in matches]}")
    return matches[0]


def atomic_write_json(path: Path, data: Any, fsync: bool = True) -> None:
    """Write ``data`` (a dict/list or a pydantic model, dumped with mode="json") as pretty
    JSON (indent 2) to ``path`` via temp file + ``os.replace``.  With ``fsync`` the file
    and its directory entry are flushed to disk before returning."""
    _atomic_write_text(Path(path), _dumps(data, str(path)), fsync)


def read_json(path: Path) -> Any:
    """Load JSON; raises StorageError with the path and the decode error.  NaN/Infinity
    are rejected (never written by storage; not valid JSON for the frontend)."""
    return _parse_json_text(_read_text(Path(path), str(path)), str(path))


def new_run_id(name: str) -> str:
    """``run_{YYYYmmdd_HHMMSS}_{4 hex}`` (UTC) — unique across worlds.  ``name`` is not part
    of the id (the pattern is fixed, INTERFACES section 3)."""
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    for _ in range(1000):
        candidate = f"run_{stamp}_{secrets.token_hex(2)}"
        if not _run_dir_candidates(candidate):
            return candidate
    raise StorageError("could not allocate a unique run id")


def new_world_id() -> str:
    """``world_{YYYYmmdd_HHMMSS}_{4 hex}`` (UTC), not yet present under the worlds root."""
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    for _ in range(1000):
        candidate = f"world_{stamp}_{secrets.token_hex(2)}"
        if not (worlds_root() / candidate).exists():
            return candidate
    raise StorageError("could not allocate a unique world id")


def _git(*args: str) -> Optional[str]:
    """stdout of a git command in the repository, or None when git is unavailable/fails."""
    try:
        done = subprocess.run(
            ["git", *args],
            cwd=str(config.REPO_DIR),
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return done.stdout if done.returncode == 0 else None


def _source_hash() -> str:
    """Short sha256 over the package's own ``*.py`` sources (names and contents), so a
    recorded revision identifies the code that ran even when git cannot."""
    digest = hashlib.sha256()
    package_dir = Path(__file__).resolve().parent
    # rglob: subpackages (assistant/) are part of the code that ran (rev 4).
    for path in sorted(package_dir.rglob("*.py"), key=lambda p: p.relative_to(package_dir).as_posix()):
        digest.update(path.relative_to(package_dir).as_posix().encode("utf-8"))
        try:
            digest.update(path.read_bytes())
        except OSError:
            continue
    return digest.hexdigest()[:8]


@lru_cache(maxsize=1)
def code_revision() -> str:
    """The code revision recorded in manifests and turn records (spec: "record the code
    revision").  ``git rev-parse --short HEAD`` when the tree is clean;
    ``<sha>+dirty.<source hash>`` when ``git status --porcelain`` reports any change or
    untracked file (the commit alone would not identify the code that ran); without git,
    ``config.CODE_REVISION`` plus the source hash.  Cached per process."""
    head = (_git("rev-parse", "--short", "HEAD") or "").strip()
    if not head:
        return f"{config.CODE_REVISION}+src.{_source_hash()}"
    status = _git("status", "--porcelain")
    if status is None or status.strip():
        return f"{head}+dirty.{_source_hash()}"
    return head


class WriterLock:
    """The exclusive advisory lock of an open run (``runs/<id>/.writer.lock``, flock).  It
    is held for the worker's lifetime and released by ``release()`` or by the operating
    system when the process dies, so a crash never leaves a run locked."""

    def __init__(self, path: Path, fd: int) -> None:
        self.path = path
        self._fd: Optional[int] = fd

    @property
    def held(self) -> bool:
        return self._fd is not None

    def release(self) -> None:
        fd, self._fd = self._fd, None
        if fd is not None:
            try:
                fcntl.flock(fd, fcntl.LOCK_UN)
            finally:
                os.close(fd)


def acquire_writer_lock(run_id: str) -> Optional[WriterLock]:
    """Take the run's writer lock without blocking.  Returns None when another process
    (or another worker in this one) holds it: the caller refuses to open the run (spec
    "one active writer per world run").  The lock file records who holds it (pid and
    host) for diagnostics only.  Raises StorageError for an unknown run."""
    path = find_run_dir(run_id) / WRITER_LOCK_FILE
    fd = os.open(str(path), os.O_RDWR | os.O_CREAT, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        return None
    try:
        os.ftruncate(fd, 0)
        os.write(fd, f"{os.getpid()}@{socket.gethostname()} {utc_now_iso()}\n".encode("utf-8"))
    except OSError:
        pass  # diagnostics only; the lock itself is what matters
    return WriterLock(path, fd)


# ---------------------------------------------------------------------------
# Runs
# ---------------------------------------------------------------------------


def list_runs() -> list[RunSummary]:
    """Scan ``worlds/*/runs/*/manifest.json`` (dirs without one are skipped, unreadable
    manifests are logged and skipped); newest ``updated_at`` first.  ``status`` is
    "finished" when ``manifest.finished`` else "paused" (the runner overlays live status).
    Every run is returned, archived or not (``archived``/``archived_at`` from ``archive.json``);
    ``RunManager.list_runs`` filters."""
    root = worlds_root()
    if not root.is_dir():
        return []
    summaries: list[RunSummary] = []
    for manifest_path in root.glob(f"*/runs/*/{MANIFEST_FILE}"):
        try:
            manifest = _read_model(manifest_path, Manifest, str(manifest_path))
        except StorageError as exc:
            log.warning("skipping run with unreadable manifest: %s", exc)
            continue
        summaries.append(_summary_from_manifest(manifest))
    summaries.sort(key=lambda s: (_timestamp_key(s.saved_at), s.run_id), reverse=True)
    return summaries


def read_archive_marker(rdir: Path) -> Optional[RunArchiveMarker]:
    """The run folder's ``archive.json`` or None (not archived).  A marker that cannot be read
    or validated is logged and treated as absent (the run stays visible and can be archived
    again, which rewrites it)."""
    path = Path(rdir) / ARCHIVE_FILE
    if not path.is_file():
        return None
    try:
        return _read_model(path, RunArchiveMarker, str(path))
    except StorageError as exc:
        log.warning("ignoring unreadable archive marker (run treated as active): %s", exc)
        return None


def archive_state(world_id: str, run_id: str) -> tuple[bool, Optional[str]]:
    """``(archived, archived_at)`` for ``RunSummary``; ``(False, None)`` for unsafe ids."""
    try:
        marker = read_archive_marker(run_dir(world_id, run_id))
    except (StorageError, OSError):
        return False, None
    return (True, marker.archived_at) if marker is not None else (False, None)


def archive_run(run_id: str, note: str = "") -> RunArchiveMarker:
    """Write ``archive.json`` (atomic).  Idempotent: an existing valid marker is kept with its
    ``archived_at``.  Works for open runs too (the marker is outside the checkpoint data).
    Raises StorageError for an unknown run."""
    rdir = find_run_dir(run_id)
    existing = read_archive_marker(rdir)
    if existing is not None:
        return existing
    marker = RunArchiveMarker(archived_at=utc_now_iso(), note=note)
    atomic_write_json(rdir / ARCHIVE_FILE, marker)
    return marker


def unarchive_run(run_id: str) -> None:
    """Remove ``archive.json`` (a no-op when the run is not archived).  Raises StorageError for
    an unknown run."""
    rdir = find_run_dir(run_id)
    (rdir / ARCHIVE_FILE).unlink(missing_ok=True)
    _fsync_path(rdir)


def delete_run(run_id: str) -> list[str]:
    """Remove the run folder permanently (see "Archive and delete" in the module docstring).
    The caller must make sure this process has no worker for the run; the writer lock covers
    other processes and closed workers still finishing a turn (``RunInUseError``).  Returns
    the removed folders (the run folder, then ``runs/`` and the world folder when they were
    left empty).  Raises StorageError for an unknown run."""
    rdir = find_run_dir(run_id)
    lock = acquire_writer_lock(run_id)
    if lock is None:
        raise RunInUseError(f"run {run_id} is open (a worker holds its writer lock)")
    removed: list[str] = []
    try:
        # The manifest is the commit point and what makes a folder a run: without it the run
        # vanishes from list_runs/find_run_dir even if the tree removal below is interrupted.
        (rdir / MANIFEST_FILE).unlink()
        _fsync_path(rdir)
        shutil.rmtree(rdir)
        removed.append(str(rdir))
    finally:
        lock.release()
    runs_dir = rdir.parent
    world_dir = runs_dir.parent
    for folder in (runs_dir, world_dir):
        try:
            folder.rmdir()  # only succeeds when empty: never removes anything else
        except OSError:
            break
        removed.append(str(folder))
    log.info("deleted run %s (%s)", run_id, ", ".join(removed))
    return removed


def read_manifest(run_id: str) -> Manifest:
    rdir = find_run_dir(run_id)
    return _read_model(rdir / MANIFEST_FILE, Manifest, f"{run_id}/{MANIFEST_FILE}")


def read_run_request(run_id: str) -> RunCreateRequest:
    """Read the original creation setup, including for archived runs and continuations.

    This is reference data, independent of checkpoints and edited working files.
    Missing or incompatible reference files raise StorageError; never guess a setup.
    """
    rdir = find_run_dir(run_id)
    return _read_model(rdir / RUN_REQUEST_FILE, RunCreateRequest, f"{run_id}/{RUN_REQUEST_FILE}")


def write_manifest(manifest: Manifest) -> None:
    """Atomic (temp + fsync + os.replace).  The run directory must exist."""
    rdir = run_dir(manifest.world_id, manifest.run_id)
    if not rdir.is_dir():
        raise StorageError(f"run directory {rdir} does not exist")
    atomic_write_json(rdir / MANIFEST_FILE, manifest, fsync=True)


def create_run(request: RunCreateRequest, manifest: Manifest, checkpoint: Checkpoint, assumptions: list[AssumptionEntry]) -> Manifest:
    """Create the run directory, write ``run_request.json``, ``assumptions.json``, the initial
    checkpoint (turn id ``r00000_init``) through the commit protocol, the working copy, an
    empty ``staged_edits.json`` and ``working/README.txt``.  Raises StorageError if the run
    directory already exists (or the run id is used in another world).  On failure before
    the manifest exists the half-created directory is removed."""
    if checkpoint.turn.turn_id != TurnId.INIT:
        raise StorageError(f"the first checkpoint must be {TurnId.INIT}, got {checkpoint.turn.turn_id}")
    rdir = run_dir(manifest.world_id, manifest.run_id)
    if rdir.exists() or _run_dir_candidates(manifest.run_id):
        raise StorageError(f"run {manifest.run_id} already exists")
    rdir.mkdir(parents=True)
    try:
        _create_run_skeleton(rdir)
        atomic_write_json(rdir / RUN_REQUEST_FILE, request)
        atomic_write_json(rdir / ASSUMPTIONS_FILE, list(assumptions))
        first = manifest.model_copy(deep=True, update={"turn_count": 0, "current_turn_id": TurnId.INIT})
        return write_checkpoint(first, checkpoint)
    except BaseException:
        if not (rdir / MANIFEST_FILE).exists():
            shutil.rmtree(rdir, ignore_errors=True)
        raise


def write_checkpoint(manifest: Manifest, checkpoint: Checkpoint) -> Manifest:
    """Commit one turn with the protocol in the module docstring.  Also writes
    ``model_calls/index.json`` (summaries) and updates the manifest (current_turn_id,
    last_round, last_turn_index, next_event_seq = max committed seq + 1, counts,
    default_model_key, turn_count, updated_at; ``real_usage``, ``finished`` and
    ``next_intervention_seq`` are persisted as given).  Returns the updated manifest.
    Never partially visible.

    Chain rule: after the first commit, ``checkpoint.turn.previous_turn_id`` must equal
    ``manifest.current_turn_id`` (otherwise recovery would drop turns), and a committed
    turn id is never written twice: ANY turn id already in the committed chain is refused
    (INTERFACES 4.5), not only the current one, so committed history can never be
    replaced.  ``manifest.json`` on disk must still point at ``manifest.current_turn_id``
    (spec "one active writer per world run"): a commit by another process is detected
    before anything is written."""
    rdir = run_dir(manifest.world_id, manifest.run_id)
    if not rdir.is_dir():
        raise StorageError(f"run directory {rdir} does not exist")
    turn = checkpoint.turn
    _check_name(turn.turn_id, "turn id")
    if manifest.turn_count > 0:
        if turn.previous_turn_id != manifest.current_turn_id:
            raise StorageError(
                f"turn {turn.turn_id} follows {turn.previous_turn_id} but the committed turn is {manifest.current_turn_id}"
            )
        on_disk = _read_model(rdir / MANIFEST_FILE, Manifest, f"{manifest.run_id}/{MANIFEST_FILE}")
        if on_disk.current_turn_id != manifest.current_turn_id:
            raise StorageError(
                f"run {manifest.run_id} was committed by another writer: disk is at {on_disk.current_turn_id}, "
                f"this worker at {manifest.current_turn_id}"
            )
        if _is_committed_turn(rdir, manifest, turn.turn_id):
            raise StorageError(f"turn {turn.turn_id} is already committed")

    # 1. the complete turn directory
    _write_turn_dir(rdir, checkpoint)
    # 2. the commit point
    committed = _manifest_after_commit(manifest, checkpoint)
    write_manifest(committed)
    # 3-5. derived files (repaired by recover_run if any of this fails)
    _after_commit(rdir, committed, checkpoint)
    return committed


def recover_run(run_id: str) -> RecoveryReport:
    """Repair the on-disk run before it is opened (see module docstring).  The manifest's
    chain wins over every other file.  Raises StorageError when the committed turn itself
    is missing or unreadable (nothing to recover to)."""
    rdir = find_run_dir(run_id)
    manifest = _read_model(rdir / MANIFEST_FILE, Manifest, f"{run_id}/{MANIFEST_FILE}")
    report = RecoveryReport()
    chain, chain_complete = _walk_chain(rdir, manifest, report.warnings)
    _remove_uncommitted_turn_dirs(rdir, chain, chain_complete, report)
    _remove_temp_files(rdir, report)
    _repair_index(rdir, chain, chain_complete, report)
    _create_run_skeleton(rdir)
    _repair_working(rdir, manifest, report)
    _repair_staged_edits(rdir, report)
    _collect_pending_calls(rdir, chain, report)
    return report


def load_checkpoint(run_id: str, turn_id: Optional[str] = None) -> Checkpoint:
    """Load ``turn_id`` (default: ``manifest.current_turn_id``) into a full ``Checkpoint``
    including events, model calls, decision packets and knowledge.  Raises StorageError."""
    rdir = find_run_dir(run_id)
    if turn_id is None:
        turn_id = _read_model(rdir / MANIFEST_FILE, Manifest, f"{run_id}/{MANIFEST_FILE}").current_turn_id
    return _load_checkpoint_at(rdir, turn_id)


def load_checkpoint_light(run_id: str, turn_id: str) -> tuple[Checkpoint, list[ModelCallSummary], list[str]]:
    """For turn views: the checkpoint WITHOUT knowledge, model call bodies or packet bodies,
    plus the ``model_calls/index.json`` summaries and the packet ids present."""
    rdir = find_run_dir(run_id)
    tdir = _turn_dir(rdir, turn_id)
    reader = _Reader(tdir, f"{TURNS_DIR}/{turn_id}/")
    checkpoint = _read_checkpoint(reader, with_bodies=False)
    summaries = _read_call_summaries(reader)
    reader.raise_if_errors()
    return checkpoint, summaries or [], _packet_ids(tdir)


def list_turns(run_id: str, from_round: Optional[int] = None, to_round: Optional[int] = None) -> list[TurnIndexEntry]:
    """Committed turns in order (init, r1 t1.., r1 end, r2 ...) from ``turns/index.jsonl``,
    optionally limited to an inclusive round range.  When the index is behind the manifest
    (a crash between commit steps 2 and 3, or a line being appended right now) the missing
    entries are derived from the chain in memory; this read path never writes."""
    rdir = find_run_dir(run_id)
    manifest = _read_model(rdir / MANIFEST_FILE, Manifest, f"{run_id}/{MANIFEST_FILE}")
    entries = _committed_entries(rdir, manifest)
    return [
        e
        for e in entries
        if (from_round is None or e.round >= from_round) and (to_round is None or e.round <= to_round)
    ]


def read_events(run_id: str, since_seq: int = 0, limit: int = config.EVENTS_PAGE_LIMIT) -> list[Event]:
    """Committed events with ``seq > since_seq`` in seq order, at most ``limit`` (the oldest
    ones first, so a poller pages forward), by scanning turn directories newest-first until
    the range is covered.  Committed seqs increase from turn to turn; gaps are tolerated."""
    rdir = find_run_dir(run_id)
    manifest = _read_model(rdir / MANIFEST_FILE, Manifest, f"{run_id}/{MANIFEST_FILE}")
    collected: list[Event] = []
    for entry in reversed(_committed_entries(rdir, manifest)):
        events = _read_turn_events_at(rdir, entry.turn_id)
        if not events:
            continue
        collected.extend(e for e in events if e.seq > since_seq)
        if min(e.seq for e in events) <= since_seq + 1:
            break
    collected.sort(key=lambda e: e.seq)
    return collected[: max(0, limit)]


def read_turn_events(run_id: str, turn_id: str) -> list[Event]:
    return _read_turn_events_at(find_run_dir(run_id), turn_id)


def read_model_call(run_id: str, turn_id: str, call_id: str) -> ModelCallRecord:
    tdir = _turn_dir(find_run_dir(run_id), turn_id)
    name = _check_name(call_id, "model call id")
    return _read_model(tdir / MODEL_CALLS_DIR / f"{name}.json", ModelCallRecord, f"{turn_id}/{MODEL_CALLS_DIR}/{name}.json")


def read_decision_packet(run_id: str, turn_id: str, packet_id: str) -> DecisionPacketRecord:
    tdir = _turn_dir(find_run_dir(run_id), turn_id)
    name = _check_name(packet_id, "packet id")
    return _read_model(tdir / PACKETS_DIR / f"{name}.json", DecisionPacketRecord, f"{turn_id}/{PACKETS_DIR}/{name}.json")


def read_knowledge(run_id: str, turn_id: str, agent_id: str) -> AgentKnowledge:
    """An agent's knowledge exactly as committed at ``turn_id`` (spec: historical
    inspection shows the knowledge then): the turn's own file, or the unchanged file an
    earlier turn holds (``knowledge_files`` in the turn's ``world.json``)."""
    rdir = find_run_dir(run_id)
    tdir = _turn_dir(rdir, turn_id)
    name = _check_name(agent_id, "agent id")
    rel = f"{ENTITIES_DIR}/{KNOWLEDGE_SUBDIR}/{name}.json"
    if (tdir / rel).is_file():
        return _read_model(tdir / rel, AgentKnowledge, f"{turn_id}/{rel}")
    ref = _knowledge_refs_of(rdir, turn_id).get(name)
    if ref is None:
        raise StorageError(f"{turn_id}/{rel}: file not found")
    held_in = ref["turn_id"]
    return _read_model(rdir / TURNS_DIR / held_in / rel, AgentKnowledge, f"{held_in}/{rel} (unchanged since, referenced by {turn_id})")


def read_assumptions(run_id: str) -> list[AssumptionEntry]:
    rdir = find_run_dir(run_id)
    data = read_json(rdir / ASSUMPTIONS_FILE)
    if not isinstance(data, list):
        raise StorageError(f"{run_id}/{ASSUMPTIONS_FILE}: expected a list of assumption entries")
    try:
        return [AssumptionEntry.model_validate(item) for item in data]
    except ValidationError as exc:
        raise StorageError("; ".join(_validation_messages(f"{run_id}/{ASSUMPTIONS_FILE}", exc))) from None


def add_call_usage(ledger: RealUsageLedger, record: ModelCallRecord, interrupted: bool = False) -> RealUsageLedger:
    """Pure: a copy of ``ledger`` with one call added (billed input, output, reported cost;
    ``interrupted_calls`` too when the outcome was uncertain).  Calls without a result
    count as calls with zero known usage."""
    result = record.result
    usage = result.usage if result is not None else None
    return RealUsageLedger(
        calls=ledger.calls + 1,
        interrupted_calls=ledger.interrupted_calls + (1 if interrupted else 0),
        input_tokens=ledger.input_tokens + (usage.billed_input_tokens if usage else 0),
        output_tokens=ledger.output_tokens + (usage.output_tokens if usage else 0),
        provider_cost_usd=ledger.provider_cost_usd + ((result.provider_cost_usd or 0.0) if result else 0.0),
    )


# ---------------------------------------------------------------------------
# Working copy, staged edits, snapshots, pending calls
# ---------------------------------------------------------------------------


def refresh_working(run_id: str, checkpoint: Checkpoint) -> None:
    """Overwrite ``working/`` (map, rules, settings, world.json, entities, knowledge) from
    ``checkpoint``: the ``entities`` directory is replaced wholesale (temp dir + swap) so
    removed agents leave no file behind; writes ``BASE_TURN`` last (it is removed first, so
    an interrupted refresh is detected as stale).  Leaves ``staged_edits.json`` and
    ``pending_model_calls/`` untouched."""
    _refresh_working_dir(find_run_dir(run_id) / WORKING_DIR, checkpoint)


def read_base_turn(run_id: str) -> Optional[str]:
    """Contents of ``working/BASE_TURN`` or None."""
    return _read_base_turn_at(find_run_dir(run_id) / WORKING_DIR)


def load_working(run_id: str) -> tuple[Optional[WorkingState], list[str]]:
    """Parse and validate every working file.  Returns ``(state, [])`` on success or
    ``(None, errors)`` listing each file and its problem (invalid JSON, schema error, a
    knowledge file without an agent or vice versa, fruit/seed plant references, positions
    outside the region, a stale BASE_TURN, and every ``world.validate_world`` error).
    Occupants are recomputed, never diffed.  Never raises for bad content and never
    writes: the committed checkpoint, staged edits and the edited files stay as they are
    (spec "Literal god mode": invalid files leave the last valid state available).
    Settings are checked against the models by the runner (``context.validate_settings``
    needs the registry)."""
    rdir = find_run_dir(run_id)
    manifest = _read_model(rdir / MANIFEST_FILE, Manifest, f"{run_id}/{MANIFEST_FILE}")
    wdir = rdir / WORKING_DIR
    errors: list[str] = []

    base = _read_base_turn_at(wdir)
    if base is None:
        errors.append(f"{WORKING_DIR}/{BASE_TURN_FILE}: missing (the working copy is incomplete; reopen the run to rebuild it)")
    elif base != manifest.current_turn_id:
        errors.append(
            f"{WORKING_DIR}/{BASE_TURN_FILE}: the working copy was made from {base} but the committed turn is "
            f"{manifest.current_turn_id}; reopen the run to rebuild it, then edit again"
        )

    reader = _Reader(wdir, f"{WORKING_DIR}/")
    world_state, knowledge, settings = _read_state_files(reader, working=True)
    errors.extend(reader.errors)
    if world_state is None or knowledge is None or settings is None:
        # Stage 1 (parse + schema) failed: the semantic checks need the complete state, so
        # say so instead of leaving the operator to wonder why only these errors are listed.
        errors.append(PARSE_STAGE_HINT)
        return None, _unique(errors)

    errors.extend(check_working_state(world_state, knowledge, settings))
    if errors:
        return None, _unique(errors)
    return WorkingState(world=world_state, knowledge=knowledge, settings=settings), []


PARSE_STAGE_HINT = f"{WORKING_DIR}/: fix the JSON errors above first; semantic checks run once every file parses"


def check_working_state(world_state: WorldState, knowledge: dict[str, AgentKnowledge], settings: RunSettings) -> list[str]:
    """Stage 2 of ``load_working`` on an already parsed state: the cross-file reference
    checks storage owns, then ``rebuild_occupants`` and every ``world.validate_world``
    problem mapped to the working file it points at.  Also used by the runner when a
    reload's diff is applied onto the boundary state (``apply_working_changes``)."""
    errors = _working_reference_errors(world_state, knowledge, settings)
    try:
        world_engine.rebuild_occupants(world_state)
        errors.extend(_working_file_for_problem(problem) for problem in world_engine.validate_world(world_state))
    except Exception as exc:  # a hand-edited state the engine cannot even inspect
        errors.append(f"world: consistency check failed: {type(exc).__name__}: {exc}")
    return _unique(errors)


def diff_working(current: Checkpoint, working: WorkingState) -> list[FieldChange]:
    """Generic JSON diff between the committed state and the working state over ``world``
    (map.cells, entities, rules; occupants excluded), ``knowledge`` and ``settings``; paths
    like ``world.agents.a01.stats.compute`` / ``knowledge.a02.records[a02-k000012].text`` /
    ``settings.context.input_token_cap``.  Added entities/records appear with
    ``before=None``; removed with ``after=None``.

    List rule: lists of records with unique ``id`` keys are matched by id (``[id]``);
    equal-length lists of objects are compared element by element (``[i]``); any other
    changed list is one change with the whole before/after lists.  Booleans never equal
    numbers; ``3 == 3.0``."""
    changes: list[FieldChange] = []
    _diff_values("world", _world_for_diff(current.world), _world_for_diff(working.world), changes)
    _diff_values(
        "knowledge",
        {k: v.model_dump(mode="json") for k, v in current.knowledge.items()},
        {k: v.model_dump(mode="json") for k, v in working.knowledge.items()},
        changes,
    )
    _diff_values("settings", current.settings.model_dump(mode="json"), working.settings.model_dump(mode="json"), changes)
    return changes


def apply_working_changes(
    world: WorldState, knowledge: dict[str, AgentKnowledge], settings: RunSettings, changes: list[FieldChange]
) -> tuple[Optional[WorkingState], list[FieldChange], list[str]]:
    """Apply a ``diff_working`` result onto the CURRENT state (which may already differ
    from the state the diff was taken against, because other staged edits were applied
    before it) and validate the outcome.  Returns ``(new_state, applied, problems)``:
    ``new_state`` is a fresh, validated ``WorkingState`` (occupants rebuilt) or None when
    anything failed; ``applied`` holds one FieldChange per change with the value found at
    apply time as ``before`` (so the record shows what really changed); ``problems`` are
    readable messages, each naming the path.  Nothing passed in is modified.

    Path rules mirror ``diff_working``: dotted keys under ``world`` / ``knowledge`` /
    ``settings``; ``name[id]`` selects the element of a list of records by id (a missing
    id on an add appends; on a removal it is already gone); ``name[i]`` an index.  A field
    changed by an earlier staged edit keeps THIS change's ``after`` value (later staged
    wins); a path whose parent no longer exists (an entity removed by an earlier edit) is a
    problem, and one problem rejects the whole set (no partial application)."""
    docs: dict[str, Any] = {
        "world": _world_for_diff(world),
        "knowledge": {k: v.model_dump(mode="json") for k, v in knowledge.items()},
        "settings": settings.model_dump(mode="json"),
    }
    applied: list[FieldChange] = []
    problems: list[str] = []
    for change in changes:
        try:
            before = _apply_one_change(docs, change)
        except _ChangePathError as exc:
            problems.append(f"{change.path}: {exc}")
            continue
        applied.append(FieldChange(path=change.path, before=before, after=change.after))
    if problems:
        return None, applied, _unique(problems)

    new_world: Optional[WorldState] = None
    new_knowledge: Optional[dict[str, AgentKnowledge]] = None
    new_settings: Optional[RunSettings] = None
    try:
        new_world = WorldState.model_validate(docs["world"])
    except ValidationError as exc:
        problems.extend(_validation_messages(f"{WORKING_DIR}/world", exc))
    try:
        new_knowledge = {k: AgentKnowledge.model_validate(v) for k, v in docs["knowledge"].items()}
    except ValidationError as exc:
        problems.extend(_validation_messages(f"{WORKING_DIR}/{ENTITIES_DIR}/{KNOWLEDGE_SUBDIR}", exc))
    try:
        new_settings = RunSettings.model_validate(docs["settings"])
    except ValidationError as exc:
        problems.extend(_validation_messages(f"{WORKING_DIR}/{SETTINGS_FILE}", exc))
    if new_world is None or new_knowledge is None or new_settings is None:
        return None, applied, _unique(problems)
    for agent_id, store in new_knowledge.items():
        if store.agent_id != agent_id:
            problems.append(f"knowledge.{agent_id}: the store's agent_id is {store.agent_id!r}")
    problems.extend(check_working_state(new_world, new_knowledge, new_settings))
    if problems:
        return None, applied, _unique(problems)
    return WorkingState(world=new_world, knowledge=new_knowledge, settings=new_settings), applied, []


class _ChangePathError(Exception):
    """A FieldChange path that cannot be applied to the current state."""


_PATH_SEGMENT = re.compile(r"^([^\[\]]+)(?:\[([^\]]*)\])?$")


def _split_change_path(path: str) -> list[tuple[str, Optional[str]]]:
    """``knowledge.a02.records[a02-k000002].text`` -> [("knowledge", None), ("a02", None),
    ("records", "a02-k000002"), ("text", None)]."""
    segments: list[tuple[str, Optional[str]]] = []
    for raw in path.split("."):
        match = _PATH_SEGMENT.match(raw)
        if match is None or not raw:
            raise _ChangePathError(f"unreadable path segment {raw!r}")
        segments.append((match.group(1), match.group(2)))
    return segments


def _list_slot(items: list[Any], selector: str, where: str) -> Optional[int]:
    """Index of the list element a ``[selector]`` names: by record id when the list is a
    list of records with unique ids (``diff_working``'s rule), else by integer index.
    None when no element matches (an add appends; a removal is already satisfied)."""
    ids = _record_ids(items)
    if ids:
        return ids.index(selector) if selector in ids else None
    if not items and not selector.isdigit():
        return None  # an empty list: a record add appends
    try:
        index = int(selector)
    except ValueError:
        raise _ChangePathError(f"{where}: no record with id {selector!r} (the list has no ids)") from None
    if index < 0 or index >= len(items):
        raise _ChangePathError(f"{where}: index {index} is out of range (the list has {len(items)} elements)")
    return index


def _apply_one_change(docs: dict[str, Any], change: FieldChange) -> Any:
    """Set (or delete, when ``after`` is None) the value at ``change.path`` in ``docs``;
    returns the value found there before (None when absent)."""
    segments = _split_change_path(change.path)
    root_key = segments[0][0]
    if root_key not in docs or segments[0][1] is not None:
        raise _ChangePathError("the path must start with world., knowledge. or settings.")
    if len(segments) == 1:
        raise _ChangePathError(f"{root_key} cannot be replaced as a whole")
    container: Any = docs[root_key]
    walked = root_key
    # Descend to the parent of the last key (creating nothing on the way: a missing parent
    # means an earlier staged edit removed it, which is a real conflict to report).
    for key, selector in segments[1:-1]:
        container = _descend(container, key, selector, walked)
        walked += f".{key}" + (f"[{selector}]" if selector is not None else "")
    last_key, last_selector = segments[-1]
    if not isinstance(container, dict):
        raise _ChangePathError(f"{walked} is not an object")
    if last_selector is None:
        before = copy.deepcopy(container.get(last_key))
        if change.after is None:
            container.pop(last_key, None)
        else:
            container[last_key] = copy.deepcopy(change.after)
        return before
    items = container.get(last_key)
    if not isinstance(items, list):
        raise _ChangePathError(f"{walked}.{last_key} is not a list")
    slot = _list_slot(items, last_selector, f"{walked}.{last_key}")
    before = copy.deepcopy(items[slot]) if slot is not None else None
    if change.after is None:
        if slot is not None:
            del items[slot]
    elif slot is None:
        if change.before is not None:
            raise _ChangePathError(f"{walked}.{last_key}[{last_selector}] does not exist any more (removed by an earlier staged edit?)")
        items.append(copy.deepcopy(change.after))
    else:
        items[slot] = copy.deepcopy(change.after)
    return before


def _descend(container: Any, key: str, selector: Optional[str], walked: str) -> Any:
    if not isinstance(container, dict) or key not in container:
        raise _ChangePathError(f"{walked}.{key} does not exist any more (removed or renamed by an earlier staged edit?)")
    value = container[key]
    if selector is None:
        return value
    if not isinstance(value, list):
        raise _ChangePathError(f"{walked}.{key} is not a list")
    slot = _list_slot(value, selector, f"{walked}.{key}")
    if slot is None:
        raise _ChangePathError(f"{walked}.{key}[{selector}] does not exist any more (removed by an earlier staged edit?)")
    return value[slot]


def write_staged_snapshot(run_id: str, intervention_id: str, working: WorkingState) -> str:
    """Persist the validated snapshot as ``staged_snapshots/{iv_id}.json``; returns the
    relative path (``ApplyWorkingFilesIntervention.snapshot_ref``)."""
    rdir = find_run_dir(run_id)
    name = _check_name(intervention_id, "intervention id")
    ref = f"{STAGED_SNAPSHOTS_DIR}/{name}.json"
    (rdir / STAGED_SNAPSHOTS_DIR).mkdir(exist_ok=True)
    atomic_write_json(rdir / ref, working, fsync=True)
    return ref


def read_staged_snapshot(run_id: str, snapshot_ref: str) -> WorkingState:
    rdir = find_run_dir(run_id)
    _check_snapshot_ref(snapshot_ref)
    return _read_model(rdir / snapshot_ref, WorkingState, snapshot_ref)


def delete_staged_snapshot(run_id: str, snapshot_ref: str) -> None:
    rdir = find_run_dir(run_id)
    _check_snapshot_ref(snapshot_ref)
    (rdir / snapshot_ref).unlink(missing_ok=True)


def read_staged_edits(run_id: str) -> StagedEdits:
    """Missing file -> empty StagedEdits.  A corrupt file raises StorageError
    (``recover_run`` moves such a file aside on open)."""
    return _read_staged_edits_at(find_run_dir(run_id) / WORKING_DIR)


def write_staged_edits(run_id: str, staged: StagedEdits) -> None:
    wdir = find_run_dir(run_id) / WORKING_DIR
    wdir.mkdir(exist_ok=True)
    atomic_write_json(wdir / STAGED_EDITS_FILE, staged, fsync=True)


def write_pending_model_call(run_id: str, record: ModelCallRecord) -> None:
    """Record a call BEFORE it is made (``working/pending_model_calls/{call_id}.json``).  Also
    used right after ``call_model`` returns to rewrite the file with the result and usage,
    so a crash between return and commit loses no known usage.  Always fsynced."""
    pending_dir = find_run_dir(run_id) / WORKING_DIR / PENDING_CALLS_DIR
    pending_dir.mkdir(parents=True, exist_ok=True)
    name = _check_name(record.call_id, "model call id")
    atomic_write_json(pending_dir / f"{name}.json", record, fsync=True)


def model_call_ids_in_round(run_id: str, round_no: int) -> set[str]:
    """Every model call id already committed in the turns of round ``round_no`` (read from
    each turn's ``model_calls/index.json``).  The runner seeds its call-id counter with it
    when it plans a round on a freshly opened worker, so a decision made for a turn whose
    earlier (interrupted or discarded) call was committed in another turn of the round never
    reuses that id.  Unreadable indexes are skipped."""
    rdir = find_run_dir(run_id)
    ids: set[str] = set()
    for entry in list_turns(run_id, round_no, round_no):
        path = rdir / TURNS_DIR / _check_name(entry.turn_id, "turn id") / MODEL_CALLS_DIR / MODEL_CALLS_INDEX
        if not path.exists():
            continue
        try:
            rows = read_json(path)
        except Exception:  # noqa: BLE001 - a damaged index only weakens the id guard
            continue
        for row in rows if isinstance(rows, list) else []:
            if isinstance(row, dict) and isinstance(row.get("call_id"), str):
                ids.add(row["call_id"])
    return ids


def list_pending_model_calls(run_id: str) -> list[ModelCallRecord]:
    """Pending call files as stored (status "pending", or with the result once the call
    returned), in call id order.  Unreadable files are logged and skipped here;
    ``recover_run`` moves them aside and reports them."""
    records, broken = _scan_pending(find_run_dir(run_id) / WORKING_DIR / PENDING_CALLS_DIR)
    for path, problem in broken:
        log.warning("unreadable pending model call file %s: %s", path.name, problem)
    return [record for _, record in records]


def clear_pending_model_calls(run_id: str, call_ids: list[str]) -> None:
    """Delete the given pending files (commit step 5).  Missing files are ignored."""
    _clear_pending_in(find_run_dir(run_id) / WORKING_DIR / PENDING_CALLS_DIR, call_ids)


# ---------------------------------------------------------------------------
# Continuations
# ---------------------------------------------------------------------------


def create_continuation(run_id: str, from_turn_id: str, name: Optional[str]) -> Manifest:
    """New run under the same world: copy ``turns/{from_turn_id}`` as the new run's first
    (and current) checkpoint, keep the turn id unchanged (round numbering continues),
    ``manifest.parent = {world_id, run_id, turn_id}``, ``next_event_seq`` = that turn's
    ``event_seq_end + 1``, ``next_intervention_seq`` = 1, fresh ``working/``, empty staged
    edits, a copy of ``assumptions.json`` (and of ``run_request.json`` for reference), a
    fresh real-usage ledger.  Default name ``"<parent name> from <turn_id>"``.  The copied
    turn keeps its ``previous_turn_id`` (a parent turn): the UI resolves that arrow through
    ``TurnView.parent``.  The parent run and its later turns are untouched.  The manifest is
    written last, so a failed creation leaves no visible run.  Raises StorageError."""
    parent_dir = find_run_dir(run_id)
    parent = _read_model(parent_dir / MANIFEST_FILE, Manifest, f"{run_id}/{MANIFEST_FILE}")
    _check_name(from_turn_id, "turn id")
    if from_turn_id not in {e.turn_id for e in _committed_entries(parent_dir, parent)}:
        raise StorageError(f"turn {from_turn_id} is not a committed turn of run {run_id}")
    source = _load_checkpoint_at(parent_dir, from_turn_id)

    new_id = new_run_id(name or parent.name)
    rdir = run_dir(parent.world_id, new_id)
    rdir.mkdir(parents=True)
    try:
        _create_run_skeleton(rdir)
        partial = rdir / TURNS_DIR / f"{PARTIAL_PREFIX}{from_turn_id}"
        shutil.copytree(parent_dir / TURNS_DIR / from_turn_id, partial)
        # The copied turn must stand alone: every knowledge file the parent's turn only
        # referenced is written here, and the map points at this turn.
        _materialize_knowledge(partial, source)
        copied = [partial, *partial.rglob("*")]
        for reference_file in (ASSUMPTIONS_FILE, RUN_REQUEST_FILE):
            if (parent_dir / reference_file).is_file():
                shutil.copy2(parent_dir / reference_file, rdir / reference_file)
                copied.append(rdir / reference_file)
        if FSYNC_TURN_FILES:
            _fsync_all(copied)
        os.replace(partial, rdir / TURNS_DIR / from_turn_id)
        _write_index(rdir / TURNS_DIR / INDEX_FILE, [_index_entry_for_turn(rdir, source.turn)])
        _refresh_working_dir(rdir / WORKING_DIR, source)

        now = utc_now_iso()
        turn = source.turn
        seqs = [e.seq for e in source.events]
        manifest = Manifest(
            world_id=parent.world_id,
            run_id=new_id,
            name=name or f"{parent.name} from {from_turn_id}",
            created_at=now,
            updated_at=now,
            seed=parent.seed,
            parent=ParentRef(world_id=parent.world_id, run_id=parent.run_id, turn_id=from_turn_id),
            code_revision=code_revision(),
            current_turn_id=from_turn_id,
            last_round=turn.round,
            last_turn_index=turn.turn_index,
            next_event_seq=max([turn.event_seq_end, *seqs, 0]) + 1,
            next_intervention_seq=1,
            agent_count=len(source.world.agents),
            living_agent_count=sum(1 for a in source.world.agents.values() if a.alive),
            default_model_key=source.settings.default_model_key,
            finished=False,
            finished_reason=None,
            turn_count=1,
            real_usage=RealUsageLedger(),
        )
        write_manifest(manifest)
        return manifest
    except BaseException:
        if not (rdir / MANIFEST_FILE).exists():
            shutil.rmtree(rdir, ignore_errors=True)
        raise


def _materialize_knowledge(tdir: Path, checkpoint: Checkpoint) -> None:
    """Write every agent's knowledge file into ``tdir`` and make its ``world.json`` map
    point at ``tdir`` itself (a continuation's first turn, see ``create_continuation``)."""
    turn_id = checkpoint.turn.turn_id
    refs: dict[str, dict[str, str]] = {}
    for agent_id, store in checkpoint.knowledge.items():
        rel = f"{ENTITIES_DIR}/{KNOWLEDGE_SUBDIR}/{_check_name(agent_id, 'agent id')}.json"
        text = _dumps(store, rel)
        (tdir / rel).parent.mkdir(parents=True, exist_ok=True)
        _write_text(tdir / rel, text, fsync=False)
        refs[agent_id] = {"turn_id": turn_id, "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest()}
    world_doc = _world_scalars(checkpoint.world)
    world_doc[KNOWLEDGE_FILES_KEY] = refs
    _write_text(tdir / WORLD_FILE, _dumps(world_doc, WORLD_FILE), fsync=False)


def working_readme_text() -> str:
    """Contents of working/README.txt explaining the literal god-mode workflow."""
    return """Empyrean working copy (literal god mode)
=======================================

This folder is a human-editable copy of the run's latest committed checkpoint.
The turn it was made from is written in BASE_TURN.  Editing files here changes
nothing until you reload them.

How to edit
-----------
1. Pause the run (the "Pause" button, or POST /api/runs/{run_id}/commands with
   {"command": "pause"}).  Every committed turn overwrites this folder with the
   new checkpoint, so edit only while the run is paused.
2. Edit any file below with a text editor.  Keep valid JSON.
3. Reload: the "Reload working files" button, or
   POST /api/runs/{run_id}/working/reload
   Every file is parsed and validated.  If anything is invalid (bad JSON, a wrong
   field type, a reference to a missing entity, a position outside the region,
   ...) the errors are listed with the file and the problem, NOTHING changes, and
   your edited files stay here so you can fix them and reload again.
4. A valid reload shows the before/after value of every changed field and stages
   one "apply_working_files" intervention (origin "file") holding exactly those
   field changes (and a snapshot of what you reloaded).  It is applied at the
   next turn boundary, and only if the run is still at the same committed turn
   (BASE_TURN); otherwise it is recorded as stale and not applied.  Later edits
   need another reload.
5. Order with UI edits: staged edits are applied in the order they were staged,
   and a file edit is applied as its field-by-field diff onto the state at that
   moment, so UI edits staged before or after the reload (voice, placements,
   stat changes, settings) all survive.  A field changed both in the UI and in a
   file keeps the value of the edit staged later.  If a change can no longer be
   applied (for example the entity it edits was removed by an earlier staged
   edit) or the result would be invalid, the whole file edit is recorded as
   failed with the reason and nothing of it is applied; the other edits still
   apply.  The record shows the value each field really had when it was changed.

Files
-----
BASE_TURN                       committed turn this copy was made from (do not edit)
map.json                        region and terrain per "x,y" cell; occupants are
                                recomputed on reload, so editing them has no effect
rules.json                      every gameplay rule and price (RulesConfig).  It does
                                not contain the assumptions table: edit the rule keys.
settings.json                   model assignment and context/memory settings (RunSettings)
world.json                      round, entity id counters, random-number state, observe page size, generation warnings and the
                                agent order
entities/agents/<id>.json       one agent each: stats, skills, skill execution state
entities/knowledge/<id>.json    what that agent knows: records and notebook
entities/plants.json            {id: plant}   (fruits.json, seeds.json, residues.json alike)
entities/removed.json           ids that left the world and why
staged_edits.json               interventions staged in the UI (managed by the app)
pending_model_calls/            in-flight model call records (managed by the app)

Notes
-----
* Adding an agent by hand needs both entities/agents/<id>.json and
  entities/knowledge/<id>.json; the UI "place entity" does this for you.
* Changing reality (for example placing a fruit) does not tell any agent.  Edit a
  knowledge file to change what an agent knows.
* To change the past instead, create a continuation from a recorded turn; the
  original run and its later turns are kept.
"""


# ---------------------------------------------------------------------------
# Internals: names, JSON text, atomic files
# ---------------------------------------------------------------------------


def _check_name(value: str, what: str) -> str:
    """Reject ids that are unsafe as a single path component (traversal, globbing)."""
    if not isinstance(value, str) or not _SAFE_NAME.match(value):
        raise StorageError(f"invalid {what}: {value!r}")
    return value


def _check_snapshot_ref(ref: str) -> None:
    if not isinstance(ref, str) or not _SNAPSHOT_REF.match(ref):
        raise StorageError(f"invalid snapshot reference: {ref!r}")


def _run_dir_candidates(run_id: str) -> list[Path]:
    root = worlds_root()
    if not root.is_dir():
        return []
    return [p for p in root.glob(f"*/runs/{run_id}") if p.is_dir()]


def _to_jsonable(data: Any) -> Any:
    if isinstance(data, BaseModel):
        return data.model_dump(mode="json")
    if isinstance(data, dict):
        return {key: _to_jsonable(value) for key, value in data.items()}
    if isinstance(data, (list, tuple)):
        return [_to_jsonable(item) for item in data]
    return data


def _dumps(data: Any, label: str) -> str:
    try:
        return json.dumps(_to_jsonable(data), indent=2, ensure_ascii=False, allow_nan=False) + "\n"
    except (TypeError, ValueError) as exc:
        raise StorageError(f"{label}: cannot be written as JSON: {exc}") from None


def _reject_constant(name: str) -> Any:
    raise ValueError(f"non-finite number {name} is not allowed")


def _parse_json_text(text: str, label: str) -> Any:
    try:
        return json.loads(text, parse_constant=_reject_constant)
    except json.JSONDecodeError as exc:
        raise StorageError(f"{label}: invalid JSON at line {exc.lineno} column {exc.colno}: {exc.msg}") from None
    except ValueError as exc:
        raise StorageError(f"{label}: invalid JSON: {exc}") from None


def _read_text(path: Path, label: str) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        raise StorageError(f"{label}: file not found") from None
    except UnicodeDecodeError as exc:
        raise StorageError(f"{label}: not UTF-8 text ({exc.reason})") from None
    except OSError as exc:
        raise StorageError(f"{label}: cannot read ({exc.strerror or exc})") from None


def _validation_messages(label: str, exc: ValidationError) -> list[str]:
    messages = []
    for problem in exc.errors()[:MAX_ERRORS_PER_FILE]:
        where = _format_loc(problem.get("loc", ()))
        messages.append(f"{label}: {where + ': ' if where else ''}{problem.get('msg', 'invalid value')}")
    hidden = exc.error_count() - MAX_ERRORS_PER_FILE
    if hidden > 0:
        messages.append(f"{label}: ... and {hidden} more problems")
    return messages


def _format_loc(loc: tuple[Any, ...]) -> str:
    text = ""
    for part in loc:
        if isinstance(part, int):
            text += f"[{part}]"
        else:
            text += f".{part}" if text else str(part)
    return text


def _read_model(path: Path, cls: type[Any], label: str) -> Any:
    data = _parse_json_text(_read_text(path, label), label)
    try:
        return cls.model_validate(data)
    except ValidationError as exc:
        raise StorageError("; ".join(_validation_messages(label, exc))) from None


def _write_text(path: Path, text: str, fsync: bool) -> None:
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)
        if fsync:
            handle.flush()
            os.fsync(handle.fileno())


def _atomic_write_text(path: Path, text: str, fsync: bool) -> None:
    temp = path.with_name(f".{path.name}{TEMP_MARKER}{secrets.token_hex(4)}")
    try:
        _write_text(temp, text, fsync)
        os.replace(temp, path)
    except OSError as exc:
        temp.unlink(missing_ok=True)
        raise StorageError(f"{path}: write failed ({exc.strerror or exc})") from None
    if fsync:
        _fsync_path(path.parent)


def _temp_files(folder: Path) -> list[Path]:
    if not folder.is_dir():
        return []
    return [p for p in folder.iterdir() if p.is_file() and p.name.startswith(".") and TEMP_MARKER in p.name]


def _file_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")


def _timestamp_key(value: str) -> float:
    try:
        stamp = datetime.fromisoformat(value)
    except ValueError:
        return 0.0
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp.timestamp()


def _unique(messages: list[str]) -> list[str]:
    return list(dict.fromkeys(messages))


# ---------------------------------------------------------------------------
# Internals: run skeleton, manifest, summaries
# ---------------------------------------------------------------------------


def _create_run_skeleton(rdir: Path) -> None:
    """Directories and the app-managed working files every run has (idempotent)."""
    wdir = rdir / WORKING_DIR
    for folder in (rdir / TURNS_DIR, rdir / STAGED_SNAPSHOTS_DIR, wdir, wdir / PENDING_CALLS_DIR):
        folder.mkdir(parents=True, exist_ok=True)
    readme = wdir / README_FILE
    text = working_readme_text()
    if not readme.is_file() or readme.read_text(encoding="utf-8") != text:
        _atomic_write_text(readme, text, fsync=False)
    if not (wdir / STAGED_EDITS_FILE).exists():
        atomic_write_json(wdir / STAGED_EDITS_FILE, StagedEdits())


def _manifest_after_commit(manifest: Manifest, checkpoint: Checkpoint) -> Manifest:
    turn = checkpoint.turn
    world = checkpoint.world
    committed = manifest.model_copy(deep=True)
    committed.current_turn_id = turn.turn_id
    committed.last_round = turn.round
    committed.last_turn_index = turn.turn_index
    seq_candidates = [manifest.next_event_seq]
    seq_candidates += [event.seq + 1 for event in checkpoint.events]
    if turn.event_seq_end > 0:
        seq_candidates.append(turn.event_seq_end + 1)
    committed.next_event_seq = max(seq_candidates)
    committed.agent_count = len(world.agents)
    committed.living_agent_count = sum(1 for agent in world.agents.values() if agent.alive)
    committed.default_model_key = checkpoint.settings.default_model_key
    committed.turn_count = manifest.turn_count + 1
    committed.updated_at = utc_now_iso()
    if not committed.code_revision:
        committed.code_revision = code_revision()
    return committed


def _summary_from_manifest(manifest: Manifest) -> RunSummary:
    archived, archived_at = archive_state(manifest.world_id, manifest.run_id)
    return RunSummary(
        world_id=manifest.world_id,
        run_id=manifest.run_id,
        name=manifest.name,
        current_turn_id=manifest.current_turn_id,
        last_round=manifest.last_round,
        last_turn_index=manifest.last_turn_index,
        saved_at=manifest.updated_at,
        agent_count=manifest.agent_count,
        living_agent_count=manifest.living_agent_count,
        status="finished" if manifest.finished else "paused",
        parent=manifest.parent,
        default_model_key=manifest.default_model_key,
        run_dir=run_dir_path(manifest.world_id, manifest.run_id),
        archived=archived,
        archived_at=archived_at,
    )


# ---------------------------------------------------------------------------
# Internals: writing state files (turn dirs and working/)
# ---------------------------------------------------------------------------


def _world_scalars(world: WorldState) -> dict[str, Any]:
    """world.json: every WorldState field without its own file, plus the agent order."""
    data = world.model_dump(mode="json", exclude=set(WORLD_FIELDS_WITH_OWN_FILES))
    data[AGENT_ORDER_KEY] = list(world.agents)
    return data


def _state_documents(world: WorldState, knowledge: dict[str, AgentKnowledge], settings: Any) -> dict[str, Any]:
    """Relative path -> data for the editable state files shared by turn dirs and working/."""
    docs: dict[str, Any] = {
        MAP_FILE: world.map,
        RULES_FILE: world.rules,
        SETTINGS_FILE: settings,
        WORLD_FILE: _world_scalars(world),
    }
    for attribute, (file_name, _) in ENTITY_MAP_FILES.items():
        docs[f"{ENTITIES_DIR}/{file_name}"] = getattr(world, attribute)
    for agent_id, agent in world.agents.items():
        docs[f"{ENTITIES_DIR}/{AGENTS_SUBDIR}/{_check_name(agent_id, 'agent id')}.json"] = agent
    for agent_id, store in knowledge.items():
        docs[f"{ENTITIES_DIR}/{KNOWLEDGE_SUBDIR}/{_check_name(agent_id, 'agent id')}.json"] = store
    return docs


def _call_summary(record: ModelCallRecord) -> ModelCallSummary:
    result = record.result
    return ModelCallSummary(
        call_id=record.call_id,
        agent_id=record.agent_id,
        model_key=record.model_key,
        provider=record.provider,
        model_id=record.model_id,
        response_model=result.response_model if result else None,
        status=record.status,
        result_status=result.status if result else None,
        input_tokens=result.usage.billed_input_tokens if result else 0,
        output_tokens=result.usage.output_tokens if result else 0,
        latency_ms=result.latency_ms if result else 0.0,
        attempts=result.attempts if result else 0,
        charged_compute=record.charged_compute,
        uncharged_compute=record.uncharged_compute,
        packet_id=record.packet_id,
        error=record.error or (result.error if result else None),
        provider_cost_usd=result.provider_cost_usd if result else None,
        reasoning_tokens=result.usage.reasoning_tokens if result else 0,
    )


def _knowledge_refs_of(rdir: Path, turn_id: Optional[str]) -> dict[str, dict[str, str]]:
    """The ``knowledge_files`` map of a committed turn dir, or ``{}`` when the turn has none
    (a run written before the map existed, the init turn, an unreadable file): the next
    commit then writes every knowledge file."""
    if not turn_id or not _SAFE_NAME.match(turn_id):
        return {}
    path = rdir / TURNS_DIR / turn_id / WORLD_FILE
    if not path.is_file():
        return {}
    try:
        data = _parse_json_text(_read_text(path, WORLD_FILE), WORLD_FILE)
    except StorageError:
        return {}
    refs = data.get(KNOWLEDGE_FILES_KEY) if isinstance(data, dict) else None
    return refs if _valid_knowledge_refs(refs) else {}


def _valid_knowledge_refs(refs: Any) -> bool:
    return isinstance(refs, dict) and all(
        isinstance(aid, str)
        and isinstance(ref, dict)
        and isinstance(ref.get("turn_id"), str)
        and _SAFE_NAME.match(ref["turn_id"])
        and isinstance(ref.get("sha256"), str)
        for aid, ref in refs.items()
    )


def _turn_documents(checkpoint: Checkpoint, previous_refs: Optional[dict[str, dict[str, str]]] = None) -> dict[str, Any]:
    """Relative path -> data (or pre-rendered text) for a turn dir.  With ``previous_refs``
    (the previous committed turn's ``knowledge_files``) an agent's knowledge file is left
    out when its text hashes to the same value as the file that map points at, and this
    turn's ``world.json`` points at that file instead (see the module docstring)."""
    docs = _state_documents(checkpoint.world, checkpoint.knowledge, checkpoint.settings)
    turn_id = checkpoint.turn.turn_id
    refs: dict[str, dict[str, str]] = {}
    for agent_id, store in checkpoint.knowledge.items():
        rel = f"{ENTITIES_DIR}/{KNOWLEDGE_SUBDIR}/{_check_name(agent_id, 'agent id')}.json"
        text = _dumps(store, rel)
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
        previous = (previous_refs or {}).get(agent_id)
        if previous is not None and previous.get("sha256") == digest:
            refs[agent_id] = {"turn_id": previous["turn_id"], "sha256": digest}
            del docs[rel]
        else:
            refs[agent_id] = {"turn_id": turn_id, "sha256": digest}
            docs[rel] = _PreRendered(text)
    world_doc = dict(docs[WORLD_FILE])
    world_doc[KNOWLEDGE_FILES_KEY] = refs
    docs[WORLD_FILE] = world_doc
    docs[STATE_FILE] = checkpoint.turn
    docs[EVENTS_FILE] = checkpoint.events
    docs[f"{MODEL_CALLS_DIR}/{MODEL_CALLS_INDEX}"] = [_call_summary(r) for r in checkpoint.model_calls]
    for record in checkpoint.model_calls:
        docs[f"{MODEL_CALLS_DIR}/{_check_name(record.call_id, 'model call id')}.json"] = record
    for packet in checkpoint.decision_packets:
        docs[f"{PACKETS_DIR}/{_check_name(packet.packet_id, 'packet id')}.json"] = packet
    return docs


class _PreRendered:
    """JSON text already rendered by ``_dumps`` (a knowledge file whose hash was taken)."""

    __slots__ = ("text",)

    def __init__(self, text: str) -> None:
        self.text = text


def _write_documents(root: Path, docs: dict[str, Any], fsync: bool) -> None:
    """Plain writes into a directory nobody reads yet (a partial or temp dir).  With
    ``fsync`` every file and folder is flushed afterwards, concurrently: the journal then
    groups the flushes (measured ~17 ms instead of ~115 ms for a 35-file turn on ext4)."""
    folders = {root}
    files: list[Path] = []
    for rel, data in docs.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        folders.add(path.parent)
        _write_text(path, data.text if isinstance(data, _PreRendered) else _dumps(data, rel), fsync=False)
        files.append(path)
    if fsync:
        _fsync_all(files + sorted(folders))


def _fsync_all(paths: list[Path]) -> None:
    with ThreadPoolExecutor(max_workers=FSYNC_WORKERS) as pool:
        list(pool.map(_fsync_path, paths))


def _fsync_path(path: Path) -> None:
    """Flush one file or directory; directories on filesystems without support are skipped."""
    try:
        fd = os.open(str(path), os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        if not path.is_dir():
            raise
    finally:
        os.close(fd)


def _write_turn_dir(rdir: Path, checkpoint: Checkpoint) -> None:
    """Commit step 1: the complete turn directory, made visible by one rename."""
    turn_id = checkpoint.turn.turn_id
    turns_dir = rdir / TURNS_DIR
    turns_dir.mkdir(exist_ok=True)
    partial = turns_dir / f"{PARTIAL_PREFIX}{turn_id}"
    final = turns_dir / turn_id
    if partial.exists():
        shutil.rmtree(partial)
    partial.mkdir()
    (partial / PACKETS_DIR).mkdir()
    (partial / ENTITIES_DIR / KNOWLEDGE_SUBDIR).mkdir(parents=True)  # present even when no store changed
    previous_refs = _knowledge_refs_of(rdir, checkpoint.turn.previous_turn_id)
    try:
        _write_documents(partial, _turn_documents(checkpoint, previous_refs), FSYNC_TURN_FILES)
        _promote_partial(partial, final)
    except OSError as exc:
        raise StorageError(f"writing turn {turn_id} failed: {exc}") from None
    if FSYNC_TURN_FILES:
        _fsync_path(turns_dir)


def _promote_partial(partial: Path, final: Path) -> None:
    """Remove a stale (never committed) turn dir of the same id, then rename.
    ``write_checkpoint`` has already refused every committed id, so a directory found
    here can only be the leftover of an attempt that failed before its commit point."""
    if final.exists():
        shutil.rmtree(final)
    os.replace(partial, final)


def _after_commit(rdir: Path, manifest: Manifest, checkpoint: Checkpoint) -> None:
    """Commit steps 3-5.  Each is repaired on open if it fails, so failures are logged."""
    turn = checkpoint.turn
    try:
        _append_index(rdir / TURNS_DIR / INDEX_FILE, _index_entry(turn, len(checkpoint.events)))
    except (OSError, StorageError) as exc:
        log.warning("run %s: turn index append failed after commit of %s: %s", manifest.run_id, turn.turn_id, exc)
    try:
        _refresh_working_dir(rdir / WORKING_DIR, checkpoint)
    except (OSError, StorageError) as exc:
        log.warning("run %s: working/ refresh failed after commit of %s: %s", manifest.run_id, turn.turn_id, exc)
    committed_calls = set(turn.model_call_ids) | {record.call_id for record in checkpoint.model_calls}
    try:
        _clear_pending_in(rdir / WORKING_DIR / PENDING_CALLS_DIR, sorted(committed_calls))
    except (OSError, StorageError) as exc:
        log.warning("run %s: pending call cleanup failed after commit of %s: %s", manifest.run_id, turn.turn_id, exc)


def _refresh_working_dir(wdir: Path, checkpoint: Checkpoint) -> None:
    """See ``refresh_working``: BASE_TURN removed first and written last; entities swapped
    in as one directory; app-managed files (staged edits, pending calls) untouched."""
    wdir.mkdir(parents=True, exist_ok=True)
    (wdir / PENDING_CALLS_DIR).mkdir(exist_ok=True)
    (wdir / BASE_TURN_FILE).unlink(missing_ok=True)
    for leftover in (WORKING_ENTITIES_NEW, WORKING_ENTITIES_OLD):
        if (wdir / leftover).exists():
            shutil.rmtree(wdir / leftover)

    docs = _state_documents(checkpoint.world, checkpoint.knowledge, checkpoint.settings)
    prefix = f"{ENTITIES_DIR}/"
    entity_docs = {rel[len(prefix):]: data for rel, data in docs.items() if rel.startswith(prefix)}
    new_entities = wdir / WORKING_ENTITIES_NEW
    new_entities.mkdir()
    (new_entities / AGENTS_SUBDIR).mkdir()
    (new_entities / KNOWLEDGE_SUBDIR).mkdir()
    _write_documents(new_entities, entity_docs, fsync=False)
    for rel, data in docs.items():
        if not rel.startswith(prefix):
            atomic_write_json(wdir / rel, data, fsync=False)

    current = wdir / ENTITIES_DIR
    old = wdir / WORKING_ENTITIES_OLD
    if current.exists():
        os.replace(current, old)
    os.replace(new_entities, current)
    if old.exists():
        shutil.rmtree(old)
    if not (wdir / README_FILE).exists():
        _atomic_write_text(wdir / README_FILE, working_readme_text(), fsync=False)
    if not (wdir / STAGED_EDITS_FILE).exists():
        atomic_write_json(wdir / STAGED_EDITS_FILE, StagedEdits())
    _atomic_write_text(wdir / BASE_TURN_FILE, checkpoint.turn.turn_id + "\n", fsync=False)


def _read_base_turn_at(wdir: Path) -> Optional[str]:
    try:
        text = (wdir / BASE_TURN_FILE).read_text(encoding="utf-8").strip()
    except (OSError, UnicodeDecodeError):
        return None
    return text or None


def _read_staged_edits_at(wdir: Path) -> StagedEdits:
    path = wdir / STAGED_EDITS_FILE
    if not path.exists():
        return StagedEdits()
    return _read_model(path, StagedEdits, f"{WORKING_DIR}/{STAGED_EDITS_FILE}")


# ---------------------------------------------------------------------------
# Internals: reading state files
# ---------------------------------------------------------------------------


class _Reader:
    """Reads files under ``root`` and collects readable problems labelled with
    ``label_prefix + relative path`` instead of raising (load_working reports them all;
    load_checkpoint raises them joined)."""

    def __init__(self, root: Path, label_prefix: str) -> None:
        self.root = root
        self.label_prefix = label_prefix
        self.errors: list[str] = []

    def label(self, rel: str) -> str:
        return f"{self.label_prefix}{rel}"

    def raw(self, rel: str) -> Any:
        label = self.label(rel)
        try:
            return _parse_json_text(_read_text(self.root / rel, label), label)
        except StorageError as exc:
            self.errors.append(str(exc))
            return None

    def validate(self, rel: str, cls: type[Any], data: Any, where: str = "") -> Any:
        try:
            return cls.model_validate(data)
        except ValidationError as exc:
            label = self.label(rel) + (f" {where}" if where else "")
            self.errors.extend(_validation_messages(label, exc))
            return None

    def model(self, rel: str, cls: type[Any]) -> Any:
        data = self.raw(rel)
        return None if data is None else self.validate(rel, cls, data)

    def model_list(self, rel: str, cls: type[Any]) -> Optional[list[Any]]:
        data = self.raw(rel)
        if data is None:
            return None
        if not isinstance(data, list):
            self.errors.append(f"{self.label(rel)}: expected a JSON list")
            return None
        items = [self.validate(rel, cls, item, f"[{i}]") for i, item in enumerate(data)]
        return None if any(item is None for item in items) else items

    def id_map(self, rel: str, cls: type[Any]) -> Optional[dict[str, Any]]:
        """An ``{id: record}`` file; each key must equal its record's id."""
        data = self.raw(rel)
        if data is None:
            return None
        if not isinstance(data, dict):
            self.errors.append(f"{self.label(rel)}: expected a JSON object {{id: record}}")
            return None
        result: dict[str, Any] = {}
        ok = True
        for key, item in data.items():
            record = self.validate(rel, cls, item, f"[{key}]")
            if record is None:
                ok = False
            elif record.id != key:
                self.errors.append(f"{self.label(rel)}: key {key} does not match the record id {record.id}")
                ok = False
            else:
                result[key] = record
        return result if ok else None

    def per_file_dir(self, rel_dir: str, cls: type[Any], id_field: str) -> Optional[dict[str, Any]]:
        """One ``{id}.json`` file per record; the file name must equal the record's id.
        Hidden files and non-JSON files (editor backups) are ignored."""
        folder = self.root / rel_dir
        if not folder.is_dir():
            self.errors.append(f"{self.label(rel_dir)}: folder missing")
            return None
        result: dict[str, Any] = {}
        ok = True
        for path in sorted(folder.iterdir()):
            if path.name.startswith(".") or path.suffix != ".json" or not path.is_file():
                continue
            rel = f"{rel_dir}/{path.name}"
            record = self.model(rel, cls)
            if record is None:
                ok = False
            elif getattr(record, id_field) != path.stem:
                self.errors.append(f"{self.label(rel)}: file name {path.stem} does not match {id_field} {getattr(record, id_field)}")
                ok = False
            else:
                result[path.stem] = record
        return result if ok else None

    def raise_if_errors(self) -> None:
        if self.errors:
            raise StorageError("; ".join(_unique(self.errors)))


def _read_state_files(
    reader: _Reader, working: bool, with_knowledge: bool = True
) -> tuple[Optional[WorldState], Optional[dict[str, AgentKnowledge]], Optional[RunSettings]]:
    """World, knowledge and settings from a turn dir or working/.  ``working`` only changes
    how strictly ``agent_order`` is applied (hand-added agents go last) and ignores a
    ``knowledge_files`` map (working/ always holds every file); without ``with_knowledge``
    the knowledge files are not read and ``{}`` is returned.  In a turn dir the agents
    whose knowledge file is not local are read from the turn dir the map points at."""
    map_state = reader.model(MAP_FILE, MapState)
    rules = reader.model(RULES_FILE, RulesConfig)
    settings = reader.model(SETTINGS_FILE, RunSettings)
    scalars = reader.raw(WORLD_FILE)
    entity_maps = {attr: reader.id_map(f"{ENTITIES_DIR}/{file_name}", cls) for attr, (file_name, cls) in ENTITY_MAP_FILES.items()}
    agents = reader.per_file_dir(f"{ENTITIES_DIR}/{AGENTS_SUBDIR}", Agent, "id")
    knowledge: Optional[dict[str, Any]] = {}
    if with_knowledge:
        knowledge = reader.per_file_dir(f"{ENTITIES_DIR}/{KNOWLEDGE_SUBDIR}", AgentKnowledge, "agent_id")

    if scalars is not None and not isinstance(scalars, dict):
        reader.errors.append(f"{reader.label(WORLD_FILE)}: expected a JSON object")
        scalars = None
    order: list[str] = []
    refs: dict[str, dict[str, str]] = {}
    if scalars is not None:
        scalars = dict(scalars)
        raw_order = scalars.pop(AGENT_ORDER_KEY, [])
        if not isinstance(raw_order, list) or not all(isinstance(i, str) for i in raw_order):
            reader.errors.append(f"{reader.label(WORLD_FILE)}: {AGENT_ORDER_KEY} must be a list of agent ids")
        else:
            order = raw_order
        raw_refs = scalars.pop(KNOWLEDGE_FILES_KEY, None)
        if raw_refs is not None and not working:
            if _valid_knowledge_refs(raw_refs):
                refs = raw_refs
            else:
                reader.errors.append(f"{reader.label(WORLD_FILE)}: {KNOWLEDGE_FILES_KEY} must map agent ids to {{turn_id, sha256}}")
    if with_knowledge and knowledge is not None and refs:
        for agent_id, ref in refs.items():
            if agent_id in knowledge:
                continue
            record = _read_referenced_knowledge(reader, agent_id, ref)
            if record is None:
                knowledge = None
                break
            knowledge[agent_id] = record
    if (
        map_state is None
        or rules is None
        or settings is None
        or scalars is None
        or agents is None
        or knowledge is None
        or any(m is None for m in entity_maps.values())
    ):
        return None, None, None

    ordered_agents = _in_order(agents, order)
    ordered_knowledge = _in_order(knowledge, order)
    if not working and set(order) != set(agents):
        reader.errors.append(f"{reader.label(WORLD_FILE)}: {AGENT_ORDER_KEY} does not list exactly the agent files")
    world_state = reader.validate(
        WORLD_FILE,
        WorldState,
        {**scalars, "map": map_state, "rules": rules, "agents": ordered_agents, **entity_maps},
    )
    if world_state is None:
        return None, None, None
    return world_state, ordered_knowledge, settings


def _read_referenced_knowledge(reader: _Reader, agent_id: str, ref: dict[str, str]) -> Optional[AgentKnowledge]:
    """An agent's knowledge from the turn dir ``ref`` names (same run: the reader's root is
    ``turns/<turn_id>``).  Problems are reported on the reader."""
    if not _SAFE_NAME.match(agent_id):
        reader.errors.append(f"{reader.label(WORLD_FILE)}: {KNOWLEDGE_FILES_KEY} has an invalid agent id {agent_id!r}")
        return None
    turns_dir = reader.root.parent
    path = turns_dir / ref["turn_id"] / ENTITIES_DIR / KNOWLEDGE_SUBDIR / f"{agent_id}.json"
    label = f"{TURNS_DIR}/{ref['turn_id']}/{ENTITIES_DIR}/{KNOWLEDGE_SUBDIR}/{agent_id}.json"
    try:
        record = _read_model(path, AgentKnowledge, label)
    except StorageError as exc:
        reader.errors.append(f"{reader.label(WORLD_FILE)}: knowledge of {agent_id} referenced in {ref['turn_id']} is unreadable ({exc})")
        return None
    if record.agent_id != agent_id:
        reader.errors.append(f"{label}: file name {agent_id} does not match agent_id {record.agent_id}")
        return None
    return record


def _in_order(records: dict[str, Any], order: list[str]) -> dict[str, Any]:
    """``records`` re-keyed in ``order`` first, then any others in sorted id order."""
    ordered = {key: records[key] for key in order if key in records}
    for key in sorted(records):
        ordered.setdefault(key, records[key])
    return ordered


def _read_call_summaries(reader: _Reader) -> Optional[list[ModelCallSummary]]:
    rel = f"{MODEL_CALLS_DIR}/{MODEL_CALLS_INDEX}"
    if not (reader.root / rel).exists():
        return []
    return reader.model_list(rel, ModelCallSummary)


def _packet_ids(tdir: Path) -> list[str]:
    folder = tdir / PACKETS_DIR
    if not folder.is_dir():
        return []
    return sorted(p.stem for p in folder.iterdir() if p.suffix == ".json" and not p.name.startswith("."))


def _read_checkpoint(reader: _Reader, with_bodies: bool) -> Checkpoint:
    """A checkpoint from a turn dir; with ``with_bodies`` False knowledge, model call and
    packet bodies are left empty.  Raises StorageError listing every problem."""
    turn = reader.model(STATE_FILE, TurnRecord)
    world_state, knowledge, settings = _read_state_files(reader, working=False, with_knowledge=with_bodies)
    events = reader.model_list(EVENTS_FILE, Event)
    model_calls: list[ModelCallRecord] = []
    packets: list[DecisionPacketRecord] = []
    if with_bodies:
        summaries = _read_call_summaries(reader) or []
        call_ids = [s.call_id for s in summaries]
        folder = reader.root / MODEL_CALLS_DIR
        if folder.is_dir():
            extra = sorted(
                p.stem for p in folder.iterdir() if p.suffix == ".json" and p.name != MODEL_CALLS_INDEX and not p.name.startswith(".")
            )
            call_ids += [c for c in extra if c not in call_ids]
        for call_id in call_ids:
            record = reader.model(f"{MODEL_CALLS_DIR}/{call_id}.json", ModelCallRecord)
            if record is not None:
                model_calls.append(record)
        for packet_id in _packet_ids(reader.root):
            packet = reader.model(f"{PACKETS_DIR}/{packet_id}.json", DecisionPacketRecord)
            if packet is not None:
                packets.append(packet)
    reader.raise_if_errors()
    if turn is None or world_state is None or knowledge is None or settings is None or events is None:
        raise StorageError(f"{reader.label_prefix}: checkpoint files are incomplete")
    return Checkpoint(
        turn=turn,
        world=world_state,
        knowledge=knowledge,
        settings=settings,
        events=events,
        model_calls=model_calls,
        decision_packets=packets,
    )


def _turn_dir(rdir: Path, turn_id: str) -> Path:
    tdir = rdir / TURNS_DIR / _check_name(turn_id, "turn id")
    if not (tdir / STATE_FILE).is_file():
        raise StorageError(f"turn {turn_id} not found in run {rdir.name}")
    return tdir


def _load_checkpoint_at(rdir: Path, turn_id: str) -> Checkpoint:
    tdir = _turn_dir(rdir, turn_id)
    return _read_checkpoint(_Reader(tdir, f"{TURNS_DIR}/{turn_id}/"), with_bodies=True)


def _read_turn_events_at(rdir: Path, turn_id: str) -> list[Event]:
    tdir = _turn_dir(rdir, turn_id)
    reader = _Reader(tdir, f"{TURNS_DIR}/{turn_id}/")
    events = reader.model_list(EVENTS_FILE, Event)
    reader.raise_if_errors()
    return events or []


# ---------------------------------------------------------------------------
# Internals: turn index and the committed chain
# ---------------------------------------------------------------------------


def _index_entry(turn: TurnRecord, event_count: int) -> TurnIndexEntry:
    return TurnIndexEntry(
        turn_id=turn.turn_id,
        kind=turn.kind,
        round=turn.round,
        turn_index=turn.turn_index,
        acting_agent_id=turn.acting_agent_id,
        action_name=(turn.action or {}).get("name"),
        ok=turn.action_result.ok if turn.action_result is not None else None,
        decision_source=turn.decision_source,
        intervention_count=len(turn.interventions),
        event_count=event_count,
        saved_at=turn.saved_at,
    )


def _index_entry_for_turn(rdir: Path, turn: TurnRecord) -> TurnIndexEntry:
    return _index_entry(turn, len(_read_turn_events_at(rdir, turn.turn_id)))


def _index_line(entry: TurnIndexEntry) -> str:
    return json.dumps(entry.model_dump(mode="json"), ensure_ascii=False, allow_nan=False) + "\n"


def _append_index(path: Path, entry: TurnIndexEntry) -> None:
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(_index_line(entry))


def _write_index(path: Path, entries: list[TurnIndexEntry]) -> None:
    _atomic_write_text(path, "".join(_index_line(e) for e in entries), fsync=False)


def _read_index_file(path: Path) -> Optional[list[TurnIndexEntry]]:
    """Entries in file order, or None when the file is missing or corrupt.  A trailing line
    without its newline is a line being appended right now (or cut by a crash) and is
    ignored."""
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None
    lines = text.split("\n")
    complete = lines[:-1]  # the last element is "" when the file ends with a newline
    entries: list[TurnIndexEntry] = []
    for line in complete:
        if not line.strip():
            continue
        try:
            entries.append(TurnIndexEntry.model_validate(json.loads(line)))
        except (ValueError, ValidationError):
            return None
    return entries


def _read_turn_record(rdir: Path, turn_id: str) -> Optional[TurnRecord]:
    """The TurnRecord of a turn dir in this run, or None when the dir does not exist."""
    path = rdir / TURNS_DIR / turn_id / STATE_FILE
    if not path.is_file():
        return None
    return _read_model(path, TurnRecord, f"{TURNS_DIR}/{turn_id}/{STATE_FILE}")


def _validate_turn_record(raw: dict[str, Any], turn_id: str) -> TurnRecord:
    try:
        return TurnRecord.model_validate(raw)
    except ValidationError as exc:
        raise StorageError("; ".join(_validation_messages(f"{TURNS_DIR}/{turn_id}/{STATE_FILE}", exc))) from None


def _walk_chain(rdir: Path, manifest: Manifest, warnings: list[str]) -> tuple[list[tuple[str, dict[str, Any]]], bool]:
    """The committed turns oldest-first as ``(turn_id, raw state.json)``: from
    ``manifest.current_turn_id`` back through ``previous_turn_id`` until a turn whose
    predecessor is not in this run (the init turn has none; a continuation's copied first
    turn points into the parent).  Raw JSON keeps this cheap on long runs.  Returns
    ``(chain, complete)``; ``complete`` is False when an older turn is missing or unreadable
    where the chain should continue.  Raises StorageError if the committed turn itself is
    missing or unreadable (nothing to recover to)."""
    chain: list[tuple[str, dict[str, Any]]] = []
    expected_start = manifest.parent.turn_id if manifest.parent else TurnId.INIT
    complete = True
    turn_id: Optional[str] = manifest.current_turn_id
    while turn_id is not None:
        if any(turn_id == seen for seen, _ in chain):
            warnings.append(f"turn {turn_id} appears twice in the chain; stopped there")
            complete = False
            break
        path = rdir / TURNS_DIR / turn_id / STATE_FILE
        label = f"{TURNS_DIR}/{turn_id}/{STATE_FILE}"
        try:
            raw = _parse_json_text(_read_text(path, label), label) if path.is_file() else None
            if raw is not None and not isinstance(raw, dict):
                raise StorageError(f"{label}: expected a JSON object")
        except StorageError as exc:
            if not chain:
                raise
            warnings.append(f"history before {chain[-1][0]} is unreadable: {exc}")
            complete = False
            break
        if raw is None:
            if not chain:
                raise StorageError(f"run {manifest.run_id}: committed turn {turn_id} is missing")
            if chain[-1][0] != expected_start:
                warnings.append(f"history before {chain[-1][0]} is missing (previous turn {turn_id} not found)")
                complete = False
            break
        chain.append((turn_id, raw))
        previous = raw.get("previous_turn_id")
        turn_id = previous if isinstance(previous, str) else None
    chain.reverse()
    return chain, complete


def _committed_entries(rdir: Path, manifest: Manifest) -> list[TurnIndexEntry]:
    """Index entries for the committed chain without writing anything.  Fast path: the
    index ends at the committed turn.  Otherwise walk back from the committed turn until an
    indexed turn is met and derive the missing entries (usually one); a full walk when the
    index is missing or unusable."""
    entries = _read_index_file(rdir / TURNS_DIR / INDEX_FILE) or []
    if entries and entries[-1].turn_id == manifest.current_turn_id:
        return entries
    position = {entry.turn_id: i for i, entry in enumerate(entries)}
    missing: list[TurnIndexEntry] = []
    turn_id: Optional[str] = manifest.current_turn_id
    while turn_id is not None and turn_id not in position:
        record = _read_turn_record(rdir, turn_id)
        if record is None:
            break
        missing.append(_index_entry_for_turn(rdir, record))
        turn_id = record.previous_turn_id
    missing.reverse()
    if turn_id is not None and turn_id in position:
        return entries[: position[turn_id] + 1] + missing
    return missing


def _is_committed_turn(rdir: Path, manifest: Manifest, turn_id: str) -> bool:
    """True when ``turn_id`` is part of the committed chain.  Cheap on the normal path
    (no directory of that name exists); when one does, the index (or the chain itself)
    decides whether it is committed history or the leftover of a failed attempt."""
    if turn_id == manifest.current_turn_id:
        return True
    if not (rdir / TURNS_DIR / turn_id / STATE_FILE).is_file():
        return False
    return any(entry.turn_id == turn_id for entry in _committed_entries(rdir, manifest))


def _is_committed_call(rdir: Path, chain: list[tuple[str, dict[str, Any]]], record: ModelCallRecord) -> bool:
    """True when a committed turn already holds this call (listed in a ``model_call_ids``, or
    its record file is in the call's own turn or in the newest turn, where carried records
    of an interrupted attempt land)."""
    if any(record.call_id in (raw.get("model_call_ids") or []) for _, raw in chain):
        return True
    if not _SAFE_NAME.match(record.call_id):
        return False
    chain_ids = {turn_id for turn_id, _ in chain}
    candidates = {record.turn_id} & chain_ids
    if chain:
        candidates.add(chain[-1][0])
    return any((rdir / TURNS_DIR / turn_id / MODEL_CALLS_DIR / f"{record.call_id}.json").is_file() for turn_id in candidates)


# ---------------------------------------------------------------------------
# Internals: recovery steps (recover_run)
# ---------------------------------------------------------------------------


def _remove_uncommitted_turn_dirs(rdir: Path, chain: list[tuple[str, dict[str, Any]]], chain_complete: bool, report: RecoveryReport) -> None:
    """Partial turn directories always go; unreachable ones only when the chain is intact
    (a damaged older turn must never cause the history behind it to be deleted)."""
    chain_ids = {turn_id for turn_id, _ in chain}
    for child in sorted((rdir / TURNS_DIR).iterdir()):
        if not child.is_dir() or child.name in chain_ids:
            continue
        if child.name.startswith(PARTIAL_PREFIX) or chain_complete:
            shutil.rmtree(child, ignore_errors=True)
            report.deleted_dirs.append(f"{TURNS_DIR}/{child.name}")
    if not chain_complete:
        report.warnings.append("the committed history is damaged; turn directories outside the chain were kept")


def _remove_temp_files(rdir: Path, report: RecoveryReport) -> None:
    """Stray temp files of interrupted atomic writes."""
    wdir = rdir / WORKING_DIR
    for folder in (rdir, rdir / TURNS_DIR, wdir, wdir / PENDING_CALLS_DIR, rdir / STAGED_SNAPSHOTS_DIR):
        for stray in _temp_files(folder):
            stray.unlink(missing_ok=True)
            report.warnings.append(f"removed unfinished temp file {stray.relative_to(rdir)}")


def _repair_index(rdir: Path, chain: list[tuple[str, dict[str, Any]]], chain_complete: bool, report: RecoveryReport) -> None:
    """With an intact chain the index must list exactly the chain; entries already present
    are reused (they are appended only after a commit, so never stale).  With a damaged
    chain the index keeps what it says about the unreadable part and only gains the
    committed turns it lacks."""
    path = rdir / TURNS_DIR / INDEX_FILE
    index = _read_index_file(path)
    known = {e.turn_id: e for e in index or []}
    if chain_complete:
        needs_rebuild = index is None or [e.turn_id for e in index] != [turn_id for turn_id, _ in chain]
        keep: list[TurnIndexEntry] = []
        wanted = chain
    else:
        wanted = [(turn_id, raw) for turn_id, raw in chain if turn_id not in known]
        needs_rebuild = index is None or bool(wanted)
        keep = list(index or [])
    if not needs_rebuild:
        return
    rebuilt = keep + [
        known.get(turn_id) or _index_entry_for_turn(rdir, _validate_turn_record(raw, turn_id)) for turn_id, raw in wanted
    ]
    _write_index(path, rebuilt)
    report.index_rebuilt = True


def _repair_working(rdir: Path, manifest: Manifest, report: RecoveryReport) -> None:
    """Rebuild working/ when BASE_TURN is not the committed turn (a crash between commit
    steps 2 and 4, or an interrupted refresh).  A current copy is left alone: it may hold
    the operator's edits waiting for a reload."""
    wdir = rdir / WORKING_DIR
    base = _read_base_turn_at(wdir)
    if base != manifest.current_turn_id:
        _refresh_working_dir(wdir, _load_checkpoint_at(rdir, manifest.current_turn_id))
        report.working_rebuilt = True
        report.warnings.append(
            f"working copy made from {base or 'an unfinished refresh'} was stale and has been discarded; "
            f"rebuilt from {manifest.current_turn_id}"
        )
        return
    for leftover in (WORKING_ENTITIES_NEW, WORKING_ENTITIES_OLD):
        if (wdir / leftover).exists():
            shutil.rmtree(wdir / leftover, ignore_errors=True)
            report.deleted_dirs.append(f"{WORKING_DIR}/{leftover}")


def _repair_staged_edits(rdir: Path, report: RecoveryReport) -> None:
    """Staged edits must stay loadable; a corrupt file is moved aside, never deleted."""
    wdir = rdir / WORKING_DIR
    try:
        _read_staged_edits_at(wdir)
    except StorageError as exc:
        aside = wdir / f"staged_edits.corrupt-{_file_stamp()}.json"
        os.replace(wdir / STAGED_EDITS_FILE, aside)
        atomic_write_json(wdir / STAGED_EDITS_FILE, StagedEdits())
        report.warnings.append(f"{exc}; moved to {WORKING_DIR}/{aside.name} and replaced by an empty list")


def _collect_pending_calls(rdir: Path, chain: list[tuple[str, dict[str, Any]]], report: RecoveryReport) -> None:
    """Leftover pending calls become interrupted records for the runner (files kept until
    the carrying commit); files of calls a committed turn already holds are deleted so
    their usage is not counted twice; unreadable files are moved aside."""
    records, broken = _scan_pending(rdir / WORKING_DIR / PENDING_CALLS_DIR)
    for path, problem in broken:
        aside = path.with_name(f"{path.stem}.corrupt-{_file_stamp()}")
        os.replace(path, aside)
        report.warnings.append(f"{problem}; moved to {aside.relative_to(rdir)} (usage unknown)")
    for path, record in records:
        if _is_committed_call(rdir, chain, record):
            path.unlink(missing_ok=True)
            report.cleared_pending_calls.append(record.call_id)
        else:
            report.pending_calls.append(_as_interrupted(record))


# ---------------------------------------------------------------------------
# Internals: pending model calls
# ---------------------------------------------------------------------------


def _scan_pending(pending_dir: Path) -> tuple[list[tuple[Path, ModelCallRecord]], list[tuple[Path, str]]]:
    records: list[tuple[Path, ModelCallRecord]] = []
    broken: list[tuple[Path, str]] = []
    if not pending_dir.is_dir():
        return records, broken
    for path in sorted(pending_dir.iterdir()):
        if path.name.startswith(".") or path.suffix != ".json" or not path.is_file():
            continue
        label = f"{WORKING_DIR}/{PENDING_CALLS_DIR}/{path.name}"
        try:
            records.append((path, _read_model(path, ModelCallRecord, label)))
        except StorageError as exc:
            broken.append((path, str(exc)))
    return records, broken


def _clear_pending_in(pending_dir: Path, call_ids: list[str]) -> None:
    for call_id in call_ids:
        (pending_dir / f"{_check_name(call_id, 'model call id')}.json").unlink(missing_ok=True)


def _as_interrupted(record: ModelCallRecord) -> ModelCallRecord:
    """A leftover pending record as the runner carries it: failed, uncertain outcome,
    nothing charged to the agent; any result (and its usage) is kept."""
    return record.model_copy(
        deep=True,
        update={
            "status": "failed",
            "error": INTERRUPTED_CALL_ERROR,
            "charged_compute": 0.0,
            "uncharged_compute": 0.0,
            "finished_at": record.finished_at or utc_now_iso(),
        },
    )


# ---------------------------------------------------------------------------
# Internals: working/ validation and diff
# ---------------------------------------------------------------------------


def _working_reference_errors(world: WorldState, knowledge: dict[str, AgentKnowledge], settings: RunSettings) -> list[str]:
    """Cross-file checks storage owns (the engine's own checks come from validate_world)."""
    errors: list[str] = []
    prefix = f"{WORKING_DIR}/{ENTITIES_DIR}"
    removed_agents = {rid for rid, removed in world.removed.items() if removed.kind == "agent"}
    known_agents = set(world.agents) | removed_agents

    for agent_id in knowledge:
        if agent_id not in known_agents:
            errors.append(
                f"{prefix}/{KNOWLEDGE_SUBDIR}/{agent_id}.json: no agent {agent_id} (restore entities/{AGENTS_SUBDIR}/{agent_id}.json, "
                f"record {agent_id} in entities/removed.json, or delete this file)"
            )
    for agent_id in world.agents:
        if agent_id not in knowledge:
            errors.append(f"{prefix}/{AGENTS_SUBDIR}/{agent_id}.json: agent {agent_id} has no knowledge file entities/{KNOWLEDGE_SUBDIR}/{agent_id}.json")

    for fruit in world.fruits.values():
        if fruit.plant_id is not None and fruit.plant_id not in world.plants:
            errors.append(f"{prefix}/fruits.json: fruit {fruit.id} refers to missing plant {fruit.plant_id}")
    for seed in world.seeds.values():
        if seed.plant_id is not None and seed.plant_id not in world.plants:
            errors.append(f"{prefix}/seeds.json: seed {seed.id} refers to missing plant {seed.plant_id}")

    region = world.map.region
    located: list[tuple[str, str, Point]] = [(f"{prefix}/{AGENTS_SUBDIR}/{a.id}.json", a.id, a.position) for a in world.agents.values()]
    for attribute in ("plants", "fruits", "seeds", "residues"):
        file_name = ENTITY_MAP_FILES[attribute][0]
        located += [(f"{prefix}/{file_name}", e.id, e.position) for e in getattr(world, attribute).values()]
    for label, entity_id, position in located:
        if not region.contains(position):
            errors.append(
                f"{label}: {entity_id} position ({position.x},{position.y}) is outside the region "
                f"x {region.min_x}..{region.max_x}, y {region.min_y}..{region.max_y}"
            )

    errors.extend(_map_cell_errors(world.map))

    for field_name in ("model_overrides", "context_overrides", "fake_scripts", "fake_options"):
        for agent_id in getattr(settings, field_name):
            if agent_id not in known_agents:
                errors.append(f"{WORKING_DIR}/{SETTINGS_FILE}: {field_name} refers to unknown agent {agent_id}")
    return errors


_WORLD_PROBLEM_PREFIX = re.compile(r"^(agents|plants|fruits|seeds|residues|removed)\.([A-Za-z0-9_\-]+): (.*)$", re.DOTALL)


def _working_file_for_problem(problem: str) -> str:
    """A ``world.validate_world`` message with the working file it points at in front
    (INTERFACES section 9: reload errors are "file path + problem").  ``agents.a02: health
    500.0 exceeds max_health 100.0`` becomes ``working/entities/agents/a02.json: health ...``;
    the entity-map files get ``working/entities/plants.json: p0003: ...``; anything else
    keeps the ``world:`` prefix."""
    match = _WORLD_PROBLEM_PREFIX.match(problem)
    if match is None:
        return f"world: {problem}"
    table, entity_id, rest = match.groups()
    if table == "agents":
        return f"{WORKING_DIR}/{ENTITIES_DIR}/{AGENTS_SUBDIR}/{entity_id}.json: {rest}"
    file_name = ENTITY_MAP_FILES[table][0]
    return f"{WORKING_DIR}/{ENTITIES_DIR}/{file_name}: {entity_id}: {rest}"


def _map_cell_errors(map_state: MapState) -> list[str]:
    label = f"{WORKING_DIR}/{MAP_FILE}"
    region = map_state.region
    errors: list[str] = []
    for key in map_state.cells:
        try:
            point = Point.model_validate(key)
        except (ValueError, ValidationError):
            errors.append(f"{label}: cell key {key!r} is not \"x,y\"")
            continue
        if not region.contains(point):
            errors.append(f"{label}: cell {key} is outside the region")
    missing = [
        f"{x},{y}"
        for x in range(region.min_x, region.max_x + 1)
        for y in range(region.min_y, region.max_y + 1)
        if f"{x},{y}" not in map_state.cells
    ]
    if missing:
        shown = ", ".join(missing[:5]) + (f" and {len(missing) - 5} more" if len(missing) > 5 else "")
        errors.append(f"{label}: no terrain for cells {shown}")
    return errors


def _world_for_diff(world: WorldState) -> dict[str, Any]:
    data = world.model_dump(mode="json")
    data["map"].pop("occupants", None)
    return data


def _json_equal(a: Any, b: Any) -> bool:
    """Structural equality on JSON values; booleans never equal numbers."""
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_json_equal(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_json_equal(x, y) for x, y in zip(a, b))
    return type(a) is type(b) and a == b


def _record_ids(items: list[Any]) -> Optional[list[str]]:
    """The ids of a list of records with unique string ``id`` keys, else None."""
    if not all(isinstance(item, dict) and isinstance(item.get("id"), str) for item in items):
        return None
    ids = [item["id"] for item in items]
    return ids if len(set(ids)) == len(ids) else None


def _diff_values(path: str, before: Any, after: Any, out: list[FieldChange]) -> None:
    if _json_equal(before, after):
        return
    if isinstance(before, dict) and isinstance(after, dict):
        for key, value in before.items():
            if key not in after:
                out.append(FieldChange(path=f"{path}.{key}", before=value, after=None))
            else:
                _diff_values(f"{path}.{key}", value, after[key], out)
        for key, value in after.items():
            if key not in before:
                out.append(FieldChange(path=f"{path}.{key}", before=None, after=value))
        return
    if isinstance(before, list) and isinstance(after, list):
        if _diff_lists(path, before, after, out):
            return
    out.append(FieldChange(path=path, before=before, after=after))


def _diff_lists(path: str, before: list[Any], after: list[Any], out: list[FieldChange]) -> bool:
    """Element-wise diff when the list shape allows it; False = report the whole list."""
    before_ids, after_ids = _record_ids(before), _record_ids(after)
    if before_ids is not None and after_ids is not None and (before or after):
        before_by_id = dict(zip(before_ids, before))
        after_by_id = dict(zip(after_ids, after))
        found: list[FieldChange] = []
        for record_id, record in before_by_id.items():
            if record_id not in after_by_id:
                found.append(FieldChange(path=f"{path}[{record_id}]", before=record, after=None))
            else:
                _diff_values(f"{path}[{record_id}]", record, after_by_id[record_id], found)
        for record_id, record in after_by_id.items():
            if record_id not in before_by_id:
                found.append(FieldChange(path=f"{path}[{record_id}]", before=None, after=record))
        if not found:
            return False  # same records in another order: report the list itself
        out.extend(found)
        return True
    if len(before) == len(after) and all(isinstance(x, dict) for x in before + after):
        for index, (old, new) in enumerate(zip(before, after)):
            _diff_values(f"{path}[{index}]", old, new, out)
        return True
    return False
