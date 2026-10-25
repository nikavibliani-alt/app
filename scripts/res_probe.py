"""Read-only probe of the MiniHotel reservation sync. Writes NOTHING.
Prints counts, dates and non-identifying attributes only (no guest names, no reservation numbers, no cookies).
"""
import collections
import datetime
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import minihotel_reservation_sync as m  # noqa: E402

NAME_PART = os.environ.get("RES_NAME", "vorotynt").lower()


def fetch(session, a, b):
    import requests  # noqa: F401
    url = f"https://emea5.hotelpms.cloud/api/Reservations?FromDate={a}T20:00:00.000Z&ToDate={b}T20:00:00.000Z"
    r = session.get(url, headers={"Accept": "application/json", "Content-Type": "application/json"})
    if r.status_code != 200:
        print("API status", r.status_code)
        return None
    return r.json().get("reservations", [])


def d(x):
    return m.parse_date(x) if x and len(str(x)) == 8 else x


def main():
    now = datetime.datetime.utcnow()
    today = now.strftime("%Y-%m-%d")
    db = m.init_firestore()
    m.ROOM_MAP = m.build_room_map(db)
    session = m.login_minihotel()
    sync_from = (now - datetime.timedelta(days=7)).strftime("%Y-%m-%d")
    sync_to = (now + datetime.timedelta(days=60)).strftime("%Y-%m-%d")
    wide_from = (now - datetime.timedelta(days=90)).strftime("%Y-%m-%d")
    wide_to = (now + datetime.timedelta(days=420)).strftime("%Y-%m-%d")
    sync_res = fetch(session, sync_from, sync_to) or []
    wide = fetch(session, wide_from, wide_to) or []
    print(f"PROBE sync window {sync_from}..{sync_to}: {len(sync_res)} rows; wide window {wide_from}..{wide_to}: {len(wide)} rows")
    print("PROBE statuses (wide):", dict(collections.Counter(r.get("status") for r in wide)))

    # 1. the Big apartment reservation
    hits = [r for r in wide if NAME_PART in ((r.get("lastName") or "") + (r.get("firstName") or "")).lower()]
    print(f"PROBE name matches in wide window: {len(hits)}")
    for r in hits:
        rn = r.get("reservationNumber", "")
        in_sync = any(x.get("reservationNumber") == rn for x in sync_res)
        docs = [x.id for x in db.collection("reservations").where("reservationNumber", "==", rn).stream()]
        print("PROBE hit:", {
            "room": r.get("roomNumber"), "room_in_map": r.get("roomNumber") in m.ROOM_MAP,
            "status": r.get("status"), "statusDescription": r.get("statusDescription"),
            "source": r.get("source"), "checkIn": d(r.get("checkIn")), "checkOut": d(r.get("checkOut")),
            "created": d(r.get("creationDate")), "in_sync_window_result": in_sync,
            "firestore_docs": len(docs), "memberId_set": bool(r.get("memberId")),
            "currency": (r.get("balance") or {}).get("currency"),
        })
        print("PROBE hit field names:", sorted(r.keys()))

    # 2. other future reservations missing from Firestore
    have = set()
    for x in db.collection("reservations").stream():
        dd = x.to_dict() or {}
        have.add(str(dd.get("reservationNumber", "")))
    missing = []
    reasons = collections.Counter()
    for r in wide:
        ci = d(r.get("checkIn"))
        if not ci or ci < today:
            continue
        rn = str(r.get("reservationNumber", ""))
        if rn in have:
            continue
        why = []
        if r.get("status") not in m.VALID_STATUSES:
            why.append("status " + str(r.get("status")))
        if r.get("roomNumber") not in m.ROOM_MAP:
            why.append("room not mapped " + str(r.get("roomNumber")))
        if ci > sync_to:
            why.append("starts after sync window")
        reasons[" + ".join(why) or "no obvious reason"] += 1
        missing.append((ci, r.get("roomNumber"), r.get("status")))
    print(f"PROBE future reservations in MiniHotel with no Firestore doc: {len(missing)}")
    for k, v in reasons.most_common():
        print("PROBE   reason:", k, v)
    if missing:
        print("PROBE   earliest/latest check-in:", min(x[0] for x in missing), max(x[0] for x in missing))
    print("PROBE   rooms:", dict(collections.Counter(x[1] for x in missing)))
    valid_mapped_in_window = [x for x in missing if x[2] in m.VALID_STATUSES and x[1] in m.ROOM_MAP and x[0] <= sync_to]
    print("PROBE   missing although valid, mapped and inside the sync window:", len(valid_mapped_in_window))

    # window semantics: stays that started before sync_from and end inside the window
    straddle = [r for r in wide if d(r.get("checkIn")) and d(r.get("checkIn")) < sync_from and d(r.get("checkOut")) and d(r.get("checkOut")) >= sync_from]
    in_sync = {r.get("reservationNumber") for r in sync_res}
    print(f"PROBE stays starting before {sync_from} and ending after it: {len(straddle)}; returned by the sync window: {sum(1 for r in straddle if r.get('reservationNumber') in in_sync)}")
    longs = [r for r in wide if d(r.get("checkIn")) and d(r.get("checkIn")) <= sync_to and d(r.get("checkOut")) and d(r.get("checkOut")) > sync_to]
    print(f"PROBE stays starting inside window and ending after it: {len(longs)}; returned by the sync window: {sum(1 for r in longs if r.get('reservationNumber') in in_sync)}")

    # 3. 'cancelled after check-in day' stays
    wide_by = {}
    for r in wide:
        wide_by.setdefault(str(r.get("reservationNumber", "")), []).append(r)
    cancelled = []
    for x in db.collection("reservations").where("status", "==", "CANCELLED").stream():
        dd = x.to_dict() or {}
        if dd.get("checkin") and dd["checkin"] < today:
            cancelled.append((x.id, dd))
    print(f"PROBE cancelled docs with check-in in the past: {len(cancelled)}")
    cnt = collections.Counter((dd.get("statusDescription"), dd.get("syncSource")) for _, dd in cancelled)
    print("PROBE   by description/source:", dict(cnt))
    api_now = collections.Counter()
    for _id, dd in cancelled:
        rows = wide_by.get(str(dd.get("reservationNumber", "")), [])
        api_now[("absent" if not rows else rows[0].get("status"))] += 1
    print("PROBE   MiniHotel status now (wide window):", dict(api_now))
    by_room = collections.Counter(dd.get("roomCode") for _, dd in cancelled)
    print("PROBE   by room:", dict(by_room))
    by_age = collections.Counter(("checkout past" if (dd.get("checkout") or "9") < today else "still in house") for _, dd in cancelled)
    print("PROBE   by stay:", dict(by_age))

    def had_form(dd, rid):
        n = 0
        for f in db.collection("checkin_guests").where("matchedReservationId", "==", rid).stream():
            n += 1
        return n

    # sample 5 spread over rooms
    seen_rooms, sample = set(), []
    for rid, dd in sorted(cancelled, key=lambda t: t[1].get("checkin", "")):
        if dd.get("roomCode") in seen_rooms:
            continue
        seen_rooms.add(dd.get("roomCode"))
        sample.append((rid, dd))
        if len(sample) == 5:
            break
    for i, (rid, dd) in enumerate(sample, 1):
        rows = wide_by.get(str(dd.get("reservationNumber", "")), [])
        ci, co, room = dd.get("checkin"), dd.get("checkout"), dd.get("roomCode")
        hk = []
        if ci and co and room:
            day = datetime.date.fromisoformat(ci)
            while day.isoformat() < co:
                s = db.collection("hk_status").document(f"{room}_{day.isoformat()}").get()
                hk.append(bool(s.exists and (s.to_dict() or {}).get("done")))
                day += datetime.timedelta(days=1)
        ts = dd.get("syncedAt")
        print(f"PROBE sample {i}:", {
            "room": room, "checkin": ci, "checkout": co, "source": dd.get("source"),
            "our_status": dd.get("status"), "our_desc": dd.get("statusDescription"),
            "marked_at(syncedAt)": str(ts)[:19] if ts else None,
            "minihotel_now": ("absent from API" if not rows else f"{rows[0].get('status')} / {rows[0].get('statusDescription')}"),
            "checkin_forms": had_form(dd, rid), "housekeeping_days_done": f"{sum(hk)}/{len(hk)}",
            "paid_info": dd.get("credit"), "debit": dd.get("debit"),
        })

    # 4. average sold price: why missing
    counted = [x.to_dict() for x in db.collection("reservations").where("checkin", ">=", (now - datetime.timedelta(days=14)).strftime("%Y-%m-%d")).where("checkin", "<=", today).stream()]
    print("PROBE recent docs:", len(counted), "currency:", dict(collections.Counter(c.get("currency") for c in counted)),
          "debit>0:", sum(1 for c in counted if isinstance(c.get("debit"), (int, float)) and c.get("debit") > 0),
          "status:", dict(collections.Counter(c.get("status") for c in counted)))
    print("PROBE FINISHED")


if __name__ == "__main__":
    main()
