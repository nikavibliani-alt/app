"""
Price watchdog. Runs after every pricing run and looks at what the new engine just did. Pure logic:
no network, no database. `scripts/price_watchdog.py` feeds it from Firestore and sends the WhatsApp.

Seven checks (each issue = {"code", "rt", "date", "text"}):
  out_of_range   a price outside the room's minimum / maximum
  big_move       one run moved a price further than the daily limits allow
  up_down_up     a price went up, down and up again within 48 hours
  holiday_broken a holiday / hold date outside its band around the anchor, or a far reset on one
  channel_failed a channel push (Booking, Expedia, Airbnb) failed in the last run
  room_stopped   the run stopped a room, or did not finish
  no_price       a date with free units and no price
"""

from datetime import datetime, timedelta

# Moves that are deliberate and bigger than a daily step (a correction into min/max, the one-time resets).
BIG_MOVE_OK_KINDS = ("correction", "reset", "far_reset", "tonight")
TOLERANCE_ABS = {"GEL": 2.0, "USD": 1.0, "EUR": 1.0}      # rounding to the price grid
TOLERANCE_PCT = 0.01
MAX_LISTED = 40

CHANNEL_NAMES = {"BOOKING": "Booking.com", "EXPEDIA": "Expedia", "AIRBNB": "Airbnb"}


def _tol(cur, base):
    return max(TOLERANCE_ABS.get(cur, 1.0), abs(base) * TOLERANCE_PCT)


def _daily_limits(calm, aggressive_down=0.0):
    return {"up": max(calm.get("daily_up", 0.08), calm.get("daily_up_hot", 0.15)),
            "down": max(calm.get("daily_down", 0.05), aggressive_down),
            "down3": calm.get("daily_down_last3", 0.15)}


def check(daily, states, run, cfg, now, live_rts=None):
    """daily {rt: {"date|CUR": record}}, states {rt: {date: {CUR: state}}}, run = the last run doc (or None).
    Returns {"status": "green"|"red", "issues": [...], "counts": {code: n}, "checked": n}."""
    issues, checked = [], 0
    calm = (cfg or {}).get("calm", {})
    agg_down = 0.08                          # the faster style may drop that much a day
    lim = _daily_limits(calm, agg_down)

    for rt, dates in sorted((daily or {}).items()):
        for key, r in sorted(dates.items()):
            date, _, cur = key.partition("|")
            checked += 1
            new = r.get("new")
            before = r.get("virtual_before")
            kind = r.get("kind")
            avail = r.get("avail") or 0
            who = f"{rt} {date} {cur}"
            if kind == "protected":
                continue
            if avail > 0 and not new:
                issues.append({"code": "no_price", "rt": rt, "date": date, "text": f"{who}: free but has no price."})
                continue
            if not new:
                continue
            mn, mx = r.get("min"), r.get("max")
            if mn is not None and new < mn - _tol(cur, mn):
                issues.append({"code": "out_of_range", "rt": rt, "date": date,
                               "text": f"{who}: price {new:g} is below the minimum {mn:g}."})
            elif mx is not None and new > mx + _tol(cur, mx):
                issues.append({"code": "out_of_range", "rt": rt, "date": date,
                               "text": f"{who}: price {new:g} is above the maximum {mx:g}."})
            if before and kind not in BIG_MOVE_OK_KINDS and new != before:
                do = r.get("do")
                up_cap = lim["up"]
                down_cap = lim["down3"] if (do is not None and do <= 3) else lim["down"]
                share = (new - before) / before
                if share > up_cap + TOLERANCE_PCT or -share > down_cap + TOLERANCE_PCT:
                    if abs(new - before) > _tol(cur, before):
                        issues.append({"code": "big_move", "rt": rt, "date": date,
                                       "text": f"{who}: moved {before:g} to {new:g} ({share:+.0%}) in one run."})
            h = r.get("hol")
            if h:
                lo, hi = h.get("lo"), h.get("hi")
                if h.get("window") and kind not in ("correction",):
                    if lo is not None and new < lo - _tol(cur, lo):
                        issues.append({"code": "holiday_broken", "rt": rt, "date": date,
                                       "text": f"{who}: {new:g} is below the holiday limit {lo:g} (anchor {h.get('anchor'):g})."})
                    elif hi is not None and new > hi + _tol(cur, hi):
                        issues.append({"code": "holiday_broken", "rt": rt, "date": date,
                                       "text": f"{who}: {new:g} is above the holiday limit {hi:g} (anchor {h.get('anchor'):g})."})
                if kind == "far_reset":
                    issues.append({"code": "holiday_broken", "rt": rt, "date": date,
                                   "text": f"{who}: a far reset happened on a holiday date."})

    # up, down, up within 48 hours (the engine keeps 72 hours of directions per date)
    cutoff = now - timedelta(hours=48)
    for rt, dates in sorted((states or {}).items()):
        for date, curs in sorted((dates or {}).items()):
            for cur, st in (curs or {}).items():
                seq = []
                for x in (st or {}).get("dirs", []):
                    try:
                        t = datetime.fromisoformat(x["t"])
                    except (KeyError, ValueError, TypeError):
                        continue
                    if t >= cutoff and x.get("d") and x.get("k") not in ("correction", "reset", "far_reset"):
                        seq.append(1 if x["d"] > 0 else -1)
                collapsed = [s for i, s in enumerate(seq) if i == 0 or s != seq[i - 1]]
                for i in range(len(collapsed) - 2):
                    if collapsed[i:i + 3] == [1, -1, 1]:
                        issues.append({"code": "up_down_up", "rt": rt, "date": date,
                                       "text": f"{rt} {date} {cur}: went up, down and up again within 48 hours."})
                        break

    if run:
        for p in run.get("failed_portals") or []:
            issues.append({"code": "channel_failed", "rt": "", "date": "",
                           "text": f"The push to {CHANNEL_NAMES.get(p, p)} failed."})
        for rt in run.get("stopped_room_types") or []:
            issues.append({"code": "room_stopped", "rt": rt, "date": "", "text": f"{rt} was stopped by the safety check."})
        if run.get("ok") is False and not run.get("stopped_room_types"):
            issues.append({"code": "room_stopped", "rt": "", "date": "", "text": "The last run did not finish."})
    else:
        issues.append({"code": "room_stopped", "rt": "", "date": "", "text": "No run found today."})

    for rt in sorted(set(live_rts or []) - set((daily or {}).keys())):
        issues.append({"code": "no_price", "rt": rt, "date": "", "text": f"{rt}: no prices were calculated today."})

    counts = {}
    for i in issues:
        counts[i["code"]] = counts.get(i["code"], 0) + 1
    return {"status": "red" if issues else "green", "issues": issues, "counts": counts, "checked": checked}


def short_issues(result):
    """One short sentence per kind of problem, for the WhatsApp message and the page."""
    names = {
        "out_of_range": "prices outside min/max", "big_move": "moves bigger than the rules allow",
        "up_down_up": "prices that went up, down and up", "holiday_broken": "holiday rule broken",
        "channel_failed": "channel push failed", "room_stopped": "room stopped",
        "no_price": "dates without a price",
    }
    return "; ".join(f"{n} {names.get(c, c)}" for c, n in sorted(result["counts"].items()))
