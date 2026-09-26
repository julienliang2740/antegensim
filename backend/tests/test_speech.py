"""
Tests for "Dictate" (rev 4, amended D9): ``assistant/speech.py`` (SpeechService: bounded
queue, capability state, preload thread, initial_prompt builder) and
``assistant/routes_speech.py`` (POST /api/assistant/transcribe: raw body with a hard cap,
content-type and language checks, 503 while not ready, 409 when the queue is full).

Every route test monkeypatches ``model.whisper_status`` / ``model.transcribe`` (no model is
loaded, nothing is downloaded).  The single ``whisper``-marked test transcribes a real clip
through the route and is skipped unless faster-whisper, the cached ``config.WHISPER_MODEL``
weights (``model.whisper_model_cached``), a working ``model.transcribe`` and a sample clip are
all present (``EMPYREAN_WHISPER_TEST_AUDIO`` or ``backend/tests/data/jfk.flac``, shared with
test_model's whisper test).
"""

from __future__ import annotations

import io
import os
import threading
from pathlib import Path
from typing import Any, Iterator, Optional

import pytest
from fastapi.testclient import TestClient

from empyrean import config, model, schemas
from empyrean.api import create_app
from empyrean.assistant import AssistantService
from empyrean.assistant import speech as speech_mod
from empyrean.assistant.speech import SpeechService, compose_initial_prompt, parse_glossary_terms
from empyrean.schemas import TranscriptionResult, WhisperStatus

URL = "/api/assistant/transcribe"
_REAL_PRELOAD = model.preload_whisper
WEBM = {"Content-Type": "audio/webm;codecs=opus"}


def _status(state: str, reason: Optional[str] = None) -> WhisperStatus:
    return WhisperStatus(status=state, model="large-v3-turbo", reason=reason)  # type: ignore[arg-type]


class FakeWhisper:
    """Stands in for model.transcribe: records calls, optionally blocks until released."""

    def __init__(self, text: str = "play three rounds", *, status: str = "ok", error: Optional[str] = None) -> None:
        self.calls: list[dict[str, Any]] = []
        self.text = text
        self.status = status
        self.error = error
        self.gate: Optional[threading.Event] = None
        self.entered = threading.Event()

    def __call__(self, audio: bytes, *, language: Optional[str] = None, initial_prompt: Optional[str] = None) -> TranscriptionResult:
        self.calls.append({"audio": audio, "language": language, "initial_prompt": initial_prompt})
        self.entered.set()
        if self.gate is not None:
            assert self.gate.wait(10), "test gate never released"
        return TranscriptionResult(
            status=self.status,  # type: ignore[arg-type]
            text=self.text if self.status == "ok" else "",
            language=language,
            duration_s=2.5,
            model="large-v3-turbo",
            error=self.error,
        )


@pytest.fixture(autouse=True)
def _never_live(monkeypatch: pytest.MonkeyPatch) -> None:
    """No live CLI call and no real Whisper load from any test here (the whisper-marked test
    undoes the preload guard for itself)."""

    def forbidden_attempt(self, ref, request, attempt_no, **kwargs):  # noqa: ANN001
        raise AssertionError("live adapter reached from a speech test")

    def forbidden_preload() -> None:
        raise AssertionError("model.preload_whisper called from a speech test")

    monkeypatch.setattr(model.ClaudeCliAdapter, "attempt", forbidden_attempt)
    monkeypatch.setattr(model, "preload_whisper", forbidden_preload)


@pytest.fixture()
def fake_whisper(monkeypatch: pytest.MonkeyPatch) -> FakeWhisper:
    fake = FakeWhisper()
    monkeypatch.setattr(model, "transcribe", fake)
    monkeypatch.setattr(model, "whisper_status", lambda: _status("ready"))
    return fake


@pytest.fixture()
def speech_client(manager, worlds_dir) -> Iterator[tuple[TestClient, AssistantService]]:
    service = AssistantService(manager, worlds_dir=worlds_dir)
    app = create_app(manager, service)
    with TestClient(app) as c:
        yield c, service


def _post(client: TestClient, body: bytes = b"\x1a\x45\xdf\xa3fake-webm", headers: Optional[dict[str, str]] = None, **params: str):
    return client.post(URL, content=body, headers=headers if headers is not None else WEBM, params=params)


# ---------------------------------------------------------------------------
# Route behaviour
# ---------------------------------------------------------------------------


def test_transcribe_ok_returns_result_and_builds_prompt_from_run(speech_client, fake_whisper: FakeWhisper) -> None:
    client, service = speech_client
    request = config.default_run_request("fake-heuristic").model_dump(mode="json")
    request["name"] = "Dictate Arena"
    created = client.post("/api/runs", json=request)
    assert created.status_code == 201, created.text
    run_id = created.json()["run_id"]

    r = _post(client, run_id=run_id)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "ok" and body["text"] == "play three rounds"
    assert body["model"] == "large-v3-turbo" and body["error"] is None
    TranscriptionResult.model_validate(body)

    assert len(fake_whisper.calls) == 1
    call = fake_whisper.calls[0]
    assert call["audio"] == b"\x1a\x45\xdf\xa3fake-webm"
    assert call["language"] == "en"  # default
    prompt = call["initial_prompt"]
    assert prompt.startswith("Empyrean simulation.")
    assert "Run: Dictate Arena." in prompt
    for card in request["agents"]:
        assert card["name"] in prompt
    assert prompt.rstrip().endswith(request["agents"][-1]["name"] + ".")  # names last (Whisper keeps the tail)
    assert "Step round" in prompt and "God mode" in prompt
    assert isinstance(service.speech, SpeechService)
    assert service.speech.inflight == 0


def test_transcribe_language_auto_explicit_prompt_and_other_types(speech_client, fake_whisper: FakeWhisper) -> None:
    client, _ = speech_client
    assert _post(client, language="auto", initial_prompt="Ada and Bram").status_code == 200
    assert fake_whisper.calls[-1]["language"] is None
    assert fake_whisper.calls[-1]["initial_prompt"] == "Ada and Bram"
    for ctype in ("audio/ogg;codecs=opus", "audio/wav", "audio/mp4", "AUDIO/WEBM"):
        assert _post(client, headers={"Content-Type": ctype}, language="DE").status_code == 200, ctype
        assert fake_whisper.calls[-1]["language"] == "de"
    # unknown run: no names, still transcribes
    assert _post(client, run_id="run_does_not_exist").status_code == 200
    assert "Agents:" not in fake_whisper.calls[-1]["initial_prompt"]


def test_transcribe_rejects_bad_requests_with_validation_error(speech_client, fake_whisper: FakeWhisper) -> None:
    client, _ = speech_client
    r = _post(client, headers={"Content-Type": "application/json"})
    assert r.status_code == 422 and r.json()["error"] == "validation_error"
    assert r.json()["problems"][0]["path"] == "content-type"
    r = _post(client, headers={})
    assert r.status_code == 422 and r.json()["error"] == "validation_error"
    r = _post(client, body=b"")
    assert r.status_code == 422 and r.json()["problems"][0]["path"] == "body"
    r = _post(client, language="english!")
    assert r.status_code == 422 and r.json()["problems"][0]["path"] == "language"
    assert fake_whisper.calls == []


@pytest.mark.parametrize(
    ("state", "reason"),
    [("loading", None), ("unavailable", "faster_whisper is not installed"), ("disabled", "speech recognition is switched off")],
)
def test_transcribe_503_while_speech_not_ready(speech_client, monkeypatch: pytest.MonkeyPatch, state: str, reason: Optional[str]) -> None:
    client, _ = speech_client
    if state == "disabled":
        monkeypatch.setattr(config, "WHISPER_MODEL", "off")
    fake = FakeWhisper()
    monkeypatch.setattr(model, "transcribe", fake)
    monkeypatch.setattr(model, "whisper_status", lambda: _status(state, reason))
    r = _post(client)
    assert r.status_code == 503
    body = r.json()
    assert body["error"] == "assistant_unavailable"
    assert state in body["detail"]
    if reason:
        assert reason in body["detail"]
    assert fake.calls == []  # never queued


def test_not_loaded_with_preload_off_reads_ready_and_loads_lazily(speech_client, monkeypatch: pytest.MonkeyPatch) -> None:
    """model.whisper_status 'disabled' only because nothing loaded it yet (preload off): the
    capability says ready (first clip slower) and the route lets model.transcribe load it."""
    client, _ = speech_client
    fake = FakeWhisper()
    monkeypatch.setattr(model, "transcribe", fake)
    monkeypatch.setattr(model, "whisper_status", lambda: _status("disabled", "the whisper model is not loaded (preload off)"))
    speech = client.get("/api/assistant/capabilities").json()["speech"]
    assert speech["status"] == "ready" and speech["reason"] == speech_mod.LAZY_LOAD_REASON
    assert _post(client).status_code == 200 and len(fake.calls) == 1
    monkeypatch.setattr(config, "WHISPER_MODEL", "off")
    assert client.get("/api/assistant/capabilities").json()["speech"]["status"] == "disabled"
    assert _post(client).status_code == 503 and len(fake.calls) == 1


def test_transcribe_503_when_model_reports_unavailable(speech_client, monkeypatch: pytest.MonkeyPatch) -> None:
    client, _ = speech_client
    fake = FakeWhisper(status="unavailable", error="model not loaded")
    monkeypatch.setattr(model, "transcribe", fake)
    monkeypatch.setattr(model, "whisper_status", lambda: _status("ready"))
    r = _post(client)
    assert r.status_code == 503 and r.json()["error"] == "assistant_unavailable"
    assert "model not loaded" in r.json()["detail"]


def test_transcribe_error_result_is_200_and_redacted(speech_client, monkeypatch: pytest.MonkeyPatch) -> None:
    client, _ = speech_client
    secret = "sk-ant-api03-" + "x" * 40
    fake = FakeWhisper(status="error", error=f"could not decode audio (token {secret})")
    monkeypatch.setattr(model, "transcribe", fake)
    monkeypatch.setattr(model, "whisper_status", lambda: _status("ready"))
    r = _post(client)
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "error" and body["text"] == ""
    assert "could not decode audio" in body["error"] and secret not in body["error"]


def test_transcribe_413_when_declared_length_exceeds_cap(speech_client, fake_whisper: FakeWhisper, monkeypatch: pytest.MonkeyPatch) -> None:
    client, _ = speech_client
    monkeypatch.setattr(config, "WHISPER_MAX_AUDIO_BYTES", 100)
    r = _post(client, body=b"x" * 101)
    assert r.status_code == 413
    assert r.json()["error"] == "payload_too_large"
    assert "100 bytes" in r.json()["detail"]
    assert _post(client, body=b"x" * 100).status_code == 200  # exactly at the cap is fine
    assert len(fake_whisper.calls) == 1


def test_transcribe_413_when_chunked_stream_exceeds_cap(speech_client, fake_whisper: FakeWhisper, monkeypatch: pytest.MonkeyPatch) -> None:
    client, _ = speech_client
    monkeypatch.setattr(config, "WHISPER_MAX_AUDIO_BYTES", 100)

    def chunks() -> Iterator[bytes]:  # no Content-Length: transfer-encoding chunked
        for _ in range(4):
            yield b"y" * 40

    r = client.post(URL, content=chunks(), headers=WEBM)
    assert r.status_code == 413 and r.json()["error"] == "payload_too_large"
    assert fake_whisper.calls == []


def test_transcribe_409_when_speech_queue_full(speech_client, fake_whisper: FakeWhisper) -> None:
    client, service = speech_client
    speech = service.speech
    assert isinstance(speech, SpeechService)
    speech.queue_max = 1
    fake_whisper.gate = threading.Event()
    held = speech.submit(b"first", language="en")  # occupies the only slot on the speech executor
    try:
        assert fake_whisper.entered.wait(5)
        assert speech.inflight == 1
        r = _post(client)
        assert r.status_code == 409
        assert r.json()["error"] == "assistant_busy"
    finally:
        fake_whisper.gate.set()
    assert held.result(5).status == "ok"
    fake_whisper.gate = None
    # the slot is released once the first job finishes
    for _ in range(50):
        if speech.inflight == 0:
            break
        threading.Event().wait(0.02)
    assert speech.inflight == 0
    assert _post(client).status_code == 200


def test_transcribe_after_shutdown_is_unavailable(manager, worlds_dir, fake_whisper: FakeWhisper) -> None:
    service = AssistantService(manager, worlds_dir=worlds_dir)
    app = create_app(manager, service)
    with TestClient(app) as client:
        service.shutdown()
        r = _post(client)
        assert r.status_code == 503 and r.json()["error"] == "assistant_unavailable"
    assert fake_whisper.calls == []
    assert service.speech.inflight == 0


def test_every_speech_error_code_is_an_api_error_code(speech_client, monkeypatch: pytest.MonkeyPatch) -> None:
    client, service = speech_client
    codes = set(schemas.ApiErrorCode.__args__)  # type: ignore[attr-defined]
    seen = set()
    monkeypatch.setattr(model, "whisper_status", lambda: _status("loading"))
    seen.add(_post(client).json()["error"])
    monkeypatch.setattr(model, "whisper_status", lambda: _status("ready"))
    monkeypatch.setattr(config, "WHISPER_MAX_AUDIO_BYTES", 3)
    seen.add(_post(client).json()["error"])
    seen.add(_post(client, headers={"Content-Type": "text/plain"}).json()["error"])
    assert seen == {"assistant_unavailable", "payload_too_large", "validation_error"}
    assert seen <= codes and "assistant_busy" in codes


def test_unavailable_router_without_assistant(client: TestClient) -> None:
    r = client.post(URL, content=b"abc", headers=WEBM)
    assert r.status_code == 503 and r.json()["error"] == "assistant_unavailable"


# ---------------------------------------------------------------------------
# Capability state and preload thread
# ---------------------------------------------------------------------------


def test_capabilities_report_speech_state(speech_client, monkeypatch: pytest.MonkeyPatch) -> None:
    client, _ = speech_client
    monkeypatch.setattr(model, "whisper_status", lambda: _status("ready"))
    speech = client.get("/api/assistant/capabilities").json()["speech"]
    assert speech["status"] == "ready" and speech["model"] == "large-v3-turbo"
    assert speech["max_seconds"] == 60 and speech["max_bytes"] == config.WHISPER_MAX_AUDIO_BYTES
    assert speech["language_default"] == "en"

    monkeypatch.setattr(model, "whisper_status", lambda: _status("unavailable", "not loaded yet"))
    speech = client.get("/api/assistant/capabilities").json()["speech"]
    assert speech["status"] == "unavailable" and speech["reason"] == "not loaded yet"


def test_capability_reads_loading_while_a_preload_thread_runs(manager, worlds_dir, monkeypatch: pytest.MonkeyPatch) -> None:
    service = AssistantService(manager, worlds_dir=worlds_dir)
    try:
        speech = SpeechService(service)
        release = threading.Event()
        loaded = threading.Event()
        calls: list[int] = []

        def fake_preload() -> None:
            calls.append(1)
            release.wait(5)
            loaded.set()

        monkeypatch.setattr(model, "preload_whisper", fake_preload)
        monkeypatch.setattr(model, "whisper_status", lambda: _status("ready") if loaded.is_set() else _status("unavailable", "not loaded"))
        thread = speech.start_preload_thread()
        assert thread.daemon and thread.name == speech_mod.PRELOAD_THREAD_NAME
        assert speech.start_preload_thread() is thread  # idempotent while alive
        cap = speech.capability()
        assert cap.status == "loading" and cap.reason == "the speech model is loading"
        # a thread started by main (same name) counts too
        assert SpeechService(service).capability().status == "loading"
        release.set()
        thread.join(5)
        assert calls == [1]
        assert speech.capability().status == "ready"
    finally:
        service.shutdown()


def test_disabled_not_loaded_reads_loading_during_preload_but_off_stays_disabled(manager, worlds_dir, monkeypatch: pytest.MonkeyPatch) -> None:
    """WP1: whisper_status is 'disabled' both when switched off and when nothing loaded the model
    yet; only the latter becomes 'loading' while a preload thread runs."""
    service = AssistantService(manager, worlds_dir=worlds_dir)
    try:
        speech = SpeechService(service)
        release = threading.Event()
        monkeypatch.setattr(model, "preload_whisper", lambda: release.wait(5))
        monkeypatch.setattr(model, "whisper_status", lambda: _status("disabled", "the whisper model is not loaded (preload off)"))
        thread = speech.start_preload_thread()
        try:
            assert speech.capability().status == "loading"
            monkeypatch.setattr(config, "WHISPER_MODEL", "off")
            assert speech.capability().status == "disabled"
        finally:
            release.set()
            thread.join(5)
    finally:
        service.shutdown()


def test_preload_failure_is_logged_not_raised(manager, worlds_dir, monkeypatch: pytest.MonkeyPatch) -> None:
    service = AssistantService(manager, worlds_dir=worlds_dir)
    try:
        def broken() -> None:
            raise RuntimeError("boom")

        monkeypatch.setattr(model, "preload_whisper", broken)
        thread = SpeechService(service).start_preload_thread()
        thread.join(5)
        assert not thread.is_alive()
    finally:
        service.shutdown()


def test_create_app_does_not_start_a_preload(speech_client) -> None:
    _, service = speech_client
    assert not service.speech.preload_running()


# ---------------------------------------------------------------------------
# initial_prompt builder
# ---------------------------------------------------------------------------


def test_parse_glossary_terms_reads_bold_headings_and_tables() -> None:
    text = "\n".join(
        [
            "# Glossary",
            "",
            "**Round**: every living agent acts once.",
            "- **Turn** - one agent's action.",
            "1. **`residue`** what is left",
            "### Decision packet",
            "* **Health / max health**: hit points.",
            "",
            "| Term | Meaning |",
            "|------|---------|",
            "| `fruit` | food |",
            "| round | duplicate, dropped |",
            "",
            "Plain text with **bold** in the middle is ignored.",
            "**" + "x" * 50 + "**",
        ]
    )
    assert parse_glossary_terms(text) == ("Round", "Turn", "residue", "Decision packet", "Health", "max health", "fruit")


def test_glossary_terms_fall_back_to_builtin(tmp_path: Path) -> None:
    assert speech_mod.glossary_terms(tmp_path / "missing.md") == speech_mod.BUILTIN_GLOSSARY_TERMS
    empty = tmp_path / "GLOSSARY.md"
    empty.write_text("# Glossary\n\nnothing here\n", encoding="utf-8")
    assert speech_mod.glossary_terms(empty) == speech_mod.BUILTIN_GLOSSARY_TERMS
    empty.write_text("**Starvation**: energy ran out\n", encoding="utf-8")
    os.utime(empty, (1_000_000, 1_000_000))
    assert speech_mod.glossary_terms(empty) == ("Starvation",)


def test_compose_initial_prompt_keeps_names_and_trims_glossary_first() -> None:
    names = [f"Agent{i:02d}" for i in range(12)]
    glossary = [f"term{i}" for i in range(200)]
    prompt = compose_initial_prompt(run_name="Arena", agent_names=names, glossary=glossary, max_chars=700)
    assert len(prompt) <= 700
    assert prompt.endswith("Agents: " + ", ".join(names) + ".")
    assert "Run: Arena." in prompt and "term0" in prompt and "term199" not in prompt
    assert "Controls: Run turn" in prompt
    # no run: glossary + controls only
    bare = compose_initial_prompt(run_name=None, agent_names=[], glossary=("plant",))
    assert bare == "Empyrean simulation. Terms: plant. Controls: " + ", ".join(speech_mod.CONTROL_LABELS) + "."
    # absurdly small cap: cut from the front, names survive
    tiny = compose_initial_prompt(run_name=None, agent_names=["Ada", "Bram"], glossary=("plant",), max_chars=20)
    assert len(tiny) <= 20 and tiny.endswith("Agents: Ada, Bram.")


def test_run_names_unknown_run_is_empty(worlds_dir) -> None:
    assert speech_mod.run_names("run_nope") == (None, [])


# ---------------------------------------------------------------------------
# Real transcription (whisper-marked; skipped unless everything is present locally)
# ---------------------------------------------------------------------------


def _sample_clip() -> Optional[Path]:
    """Same sample as test_model's whisper test (EMPYREAN_WHISPER_TEST_AUDIO or tests/data/jfk.flac),
    plus this session's scratchpad copy while the lead decides whether to commit the fixture."""
    candidates = [
        os.environ.get("EMPYREAN_WHISPER_TEST_AUDIO"),
        str(Path(__file__).resolve().parent / "data" / "jfk.flac"),
        "/tmp/claude-1000/-home-ubuntu-antegensim/da98fe04-2eb4-430b-9718-4f30d7d422bd/scratchpad/jfk.flac",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return Path(candidate)
    return None


def _whisper_weights_cached() -> bool:
    cached = getattr(model, "whisper_model_cached", None)  # model-boundary helper (never downloads)
    return bool(cached()) if callable(cached) else False


def _to_wav(path: Path) -> bytes:
    import av  # test-side transcode so the clip goes through the route as audio/wav

    out = io.BytesIO()
    with av.open(str(path)) as src, av.open(out, "w", format="wav") as dst:
        stream = dst.add_stream("pcm_s16le", rate=16000)
        stream.layout = "mono"
        resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
        for frame in src.decode(audio=0):
            for rframe in resampler.resample(frame):
                for packet in stream.encode(rframe):
                    dst.mux(packet)
        for rframe in resampler.resample(None):
            for packet in stream.encode(rframe):
                dst.mux(packet)
        for packet in stream.encode(None):
            dst.mux(packet)
    return out.getvalue()


@pytest.mark.whisper
def test_real_whisper_transcribes_jfk_clip(speech_client, monkeypatch: pytest.MonkeyPatch) -> None:
    clip = _sample_clip()
    if clip is None:
        pytest.skip("no sample clip (set EMPYREAN_WHISPER_TEST_AUDIO or add backend/tests/data/jfk.flac)")
    if not _whisper_weights_cached():
        pytest.skip(f"faster-whisper or the cached {config.WHISPER_MODEL} weights are missing (never downloaded in tests)")
    monkeypatch.setattr(model, "preload_whisper", _REAL_PRELOAD)  # lift the autouse guard for this test only
    monkeypatch.setenv("HF_HUB_OFFLINE", "1")
    model.preload_whisper()
    if model.whisper_status().status != "ready":
        pytest.skip(f"model.transcribe is not available in this build: {model.whisper_status().reason}")
    client, _ = speech_client
    r = client.post(URL, content=_to_wav(clip), headers={"Content-Type": "audio/wav"}, params={"language": "en"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "ok", body
    text = body["text"].lower()
    assert "ask not what your country can do for you" in text
    assert body["duration_s"] is None or 10 <= body["duration_s"] <= 12
