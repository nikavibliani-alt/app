"""
Weekly review, Bot 1: the numbers. Pure code, no AI. Everything the analyst may talk about is in the dict this builds;
Bot 2 reads only this, Bot 3 checks every claim against it.

`build(data, week_from, week_to)` is pure (data = lists already read); `load(db, now)` reads Firestore.
Every record carries property_id. A part with no data says so in `data_notes` instead of showing a made-up zero.
"""

from __future__ import annotations

import re
from datetime import date, datetime, timedelta

PROPERTY_ID = "maxela"
LOG_START = "2026-10-12"        # the day the price-event history log went live
DEEP = 0.02                      # a price within 2% of min / max counts as "at" it


def _days(a: str, b: str):
    x, y = date.fromisoformat(a), date.fromisoformat(b)
    return [(x + timedelta(days=k)).isoformat() for k in range((y - x).days + 1)]


def _avg(xs):
    xs = [x for x in xs if isinstance(x, (int, float))]
    return round(sum(xs) / len(xs)) if xs else None


# What every number means, in plain words. It travels inside the numbers, so the analyst and the checker read the same meaning.
GUIDE = {
    "bookings_made": "Bookings made this week (by booking date).",
    "nights_sold": "Nights in those bookings.",
    "price_raises_written": "How many times a price was raised and written to MiniHotel. One count = one night, in one price list (Booking in lari or Airbnb in dollars), in one run. The same night can be counted many times. It is NOT a number of nights.",
    "price_drops_written": "How many times a price was lowered and written to MiniHotel. One count = one night, in one price list, in one run. The same night can be counted many times. It is NOT a number of nights.",
    "nights_lowered": "How many different nights had at least one price drop this week.",
    "last3_price_drops": "Price drops written on EMPTY nights that were 3 days or less from arrival (not the cancellation drops). One count = one night, in one price list, in one run.",
    "last3_nights_lowered": "How many different nights those last-3-day drops were on.",
    "last3_nights_lowered_then_booked": "Of those nights, how many were BOOKED AFTER the price was lowered. The night was empty when its price was lowered. It does not mean nights that were already sold.",
    "cancelled_tonight_lowered": "After a cancellation, tonight's freed night was lowered to the room's minimum (counts of price changes).",
    "cancelled_tonight_lowered_then_booked": "Of those, how many were booked after the lowering.",
    "cancelled_tomorrow_lowered": "After a cancellation, tomorrow's freed night was lowered halfway to the minimum (counts of price changes).",
    "cancelled_tomorrow_lowered_then_booked": "Of those, how many were booked after the lowering.",
    "held_back_by_protect": "Price changes the engine wanted to make but a Don't change rule held back. One count = one decision for one night in one price list in one run. It does NOT mean nights are closed or blocked.",
    "held_back_by_hold": "Price changes held back by a small-moves-only rule (same kind of count).",
    "held_back_other": "Price changes held back by another rule, for example only the morning run may lower prices, the daily limits, or the holiday rule limits (same kind of count). It does NOT mean nights are closed or blocked.",
    "cancellations": "REAL cancellations: a booking cancelled before its check-in day and not replaced by a changed booking. Changes of a booking and cancellations of stays that were already over are not in this number.",
    "cancellations_changed": "Cancelled records that are really a change of the same booking (a new room or new dates). Not real cancellations.",
    "cancellations_after_stay": "Bookings marked cancelled after their check-in day had already passed. They freed no night to sell. Not real cancellations.",
    "nights_hit_min": "Different nights whose price was written at the minimum.",
    "nights_hit_max": "Different nights whose price was written at the maximum.",
    "holiday_rule_moves": "Price decisions that followed the holiday rule.",
    "stopped_by_safety_check": "Price decisions stopped by a safety check.",
}


def numbers_headline(numbers: dict) -> str:
    """A headline made only from the numbers (no AI): used when the written headline is not confirmed."""
    wk = numbers.get("week") or {}
    rooms = (numbers.get("rooms") or {}).values()
    tot = lambda k: sum(r.get(k) or 0 for r in rooms)      # noqa: E731
    a, b = wk.get("from", ""), wk.get("to", "")
    try:
        span = f"{int(a[8:])}–{int(b[8:])} {MONTHS[int(b[5:7]) - 1]}" if a[:7] == b[:7] else f"{int(a[8:])} {MONTHS[int(a[5:7]) - 1]} – {int(b[8:])} {MONTHS[int(b[5:7]) - 1]}"
    except (ValueError, IndexError):
        span = "This week"
    return (f"{span}: {tot('bookings_made')} booking{'s' if tot('bookings_made') != 1 else ''} made ({tot('nights_sold')} nights), "
            f"{tot('cancellations')} real cancellation{'s' if tot('cancellations') != 1 else ''}, "
            f"{tot('price_drops_written')} price drop{'s' if tot('price_drops_written') != 1 else ''} and {tot('price_raises_written')} price raise{'s' if tot('price_raises_written') != 1 else ''} written.")


MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def week_key(iso: str) -> str:
    y, w, _ = date.fromisoformat(iso).isocalendar()
    return f"{y}-W{w:02d}"


def build(data: dict, week_from: str, week_to: str) -> dict:
    """data: price_events, booking_events, runs, watchdog_days (day -> status), stays, rules {rt: {night: (start, min, max)}} via
    `limits(rt, night)`, scorecard summary, twin results, events, room_ids, since (first day the history log exists)."""
    notes = []
    rooms = {rt: {} for rt in data.get("room_ids", [])}
    nights_of_week = set(_days(week_from, week_to))
    pe = [e for e in data.get("price_events", []) if week_from <= e.get("day", "") <= week_to]
    # The history log loaded every old booking and cancellation at once on its first day (LOG_START): those are not "this week".
    be = [e for e in data.get("booking_events", []) if week_from <= e.get("day", "") <= week_to and e.get("day", "") > data.get("since", LOG_START)]
    stays = data.get("stays", [])
    limits = data.get("limits") or (lambda rt, night: None)

    def sold_after(rt, night, since):
        return any(s["rt"] == rt and s.get("created") and s["created"] >= since and s["checkin"] <= night < s["checkout"] for s in stays)

    for rt in rooms:
        r = rooms[rt]
        mine = [e for e in pe if e.get("rt") == rt]
        wrote = [e for e in mine if e.get("written") and e.get("old") is not None and e.get("new") is not None]
        r["bookings"] = sum(1 for e in be if e.get("rt") == rt and e.get("event") == "booking")
        kinds = [cancel_kind(e, data.get("cancel_class") or {}) for e in be if e.get("rt") == rt and e.get("event") == "cancellation"]
        r["cancellations"] = kinds.count("real")
        r["cancellations_changed"] = kinds.count("changed")
        r["cancellations_after_stay"] = kinds.count("after_stay")
        # bookings made this week, from the stored stays (the booking events only exist since the log began)
        new_stays = [s for s in stays if s["rt"] == rt and s.get("created") and week_from <= s["created"] <= week_to]
        sold_prices, starts, mins, maxs, at_min, at_max, n_nights = [], [], [], [], 0, 0, 0
        for s in new_stays:
            for night in _days(s["checkin"], (date.fromisoformat(s["checkout"]) - timedelta(days=1)).isoformat()):
                n_nights += 1
                lim = limits(rt, night)
                p = s.get("per_night") if s.get("currency") == "GEL" else None
                if p:
                    sold_prices.append(p)
                if lim and p:
                    st, mn, mx = lim
                    starts.append(st); mins.append(mn); maxs.append(mx)
                    at_min += p <= mn * (1 + DEEP)
                    at_max += p >= mx * (1 - DEEP)
        r.update({"bookings_made": len(new_stays), "nights_sold": n_nights, "avg_sold_price_gel": _avg(sold_prices),
                  "avg_start_gel": _avg(starts), "avg_min_gel": _avg(mins), "avg_max_gel": _avg(maxs),
                  "sold_at_or_near_min": at_min, "sold_at_or_near_max": at_max})
        r["price_raises_written"] = sum(1 for e in wrote if e["new"] > e["old"])
        r["price_drops_written"] = sum(1 for e in wrote if e["new"] < e["old"])
        r["nights_lowered"] = len({e["date"] for e in wrote if e["new"] < e["old"]})
        r["nights_hit_min"] = len({e["date"] for e in wrote if e.get("min") is not None and e["new"] <= e["min"] + 1e-9})
        r["nights_hit_max"] = len({e["date"] for e in wrote if e.get("max") is not None and e["new"] >= e["max"] - 1e-9})
        l3 = [e for e in wrote if e.get("kind") != "tonight" and e.get("days_out") is not None and e["days_out"] <= 3 and e["new"] < e["old"]]
        r["last3_price_drops"] = len(l3)
        r["last3_nights_lowered"] = len({e["date"] for e in l3})
        r["last3_nights_lowered_then_booked"] = len({e["date"] for e in l3 if sold_after(rt, e["date"], e["day"])})
        for name, dout in (("tonight", 0), ("tomorrow", 1)):
            cd = [e for e in wrote if e.get("kind") == "tonight" and e.get("days_out") == dout]
            r[f"cancelled_{name}_lowered"] = len(cd)
            r[f"cancelled_{name}_lowered_then_booked"] = sum(1 for e in cd if sold_after(rt, e["date"], e["day"]))
        r["holiday_rule_moves"] = sum(1 for e in mine if e.get("hol") and e.get("written"))
        held = [e for e in mine if e.get("blocked")]                       # one count per decision, not per message
        text = lambda e: " ".join(str(b).lower() for b in (e.get("blocked") or []))     # noqa: E731
        r["held_back_by_protect"] = sum(1 for e in held if "protect" in text(e))
        r["held_back_by_hold"] = sum(1 for e in held if "protect" not in text(e) and "hold" in text(e))
        r["held_back_other"] = len(held) - r["held_back_by_protect"] - r["held_back_by_hold"]
        r["stopped_by_safety_check"] = sum(1 for e in mine if e.get("kind") == "stopped")

    runs = [x for x in data.get("runs", []) if week_from <= x.get("day", "") <= week_to]
    fails = {}
    for x in runs:
        for p in x.get("failed_portals") or []:
            fails[p] = fails.get(p, 0) + 1
    wd = {d: s for d, s in (data.get("watchdog_days") or {}).items() if week_from <= d <= week_to}
    all_ = {"runs": len(runs), "urgent_runs": sum(1 for x in runs if x.get("urgent")), "channel_push_failures": fails,
            "runs_with_stopped_rooms": sum(1 for x in runs if x.get("stopped_room_types")),
            "watchdog_days_recorded": len(wd), "watchdog_red_days": sum(1 for s in wd.values() if s == "red")}
    changes = []
    for c in data.get("season_changes", []):
        day = str(c.get("day", ""))[:10]
        if week_from <= day <= week_to:
            changes.append({"day": day, "old": c.get("old"), "new": c.get("new")})
    all_["season_date_changes"] = {"count": len(changes), "list": changes[:5]}
    um = data.get("season_unmarked") or []
    if um:
        from calm_pricing import seasons as _sn
        all_["season_unmarked"] = {"count": len(um), "text": _sn.unmarked_text(um)}
        notes.append(f"{_sn.unmarked_text(um)}. They use Mid prices until you mark them.")
    else:
        all_["season_unmarked"] = {"count": 0, "text": ""}
    sc = data.get("scorecard") or {}
    all_["ideas"] = {k: sc.get(k, 0) for k in ("finished", "right", "wrong", "unclear", "tracking")}
    tw = [t for t in data.get("twin_results", []) if t.get("status") == "final"]
    all_["twin"] = {"finished": len(tw), "twin_lower_avg_price": sum(1 for t in tw if (t.get("diff_pct") or 0) < 0),
                    "twin_higher_avg_price": sum(1 for t in tw if (t.get("diff_pct") or 0) > 0),
                    "avg_difference_pct": _avg([t.get("diff_pct") for t in tw])}
    ev = data.get("events") or []
    all_["events"] = {"saved": len(ev), "approved": sum(1 for e in ev if e.get("status") in ("approved", "manual")),
                      "in_the_next_14_days": sum(1 for e in ev if e.get("date") and week_to <= e["date"] <= (date.fromisoformat(week_to) + timedelta(days=14)).isoformat())}

    since = data.get("since")
    if not since or since > week_from:
        notes.append(f"The history log of price changes only exists since {since or 'today'}, so price moves, drops and cancellations before that are not counted.")
    if all_["watchdog_days_recorded"] < len(nights_of_week):
        notes.append(f"The watchdog result was recorded for {all_['watchdog_days_recorded']} of {len(nights_of_week)} days this week.")
    if (data.get("since") or LOG_START) >= week_from:
        notes.append(f"Cancellations and the booking log are counted from {(date.fromisoformat(data.get('since') or LOG_START) + timedelta(days=1)).isoformat()}: the older ones were loaded all at once when the log began.")
    if not all_["ideas"]["finished"]:
        notes.append("No idea has finished yet, so the scorecard has nothing to judge.")
    if not tw:
        notes.append("No twin comparison has finished yet.")
    if not any(r.get("nights_sold") for r in rooms.values()):
        notes.append("No bookings were made this week.")
    return {"property_id": PROPERTY_ID, "week": {"from": week_from, "to": week_to, "key": week_key(week_to)}, "data_notes": notes,
            "guide": GUIDE, "rooms": rooms, "all": all_}


def cancel_kind(e: dict, changed_refs: dict) -> str:
    """real (cancelled before its check-in day), after_stay (marked cancelled after the check-in day had passed: freed nothing),
    changed (the same booking lives on in a new room or new dates)."""
    ci, day = str(e.get("checkin") or ""), str(e.get("day") or "")
    if ci and day and ci < day:
        return "after_stay"
    return "changed" if changed_refs.get(e.get("ref")) else "real"


def flat_numbers(numbers: dict) -> set:
    """Every number that appears in the data, as plain strings (an integer, a rounded decimal, and as a percentage)."""
    out = set()

    def walk(x):
        if isinstance(x, bool) or x is None:
            return
        if isinstance(x, (int, float)):
            out.add(str(int(x)) if float(x).is_integer() else str(round(x, 2)))
            out.add(str(round(x)))
            out.add(str(abs(round(x))))
        elif isinstance(x, dict):
            for v in x.values():
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)
    walk(numbers)
    wk = numbers.get("week", {})
    for d in (wk.get("from"), wk.get("to")):
        if d:
            out.update({str(int(d[8:])), d[:4], str(int(d[5:7]))})
    return out


RULE_WORDS = {"3", "7", "14"}      # "last 3 days", "this week", "next 14 days": time words from the rules, not data
NUM = re.compile(r"(?<![\w.])\d+(?:[.,]\d+)?")
DATEISH = re.compile(r"\b\d{1,2}(?:[–-]\d{1,2})?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*(?:\s+\d{4})?|\b\d{4}-\d{2}-\d{2}\b|\b20\d{2}\b")


def unsupported_numbers(text: str, numbers: dict) -> list:
    """Numbers written in a claim that are not in the data. Dates and the words one/two are not numbers here."""
    allowed = flat_numbers(numbers) | RULE_WORDS
    stripped = DATEISH.sub(" ", str(text))
    bad = []
    for m in NUM.findall(stripped):
        n = m.replace(",", ".")
        norm = str(int(float(n))) if float(n).is_integer() else str(round(float(n), 2))
        if norm not in allowed and str(round(float(n))) not in allowed:
            bad.append(m)
    return bad


# ---------------------------------------------------------------- reading Firestore

def first_log_day(db) -> str:
    """The first day the history log has anything (the day it loaded every old booking and cancellation at once). Those rows are
    not 'this week': counting starts the day after."""
    days = []
    try:
        days = [(d.to_dict() or {}).get("day") for d in db.collection("pmslog_booking_events").stream()]
    except Exception:
        pass
    days = [d for d in days if d]
    return min(days) if days else LOG_START


def changed_cancellations(db, events: list) -> dict:
    """{ref: "changed"} for cancellation events whose booking lives on: another line of the same booking is still confirmed, or the same
    guest booked again within 2 days of the cancellation. Reads reservations; nothing is printed or kept about guests."""
    import hashlib
    import pmslog
    refs = {e["ref"]: e for e in events if e.get("event") == "cancellation" and e.get("ref")}
    if not refs:
        return {}
    live = ("OK", "OK2")
    by_book, by_guest, mine = {}, {}, []
    for doc in db.collection("reservations").stream():
        r = doc.to_dict() or {}
        base = str(r.get("bookingId") or r.get("reservationNumber") or doc.id).split("_")[0]
        nm = f"{r.get('firstName', '')} {r.get('lastName', '')}".strip().lower()
        g = hashlib.sha1(nm.encode()).hexdigest()[:10] if nm else None
        st = str(r.get("status", "")).upper()
        if st in live:
            by_book.setdefault(base, []).append(doc.id)
            if g:
                by_guest.setdefault(g, []).append(str(r.get("creationDate") or "")[:10])
        ref = pmslog.ref_hash(r.get("reservationNumber") or r.get("id") or doc.id)
        if ref in refs:
            mine.append((ref, doc.id, base, g))
    out = {}
    for ref, did, base, g in mine:
        day = refs[ref].get("day", "")
        if any(x != did for x in by_book.get(base, [])):
            out[ref] = "changed"
        elif g and day and any(c and abs((date.fromisoformat(c) - date.fromisoformat(day)).days) <= 2 for c in by_guest.get(g, [])):
            out[ref] = "changed"
    return out


def load(db, now: datetime) -> dict:
    """Read one week of facts. Never writes."""
    import idea_scorecard as sc
    import pricing_shadow as ps
    from calm_pricing import season_of
    today = now.date().isoformat()
    week_to = today
    week_from = (now.date() - timedelta(days=6)).isoformat()
    days = _days(week_from, week_to)

    def by_day(coll, field="day"):
        out = []
        for d in days:
            out += [x.to_dict() or {} for x in db.collection(coll).where(field, "==", d).stream()]
        return out

    import json
    import os
    repo_config = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")))
    rules, settings = ps.load_rules(db, repo_config)
    cfg = ps.build_config(rules, settings, {})

    def limits(rt, night):
        cell = (((cfg.get("rules") or {}).get(rt) or {}).get("GEL") or {}).get(season_of(night, cfg))
        return (cell["start"], cell["min"], cell["max"]) if isinstance(cell, dict) and all(k in cell for k in ("start", "min", "max")) else None

    wd = {}
    for d in days:
        snap = db.collection("pricing_watchdog_days").document(d).get()
        if snap.exists:
            wd[d] = (snap.to_dict() or {}).get("status")
    season_changes = []
    try:
        for d in db.collection("pricing_changes").where("type", "==", "season_dates").stream():
            c = d.to_dict() or {}
            ts = c.get("ts")
            f = (c.get("fields") or {}).get("season_ranges") or {}
            season_changes.append({"day": (ts.isoformat() if hasattr(ts, "isoformat") else str(ts or ""))[:10], "old": f.get("old"), "new": f.get("new")})
    except Exception:
        pass
    season_unmarked = []
    try:
        from calm_pricing import seasons as _sn
        rs = db.collection("pricing_config").document("rules").get()
        raw = (rs.to_dict() or {}).get("seasonRanges") if rs.exists else None
        if isinstance(raw, list):
            season_unmarked = _sn.unmarked(_sn.parse(raw)[0])
    except Exception:
        pass
    ssum = db.collection("pricing_scorecard").document("_summary").get()
    cancel_class = changed_cancellations(db, by_day("pmslog_booking_events"))
    return {"price_events": by_day("pmslog_price_events"), "booking_events": by_day("pmslog_booking_events"),
            "runs": by_day("pricing_calm_runs"), "watchdog_days": wd, "stays": sc.priced_stays(db, today, back_days=120),
            "limits": limits, "cancel_class": cancel_class, "season_changes": season_changes, "season_unmarked": season_unmarked, "scorecard": ssum.to_dict() if ssum.exists else {},
            "twin_results": [d.to_dict() or {} for d in db.collection("pricing_twin_results").stream()],
            "events": [dict(d.to_dict() or {}, date=(d.to_dict() or {}).get("date") or d.id.replace("event_", "")) for d in db.collection("pricing_events").stream()],
            "room_ids": sorted((ps.ROOM_TYPES or {}).keys()), "since": first_log_day(db)}, week_from, week_to
