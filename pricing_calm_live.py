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
  python pricing_calm_live.py --reset XCV_1,XCV_2 [--dry]
      # ONE-TIME price reset for those room types only (see reset_report). Any free date
      # priced above its plain target (start x weekend x holiday, inside min/max) goes
      # straight down to it; the daily limits are skipped for this run. Never raises a
      # price. Skips today, fully booked, protected and out-of-window dates. Other live
      # room types and the six old ones are not read or written.
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
RESET_ALLOWED = {"XCV_1", "XCV_2"}          # the one-time reset may only ever touch these
CUR_LABEL = {"GEL": "Booking GEL", "USD": "Airbnb (EUR list)"}


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
        out[rt] = {**ps.ROOM_TYPES[rt], "fill_missing": True,
                   **{k: v for k, v in over.items() if k in ("style", "portals", "window_days", "fill_missing")},
                   "status": "live"}
        out[rt]["fill_missing"] = out[rt]["fill_missing"] is True
        if "window_days" in out[rt]:
            try:
                w = int(out[rt]["window_days"])
            except (TypeError, ValueError):
                w = 0
            if not 30 <= w <= 400:
                print(f"  {rt}: window_days {out[rt]['window_days']!r} is outside 30-400; 90 used.")
                w = 90
            out[rt]["window_days"] = w
        if out[rt].get("style") not in (None, "normal", "aggressive"):
            print(f"  {rt}: style {out[rt]['style']!r} is not valid; normal used.")
            out[rt]["style"] = "normal"
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


def parse_reset(text: str) -> set:
    rts = {x.strip() for x in (text or "").split(",") if x.strip()}
    bad = rts - RESET_ALLOWED
    if not rts or bad:
        raise SystemExit(f"--reset may only name {sorted(RESET_ALLOWED)}; got {sorted(rts) or 'nothing'}")
    return rts


def reset_report(result: dict, rts: set, today) -> dict:
    """
    Per month and price list: today's average price vs the reset price (and the engine's
    own target), dates that change, plus the safety checks. Returns {"checks": {name: bool}}.
    """
    from collections import defaultdict
    decs = [d for d in result.get("decisions", []) if d["rt"] in rts]
    print("\n" + "=" * 70)
    print(f"RESET REPORT: {', '.join(sorted(rts))} (free dates only; today, fully booked, protected skipped)")
    print("=" * 70)
    for rt in sorted(rts):
        for cur in ("GEL", "USD"):
            rows = [d for d in decs if d["rt"] == rt and d["currency"] == cur and d["avail"] > 0
                    and d["days_out"] >= 1 and d["kind"] != "protected" and d["mh_price"] > 0
                    and d.get("base_target") is not None]
            print(f"\n--- {rt} | {CUR_LABEL[cur]} | {len(rows)} free dates with a price ---")
            if not rows:
                continue
            print(f"{'month':8} {'dates':>5} {'change':>6} {'today avg':>10} {'new avg':>9} {'plain target':>13} {'engine target':>14}")
            by_m = defaultdict(list)
            for d in rows:
                by_m[d["date"][:7]].append(d)
            for m in sorted(by_m):
                g = by_m[m]
                n = len(g)
                ch = sum(1 for d in g if d["kind"] == "reset")
                avg = lambda xs: sum(xs) / len(xs)
                today_avg = avg([d["mh_price"] for d in g])
                new_avg = avg([d["proposed"] if d["kind"] == "reset" else d["current"] for d in g])
                tgt = [d["target"] for d in g if d.get("target") is not None]
                plain = avg([d["base_target"] for d in g])
                print(f"{m:8} {n:>5} {ch:>6} {today_avg:>10.1f} {new_avg:>9.1f} {plain:>13.1f} {(avg(tgt) if tgt else 0):>14.1f}")
    resets = [d for d in decs if d["kind"] == "reset"]
    writes = result.get("writes") or []
    checks = {
        "every new price is inside min and max": all(d["min"] - 1e-9 <= d["proposed"] <= d["max"] + 1e-9 for d in resets),
        "nothing was raised": all(d["proposed"] < d["current"] for d in resets)
                              and {(w["rt"], w["date"], w["currency"]) for w in writes}
                              == {(d["rt"], d["date"], d["currency"]) for d in resets},
        "only the reset room types are in the write": {w["rt"] for w in writes} <= set(rts),
        "no old room type in the write": not ({w["rt"] for w in writes} & ps.OLD_ENGINE_RTS),
        "today is not in the write": all(w["date"] > today.isoformat() for w in writes),
        "every write is a reset price": len(writes) == len(resets),
        "run was not stopped": bool(result.get("ok")) and not result.get("stopped_room_types"),
    }
    print(f"\nDates that change: {len({(d['rt'], d['date']) for d in resets})} "
          f"(price changes: Booking GEL {sum(1 for d in resets if d['currency'] == 'GEL')}, "
          f"Airbnb {sum(1 for d in resets if d['currency'] == 'USD')})")
    print("Room types in the write:", sorted({w['rt'] for w in writes}) or "none")
    for name, okv in checks.items():
        print(f"  CHECK {'OK  ' if okv else 'FAIL'} {name}")
    return {"checks": checks, "all_ok": all(checks.values())}


def far_reset_counts(result: dict, live_rts) -> dict:
    """How many far dates (61+ days, above target) went straight to their target, per room type."""
    out = {rt: 0 for rt in sorted(live_rts)}
    for d in result.get("decisions", []):
        if d["kind"] == "far_reset":
            out[d["rt"]] = out.get(d["rt"], 0) + 1
    return out


def far_reset_problems(result: dict, live_rts) -> list:
    """Safety check on far resets: only live room types, 61+ days away, strictly lower, inside min and max."""
    bad = []
    for d in result.get("decisions", []):
        if d["kind"] != "far_reset":
            continue
        if d["rt"] not in live_rts or d["rt"] in ps.OLD_ENGINE_RTS:
            bad.append(f"{d['rt']} is not a live room type")
        if d["days_out"] < 61:
            bad.append(f"{d['rt']} {d['date']} is only {d['days_out']} days away")
        if not d["proposed"] < d["current"]:
            bad.append(f"{d['rt']} {d['date']} {d['currency']} would not go down")
        if not (d["min"] - 1e-9 <= d["proposed"] <= d["max"] + 1e-9):
            bad.append(f"{d['rt']} {d['date']} {d['currency']} is outside min/max")
    return bad


def main(argv=None, db=None, get=requests.get, post=None, cookie_fn=None, now=None):
    parser = argparse.ArgumentParser(description="Calm pricing engine, live room types")
    parser.add_argument("--dry", action="store_true", help="calculate and print; write and save nothing")
    parser.add_argument("--reset", default=None, metavar="XCV_1,XCV_2",
                        help="one-time reset: lower prices above the plain target straight to it (never raises)")
    args = parser.parse_args(argv)
    reset_rts = parse_reset(args.reset) if args.reset is not None else set()

    now = now or datetime.now(ps.TBILISI).replace(tzinfo=None)
    today = now.date()
    db = db or ps.init_db()
    repo_config = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")))
    rules, settings = ps.load_rules(db, repo_config)
    live_rts = live_room_types(rules, settings)
    if not live_rts:
        print("Calm engine live: no room type is switched to live. Nothing to do.")
        return {"ok": True, "writes": [], "sent": False}

    if reset_rts:
        missing = reset_rts - set(live_rts)
        if missing:
            raise SystemExit(f"--reset: {sorted(missing)} is not switched to live with complete prices; nothing done.")
        live_rts = {rt: v for rt, v in live_rts.items() if rt in reset_rts}      # no other room type is read or written
    cfg = ps.build_config(rules, settings, ps.load_events(db))
    cfg["room_types"] = live_rts
    paused = read_paused(db)

    with LiveWriteGuard(set(live_rts)):
        if cookie_fn is None:
            from minihotel_auth import get_session_cookie
            cookie_fn = get_session_cookie
        cookie = cookie_fn()
        days = max([cfg["window_days"]] + [int(v.get("window_days") or 0) for v in live_rts.values()])
        inventory = ps.fetch_inventory(cookie, today, days, get=get, room_types=list(live_rts))
        reservations, skipped = ps.load_reservations(db, today)
        state = ps.load_state(db, prefix=STATE_PREFIX)
        if reset_rts:
            state = {k: v for k, v in state.items() if k in reset_rts or k == "_meta"}   # others are never saved
        result = run({"now": now, "inventory": inventory, "reservations": reservations, "shadow": False,
                      **({"reset": sorted(reset_rts)} if reset_rts else {})}, cfg, state)

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
        far = far_reset_counts(result, live_rts)
        print("  Far dates (61+ days) sent straight to their target, per room type: "
              + ", ".join(f"{rt} {n}" for rt, n in far.items()))
        problems = far_reset_problems(result, live_rts)
        if problems:
            print("FAR RESET STOPPED: a safety check failed; nothing written, nothing saved.")
            for x in problems[:10]:
                print("   ", x)
            raise SystemExit(1)
        fills = sum(1 for d in result["decisions"] if d.get("fill") and d["kind"] in ("fill", "move"))
        if fills:
            print(f"  {fills} empty date(s) get a first price from your start price.")
        for d in [d for d in result["decisions"] if d["kind"] in ("move", "correction", "fill", "reset", "far_reset")][:20]:
            print(f"  {d['rt']:6} {d['date']} {d['currency']}: {d['current']:.0f} -> {d['proposed']:.0f}  ({d['why'][-1]})")

        report = reset_report(result, reset_rts, today) if reset_rts else None
        if args.dry:
            print("Dry run: nothing written to MiniHotel, nothing saved.")
            return {**result, "sent": False, "payload": payload, "report": report}
        if report is not None and not report["all_ok"]:
            print("RESET STOPPED: a safety check failed; nothing written, nothing saved.")
            raise SystemExit(1)
        extra = {"hour": now.hour, "paused": paused, **({"reset": sorted(reset_rts)} if reset_rts else {}), "room_types": sorted(live_rts), "writes": len(writes),
                 "far_reset": far}
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
        return {**result, "sent": bool(payload), "payload": payload, "failed_portals": failed_portals, "report": report}


if __name__ == "__main__":
    main()
