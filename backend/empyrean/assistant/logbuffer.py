"""
In-process server log ring buffer (rev 4, D3/D14): a ``logging.Handler`` on the ``empyrean``
logger tree at INFO+ that redacts each record at emit time (``model.redact`` plus hf_ and
generic 40+ char token patterns) and keeps ``config.SERVER_LOG_RING_LINES`` lines for the
``get_server_log`` tool (capped at ``config.SERVER_LOG_TAIL_MAX_CHARS``).  OWNER: WP2.
"""
# DOCS: only empyrean.* loggers are captured (no uvicorn access lines); installed by main.

from __future__ import annotations

import logging
from typing import Optional


class RingBufferHandler(logging.Handler):
    def __init__(self, capacity: int, registry: object = None) -> None:
        super().__init__(level=logging.INFO)
        raise NotImplementedError("WP2 RingBufferHandler")

    def emit(self, record: logging.LogRecord) -> None:  # pragma: no cover - placeholder
        raise NotImplementedError("WP2 RingBufferHandler.emit")

    def tail(self, lines: int = 200, grep: Optional[str] = None, *, max_chars: Optional[int] = None) -> list[str]:
        raise NotImplementedError("WP2 RingBufferHandler.tail")


def install(registry: object = None, *, logger_name: str = "empyrean") -> RingBufferHandler:
    """Attach one handler to the ``empyrean`` logger (idempotent) and return it."""
    raise NotImplementedError("WP2 logbuffer.install")


__all__ = ["RingBufferHandler", "install"]
