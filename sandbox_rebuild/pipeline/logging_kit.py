"""System logs + alerts — every controller writes here. No silent failures."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .config import PipelineConfig
from .store import MemoryStore


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class Logger:
    def __init__(self, store: MemoryStore, cfg: PipelineConfig):
        self.store = store
        self.cfg = cfg

    def write(
        self,
        *,
        controller: str,
        action: str,
        status: str,
        message: str,
        input_data: dict[str, Any] | None = None,
        output_data: dict[str, Any] | None = None,
        correlation_id: str | None = None,
        alert: bool = False,
        severity: str = "error",
    ) -> str:
        payload = {
            "controller": controller,
            "action": action,
            "status": status,  # ok | warn | error
            "message": message,
            "input": input_data or {},
            "output": output_data or {},
            "timestamp": _now_iso(),
            "correlationId": correlation_id,
        }
        log_id = self.store.add(self.cfg.system_logs, payload)
        if alert or status == "error":
            self.store.add(
                self.cfg.system_alerts,
                {
                    **payload,
                    "logId": log_id,
                    "acked": False,
                    "severity": severity if status != "ok" else "info",
                },
            )
        return log_id
