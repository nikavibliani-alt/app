"""Read-only: checks the facts behind the weekly report of the last 7 days. Writes nothing. Prints counts, rooms and dates only
(no guest name, phone, reservation number, no keys)."""
import collections
import hashlib
import os
import sys
from datetime import date, datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pricing_shadow as ps  # noqa: E402
import pmslog  # noqa: E402
import weekly_numbers as wn  # noqa: E402


def ranges(days):
    days = sorted(set(days))
    out = []
    for d in days:
        if out and (date.fromisoformat(d) - date.fromisoformat(out[-1][1])).days == 1:
            out[-1][1] = d
        else:
            out.append([d, d])
    return ", ".join(a if a == b else f"{a}..{b}" for a, b in out)


def main():
    print("READ-ONLY probe: nothing is written.\n")
    db = ps.init_db()
    now = datetime.now(ps.TBILISI).replace(tzinfo=None)
    data, wf, wt = wn.load(db, now)
    numbers = wn.build(data, wf, wt)
    key = numbers["week"]["key"]
    print(f"Week {wf} .. {wt} ({key}); history log first day {data['since']}\n")

    print("=== 1. The saved weekly report ===")
    for d in db.collection("pricing_weekly").stream():
        w = d.to_dict() or {}
        r = w.get("report") or {}
        print(f"  {d.id}: ts {w.get('ts')} ai_calls {w.get('ai_calls')} checked {r.get('checked')} error {r.get('error')} draft_items {r.get('draft_items')} "
              f"kept {sum(len(r.get(n) or []) for n in ('worked', 'didnt', 'upgrades'))} removed {len(r.get('removed') or [])} edited {r.get('edited')}")
        print(f"     headline: {(r.get('headline') or '')[:160]}")
        for x in (r.get('removed') or [])[:6]:
            print(f"     removed {x.get('id')}: {x.get('why')}")

    print("\n=== 2. Drops in the last 3 days: were they empty nights that then got booked? ===")
    stays = data["stays"]
    pe = [e for e in data["price_events"] if wf <= e.get("day", "") <= wt]
    for rt in numbers["rooms"]:
        l3 = [e for e in pe if e.get("rt") == rt and e.get("written") and e.get("old") is not None and e.get("new") is not None
              and e.get("kind") != "tonight" and e.get("days_out") is not None and e["days_out"] <= 3 and e["new"] < e["old"]]
        if not l3:
            continue
        nights = {e["date"] for e in l3}
        empty_at_drop = sum(1 for e in l3 if (e.get("avail") or 0) > 0)
        sold_events, sold_nights, examples = 0, set(), []
        for e in l3:
            hit = [s for s in stays if s["rt"] == rt and s.get("created") and s["created"] >= e["day"] and s["checkin"] <= e["date"] < s["checkout"]]
            if hit:
                sold_events += 1
                sold_nights.add(e["date"])
                if len(examples) < 3:
                    examples.append(f"night {e['date']} lowered {e['old']:g}->{e['new']:g} on {e['day']} ({e.get('currency')}), booked on {hit[0]['created']}")
        print(f"  {rt}: {len(l3)} drops on {len(nights)} nights | empty when lowered (free units > 0): {empty_at_drop} of {len(l3)} | "
              f"drops on nights booked afterwards: {sold_events} (those are {len(sold_nights)} nights) | code says {numbers['rooms'][rt]['last3_nights_lowered_then_booked']} nights")
        for x in examples:
            print("      e.g.", x)

    print("\n=== 3. Big apartment (BIG_APT) ===")
    rt = "BIG_APT"
    mine = [e for e in pe if e.get("rt") == rt]
    drops = [e for e in mine if e.get("written") and e.get("old") is not None and e.get("new") is not None and e["new"] < e["old"]]
    print(f"  price events {len(mine)}; written drops {len(drops)} on {len({e['date'] for e in drops})} different nights, "
          f"by price list {dict(collections.Counter(e.get('currency') for e in drops))}, by kind {dict(collections.Counter(e.get('kind') for e in drops))}")
    msgs = collections.Counter(str(b)[:70] for e in mine for b in (e.get("blocked") or []))
    ev_blocked = sum(1 for e in mine if e.get("blocked"))
    print(f"  events with a held-back message: {ev_blocked}; messages: {sum(msgs.values())} on {len({e['date'] for e in mine if e.get('blocked')})} nights")
    for m, n in msgs.most_common(5):
        print(f"      {n} x {m}")
    print(f"  the report says: held_back_other {numbers['rooms'][rt]['held_back_other']}, price_drops_written {numbers['rooms'][rt]['price_drops_written']}, bookings made {numbers['rooms'][rt]['bookings_made']}, nights sold {numbers['rooms'][rt]['nights_sold']}")
    # nights closed in MiniHotel: no free unit, but no counted stay on that night
    from minihotel_auth import get_session_cookie
    today = now.date()
    inv = ps.fetch_inventory(get_session_cookie(), today, 120, room_types=[rt]).get(rt, {})
    stay_nights = set()
    for s in stays:
        if s["rt"] == rt:
            d = date.fromisoformat(s["checkin"])
            while d < date.fromisoformat(s["checkout"]):
                stay_nights.add(d.isoformat())
                d += timedelta(days=1)
    zero = [d for d, c in sorted(inv.items()) if d >= today.isoformat() and int(c.get("avail") or 0) == 0]
    closed = [d for d in zero if d not in stay_nights]
    print(f"  next 120 days: {len(zero)} nights with no free unit; {len(closed)} of them have NO confirmed stay (closed or blocked in MiniHotel): {ranges(closed) or 'none'}")
    if closed:
        st = collections.Counter()
        for doc in db.collection("reservations").stream():
            r = doc.to_dict() or {}
            if ps.ROOM_CODE_TO_RT.get(r.get("roomCode", "")) == rt and ps._iso_day(r.get("checkin")) and ps._iso_day(r.get("checkout")):
                ci, co = ps._iso_day(r.get("checkin")), ps._iso_day(r.get("checkout"))
                if any(ci <= d < co for d in closed):
                    st[f"{str(r.get('status', '')).upper() or '(none)'} {ci}..{co} booked {ps._iso_day(r.get('creationDate'))}"] += 1
        print(f"  reservation records covering those closed nights (any status): {dict(st) or 'none'}")
    print(f"  nights with a stay: {len(zero) - len(closed)}: {ranges([d for d in zero if d in stay_nights]) or 'none'}")

    print("\n=== 4. Cancellations: real, or changes of an existing booking? ===")
    be = [e for e in data["booking_events"] if wf <= e.get("day", "") <= wt and e.get("day", "") > data["since"] and e.get("event") == "cancellation"]
    refs = {e["ref"]: e for e in be}
    print(f"  cancellation events in the week: {len(be)} (log first day {data['since']}); by room {dict(collections.Counter(e['rt'] for e in be))}; by day {dict(sorted(collections.Counter(e['day'] for e in be).items()))}")
    allres = {}
    for doc in db.collection("reservations").stream():
        r = doc.to_dict() or {}
        allres[doc.id] = r
    sample = next((r for r in allres.values() if str(r.get("status", "")).upper() == "CANCELLED"), {})
    print(f"  fields on a cancelled reservation: {sorted(sample.keys())}")
    print(f"  status values seen: {dict(collections.Counter(str(r.get('status', '')).upper() for r in allres.values()))}")
    by_book = collections.defaultdict(list)
    for did, r in allres.items():
        by_book[str(r.get("bookingId") or r.get("reservationNumber") or did).split("_")[0]].append((did, r))
    by_guest = collections.defaultdict(list)
    for did, r in allres.items():
        nm = str(r.get("guestName") or r.get("name") or r.get("firstName", "") + r.get("lastName", "")).strip().lower()
        if nm:
            by_guest[hashlib.sha1(nm.encode()).hexdigest()[:10]].append((did, r))
    kinds = collections.Counter()
    per_room = collections.defaultdict(collections.Counter)
    for did, r in allres.items():
        ref = pmslog.ref_hash(r.get("reservationNumber") or r.get("id") or did)
        # the event id uses s.get("reservationNumber") or s.get("id")
        e = refs.get(ref)
        if not e:
            continue
        base = str(r.get("bookingId") or r.get("reservationNumber") or did).split("_")[0]
        others = [x for x in by_book[base] if x[0] != did and str(x[1].get("status", "")).upper() in ("OK", "OK2")]
        nm = str(r.get("guestName") or r.get("name") or r.get("firstName", "") + r.get("lastName", "")).strip().lower()
        g = hashlib.sha1(nm.encode()).hexdigest()[:10] if nm else None
        rebook = [x for x in by_guest.get(g, []) if x[0] != did and str(x[1].get("status", "")).upper() in ("OK", "OK2")
                  and abs((date.fromisoformat(str(x[1].get("creationDate"))[:10]) - date.fromisoformat(e["day"])).days) <= 2] if g else []
        past = e["checkin"] < e["day"]
        k = "same booking still has a live line (room or date change)" if others else ("same guest booked again within 2 days (likely a change)" if rebook else ("stay already over when cancelled" if past else "real cancellation"))
        kinds[k] += 1
        per_room[e["rt"]][k] += 1
    print(f"  matched {sum(kinds.values())} of {len(be)} events to a reservation record")
    for k, n in kinds.most_common():
        print(f"      {n}  {k}")
    for rt_, c in sorted(per_room.items()):
        print(f"  {rt_}: {dict(c)}")


if __name__ == "__main__":
    main()
