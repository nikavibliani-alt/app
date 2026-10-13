"""
Start the ideas clean. Backs up EVERY document of pricing_proposals (ideas and weekly run markers) to the history bucket, reads the file back
and checks the count, and only then deletes them all. If the bucket cannot be reached or the check fails, nothing is deleted.

  python scripts/ideas_reset.py --dry   # count only
  python scripts/ideas_reset.py         # back up, verify, delete

Prints counts only.
"""

import argparse
import gzip
import json
import os
import sys
from collections import Counter
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pmslog  # noqa: E402
import pricing_shadow as ps  # noqa: E402


def backup_path(now: datetime) -> str:
    return f"property_id={pmslog.PROPERTY_ID}/backup/pricing_proposals/{now:%Y%m%d-%H%M%S}.jsonl.gz"


def run(db, bucket, now: datetime, dry: bool = False) -> dict:
    rows = [{"id": d.id, **(d.to_dict() or {})} for d in db.collection("pricing_proposals").stream()]
    by_status = Counter(r.get("status") or ("marker" if r.get("type") == "run_marker" else "none") for r in rows)
    out = {"found": len(rows), "by_status": dict(sorted(by_status.items())), "backed_up": 0, "deleted": 0, "path": None}
    if dry or not rows:
        print(f"Ideas reset: {len(rows)} documents {out['by_status']}" + (" | DRY: nothing backed up or deleted" if dry else ""))
        return out
    if bucket is None:
        print("Ideas reset STOPPED: the history bucket cannot be reached, so nothing was backed up and nothing was deleted.")
        raise SystemExit(1)
    path = backup_path(now)
    blob = bucket.blob(path)
    if blob.exists():
        raise SystemExit("Ideas reset STOPPED: that backup file already exists.")
    blob.upload_from_string(pmslog.jsonl_gz(rows), content_type="application/gzip")
    back = gzip.decompress(blob.download_as_bytes()).decode().strip().splitlines()
    ids = {json.loads(x)["id"] for x in back}
    if len(back) != len(rows) or ids != {r["id"] for r in rows}:
        print("Ideas reset STOPPED: the backup could not be verified, so nothing was deleted.")
        raise SystemExit(1)
    out.update({"backed_up": len(back), "path": path})
    batch, n = db.batch(), 0
    for r in rows:
        batch.delete(db.collection("pricing_proposals").document(r["id"]))
        n += 1
        if n % 400 == 0:
            batch.commit()
            batch = db.batch()
    batch.commit()
    out["deleted"] = n
    print(f"Ideas reset: {len(rows)} documents {out['by_status']} | backed up and verified ({len(back)} rows) | deleted {n}")
    return out


def main(argv=None, db=None, bucket=None, now=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args(argv)
    now = now or datetime.now(ps.TBILISI).replace(tzinfo=None)
    db = db or ps.init_db()
    if bucket is None and not args.dry:
        bucket, note = pmslog.get_bucket(create=False)
        print("History bucket:", note[:80])
    return run(db, bucket, now, args.dry)


if __name__ == "__main__":
    main()
