"""
Calm pricing engine, LIVE for the room types switched on in calm_settings.json
(first: XCV_1 and XCV_2). It writes their prices to MiniHotel and pushes them
to the channels, the same way the current engine does.

Safety:
  * Only room types with "engine": "live" in the settings are written, and NEVER
    the six room types the current engine still prices (ROOMS, MAXELA, BIG_APT,
    FREEDOM, ORBE_1, ORBE_2): two engines can never write the same room type.
  * A guard refuses any write to MiniHotel except the price write for those live
    room types, the channel push and the login.
  * The pause switch on the pricing page (pricing_config/control) stops all writes.
    If the switch cannot be read, the run counts as paused.
  * All rules of the calm engine apply (min/max, arrival day, one lowering run a
    day, 24-hour limits, protected dates, safety stops).
  * The engine memory is saved only after MiniHotel accepted the prices.

Usage:
  python pricing_calm_live.py          # live run (GitHub Actions, after the current engine)
  python pricing_calm_live.py --dry    # calculate and print; write nothing, save nothing
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime
from urllib.parse import urlparse

import requests

import pricing_shadow as ps
from calm_pricing import run

BASE_URL = "https://ssl20.minihotelpms.com"
WRITE_PATH = "/api/ScreenA"
SYNC_PATH = "/api/ScreenA/Portals/SendPrices"
DEFAULT_PORTALS = ["BOOKING", "AIRBNB"]
STATE_PREFIX = "live_"


class LiveWriteGuard:
    """
    Wraps requests.Session.request. Toward MiniHotel, besides reading and logging in,
    it allows only: the price write (POST /api/ScreenA) when every room type in it is
    one of the live room types, and the channel push (POST /api/ScreenA/Portals/SendPrices).
    """

    def __init__(self, allowed_room_types: set):
        self.allowed = set(allowed_room_types) - ps.OLD_ENGINE_RTS

    def check(self, method, url, kwargs):
        method = (method or "GET").upper()
        try:
            ps._guard_check(method, url)
            return
        except RuntimeError:
            pass
        u = urlparse(str(url))
        if method == "POST" and u.path == SYNC_PATH:
            return
        if method == "POST" and u.path == WRITE_PATH:
            body = kwargs.get("json")
            codes = {x.get("roomTypeCode") for x in body} if isinstance(body, list) else {None}
            if codes and codes <= self.allowed:
                return
            raise RuntimeError(f"pricing_calm_live.py may only write {sorted(self.allowed)}, not {sorted(map(str, codes))}")
        raise RuntimeError(f"pricing_calm_live.py refused {method} {u.hostname}{u.path}")

    def __enter__(self):
        self._orig = requests.Session.request
        orig, guard = self._orig, self

        def guarded(session, method, url, *a, **k):
            guard.check(method, url, k)
            return orig(session, method, url, *a, **k)
        requests.Session.request = guarded
        return self

    def __exit__(self, *exc):
        requests.Session.request = self._orig
        return False


def read_paused(db) -> bool:
    """pricing_config/control {paused: true}. Missing = not paused. A read error counts as paused."""
    try:
        snap = db.collection("pricing_config").document("control").get()
        return bool(snap.exists and (snap.to_dict() or {}).get("paused") is True)
    except Exception as e:                                    # noqa: BLE001
        print(f"  Could not read the pause switch ({e}); treating as PAUSED.", file=sys.stderr)
        return True


def live_room_types(rules: dict, settings: dict) -> dict:
    out = {}
    for rt, over in (settings.get("room_types") or {}).items():
        if (over or {}).get("engine") != "live" or rt in ps.OLD_ENGINE_RTS or rt not in ps.ROOM_TYPES:
            continue
        if not rules.get(rt):
            print(f"  {rt} is set to live but has no minimum/start/maximum: skipped.")
            continue
        out[rt] = {**ps.ROOM_TYPES[rt], **{k: v for k, v in over.items() if k in ("style", "portals")},
                   "status": "live"}
    return out


def build_payload(writes: list) -> list:
    """Same shape as the current engine: GEL list for Booking/Expedia; EUR list (+ *ALL, as today) for Airbnb."""
    by_rt = {}
    for w in writes:
        rates = by_rt.setdefault(w["rt"], {}).setdefault(w["date"], [])
        if w["currency"] == "GEL":
            rates.append({"PriceList": "GEL", "Price": w["price"]})
        else:
            pl = ps.PRICE_LIST.get(w["currency"], w["currency"])
            rates.append({"PriceList": pl, "Price": w["price"]})
            rates.append({"PriceList": "*ALL", "Price": w["price"]})
    return [{"roomTypeCode": rt, "Dates": [{"Date": d, "Rates": r} for d, r in sorted(dates.items())]}
            for rt, dates in sorted(by_rt.items())]


def headers(cookie: str) -> dict:
    return {"Cookie": cookie, "Accept": "application/json, text/plain, */*", "X-Requested-With": "XMLHttpRequest",
            "Content-Type": "application/json", "User-Agent": "Mozilla/5.0"}


def send_prices(payload: list, cookie: str, post=None):
    post = post or requests.post
    resp = post(BASE_URL + WRITE_PATH, json=payload, headers=headers(cookie), timeout=30)
    resp.raise_for_status()


def push_channels(portals: list, cookie: str, post=None, sleep=time.sleep):
    post = post or requests.post
    failed = []
    for portal in portals:
        for attempt in range(3):
            try:
                resp = post(f"{BASE_URL}{SYNC_PATH}?Portal={portal}", json={"portal": portal},
                            headers=headers(cookie), timeout=20)
                resp.raise_for_status()
                break
            except (requests.exceptions.ReadTimeout, requests.exceptions.ConnectionError):
                if attempt == 2:
                    failed.append(portal)
                else:
                    sleep(5)
    return failed


def main(argv=None, db=None, get=requests.get, post=None, cookie_fn=None, now=None):
    parser = argparse.ArgumentParser(description="Calm pricing engine, live room types")
    parser.add_argument("--dry", action="store_true", help="calculate and print; write and save nothing")
    args = parser.parse_args(argv)

    now = now or datetime.now(ps.TBILISI).replace(tzinfo=None)
    today = now.date()
    db = db or ps.init_db()
    repo_config = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")))
    rules, settings = ps.load_rules(db, repo_config)
    live_rts = live_room_types(rules, settings)
    if not live_rts:
        print("Calm engine live: no room type is switched to live. Nothing to do.")
        return {"ok": True, "writes": [], "sent": False}

    cfg = ps.build_config(rules, settings, ps.load_events(db))
    cfg["room_types"] = live_rts
    paused = read_paused(db)

    with LiveWriteGuard(set(live_rts)):
        if cookie_fn is None:
            from minihotel_auth import get_session_cookie
            cookie_fn = get_session_cookie
        cookie = cookie_fn()
        inventory = ps.fetch_inventory(cookie, today, cfg["window_days"], get=get, room_types=list(live_rts))
        reservations, skipped = ps.load_reservations(db, today)
        state = ps.load_state(db, prefix=STATE_PREFIX)
        result = run({"now": now, "inventory": inventory, "reservations": reservations, "shadow": False}, cfg, state)

        writes = result["writes"]
        assert all(w["rt"] in live_rts for w in writes), "write for a room type that is not live"
        payload = build_payload(writes)
        print(f"Calm engine LIVE {now:%Y-%m-%d %H:%M} Tbilisi | room types {sorted(live_rts)} | ok={result['ok']} | "
              f"stopped={result.get('stopped_room_types') or 'none'} | main run={result['main_run']} | "
              f"{len(writes)} price changes | {result['corrections']} min/max corrections"
              + (" | PAUSED" if paused else "") + (" | DRY" if args.dry else ""))
        for a in result["alerts"][:10]:
            print("  ALERT:", a)
        for w in result["warnings"][:5]:
            print("  note:", w)
        for d in [d for d in result["decisions"] if d["kind"] in ("move", "correction")][:20]:
            print(f"  {d['rt']:6} {d['date']} {d['currency']}: {d['current']:.0f} -> {d['proposed']:.0f}  ({d['why'][-1]})")

        if args.dry:
            print("Dry run: nothing written to MiniHotel, nothing saved.")
            return {**result, "sent": False, "payload": payload}
        extra = {"hour": now.hour, "paused": paused, "room_types": sorted(live_rts), "writes": len(writes)}
        if paused:
            ps.save(db, now, {}, {**result, "decisions": []}, {**extra, "note": "PAUSED: nothing written"},
                    prefix=STATE_PREFIX, daily_coll="pricing_calm_daily", runs_coll="pricing_calm_runs")
            print(f"PAUSED: {len(writes)} price changes not written.")
            return {**result, "sent": False, "payload": payload}

        failed_portals = []
        if payload:
            send_prices(payload, cookie, post=post)              # raises on error: memory is then NOT saved
            portals = sorted({p for rt in {w["rt"] for w in writes}
                              for p in (live_rts[rt].get("portals") or DEFAULT_PORTALS)})
            failed_portals = push_channels(portals, cookie, post=post)
        extra["failed_portals"] = failed_portals
        ps.save(db, now, result["state"], result, extra,
                prefix=STATE_PREFIX, daily_coll="pricing_calm_daily", runs_coll="pricing_calm_runs")
        print(f"Written: {len(writes)} prices for {sorted({w['rt'] for w in writes})}."
              + (f" Channel push failed for {failed_portals}." if failed_portals else ""))
        return {**result, "sent": bool(payload), "payload": payload, "failed_portals": failed_portals}


if __name__ == "__main__":
    main()
