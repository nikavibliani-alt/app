"""Date helpers for assignment overlap (Tbilisi calendar dates as YYYY-MM-DD strings)."""
from __future__ import annotations


def dates_overlap(a_in: str, a_out: str, b_in: str, b_out: str) -> bool:
    """Half-open stay windows [checkin, checkout). Same-day turnovers do not overlap."""
    if not all([a_in, a_out, b_in, b_out]):
        return False
    return a_in < b_out and b_in < a_out
