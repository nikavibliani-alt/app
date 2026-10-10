"""
Pure helpers for `pricing_check.py --check recap` (no network, no Firestore, easy to test).
Everything here only calculates on data that was already read.
"""
from collections import defaultdict

NEW_ENGINE_RTS = ("XCV_1", "XCV_2", "VGL_ST", "VGL_AP")
CUR_LABEL = {"GEL": "Booking GEL", "USD": "Airbnb (EUR list)"}


def after_reset_prices(daily_docs: dict) -> dict:
    """
    daily_docs: {rt: {"YYYY-MM-DD|CUR": record}} from pricing_calm_daily of the reset day (each date
    holds the record of the LAST run that day). Price right after the reset:
      * date moved by a later run  -> the price that run started from (virtual_before)
      * otherwise                  -> the price MiniHotel showed (mh), or the reset price (new)
    Returns {(rt, date, cur): price}.
    """
    out = {}
    for rt, dates in daily_docs.items():
        for key, rec in (dates or {}).items():
            try:
                ds, cur = key.split("|")
            except ValueError:
                continue
            kind = rec.get("kind")
            if kind in ("move", "correction", "fill"):
                p = rec.get("virtual_before")
            elif kind == "reset":
                p = rec.get("new")
            else:
                p = rec.get("mh")
            if p and float(p) > 0:
                out[(rt, ds, cur)] = float(p)
    return out


def now_prices(inventory: dict) -> dict:
    """inventory from fetch_inventory -> {(rt, date, cur): price}."""
    out = {}
    for rt, dates in inventory.items():
        for ds, cell in dates.items():
            for cur, p in (cell.get("prices") or {}).items():
                if p and float(p) > 0:
                    out[(rt, ds, cur)] = float(p)
    return out


def month_table(before: dict, now: dict) -> list:
    """Rows (rt, cur, month, n, avg_before, avg_now, n_changed) over dates present in both."""
    groups = defaultdict(list)
    for key, b in before.items():
        if key in now:
            rt, ds, cur = key
            groups[(rt, cur, ds[:7])].append((b, now[key]))
    rows = []
    for (rt, cur, m), pairs in sorted(groups.items()):
        n = len(pairs)
        rows.append((rt, cur, m, n, sum(p[0] for p in pairs) / n, sum(p[1] for p in pairs) / n,
                     sum(1 for p in pairs if abs(p[0] - p[1]) >= 0.5)))
    return rows


def biggest_moves(before: dict, now: dict, n: int = 5) -> list:
    """The n largest relative moves: (pct, rt, date, cur, before, now)."""
    moves = []
    for key, b in before.items():
        a = now.get(key)
        if a is not None and b > 0 and abs(a - b) >= 0.5:
            moves.append(((a - b) / b * 100, key[0], key[1], key[2], b, a))
    moves.sort(key=lambda m: abs(m[0]), reverse=True)
    return moves[:n]


def shadow_distance(dates: dict) -> dict:
    """
    One shadow daily record {"date|CUR": {mh, new, avail, ...}} -> per currency how far the shadow
    price is from the price now in MiniHotel (set by the current engine), free dates with a price only.
    """
    per = defaultdict(list)
    for key, rec in (dates or {}).items():
        try:
            _, cur = key.split("|")
        except ValueError:
            continue
        mh, new = rec.get("mh"), rec.get("new")
        if not mh or not new or float(mh) <= 0 or (rec.get("avail") or 0) <= 0:
            continue
        per[cur].append((float(new) - float(mh)) / float(mh) * 100)
    out = {}
    for cur, xs in per.items():
        out[cur] = {"n": len(xs), "same": sum(1 for x in xs if abs(x) < 0.5),
                    "avg": sum(xs) / len(xs), "avg_abs": sum(abs(x) for x in xs) / len(xs),
                    "max_abs": max(abs(x) for x in xs)}
    return out


def run_days(runs: list) -> dict:
    """runs: [{"ts": "YYYY-MM-DDTHH:MM..", "main_run": bool}] -> {day: (runs, lowering_runs)}."""
    out = defaultdict(lambda: [0, 0])
    for r in runs:
        day = str(r.get("ts", ""))[:10]
        out[day][0] += 1
        out[day][1] += 1 if r.get("main_run") else 0
    return {d: tuple(v) for d, v in sorted(out.items())}


def reservation_rows(docs: list, rt_of: dict, since_day: str) -> dict:
    """
    docs: reservation dicts (no names). Returns {"new": [...], "cancelled_new": [...]} where each row is
    (rt, checkin, nights, source, price_per_night_text, status, creation_day).
    creationDate has no time of day, so the first day is only partly inside the period.
    """
    new, cancelled = [], []
    for x in docs:
        created = str(x.get("creationDate") or "")[:10]
        if not created or created < since_day:
            continue
        rt = rt_of.get(x.get("roomCode")) or f"other:{x.get('roomCode')}"
        try:
            nights = int(x.get("nights") or 0)
        except (TypeError, ValueError):
            nights = 0
        debit = x.get("debit")
        try:
            ppn = f"{float(debit) / nights:.0f} {x.get('currency') or ''}".strip() if nights and debit else "not stored"
        except (TypeError, ValueError):
            ppn = "not stored"
        row = (rt, str(x.get("checkin") or "")[:10], nights, str(x.get("source") or "unknown"), ppn,
               str(x.get("status") or ""), created)
        (cancelled if str(x.get("status") or "").upper() == "CL" else new).append(row)
    return {"new": sorted(new, key=lambda r: (r[0], r[1])), "cancelled_new": sorted(cancelled, key=lambda r: (r[0], r[1]))}
