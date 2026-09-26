"""
In-process server log ring buffer (rev 4, D3/D14): a ``logging.Handler`` on the ``empyrean``
logger tree at INFO+ that redacts each record at emit time (``model.redact`` plus ``hf_`` and
generic 40+ char token patterns) and keeps ``config.SERVER_LOG_RING_LINES`` lines for the
``get_server_log`` tool (capped at ``config.SERVER_LOG_TAIL_MAX_CHARS``).  OWNER: WP2.
"""
# DOCS: only empyrean.* loggers are captured (no uvicorn access lines); installed once by
# AssistantService (idempotent); lines are "<time> <LEVEL> <logger>: <message>" and redacted.

from __future__ import annotations

import logging
import re
import threading
import time
from collections import deque
from typing import Optional

from .. import config, model

_EXTRA_PATTERNS = (
    re.compile(r"\bhf_[A-Za-z0-9]{16,}\b"),
    re.compile(r"(?<![A-Za-z0-9_\-/.])[A-Za-z0-9_\-]{40,}(?![A-Za-z0-9_\-/.])"),
)


def redact_line(text: str, registry: object = None) -> str:
    """``model.redact`` (credential values, sk-/AKIA-/bearer tokens) plus hf_ tokens and long
    opaque tokens.  Paths and ids stay readable (they contain '/' or '.' or are shorter)."""
    out = model.redact(text, registry) or ""  # type: ignore[arg-type]
    for pattern in _EXTRA_PATTERNS:
        out = pattern.sub("[REDACTED]", out)
    return out


class RingBufferHandler(logging.Handler):
    """Thread-safe bounded buffer of formatted, redacted log lines."""

    def __init__(self, capacity: int, registry: object = None) -> None:
        super().__init__(level=logging.INFO)
        self.capacity = max(1, int(capacity))
        self.registry = registry
        self._lines: deque[str] = deque(maxlen=self.capacity)
        self._guard = threading.Lock()
        self.dropped = 0

    def emit(self, record: logging.LogRecord) -> None:
        try:
            message = record.getMessage()
            if record.exc_info and record.exc_info[1] is not None:
                message += f" [{type(record.exc_info[1]).__name__}: {record.exc_info[1]}]"
            stamp = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created))
            line = f"{stamp} {record.levelname} {record.name}: {redact_line(message.replace(chr(10), ' | '), self.registry)}"
            with self._guard:
                if len(self._lines) == self.capacity:
                    self.dropped += 1
                self._lines.append(line)
        except Exception:  # noqa: BLE001 - a logging handler must never raise
            pass

    def tail(self, lines: int = 200, grep: Optional[str] = None, *, max_chars: Optional[int] = None) -> list[str]:
        """The last ``lines`` lines (optionally only those matching ``grep``, a case-insensitive
        regex or plain substring), trimmed from the front to ``max_chars`` characters in total."""
        limit = max(1, min(int(lines), self.capacity))
        cap = config.SERVER_LOG_TAIL_MAX_CHARS if max_chars is None else max(0, int(max_chars))
        with self._guard:
            snapshot = list(self._lines)
        if grep:
            try:
                pattern = re.compile(grep, re.IGNORECASE)
                snapshot = [ln for ln in snapshot if pattern.search(ln)]
            except re.error:
                needle = grep.lower()
                snapshot = [ln for ln in snapshot if needle in ln.lower()]
        selected = snapshot[-limit:]
        total = sum(len(ln) + 1 for ln in selected)
        while selected and total > cap:
            total -= len(selected[0]) + 1
            selected.pop(0)
        return selected

    def clear(self) -> None:
        with self._guard:
            self._lines.clear()
            self.dropped = 0

    def __len__(self) -> int:
        with self._guard:
            return len(self._lines)


def install(registry: object = None, *, logger_name: str = "empyrean") -> RingBufferHandler:
    """Attach one handler to the ``empyrean`` logger (idempotent: an existing handler is
    returned) and make sure INFO records reach it (the logger level is lowered to INFO only
    when it is above INFO or unset)."""
    logger = logging.getLogger(logger_name)
    for handler in logger.handlers:
        if isinstance(handler, RingBufferHandler):
            if registry is not None and handler.registry is None:
                handler.registry = registry
            return handler
    handler = RingBufferHandler(config.SERVER_LOG_RING_LINES, registry)
    logger.addHandler(handler)
    if logger.level == logging.NOTSET or logger.level > logging.INFO:
        logger.setLevel(logging.INFO)
    return handler


__all__ = ["RingBufferHandler", "install", "redact_line"]
