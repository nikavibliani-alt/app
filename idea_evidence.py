"""
Evidence that is saved with every new idea (pricing_proposals/<id>.evidence), at the moment the idea is made.

It is plain facts, worked out here from the saved data, never taken from the idea maker's words:
  - the dates the idea is about: the next stretch of the season (its real first and last day, and the
    nights from today on that were looked at),
  - which of those nights were booked and which were not, on that day (real dates, from the prices the
    new engine saved at its last run),
  - last year's same stretch (dates, nights booked in the end, nights already booked by the same day last
    year) from the stored stays, when there are any.
Nothing here changes how a price is calculated.
"""

from __future__ import annotations

import re
from datetime import date, datetime, timedelta

EVIDENCE_VERSION = 1
USES_LAST_YEAR = re.compile(r"last year|year ago|previous year|same time", re.I)


def _overrides(config: dict) -> list:
    ov = config.get("dateOverrides") or config.get("date_overrides") or []
    if isinstance(ov, dict):
        ov = list(ov.values())
    return [o for o in ov if isinstance(o, dict)]


def season_of(iso: str, config: dict) -> str:
    """Same rule as the engines: the holiday ranges first, then the fixed seasons, else mid."""
    md = iso[5:]
    for o in _overrides(config):
        frm, to, s = o.get("from", ""), o.get("to", ""), o.get("season")
        if not (frm and to and s):
            continue
        if (frm <= md <= to) if frm <= to else (md >= frm or md <= to):
            return s
    for season in config.get("seasons", []):
        for start, end in season.get("ranges", []):
            if start <= md <= end:
                return season["name"]
    return "mid"


def _add(iso: str, n: int) -> str:
    return (date.fromisoformat(iso) + timedelta(days=n)).isoformat()


def shift_year(iso: str, years: int = -1) -> str:
    d = date.fromisoformat(iso)
    try:
        return d.replace(year=d.year + years).isoformat()
    except ValueError:                                   # 29 Feb
        return d.replace(year=d.year + years, day=28).isoformat()


def stretches(season: str, config: dict, today: str, back: int = 400, ahead: int = 500) -> list:
    """The runs of days that belong to a season and end today or later. The one running now starts on its real first day."""
    runs, cur = [], None
    for k in range(-back, ahead + 1):
        iso = _add(today, k)
        if season_of(iso, config) == season:
            if cur is None:
                cur = {"from": iso, "to": iso}
            else:
                cur["to"] = iso
        elif cur:
            runs.append(cur)
            cur = None
    if cur:
        runs.append(cur)
    out = []
    for r in runs:
        if r["to"] >= today and r["from"] <= _add(today, 365):          # from today until a year ahead; a run cut off by the search window is never listed
            r["nights"] = (date.fromisoformat(r["to"]) - date.fromisoformat(r["from"])).days + 1
            out.append(r)
    return out


def load_daily(db, prop: str, today: str) -> tuple:
    """The prices the new engine saved at its last run for this room: (day, {"date|CUR": record}) or (None, {})."""
    for back in (0, 1):
        day = _add(today, -back)
        try:
            snap = db.collection("pricing_calm_daily").document(f"{day}_{prop}").get()
        except Exception:
            return None, {}
        if snap.exists:
            return day, (snap.to_dict() or {}).get("dates") or {}
    return None, {}


def load_stays(db, today: str, back_days: int = 460) -> list:
    """Confirmed stays with a booking date (the same rule the pricing engine uses). Empty list if they cannot be read."""
    try:
        import pricing_shadow as ps
        cutoff = _add(today, -back_days)
        out = []
        for doc in db.collection("reservations").where("checkin", ">=", cutoff).stream():
            r = doc.to_dict() or {}
            if str(r.get("status", "")).upper() not in ps.COUNTED_STATUSES:
                continue
            rt = ps.ROOM_CODE_TO_RT.get(r.get("roomCode", ""))
            ci, co = ps._iso_day(r.get("checkin")), ps._iso_day(r.get("checkout"))
            if not (rt and ci and co):
                continue
            out.append({"rt": rt, "checkin": ci, "checkout": co, "created": ps._iso_day(r.get("creationDate"))})
        return out
    except Exception:
        return []


def _units(prop: str) -> int:
    try:
        import pricing_shadow as ps
        return int(ps.ROOM_TYPES[prop]["units"])
    except Exception:
        return 1


def last_year(stays: list, prop: str, st: dict, today: str) -> dict:
    """The same stretch one year earlier: nights booked in the end and nights already booked by the same day."""
    a, b, asof = shift_year(st["from"]), shift_year(st["to"]), shift_year(today)
    nights = (date.fromisoformat(b) - date.fromisoformat(a)).days + 1
    mine = [s for s in stays if s["rt"] == prop]
    near = [s for s in mine if s["checkout"] > a and s["checkin"] <= b]
    if not near:
        return {"available": False, "from": a, "to": b,
                "why": "No stays from that time are stored for this room."}
    booked = by_asof = 0
    for s in near:
        lo, hi = max(s["checkin"], a), min(_add(s["checkout"], -1), b)
        if lo > hi:
            continue
        n = (date.fromisoformat(hi) - date.fromisoformat(lo)).days + 1
        booked += n
        if s["created"] and s["created"] <= asof:
            by_asof += n
    return {"available": True, "from": a, "to": b, "as_of": asof, "nights": nights, "units": _units(prop),
            "room_nights": nights * _units(prop), "booked_nights": booked, "booked_by_that_day": by_asof}


def collect(db, config: dict, today: str, prop: str, season: str, ptype: str, reasoning: str, stays: list | None = None) -> dict:
    """The evidence for one idea. Never raises: a part that cannot be found is left out and says why."""
    ev = {"version": EVIDENCE_VERSION, "made_on": today, "uses_last_year": bool(USES_LAST_YEAR.search(reasoning or ""))}
    runs = stretches(season, config, today)
    if not runs:
        ev["dates_missing"] = "The dates of this season could not be found in the settings."
        return ev
    st = runs[0]
    ev["stretch"] = {"from": st["from"], "to": st["to"], "nights": st["nights"]}
    ev["later"] = [{"from": r["from"], "to": r["to"]} for r in runs[1:3]]
    start = max(st["from"], today)
    nights = [_add(start, k) for k in range((date.fromisoformat(st["to"]) - date.fromisoformat(start)).days + 1)]
    ev["looked_at"] = {"from": start, "to": st["to"], "nights": len(nights)}
    day, dates = load_daily(db, prop, today)
    cur = "USD" if str(ptype).lower().endswith("eur") else "GEL"
    other = "GEL" if cur == "USD" else "USD"
    booked, empty, no_price = [], [], []
    for iso in nights:
        rc = dates.get(f"{iso}|{cur}") or dates.get(f"{iso}|{other}")
        if not rc:
            no_price.append(iso)
        elif rc.get("avail") == 0:
            booked.append(iso)
        else:
            empty.append(iso)
    ev.update({"booked": booked, "empty": empty, "no_price": no_price, "booked_count": len(booked),
               "known_nights": len(booked) + len(empty), "units": _units(prop),
               "source": f"the prices saved by the new engine on {day}" if day else "no saved prices were found"})
    if stays is None:
        stays = load_stays(db, today)
    ev["last_year"] = last_year(stays, prop, st, today)
    return ev


def last_year_lines(db, config: dict, today: str, props: list, stays: list | None = None) -> str:
    """Text for the idea maker's prompt: only real numbers about last year, so it never invents any."""
    if stays is None:
        stays = load_stays(db, today)
    names = []
    for s in config.get("seasons", []):
        names.append(s["name"])
    for o in _overrides(config):
        if o.get("season") and o["season"] not in names:
            names.append(o["season"])
    lines = []
    for prop in props:
        for season in names:
            runs = stretches(season, config, today)
            if not runs:
                continue
            ly = last_year(stays, prop, runs[0], today)
            if ly["available"]:
                lines.append(f"  {prop} {season} (next stretch {runs[0]['from']} to {runs[0]['to']}): last year {ly['from']} to {ly['to']}: "
                             f"{ly['booked_nights']} of {ly['room_nights']} room-nights booked in the end, {ly['booked_by_that_day']} already booked by {ly['as_of']}")
    if not lines:
        return ""
    return "\nLAST YEAR (real numbers from stored stays; the ONLY last-year numbers you may use):\n" + "\n".join(lines)
