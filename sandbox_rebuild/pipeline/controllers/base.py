"""Base controller helpers."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ..config import PipelineConfig
from ..logging_kit import Logger
from ..store import MemoryStore


@dataclass
class ControllerResult:
    ok: bool
    code: str
    message: str
    data: dict[str, Any] | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "code": self.code,
            "message": self.message,
            "data": self.data or {},
        }


class BaseController:
    name = "Base"

    def __init__(self, store: MemoryStore, cfg: PipelineConfig, logger: Logger):
        self.store = store
        self.cfg = cfg
        self.log = logger
