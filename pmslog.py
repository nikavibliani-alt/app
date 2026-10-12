"""
PMS history log: the core of a future multi-property PMS. Plain facts, append-only, kept forever.

Four streams (see docs/DATA_CAPTURE_PLAN.md). Every record carries property_id, a schema number, the time,
and (for price events) the engine version and the settings version that produced it:

  price_events     one price decision that changed something, was blocked or was stopped, and what was written
  snapshots        one document per day and room: the price and free units of every night, 365 days ahead
  booking_events   one booking or one cancellation (no guest name, phone or reservation number: a hash)
  settings_events  one changed setting: who, when, field, old, new

Recent records live in Firestore (pmslog_*) for 90 days; a daily job exports each day to Cloud Storage
(jsonl.gz) and only then removes old Firestore rows. Nothing here changes how a price is calculated, and a
failure here never stops a pricing run.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import os
from datetime import date, datetime, timedelta

PROPERTY_ID = "maxela"
SCHEMA = 1
KEEP_DAYS = 90
STREAMS = {
    "price_events": "pmslog_price_events",
    "snapshots": "pmslog_snapshots",
    "booking_events": "pmslog_booking_events",
    "settings_events": "pmslog_settings_events",
    "twin": "pricing_twin",                    # the "what if" twin: its prices next to the real ones, night by night
}
WRITE_KINDS = ("move", "correction", "fill", "reset", "far_reset", "tonight")
BUCKET_DEFAULT = "sleepy-5c962-pms-history"
BUCKET_LOCATION = "europe-west1"


# ---------------------------------------------------------------- common fields

def engine_version(env=os.environ) -> str:
    return (env.get("GITHUB_SHA") or "dev")[:10]


def settings_version(*parts) -> str:
    """A short fingerprint of the settings a run used: the same settings always give the same text."""
    return hashlib.sha1(json.dumps(parts, sort_keys=True, default=str).encode()).hexdigest()[:12]


def ref_hash(value) -> str:
    """An internal reference for a booking: not reversible without the reservation number, and never the number itself."""
    return hashlib.sha256(f"{PROPERTY_ID}|{value}".encode()).hexdigest()[:16]


def base(stream: str, now: datetime, source: str, event_id: str, **fields) -> dict:
    return {"property_id": PROPERTY_ID, "schema": SCHEMA, "stream": stream, "event_id": event_id,
            "ts": now.isoformat(), "day": now.date().isoformat(), "source": source, **fields}


# ---------------------------------------------------------------- 1. price events

def price_events(result: dict, now: datetime, run_id: str, portals: dict, engine_ver: str, settings_ver: str, sent: bool) -> list:
    """The decisions of one run that changed a price, were blocked by a rule, or were stopped by a safety check."""
    out = []
    for n, d in enumerate(result.get("decisions", [])):
        kind = d.get("kind")
        changed = kind in WRITE_KINDS or kind == "stopped"
        if not (changed or d.get("blocked")):
            continue
        new = d.get("rejected") if kind == "stopped" and d.get("rejected") is not None else d.get("proposed")
        out.append(base(
            "price_events", now, "engine", f"{run_id}-{n:05d}",
            rt=d["rt"], date=d["date"], currency=d["currency"], channels=list(portals.get(d["rt"], [])),
            old=d.get("current"), new=new, kind=kind, written=bool(d.get("write")) and kind != "stopped" and sent,
            reason=(d.get("why") or [""])[-1], blocked=(d.get("blocked") or [])[:2],
            target=d.get("target"), min=d.get("min"), max=d.get("max"), days_out=d.get("days_out"),
            units=d.get("units"), avail=d.get("avail"), style=d.get("style"), hol=d.get("holiday"),
            run_id=run_id, main_run=bool(result.get("main_run")), engine_version=engine_ver, settings_version=settings_ver))
    return out


# ---------------------------------------------------------------- 2. daily snapshot

def snapshot_docs(inventory: dict, now: datetime, units: dict, engine_ver: str) -> dict:
    """{doc_id: document}: for each room one map night -> {GEL, USD, free}. One document per day and room keeps writes low."""
    docs = {}
    day = now.date().isoformat()
    for rt, dates in inventory.items():
        nights = {}
        for ds, cell in sorted(dates.items()):
            if ds < day:
                continue
            p = cell.get("prices") or {}
            nights[ds] = {"GEL": p.get("GEL"), "USD": p.get("USD"), "free": cell.get("avail")}
        docs[f"{day}_{rt}"] = base("snapshots", now, "snapshot", f"{day}_{rt}", rt=rt, units=units.get(rt),
                                   nights=nights, night_count=len(nights), engine_version=engine_ver)
    return docs


# ---------------------------------------------------------------- 3. bookings and cancellations

def booking_events(stays: list, rt_of, today: date, now: datetime) -> list:
    """From stored reservations: a booking event for each stay booked in the last 3 days, a cancellation event for
    each stay marked cancelled. Ids are fixed per reservation, so running again never doubles anything."""
    out = []
    for s in stays:
        rt = rt_of(s.get("roomCode", ""))
        ci, co, created = s.get("checkin"), s.get("checkout"), s.get("creationDate")
        if not (rt and ci and co):
            continue
        status = str(s.get("status", "")).upper()
        try:
            nights = (date.fromisoformat(co) - date.fromisoformat(ci)).days
            ahead = (date.fromisoformat(ci) - date.fromisoformat(created)).days if created else None
        except ValueError:
            continue
        per = round(float(s.get("debit") or 0) / nights, 2) if nights > 0 and s.get("debit") else None
        rec = dict(rt=rt, checkin=ci, checkout=co, nights=nights, price_per_night=per, currency=s.get("currency"),
                   channel=(s.get("source") or "").lower() or None, booked_on=created, days_in_advance=ahead, status=status)
        ref = ref_hash(s.get("reservationNumber") or s.get("id"))
        if status == "CANCELLED":
            out.append(base("booking_events", now, "sync", f"cancel_{ref}", event="cancellation", ref=ref, **rec))
        elif status in ("OK", "OK2") and created and created >= (today - timedelta(days=3)).isoformat():
            out.append(base("booking_events", now, "sync", f"book_{ref}", event="booking", ref=ref, **rec))
    return out


# ---------------------------------------------------------------- 4. settings changes

def settings_events(changes: list, now: datetime) -> list:
    """From pricing_changes documents that carry structured fields: one event per changed field."""
    out = []
    for c in changes:
        fields = c.get("fields") or {}
        ts = c.get("ts")
        ts = ts.isoformat() if hasattr(ts, "isoformat") else str(ts or now.isoformat())
        for i, (path, v) in enumerate(sorted(fields.items())):
            out.append({"property_id": PROPERTY_ID, "schema": SCHEMA, "stream": "settings_events",
                        "event_id": f"set_{c['id']}_{i}", "ts": ts, "day": ts[:10], "source": "page",
                        "actor": c.get("by") or "unknown", "field": path, "old": v.get("old"), "new": v.get("new"),
                        "where": c.get("type"), "note": c.get("detail")})
    return out


# ---------------------------------------------------------------- writing and exporting

def write_events(db, stream: str, items: list, id_key: str = "event_id", overwrite: bool = False) -> int:
    """Append-only: a record that already exists is never changed (unless overwrite, used only for a whole day's snapshot)."""
    coll = db.collection(STREAMS[stream])
    n = 0
    batch, in_batch = db.batch(), 0
    for it in items:
        ref = coll.document(it[id_key])
        if not overwrite and ref.get().exists:
            continue
        batch.set(ref, it)
        in_batch += 1
        n += 1
        if in_batch >= 400:
            batch.commit()
            batch, in_batch = db.batch(), 0
    if in_batch:
        batch.commit()
    return n


def jsonl_gz(rows: list) -> bytes:
    text = "\n".join(json.dumps(r, sort_keys=True, default=str) for r in rows)
    return gzip.compress(text.encode() + b"\n")


def object_path(stream: str, day: str) -> str:
    return f"property_id={PROPERTY_ID}/stream={stream}/day={day}/part-0.jsonl.gz"


def read_day(db, stream: str, day: str) -> list:
    return [d.to_dict() for d in db.collection(STREAMS[stream]).where("day", "==", day).stream()]


def export_day(db, bucket, day: str, dry: bool = False) -> dict:
    """Write one day of every stream as a compressed file, read it back and compare the row count. Returns the manifest."""
    manifest = {"day": day, "streams": {}, "ok": True}
    for stream in STREAMS:
        rows = read_day(db, stream, day)
        data = jsonl_gz(rows)
        entry = {"rows": len(rows), "bytes": len(data), "path": object_path(stream, day)}
        if not dry and rows:
            blob = bucket.blob(entry["path"])
            if not blob.exists():                                  # never overwritten: a day is exported once
                blob.upload_from_string(data, content_type="application/gzip")
            back = gzip.decompress(blob.download_as_bytes()).decode().strip().splitlines()
            entry["verified"] = len(back) == len(rows)
            manifest["ok"] = manifest["ok"] and entry["verified"]
        manifest["streams"][stream] = entry
    if not dry:
        db.collection("pmslog_exports").document(day).set({**manifest, "exported_at": datetime.utcnow().isoformat()})
    return manifest


def prune(db, before_day: str, dry: bool = False) -> dict:
    """Remove Firestore rows older than KEEP_DAYS, but only for days whose export is confirmed."""
    removed = {s: 0 for s in STREAMS}
    for snap in db.collection("pmslog_exports").stream():
        m = snap.to_dict() or {}
        if not m.get("ok") or m.get("day", "9999") >= before_day:
            continue
        for stream in STREAMS:
            for d in db.collection(STREAMS[stream]).where("day", "==", m["day"]).stream():
                if not dry:
                    db.collection(STREAMS[stream]).document(d.id).delete()
                removed[stream] += 1
    return removed


def get_bucket(name: str = BUCKET_DEFAULT, create: bool = True):
    """The history bucket in europe-west1 (versioning on, no retention lock). Returns (bucket, note); bucket is None when
    it cannot be reached or created: nothing is lost then, Firestore keeps the days and the next run tries again."""
    try:
        from firebase_admin import storage
        client = storage.bucket(name).client
        b = client.bucket(name)
        if b.exists(timeout=20):
            return b, "exists"
        if not create:
            return None, "missing"
        b = client.create_bucket(name, location=BUCKET_LOCATION, timeout=30)
        b.versioning_enabled = True
        b.patch(timeout=30)
        return b, "created"
    except Exception as e:  # noqa: BLE001
        return None, f"{type(e).__name__}: {str(e)[:160]}"
