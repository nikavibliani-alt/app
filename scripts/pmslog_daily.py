"""
Daily history job (pmslog): snapshot of every night 365 days ahead, booking and cancellation events,
setting changes, export of yesterday to Cloud Storage, then removal of Firestore rows older than 90 days
(only for days whose export is confirmed). Prints counts and sizes only: no guest data, no keys.

  python scripts/pmslog_daily.py --dry   # count and print; write nothing anywhere
  python scripts/pmslog_daily.py         # write, export, prune
"""

import argparse
import json
import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pmslog  # noqa: E402
import pricing_shadow as ps  # noqa: E402
import pricing_calm_live as live  # noqa: E402


def _day(v):
    return ps._iso_day(v) if v else None


def stays_for_log(db, today, lookback=200):
    cutoff = (today - timedelta(days=lookback)).isoformat()
    out = []
    for doc in db.collection("reservations").where("checkin", ">=", cutoff).stream():
        r = doc.to_dict() or {}
        out.append({"id": doc.id, "roomCode": r.get("roomCode", ""), "checkin": _day(r.get("checkin")), "checkout": _day(r.get("checkout")),
                    "creationDate": _day(r.get("creationDate")), "status": r.get("status"), "debit": r.get("debit") or r.get("totalPrice"),
                    "currency": r.get("currency"), "source": r.get("source") or r.get("channel"), "reservationNumber": r.get("reservationNumber") or doc.id})
    return out


def main(argv=None, db=None, now=None, cookie_fn=None, get=None, bucket=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--no-snapshot", action="store_true")
    args = ap.parse_args(argv)
    now = now or datetime.now(ps.TBILISI).replace(tzinfo=None)
    today = now.date()
    db = db or ps.init_db()
    eng = pmslog.engine_version()
    report = {"dry": args.dry}

    if not args.no_snapshot:
        repo_config = json.load(open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config.json")))
        rules, settings = ps.load_rules(db, repo_config)
        rts = list(live.live_room_types(rules, settings))
        if cookie_fn is None:
            from minihotel_auth import get_session_cookie
            cookie_fn = get_session_cookie
        kw = {"get": get} if get else {}
        inv = ps.fetch_inventory(cookie_fn(), today, 365, room_types=rts, **kw)
        docs = pmslog.snapshot_docs(inv, now, {rt: (ps.ROOM_TYPES.get(rt) or {}).get("units") for rt in rts}, eng)
        report["snapshot_rooms"], report["snapshot_nights"] = len(docs), sum(d["night_count"] for d in docs.values())
        if not args.dry:
            pmslog.write_events(db, "snapshots", list(docs.values()), overwrite=True)

    stays = stays_for_log(db, today)
    bk = pmslog.booking_events(stays, lambda c: ps.ROOM_CODE_TO_RT.get(c), today, now)
    report["booking_events"] = len(bk)
    since = (now - timedelta(days=2)).isoformat()
    changes = []
    for d in db.collection("pricing_changes").stream():
        c = d.to_dict() or {}
        if c.get("fields") and str(c.get("ts", ""))[:19] >= since[:19]:
            changes.append({**c, "id": d.id})
    st = pmslog.settings_events(changes, now)
    report["settings_events"] = len(st)
    if not args.dry:
        report["booking_new"] = pmslog.write_events(db, "booking_events", bk)
        report["settings_new"] = pmslog.write_events(db, "settings_events", st)

    yesterday = (today - timedelta(days=1)).isoformat()
    if bucket is None and not args.dry:
        bucket, note = pmslog.get_bucket()
        report["bucket"] = note
    if args.dry:
        report["export"] = {s: {k: v for k, v in e.items() if k in ("rows", "bytes")}
                            for s, e in pmslog.export_day(db, None, yesterday, dry=True)["streams"].items()}
    elif bucket is None:
        print("Bucket not available: nothing exported and nothing pruned; Firestore keeps every row.")
    else:
        m = pmslog.export_day(db, bucket, yesterday)
        report["export_ok"] = m["ok"]
        cut = (today - timedelta(days=pmslog.KEEP_DAYS)).isoformat()
        report["pruned"] = pmslog.prune(db, cut)
    print("History log:", json.dumps(report, sort_keys=True, default=str))
    return report


if __name__ == "__main__":
    main()
