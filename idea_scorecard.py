"""
Idea scorecard (Beta). Follows every decided idea (applied, skipped, replaced) until all its nights have passed,
then marks it Right, Wrong or Unclear with a plain reason that uses real dates and numbers.

Pure logic, no AI: `judge()` takes one idea and the stored stays and returns the verdict. `scripts/idea_scorecard.py`
reads and saves. Everything carries property_id. The verdict is evidence, not proof: nobody can know what would have
happened at the other price.

Rules (the nights that were EMPTY when the idea was made are the ones judged; a night counts as sold when a stay
booked on or after the idea's day covers it):
  idea says lower   applied: filled (>= 75%) Right, mostly empty (< 50%) Wrong
                    not applied: sold anyway (>= 75%) Wrong, stayed empty (< 50%) Right
  idea says raise   applied: sold anyway (>= 75%) Right, mostly empty (< 50%) Wrong
                    not applied: the room sold well (>= 75%) Right, stayed empty (< 50%) Wrong
  in between, or fewer than 5 empty nights, or no stays to look at: Unclear
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

PROPERTY_ID = "maxela"
HIGH, LOW, MIN_NIGHTS = 0.75, 0.50, 5
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
WHAT = {"startprice": "start price", "floor": "minimum", "ceiling": "maximum"}
SEASON_NAMES = {"xmas_low": "low Christmas", "low": "Low season", "mid": "Mid season", "high": "High season", "peak": "Peak season"}
REPLACED = "Replaced by a newer idea"
NOT_USEFUL = "Not useful: nothing left to sell"
NOT_USEFUL_FEW = "Not useful: too few nights to sell"


def _d(iso):
    return date.fromisoformat(iso[:10])


def dates_text(a: str, b: str) -> str:
    x, y = _d(a), _d(b)
    if (x.year, x.month) == (y.year, y.month):
        return f"{x.day}–{y.day} {MONTHS[y.month - 1]} {y.year}" if x != y else f"{x.day} {MONTHS[x.month - 1]} {x.year}"
    return f"{x.day} {MONTHS[x.month - 1]} – {y.day} {MONTHS[y.month - 1]} {y.year}"


def field_of(ptype: str) -> str:
    t = str(ptype or "")
    return t[:-3].lower() if t.lower().endswith("eur") else t.lower()


def decision_of(p: dict):
    """applied / skipped / replaced, or None while the idea is still waiting."""
    st = p.get("status")
    if st in ("approved", "auto_applied"):
        return "applied"
    if st == "rejected" and p.get("rejection_reason") in (NOT_USEFUL, NOT_USEFUL_FEW):
        return None                                     # never a real choice: nothing was left to sell, so it is not followed
    if st == "rejected":
        return "replaced" if p.get("rejection_reason") == REPLACED else "skipped"
    return None


def nights_between(a: str, b: str) -> list:
    n = (_d(b) - _d(a)).days
    return [(_d(a) + timedelta(days=k)).isoformat() for k in range(n + 1)]


def priced_stays(db, today: str, back_days: int = 460) -> list:
    """Counted stays with their booking day and price per night (what the guest was charged, in the stay's own currency)."""
    import pricing_shadow as ps
    out = []
    cutoff = (_d(today) - timedelta(days=back_days)).isoformat()
    for doc in db.collection("reservations").where("checkin", ">=", cutoff).stream():
        r = doc.to_dict() or {}
        if str(r.get("status", "")).upper() not in ps.COUNTED_STATUSES:
            continue
        rt = ps.ROOM_CODE_TO_RT.get(r.get("roomCode", ""))
        ci, co = ps._iso_day(r.get("checkin")), ps._iso_day(r.get("checkout"))
        if not (rt and ci and co):
            continue
        n = (_d(co) - _d(ci)).days
        debit = r.get("debit")
        per = round(float(debit) / n, 2) if n > 0 and isinstance(debit, (int, float)) and debit else None
        out.append({"rt": rt, "checkin": ci, "checkout": co, "created": ps._iso_day(r.get("creationDate")),
                    "per_night": per, "currency": r.get("currency")})
    return out


def judge(p: dict, stays: list, today: str, name_of=lambda rt: rt) -> dict:
    """One idea -> its scorecard document (without ids and times). status is tracking, final or no_dates."""
    dec = decision_of(p)
    ev = p.get("evidence") or {}
    look = ev.get("looked_at")
    cur, sug = p.get("current"), p.get("suggested")
    lower = isinstance(cur, (int, float)) and isinstance(sug, (int, float)) and sug < cur
    base = {"property_id": PROPERTY_ID, "idea_id": p.get("id"), "room": p.get("property"), "season": p.get("season"),
            "type": p.get("type"), "field": field_of(p.get("type")), "direction": "lower" if lower else "raise",
            "decision": dec, "made_on": ev.get("made_on") or p.get("date")}
    if not look:
        return {**base, "status": "no_dates", "verdict": None,
                "reason": "This idea was made before its dates were saved, so it cannot be followed."}
    a, b = look["from"], look["to"]
    base.update({"from": a, "to": b})
    empty = ev.get("empty")
    if empty is None:
        empty = nights_between(a, b)
    made = base["made_on"] or a
    if b >= today:
        left = (_d(b) - _d(today)).days + 1
        return {**base, "status": "tracking", "verdict": None, "nights_left": left,
                "reason": f"Still running: {left} night{'s' if left != 1 else ''} to go (until {dates_text(b, b)})."}
    mine = [s for s in stays if s["rt"] == p.get("property") and s.get("created") and s["created"] >= made]
    sold, prices = [], []
    for night in empty:
        hit = [s for s in mine if s["checkin"] <= night < s["checkout"]]
        if hit:
            sold.append(night)
            prices += [s["per_night"] for s in hit if s.get("per_night") and s.get("currency") == "GEL"]
    n, k = len(empty), len(sold)
    share = k / n if n else None
    avg = round(sum(prices) / len(prices)) if prices else None
    nums = {"empty_at_start": n, "sold": k, "share": round(share, 2) if share is not None else None, "avg_price_gel": avg}
    what = WHAT.get(base["field"], base["field"])
    season = SEASON_NAMES.get(p.get("season"), str(p.get("season")))
    head = f"Said {base['direction']} the {what} for {name_of(p.get('property'))} ({season}, {dates_text(a, b)}). "
    did = {"applied": "You applied it. ", "skipped": "You skipped it. ", "replaced": "A newer idea replaced it. "}[dec]
    at = f"{k} of {n} nights that were empty when the idea was made got a booking"
    price = f" (average {avg} ₾ a night)" if avg else ""
    applied = dec == "applied"
    if n < MIN_NIGHTS:
        verdict, why = "unclear", f"Only {n} night{'s' if n != 1 else ''} were empty then: too few to judge."
    elif not stays:
        verdict, why = "unclear", "No stays could be read, so nothing can be judged."
    else:
        hi, lo = share >= HIGH, share < LOW
        if lower:
            good, bad = (hi, lo) if applied else (lo, hi)      # lowering is right if it filled, or if skipping it did no harm
        else:
            good, bad = hi, lo                                  # raising is right when the room was in demand
        verdict = "right" if good else "wrong" if bad else "unclear"
        tail = {"applied": " at the new price" if applied else "", "skipped": " at your price", "replaced": " at your price"}[dec]
        if verdict == "unclear":
            why = f"{at}{tail}{price}: neither clearly good nor bad."
        else:
            anyway = " anyway" if (not applied and hi) else ""
            why = f"{at}{anyway}{tail}{price}."
    return {**base, "status": "final", "verdict": verdict, "numbers": nums,
            "reason": f"{head}{did}{why} → {verdict.capitalize()}"}


def summary(cards: list) -> dict:
    fin = [c for c in cards if c.get("status") == "final"]
    return {"property_id": PROPERTY_ID, "finished": len(fin),
            "right": sum(1 for c in fin if c["verdict"] == "right"),
            "wrong": sum(1 for c in fin if c["verdict"] == "wrong"),
            "unclear": sum(1 for c in fin if c["verdict"] == "unclear"),
            "tracking": sum(1 for c in cards if c.get("status") == "tracking")}
