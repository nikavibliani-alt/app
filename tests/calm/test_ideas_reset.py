import gzip
import importlib.util
import json
import os
import sys
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("ideas_reset", os.path.join(ROOT, "scripts", "ideas_reset.py"))
rs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rs)
from test_pmslog import DB, Bucket  # noqa: E402

NOW = datetime(2026, 10, 13, 14, 0, 5)


def seeded():
    db = DB()
    p = db.collection("pricing_proposals")
    p.document("a").set({"status": "pending", "property": "BIG_APT", "ts": datetime(2026, 10, 1)})
    p.document("b").set({"status": "approved", "property": "ROOMS"})
    p.document("c").set({"status": "rejected", "rejection_reason": "Replaced by a newer idea"})
    p.document("run_2026-10-12").set({"type": "run_marker", "date": "2026-10-12"})
    return db


def test_every_document_is_backed_up_and_verified_before_anything_is_deleted():
    db, bucket = seeded(), Bucket()
    out = rs.run(db, bucket, NOW)
    assert out["found"] == 4 and out["backed_up"] == 4 and out["deleted"] == 4
    assert not db.store["pricing_proposals"]
    path = "property_id=maxela/backup/pricing_proposals/20261013-140005.jsonl.gz"
    rows = [json.loads(x) for x in gzip.decompress(bucket.store[path]).decode().strip().splitlines()]
    assert sorted(r["id"] for r in rows) == ["a", "b", "c", "run_2026-10-12"]
    assert out["by_status"] == {"approved": 1, "marker": 1, "pending": 1, "rejected": 1}


def test_dry_run_changes_nothing_and_no_bucket_means_nothing_is_deleted():
    db, bucket = seeded(), Bucket()
    rs.run(db, bucket, NOW, dry=True)
    assert len(db.store["pricing_proposals"]) == 4 and not bucket.store
    try:
        rs.run(db, None, NOW)
        raise AssertionError("should have stopped")
    except SystemExit as e:
        assert e.code == 1
    assert len(db.store["pricing_proposals"]) == 4


def test_a_backup_that_does_not_match_stops_the_delete():
    class Lying(Bucket):
        def blob(self, path):
            b = super().blob(path)
            real = b.upload_from_string
            b.upload_from_string = lambda data, content_type=None: real(__import__("gzip").compress(b'{"id": "a"}\n'), content_type)
            return b
    db = seeded()
    try:
        rs.run(db, Lying(), NOW)
        raise AssertionError("should have stopped")
    except SystemExit as e:
        assert e.code == 1
    assert len(db.store["pricing_proposals"]) == 4
