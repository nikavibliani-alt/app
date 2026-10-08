"""
Shadow test report: compares what the new engine WOULD have done with what the
current engine actually did. Reads Firestore only; changes nothing.

For every room type, date and currency the shadow keeps one record per day
(the last run of that day): the price in MiniHotel (set by the current engine)
and the new engine's own price. From those daily records this report shows:
  * runs, stopped runs and their reasons, days without a run allowed to lower prices
  * next 30 days: average MiniHotel price vs average new-engine price
  * for both engines: biggest one-day move, direction reversals, changes per date
  * any new-engine price outside your minimum/maximum (must be 0)
  * nights that passed: sold or empty, and both prices on the arrival day

Usage:
  python pricing_shadow_report.py            # last 14 days
  python pricing_shadow_report.py --days 7
"""

from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

TBILISI = timezone(timedelta(hours=4))


def collect(db, days: int, today: date | None = None):
    today = today or datetime.now(TBILISI).date()
    first = (today - timedelta(days=days)).isoformat()
    daily = [d.to_dict() for d in db.collection("pricing_shadow_daily").where("day", ">=", first).stream()]
    runs = [d.to_dict() for d in db.collection("pricing_shadow_runs").where("ts", ">=", first).stream()]
    return today, daily, runs


def _series(daily: list) -> dict:
    """(rt, date, currency) -> [(day, record)] sorted by day."""
    out = defaultdict(list)
    for doc in daily:
        for key, rec in (doc.get("dates") or {}).items():
            ds, cur = key.split("|")
            out[(doc["rt"], ds, cur)].append((doc["day"], rec))
    for v in out.values():
        v.sort(key=lambda x: x[0])
    return out


def _moves(prices: list, bounds: list | None = None) -> tuple[float, int, int, int]:
    """
    biggest one-day move (share), direction reversals, changes, min/max corrections.
    With `bounds`, a move from a price outside that day's minimum/maximum back inside
    is a correction: counted separately, not as a move.
    """
    biggest, reversals, changes, corrections, last_dir = 0.0, 0, 0, 0, 0
    for i, (a, b) in enumerate(zip(prices, prices[1:])):
        if not a or not b or abs(b - a) < 0.5:
            continue
        if bounds:
            mn, mx = bounds[i + 1]
            if mn is not None and mx is not None and (a < mn - 0.01 or a > mx + 0.01):
                corrections += 1
                continue
        changes += 1
        biggest = max(biggest, abs(b - a) / a)
        d = 1 if b > a else -1
        if last_dir and d != last_dir:
            reversals += 1
        last_dir = d
    return biggest, reversals, changes, corrections


def summarise(today: date, daily: list, runs: list) -> str:
    out = []
    stopped = [r for r in runs if not r.get("ok")]
    run_days = {str(r.get("day") or r.get("ts", "")[:10]) for r in runs}
    main_days = {str(r.get("day") or r.get("ts", "")[:10]) for r in runs if r.get("main_run") and r.get("ok")}
    late_main = sum(1 for r in runs if any("No run between" in w for w in r.get("warnings", [])))
    # every calendar day from the first run to today, including days with no run at all
    all_days = set()
    if run_days:
        d = date.fromisoformat(min(run_days))
        while d <= today:
            all_days.add(d.isoformat())
            d += timedelta(days=1)
    no_run = sorted(all_days - run_days)
    rt_stops = defaultdict(int)
    for r in runs:
        for rt in r.get("stopped_room_types") or []:
            rt_stops[rt] += 1
    out.append(f"Shadow runs: {len(runs)} on {len(run_days)} of {len(all_days)} days | "
               f"whole runs stopped by safety checks: {len(stopped)}")
    if rt_stops:
        out.append("  Room types left alone by a safety check: "
                   + ", ".join(f"{rt} in {n} run(s)" for rt, n in sorted(rt_stops.items())))
    settings_w = sorted({w for r in runs for w in r.get("warnings", []) if w.startswith("setting")})
    for w in settings_w[:5]:
        out.append(f"  {w}")
    out.append(f"Days without a successful run allowed to lower prices: {len(all_days - main_days)} "
               f"(no run at all: {len(no_run)}) | days where that run came after 12:00: {late_main}")
    rev_new = defaultdict(int)
    for r in runs:
        for rt, n in (r.get("reversals_by_rt") or {}).items():
            rev_new[rt] += n
    alerts = defaultdict(int)
    for r in runs:
        for a in r.get("alerts", []):
            alerts[a.split(":")[0]] += 1
    for k, v in sorted(alerts.items(), key=lambda x: -x[1])[:10]:
        out.append(f"  alert '{k}': {v} runs")

    series = _series(daily)

    # ---- next 30 days: latest record per date ----
    out.append("")
    out.append("Next 30 days, average price per night (MiniHotel now -> new engine):")
    by_rt = defaultdict(lambda: {"mh": [], "new": [], "status": defaultdict(int)})
    for (rt, ds, cur), recs in series.items():
        rec = recs[-1][1]
        d_out = (date.fromisoformat(ds) - today).days
        if 0 <= d_out <= 30 and rec.get("avail", 0) > 0 and rec.get("mh") and rec.get("new"):
            b = by_rt[(rt, cur)]
            b["mh"].append(rec["mh"])
            b["new"].append(rec["new"])
            b["status"][rec.get("status", "?")] += 1
    for (rt, cur), b in sorted(by_rt.items()):
        o, n = sum(b["mh"]) / len(b["mh"]), sum(b["new"]) / len(b["new"])
        st = ", ".join(f"{k} {v}" for k, v in sorted(b["status"].items(), key=lambda x: -x[1])[:3])
        out.append(f"  {rt:8} {cur}: {o:7.0f} -> {n:7.0f} ({(n - o) / o:+.0%})   dates: {st}")

    # ---- calmness, both engines, from one price per date per day ----
    out.append("")
    out.append("How calm (one price per date per day; current engine | new engine):")
    calm = defaultdict(lambda: {"mh": [0.0, 0, 0, 0, 0], "new": [0.0, 0, 0, 0, 0]})
    outside = []
    for (rt, ds, cur), recs in series.items():
        bounds = [(r.get("min"), r.get("max")) for _, r in recs]
        for side in ("mh", "new"):
            big, rev, ch, corr = _moves([r.get(side) for _, r in recs], bounds if side == "new" else None)
            c = calm[(rt, cur)][side]
            c[0], c[1], c[2], c[3], c[4] = max(c[0], big), c[1] + rev, c[2] + ch, c[3] + 1, c[4] + corr
        for day, r in recs:
            mn, mx, new = r.get("min"), r.get("max"), r.get("new")
            if mn is not None and mx is not None and new and r.get("avail", 0) > 0:
                if new < mn - 0.01 or new > mx + 0.01:
                    outside.append((rt, ds, cur, day, new, mn, mx))
    if rev_new:
        out.append("  New engine, direction reversals counted on every run (not only once a day): "
                   + ", ".join(f"{rt} {n}" for rt, n in sorted(rev_new.items())))
    for (rt, cur), c in sorted(calm.items()):
        m, n = c["mh"], c["new"]
        out.append(f"  {rt:8} {cur}: biggest one-day move {m[0]:.0%} | {n[0]:.0%}   "
                   f"reversals {m[1]} | {n[1]}   changes per date {m[2] / max(1, m[3]):.1f} | {n[2] / max(1, n[3]):.1f}"
                   + (f"   (new engine also brought {n[4]} price(s) back inside your min/max)" if n[4] else ""))
    out.append(f"New-engine prices outside your minimum/maximum: {len(outside)} "
               "(on an approved event date the maximum includes the event lift)")
    for o in outside[:5]:
        out.append(f"  {o}")

    # ---- passed nights ----
    out.append("")
    out.append("Nights that already passed (arrival-day record):")
    passed = defaultdict(lambda: {"sold": 0, "empty": 0, "mh": [], "new": []})
    for (rt, ds, cur), recs in series.items():
        for day, rec in recs:
            if day == ds:
                p = passed[(rt, cur)]
                p["sold" if rec.get("avail", 1) == 0 else "empty"] += 1
                if rec.get("mh"):
                    p["mh"].append(rec["mh"])
                if rec.get("new"):
                    p["new"].append(rec["new"])
    for (rt, cur), p in sorted(passed.items()):
        if p["mh"] and p["new"]:
            out.append(f"  {rt:8} {cur}: {p['sold']} sold out, {p['empty']} with free units | "
                       f"avg arrival-day price MiniHotel {sum(p['mh']) / len(p['mh']):.0f}, new {sum(p['new']) / len(p['new']):.0f}")
    out.append("")
    out.append("Note: guests booked at the MiniHotel prices, so this cannot show what the new prices would have sold.")
    return "\n".join(out)


def main(argv=None, db=None, today: date | None = None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=14)
    args = parser.parse_args(argv)
    if db is None:
        from pricing_shadow import init_db
        db = init_db()
    today, daily, runs = collect(db, args.days, today)
    text = summarise(today, daily, runs)
    print(text)
    return text


if __name__ == "__main__":
    main()
