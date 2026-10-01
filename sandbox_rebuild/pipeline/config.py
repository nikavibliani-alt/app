"""Sandbox pipeline config.

SAFE BY DEFAULT:
  dry_run=True  → MemoryStore only, never touches Firebase.
  dry_run=False → still only v2_* collections (never live reservations/checkin_guests).

Live HTML (checkin-admin.html, checkin-guest-v2.html) is never imported or edited here.
"""
from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class PipelineConfig:
    dry_run: bool = True
    collection_prefix: str = "v2_"
    actor_default: str = "sandbox"

    @property
    def assignments(self) -> str:
        return f"{self.collection_prefix}assignments"

    @property
    def guests(self) -> str:
        return f"{self.collection_prefix}guests"

    @property
    def reservations(self) -> str:
        return f"{self.collection_prefix}reservations"

    @property
    def room_moves(self) -> str:
        return f"{self.collection_prefix}room_moves"

    @property
    def system_logs(self) -> str:
        return f"{self.collection_prefix}system_logs"

    @property
    def system_alerts(self) -> str:
        return f"{self.collection_prefix}system_alerts"


def load_config() -> PipelineConfig:
    dry = os.environ.get("PIPELINE_DRY_RUN", "1").strip() not in ("0", "false", "False")
    prefix = os.environ.get("PIPELINE_PREFIX", "v2_").strip() or "v2_"
    return PipelineConfig(dry_run=dry, collection_prefix=prefix)
