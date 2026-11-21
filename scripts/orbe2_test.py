"""
Owner test: lower Orbe 2's minimum by 10% (both lari and dollars, every season) for a 3-week test, and mark it in the history
(pricing_changes, type owner_test) so the weekly report compares before and after.

  python scripts/orbe2_test.py --dry   # show every minimum, now and after, and what would be written; writes nothing
  python scripts/orbe2_test.py         # back up the two documents (read back and checked), change the minimums, write the history mark
  python scripts/orbe2_test.py --undo  # put the old minimums back (from the history mark) and close the test

Prints rooms, seasons and prices only.
"""
import argparse
import gzip
import json
import os
import sys
from datetime import date, datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pmslog  # noqa: E402
import pricing_shadow as ps  # noqa: E402

ROOM = "ORBE_2"
SHARE = 0.10
WEEKS = 3
NAME = "owner test: lower Orbe 2 minimum"
STEP = {"GEL": 5, "USD": 1}
KEYS = {"GEL": "priceRules", "USD": "eurRules"}          # the pricing page's tables ("eurRules" holds the dollar list)


def lowered(value: float, cur: str) -> float:
    """10% lower, rounded to the price grid (lari 5, dollars 1), always at least one step lower."""
    step = STEP[cur]
    new = round(value * (1 - SHARE) / step) * step
    return float(min(new, value - step)) if value - step > 0 else float(value)


def gel_rules(page: dict, repo_config: dict) -> dict:
    """Orbe 2 is priced in dollars only, so the engine does not load a lari list for it. The lari minimums still stored on the pricing page
    are read the same way the engine reads any list, so they are lowered too (they only matter if lari is ever switched on for this room)."""
    out = {}
    for season in ps.SEASONS:
        cell = ps._season_cell(page.get("priceRules"), ROOM, season)
        cell = cell if isinstance(cell, dict) else {}
        mn = ps._num(cell.get("min")) or ps._num(ps._season_cell(repo_config.get("floor_prices_gel"), ROOM, season))
        mx = ps._num(cell.get("max")) or ps._num(ps._season_cell(repo_config.get("ceiling_prices_gel"), ROOM, season))
        st = ps._num(ps._season_cell(page.get("startPrices"), ROOM, season)) or ps._num(ps._season_cell(repo_config.get("base_prices_gel"), ROOM, season))
        if mn and st and mx:
            out[season] = {"min": mn, "start": st, "max": mx}
    return out


def plan(effective: dict, v2_rules: dict) -> list:
    """effective: {cur: {season: {min,start,max}}} for the room. Returns [{cur, season, old, new, start, max, doc, path}] (a minimum is never raised to the start)."""
    out = []
    for cur, by_season in sorted(effective.items()):
        if cur not in STEP:
            continue
        for season, r in sorted(by_season.items()):
            old, start = r["min"], r["start"]
            new = lowered(old, cur)
            if new >= start or new <= 0 or new >= old:
                continue
            in_v2 = bool((((v2_rules or {}).get(ROOM) or {}).get(cur) or {}).get(season))
            doc = "engine_v2" if in_v2 else "rules"
            path = f"rules.{ROOM}.{cur}.{season}.min" if in_v2 else f"{KEYS[cur]}.{ROOM}.{season}.min"
            out.append({"cur": cur, "season": season, "old": old, "new": new, "start": start, "max": r["max"], "doc": doc, "path": path})
    return out


def main(argv=None, db=None, bucket=None, now=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--undo", action="store_true")
    args = ap.parse_args(argv)
    now = now or datetime.now(ps.TBILISI).replace(tzinfo=None)
    today = now.date()
    db = db or ps.init_db()
    marks = [dict(d.to_dict() or {}, _id=d.id) for d in db.collection("pricing_changes").where("type", "==", "owner_test").stream()]
    marks = [m for m in marks if ((m.get("test") or {}).get("room") == ROOM and not (m.get("test") or {}).get("closed"))]
    if args.undo:
        return undo(db, marks, args.dry, now)
    if marks:
        print(f"{NAME}: already running since {marks[0]['test'].get('from')}; nothing changed.")
        return {"already": True}
    repo_config = json.load(open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config.json")))
    rules, _ = ps.load_rules(db, repo_config)
    v2 = (db.collection("pricing_config").document("engine_v2").get().to_dict() or {}) if db.collection("pricing_config").document("engine_v2").get().exists else {}
    page = db.collection("pricing_config").document("rules").get().to_dict() or {}
    effective = dict(rules.get(ROOM) or {})
    if "GEL" not in effective:
        g = gel_rules(page, repo_config)
        if g:
            effective["GEL"] = g
    rows = plan(effective, v2.get("rules") or {})
    print(f"{ROOM}: {len(rows)} minimums to lower by about {SHARE:.0%} (lari to the nearest 5, dollars to the nearest 1):")
    for r in rows:
        print(f"  {r['season']:9} {r['cur']}{'' if r['cur'] == 'USD' else ' (not priced by the engine for this room)'}: minimum {r['old']:g} -> {r['new']:g} ({(r['new'] - r['old']) / r['old']:+.1%}) | start {r['start']:g} max {r['max']:g} | {r['doc']}.{r['path']}")
    if args.dry or not rows:
        print("DRY: nothing written." if args.dry else "Nothing to change.")
        return {"rows": rows}
    if bucket is None:
        bucket, note = pmslog.get_bucket(create=False)
        print("History bucket:", note[:80])
    if bucket is None:
        print("STOPPED: the history bucket cannot be reached, so nothing was backed up and nothing was changed.")
        raise SystemExit(1)
    docs = {name: (db.collection("pricing_config").document(name).get().to_dict() or {}) for name in ("rules", "engine_v2")}
    payload = [{"id": f"pricing_config/{n}", **json.loads(json.dumps(d, default=str))} for n, d in docs.items()]
    path = f"property_id={pmslog.PROPERTY_ID}/backup/orbe2_test/{now:%Y%m%d-%H%M%S}.jsonl.gz"
    blob = bucket.blob(path)
    blob.upload_from_string(pmslog.jsonl_gz(payload), content_type="application/gzip")
    back = gzip.decompress(blob.download_as_bytes()).decode().strip().splitlines()
    if len(back) != len(payload):
        print("STOPPED: the backup could not be verified, so nothing was changed.")
        raise SystemExit(1)
    print(f"Backed up and verified: {len(back)} documents at {path.split('/', 2)[2]}")
    by_doc = {}
    for r in rows:
        by_doc.setdefault(r["doc"], {})[r["path"]] = r["new"]
    for name, fields in by_doc.items():
        db.collection("pricing_config").document(name).update(fields)
    end = (today + timedelta(weeks=WEEKS)).isoformat()
    from firebase_admin import firestore
    db.collection("pricing_changes").add({
        "ts": firestore.SERVER_TIMESTAMP, "type": "owner_test", "detail": f"{NAME} by 10% (3-week test, {today.isoformat()} to {end})",
        "by": "owner (asked in chat)",
        "fields": {f"{r['doc']}/{r['path']}".replace(".", "/"): {"old": r["old"], "new": r["new"]} for r in rows},
        "test": {"room": ROOM, "name": NAME, "from": today.isoformat(), "to": end, "weeks": WEEKS, "change": "minimum -10% (lari and dollars)",
                 "paths": {f"{r['doc']}|{r['path']}": [r["old"], r["new"]] for r in rows}}})
    print(f"Changed {len(rows)} minimums and marked the test in the history ({today.isoformat()} to {end}).")
    return {"rows": rows, "from": today.isoformat(), "to": end}


def undo(db, marks, dry, now):
    if not marks:
        print("No running Orbe 2 test found.")
        return {"undone": 0}
    t = marks[0]["test"]
    by_doc = {}
    for key, (old, new) in (t.get("paths") or {}).items():
        doc, path = key.split("|", 1)
        by_doc.setdefault(doc, {})[path] = old
    print(f"Undo: put back {sum(len(v) for v in by_doc.values())} minimums." + (" DRY: nothing written." if dry else ""))
    if not dry:
        for name, fields in by_doc.items():
            db.collection("pricing_config").document(name).update(fields)
        db.collection("pricing_changes").document(marks[0]["_id"]).set({"test": {**t, "closed": now.date().isoformat(), "closed_by": "undo"}}, merge=True)
    return {"undone": len(by_doc)}


if __name__ == "__main__":
    main(sys.argv[1:])
