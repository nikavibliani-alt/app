"""Read-only: the last 3 saved weekly reports in short, plus what the reports do not show (same-day arrival drops, the XCV owner test).
Writes NOTHING. Prints rooms, dates and counts only (no guest data, no keys)."""
import collections
import os
import sys
from datetime import date, datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pricing_shadow as ps  # noqa: E402

OWNER_TEST_FROM = "2026-11-03"


def d_(iso):
    return date.fromisoformat(iso[:10])


def short(x, n=420):
    x = str(x or "")
    return x if len(x) <= n else x[:n] + "..."


def main():
    db = ps.init_db()
    now = datetime.now(ps.TBILISI).replace(tzinfo=None)
    today = now.date()
    weeks = sorted([d for d in db.collection("pricing_weekly").stream() if d.id[:2] == "20"], key=lambda d: d.id)
    print("Saved weekly reports:", [d.id for d in weeks])
    last = weeks[-3:]
    keep = {}
    cols = ["bookings_made", "nights_sold", "cancellations", "cancellations_changed", "cancellations_after_stay",
            "last3_price_drops", "last3_nights_lowered", "last3_nights_lowered_then_booked",
            "cancelled_tonight_lowered", "cancelled_tonight_lowered_then_booked", "cancelled_tomorrow_lowered", "cancelled_tomorrow_lowered_then_booked",
            "nights_hit_min", "nights_hit_max", "price_drops_written", "price_raises_written", "held_back_other", "avg_sold_price_gel"]
    for d in last:
        w = d.to_dict() or {}
        n, r = w.get("numbers") or {}, w.get("report") or {}
        wk = n.get("week") or {}
        keep[d.id] = (wk.get("from"), wk.get("to"))
        print(f"\n######## {d.id}: {wk.get('from')} to {wk.get('to')} | saved {w.get('ts')} | checked {r.get('checked')} | error {r.get('error')}")
        rooms = n.get("rooms") or {}
        print("room | " + " | ".join(c.replace("last3_nights_lowered_then_booked", "l3_booked").replace("cancelled_", "c_").replace("_lowered", "_low").replace("cancellations", "canc")
                                    .replace("price_", "p_").replace("nights_", "n_") for c in cols))
        tot = collections.Counter()
        for k, v in sorted(rooms.items()):
            print(f"{k} | " + " | ".join(str(v.get(c)) for c in cols))
            for c in cols:
                if isinstance(v.get(c), (int, float)):
                    tot[c] += v[c]
        print("TOTAL | " + " | ".join(str(tot[c]) for c in cols))
        sold_nothing = [k for k, v in rooms.items() if not v.get("nights_sold")]
        max_often = sorted(((v.get("nights_hit_max") or 0, k) for k, v in rooms.items()), reverse=True)[:4]
        print("Sold nothing:", sold_nothing or "none", "| most nights at maximum:", max_often)
        al = n.get("all") or {}
        print("ALL:", {k: al.get(k) for k in ("runs", "urgent_runs", "channel_push_failures", "runs_with_stopped_rooms", "watchdog_days_recorded", "watchdog_red_days", "ideas", "twin", "events")})
        print("data notes:", n.get("data_notes"))
        print("headline:", r.get("headline"), "| by:", r.get("headline_by"), "|", r.get("headline_note"))
        print("checker headline:", r.get("check_headline"), "| removed:", [(x.get("id"), x.get("why")) for x in (r.get("removed") or [])], "| edited:", r.get("edited"))
        for sec in ("worked", "didnt", "upgrades"):
            for it in (r.get(sec) or []):
                print(f"  {sec}: {short(it.get('text'), 330)}")

    # watchdog red days and why
    print("\n=== Watchdog days ===")
    first = min(v[0] for v in keep.values())
    for dd in sorted(db.collection("pricing_watchdog_days").stream(), key=lambda x: x.id):
        if first <= dd.id <= today.isoformat():
            x = dd.to_dict() or {}
            if x.get("status") != "green":
                print(" ", dd.id, {k: (short(v, 260) if isinstance(v, str) else v) for k, v in x.items() if k not in ("property_id",)})
    greens = sum(1 for dd in db.collection("pricing_watchdog_days").stream() if first <= dd.id <= today.isoformat() and (dd.to_dict() or {}).get("status") == "green")
    print("  green days in that span:", greens)

    stays, _ = ps.load_reservations(db, today)

    def booked_after(rt, night, since):
        return any(s["rt"] == rt and s["created"] >= since and s["checkin"] <= night < s["checkout"] for s in stays)

    print("\n=== Same-day (arrival day) drops: the 12:00 and 17:00 rule, from the price-event log ===")
    evs = [e.to_dict() for e in db.collection("pmslog_price_events").where("day", ">=", "2026-10-31").stream()]
    arr = [e for e in evs if e.get("kind") == "arrival" and e.get("written")]
    print(f"Arrival-day price changes written since 31 Oct: {len(arr)}")
    per = collections.defaultdict(lambda: collections.defaultdict(set))
    for e in arr:
        wk = next((k for k, (a, b) in keep.items() if a <= e["day"] <= b), "other/after")
        step = "17:00 step (to minimum)" if int(str(e.get("ts"))[11:13]) >= 17 else "12:00 step (halfway)"
        per[(wk, e["rt"], step)]["nights"].add(e["date"])
        per[(wk, e["rt"], step)]["events"].add((e["date"], e["currency"], e["old"], e["new"]))
    for (wk, rt, step), v in sorted(per.items()):
        sold = [nt for nt in v["nights"] if booked_after(rt, nt, nt)]
        print(f"  {wk} {rt} {step}: {len(v['events'])} price changes on {len(v['nights'])} nights; booked the same day after it (booking date = the night): {len(sold)}")
    gone = [e for e in evs if e.get("days_out") == 0 and e.get("kind") != "arrival" and e.get("written")]
    print("  other day-0 price changes written (for comparison, not the rule):", collections.Counter(e.get("kind") for e in gone))

    print("\n=== XCV owner test: bookings made (by booking date) before vs after", OWNER_TEST_FROM, "===")
    cut = d_(OWNER_TEST_FROM)
    before_days = 28
    b_from = cut - timedelta(days=before_days)
    a_days = (today - cut).days + 1
    for grp, rts in (("XCV_1", ["XCV_1"]), ("XCV_2", ["XCV_2"]), ("XCV both", ["XCV_1", "XCV_2"]),
                     ("all other rooms (control)", sorted({s["rt"] for s in stays} - {"XCV_1", "XCV_2"}))):
        sel = [s for s in stays if s["rt"] in rts]
        b = [s for s in sel if b_from <= d_(s["created"]) < cut]
        a = [s for s in sel if cut <= d_(s["created"]) <= today]
        nb = sum((d_(s["checkout"]) - d_(s["checkin"])).days for s in b)
        na = sum((d_(s["checkout"]) - d_(s["checkin"])).days for s in a)
        lead = lambda xs: round(sum((d_(s["checkin"]) - d_(s["created"])).days for s in xs) / len(xs), 1) if xs else None  # noqa: E731
        print(f"  {grp}: before ({b_from}..{cut - timedelta(days=1)}, {before_days} d): {len(b)} bookings, {nb} nights, {len(b) / before_days:.2f} bookings/day, lead {lead(b)} d"
              f" | after ({cut}..{today}, {a_days} d): {len(a)} bookings, {na} nights, {len(a) / a_days:.2f} bookings/day, lead {lead(a)} d")
    for rt in ("XCV_1", "XCV_2"):
        wks = collections.Counter()
        for s in stays:
            if s["rt"] == rt:
                c = d_(s["created"])
                if c >= cut - timedelta(days=28):
                    wks[(c - (cut - timedelta(days=28))).days // 7] += 1
        print(f"  {rt} bookings per 7-day block starting {cut - timedelta(days=28)}: {[wks[i] for i in range(0, ((today - (cut - timedelta(days=28))).days // 7) + 1)]}")

    print("\n=== Ideas (pricing_proposals) and scorecard ===")
    props = [dict(p.to_dict() or {}, _id=p.id) for p in db.collection("pricing_proposals").stream() if not p.id.startswith("weekly")]
    for k, (a, b) in keep.items():
        mine = [p for p in props if a <= str((p.get("evidence") or {}).get("made_on") or p.get("date") or "")[:10] <= b]
        print(f"  {k}: ideas made {len(mine)} | by status {dict(collections.Counter(p.get('status') for p in mine))} | reasons {dict(collections.Counter(p.get('rejection_reason') for p in mine if p.get('rejection_reason')))}")
    print("  all ideas by status:", dict(collections.Counter(p.get("status") for p in props)))
    sc = [dict(s.to_dict() or {}, _id=s.id) for s in db.collection("pricing_scorecard").stream()]
    summ = next((s for s in sc if s["_id"] == "_summary"), {})
    print("  scorecard summary:", {k: summ.get(k) for k in ("finished", "right", "wrong", "unclear", "tracking", "no_dates")})
    for s in sorted([s for s in sc if s["_id"] != "_summary"], key=lambda s: str(s.get("made_on"))):
        if s.get("status") == "final" or (s.get("verdict")):
            print(f"   {s.get('room')} {s.get('field')} {s.get('direction')} {s.get('decision')} made {s.get('made_on')} {s.get('from')}..{s.get('to')} -> {s.get('verdict')}: {short(s.get('reason'), 240)}")
    print("PROBE FINISHED")


if __name__ == "__main__":
    main()
