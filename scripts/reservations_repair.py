"""
Repair stays our sync wrongly marked "Cancelled (not in MiniHotel)". MiniHotel is the truth: a stay that MiniHotel still shows with a valid
status (OK, OK2, CL, WL), the same dates and the same room gets its MiniHotel status back. Everything else is left as it is.

  python scripts/reservations_repair.py --dry   # counts only, writes nothing
  python scripts/reservations_repair.py         # back up the records to be changed (read back and checked), then restore them

Prints counts only (no guest names, no reservation numbers).
"""
import argparse
import gzip
import json
import os
import sys
from collections import Counter
from datetime import date, datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import minihotel_reservation_sync as m  # noqa: E402
import pmslog  # noqa: E402
import pricing_shadow as ps  # noqa: E402

MARK = "Cancelled (not in MiniHotel)"


def plan(docs: list, api: list, room_map: dict) -> dict:
    """docs: [{id, ...fields}] marked cancelled by our sync. api: MiniHotel rows. Returns {restore: [(id, row)], left: Counter, ...}."""
    by_rn = {}
    for r in api:
        by_rn.setdefault(str(r.get("reservationNumber") or "").strip(), []).append(r)
    restore, left = [], Counter()
    for d in docs:
        rows = by_rn.get(str(d.get("reservationNumber") or "").strip(), [])
        if not rows:
            left["not in MiniHotel's answer (left cancelled)"] += 1
            continue
        valid = [r for r in rows if r.get("status") in m.VALID_STATUSES]
        if not valid:
            left[f"MiniHotel status is {sorted({r.get('status') for r in rows})} (left cancelled)"] += 1
            continue
        same_room = [r for r in valid if room_map.get(r.get("roomNumber", "")) == d.get("roomCode")]
        row = same_room[0] if same_room else None
        if row is None:
            left["MiniHotel has it in another room (left; the sync moves it)"] += 1
            continue
        if m.parse_date(row.get("checkIn")) != d.get("checkin") or m.parse_date(row.get("checkOut")) != d.get("checkout"):
            left["MiniHotel has other dates (left; the sync updates it)"] += 1
            continue
        restore.append((d["id"], row))
    return {"restore": restore, "left": left}


def main(argv=None, db=None, bucket=None, now=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args(argv)
    now = now or datetime.now(ps.TBILISI).replace(tzinfo=None)
    today = now.date()
    db = db or ps.init_db()
    m.ROOM_MAP = m.build_room_map(db)
    docs = [{"id": s.id, **(s.to_dict() or {})} for s in db.collection("reservations").where("status", "==", "CANCELLED").stream()]
    docs = [d for d in docs if d.get("statusDescription") == MARK and d.get("syncSource") == "minihotel_api"]
    print(f"Marked '{MARK}': {len(docs)} records; stay already over: {sum(1 for d in docs if str(d.get('checkout')) < today.isoformat())}")
    if not docs:
        return {"found": 0}
    first = min(str(d.get("checkin") or "9999") for d in docs)
    from_date = (date.fromisoformat(first) - timedelta(days=3)).isoformat()
    to_date = (today + timedelta(days=m.SYNC_DAYS_AHEAD)).isoformat()
    session = m.login_minihotel()
    api = m.fetch_reservations(session, from_date, to_date)
    print(f"MiniHotel answer for {from_date}..{to_date}: {len(api)} rows")
    pl = plan(docs, api, m.ROOM_MAP)
    ids = {i for i, _ in pl["restore"]}
    byid = {d["id"]: d for d in docs}
    print(f"MiniHotel still shows {len(pl['restore'])} of them as valid stays with the same room and dates: they can be restored.")
    print("  they are, by MiniHotel status:", dict(Counter(r.get("status") for _, r in pl["restore"])),
          "| by room:", dict(sorted(Counter(byid[i].get("roomCode") for i in ids).items())))
    print("  by check-out month:", dict(sorted(Counter(str(byid[i].get("checkout"))[:7] for i in ids).items())))
    print("  still to come (check-out today or later):", sum(1 for i in ids if str(byid[i].get("checkout")) >= today.isoformat()))
    for k, v in pl["left"].most_common():
        print(f"  left as they are: {v} - {k}")
    gone = [byid[d["id"]] for d in docs if d["id"] not in ids]
    absent = [d for d in gone if not any(str(r.get("reservationNumber") or "").strip() == str(d.get("reservationNumber") or "").strip() for r in api)]
    gaps = Counter()
    for d in absent:
        try:
            gaps[min(max((date.fromisoformat(str(d.get("syncedAt"))[:10]) - date.fromisoformat(d["checkout"])).days, -1), 9)] += 1
        except Exception:
            gaps["?"] += 1
    print(f"Left cancelled and absent from MiniHotel's answer: {len(absent)} | by check-out month {dict(sorted(Counter(str(d.get('checkout'))[:7] for d in absent).items()))}")
    print(f"  days from check-out to the day marked (-1 = before the stay ended, 7 = the old bug's signature): {dict(sorted(gaps.items(), key=lambda kv: str(kv[0])))}")
    print(f"  of those, the stay was already over: {sum(1 for d in absent if str(d.get('checkout')) < today.isoformat())}; created in the last 60 days: {sum(1 for d in absent if str(d.get('creationDate') or '') >= (today - timedelta(days=60)).isoformat())}")
    total = len(list(db.collection("reservations").where("checkin", ">=", (today - timedelta(days=365)).isoformat()).stream()))
    print(f"Records with check-in in the last 365 days or later (what the admin page loads, it keeps the newest 1000): {total}")
    if args.dry or not pl["restore"]:
        print("DRY: nothing written." if args.dry else "Nothing to restore.")
        return {"found": len(docs), "restorable": len(pl["restore"])}
    if bucket is None:
        bucket, note = pmslog.get_bucket(create=False)
        print("History bucket:", note[:80])
    if bucket is None:
        print("Repair STOPPED: the history bucket cannot be reached, so nothing was backed up and nothing was changed.")
        raise SystemExit(1)
    rows = [byid[i] for i in sorted(ids)]
    path = f"property_id={pmslog.PROPERTY_ID}/backup/reservations_repair/{now:%Y%m%d-%H%M%S}.jsonl.gz"
    blob = bucket.blob(path)
    if blob.exists():
        raise SystemExit("Repair STOPPED: that backup file already exists.")
    blob.upload_from_string(pmslog.jsonl_gz(json.loads(json.dumps(rows, default=str))), content_type="application/gzip")
    back = gzip.decompress(blob.download_as_bytes()).decode().strip().splitlines()
    if len(back) != len(rows) or {json.loads(x)["id"] for x in back} != ids:
        print("Repair STOPPED: the backup could not be verified, so nothing was changed.")
        raise SystemExit(1)
    print(f"Backed up and verified: {len(back)} records at {path.split('/', 2)[2]}")
    from firebase_admin import firestore
    batch, n = db.batch(), 0
    for rid, row in pl["restore"]:
        batch.update(db.collection("reservations").document(rid), {
            "status": row.get("status"), "statusDescription": row.get("statusDescription") or "",
            "repairedAt": firestore.SERVER_TIMESTAMP, "repairedFrom": MARK})
        n += 1
        if n % 400 == 0:
            batch.commit()
            batch = db.batch()
    batch.commit()
    print(f"Restored {n} records to their MiniHotel status.")
    return {"found": len(docs), "restored": n, "backup": path}


if __name__ == "__main__":
    main(sys.argv[1:])
