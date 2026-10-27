"""Read-only probe: does MiniHotel return the same rows for a 1-year window as for the old 60-day one?
Writes NOTHING. Prints counts, dates and non-identifying attributes only (no guest names, no reservation numbers).
"""
import collections
import datetime
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import minihotel_reservation_sync as m  # noqa: E402

NAME_PART = os.environ.get("RES_NAME", "silvi").lower()


def fetch(session, a, b):
    url = f"https://emea5.hotelpms.cloud/api/Reservations?FromDate={a}T20:00:00.000Z&ToDate={b}T20:00:00.000Z"
    t = time.time()
    r = session.get(url, headers={"Accept": "application/json", "Content-Type": "application/json"})
    took = time.time() - t
    if r.status_code != 200:
        print(f"PROBE {a}..{b}: API status {r.status_code}")
        return None, took
    return r.json().get("reservations", []), took


def keyset(rows):
    return {(str(r.get("reservationNumber", "")), str(r.get("roomNumber", ""))) for r in rows}


def d(x):
    return m.parse_date(x) if x and len(str(x)) == 8 else x


def main():
    now = datetime.datetime.utcnow()
    f = lambda n: (now + datetime.timedelta(days=n)).strftime("%Y-%m-%d")
    db = m.init_firestore()
    m.ROOM_MAP = m.build_room_map(db)
    session = m.login_minihotel()
    old, t_old = fetch(session, f(-7), f(60))
    far, t_far = fetch(session, f(60), f(365))
    new, t_new = fetch(session, f(-7), f(365))
    if old is None or new is None or far is None:
        print("PROBE a window was refused: stop")
        return
    print(f"PROBE old window {f(-7)}..{f(60)}: {len(old)} rows in {t_old:.1f}s")
    print(f"PROBE far part  {f(60)}..{f(365)}: {len(far)} rows in {t_far:.1f}s")
    print(f"PROBE new window {f(-7)}..{f(365)}: {len(new)} rows in {t_new:.1f}s")
    ko, kf, kn = keyset(old), keyset(far), keyset(new)
    print(f"PROBE old window rows missing from the new window: {len(ko - kn)}")
    print(f"PROBE new window rows in neither old nor far part: {len(kn - ko - kf)}")
    print(f"PROBE rows in new but not in old: {len(kn - ko)}")
    dates = [d(r.get("checkIn")) for r in new if d(r.get("checkIn"))]
    print(f"PROBE new window check-in range: {min(dates)} .. {max(dates)}")
    print("PROBE statuses (new):", dict(collections.Counter(r.get("status") for r in new)))
    extra = [r for r in new if (str(r.get("reservationNumber", "")), str(r.get("roomNumber", ""))) not in ko]
    valid = [r for r in extra if r.get("status") in m.VALID_STATUSES and r.get("roomNumber") in m.ROOM_MAP and r.get("roomNumber") not in m.SKIP_ROOMS]
    ota = [r for r in valid if (r.get("source") or "").lower() in {"booking", "expedia"}]
    print(f"PROBE extra rows that would be saved: {len(valid)}; of them Booking/Expedia: {len(ota)}")
    print("PROBE extra by source:", dict(collections.Counter((r.get("source") or "") for r in valid)))
    # the guest who could not find their booking
    hits = [r for r in new if NAME_PART in ((r.get("lastName") or "") + (r.get("firstName") or "")).lower()]
    print(f"PROBE name matches in the new window: {len(hits)}")
    for r in hits:
        rn = str(r.get("reservationNumber", ""))
        docs = [x.id for x in db.collection("reservations").where("reservationNumber", "==", rn).stream()]
        print("PROBE hit:", {"room": r.get("roomNumber"), "room_in_map": r.get("roomNumber") in m.ROOM_MAP, "status": r.get("status"),
                              "source": r.get("source"), "checkIn": d(r.get("checkIn")), "checkOut": d(r.get("checkOut")),
                              "in_old_window": (rn, str(r.get("roomNumber", ""))) in ko, "firestore_docs": len(docs)})
    print("PROBE FINISHED")


if __name__ == "__main__":
    main()
