"""
Calm pricing engine, LIVE for the room types switched on in calm_settings.json
(XCV, VGL and, since the move, ROOMS, MAXELA, BIG_APT, FREEDOM, ORBE_1, ORBE_2). It writes their
prices to MiniHotel and pushes them to each room type's channels (BOOKING, EXPEDIA, AIRBNB), the
same way the old engine did.

Safety:
  * Only room types with "engine": "live" in the settings are written, and NEVER a room type
    listed in pricing_shadow.OLD_ENGINE_RTS (room types still on the old engine; empty now):
    two engines can never write the same room type.
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
import threading
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
VALID_PORTALS = ("BOOKING", "EXPEDIA", "AIRBNB")      # the channels MiniHotel can push to
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


def read_release(db) -> set:
    """Nights you gave back to the engine on the pricing page: pricing_config/control.release = ["ROOM|YYYY-MM-DD", ...]."""
    try:
        snap = db.collection("pricing_config").document("control").get()
        raw = (snap.to_dict() or {}).get("release") if snap.exists else None
    except Exception:
        return set()
    return {x for x in (raw or []) if isinstance(x, str) and "|" in x}


def read_own_prices(db, today: str) -> dict:
    """Prices typed on the pricing page: pricing_config/control.setprice = [{rt, date, GEL?, USD?}]. -> {"ROOM|DATE": {"GEL": x, "USD": y}}."""
    try:
        snap = db.collection("pricing_config").document("control").get()
        raw = (snap.to_dict() or {}).get("setprice") if snap.exists else None
    except Exception:
        return {}
    out = {}
    for x in raw or []:
        try:
            rt, ds = str(x["rt"]), str(x["date"])
        except (KeyError, TypeError):
            continue
        if ds < today:
            continue
        prices = {c: float(x[c]) for c in ("GEL", "USD") if x.get(c) not in (None, "")}
        if prices:
            out[f"{rt}|{ds}"] = prices
    return out


def clear_own_prices(db, done: set, today: str):
    """Take the typed prices the run has finished (and the ones for past nights) off the list; read again first so a price typed meanwhile is kept."""
    try:
        ref = db.collection("pricing_config").document("control")
        snap = ref.get()
        cur = [x for x in ((snap.to_dict() or {}).get("setprice") or [])] if snap.exists else []
        keep = [x for x in cur if isinstance(x, dict) and f"{x.get('rt')}|{x.get('date')}" not in done and str(x.get("date", "")) >= today]
        if len(keep) != len(cur):
            ref.set({"setprice": keep}, merge=True)
    except Exception as e:  # noqa: BLE001
        print(f"  Could not clear the typed-price list: {type(e).__name__}")


def clear_release(db, done: set):
    """Take the nights the run has handled off the list (read again first, so a night given back meanwhile is not lost)."""
    if not done:
        return
    try:
        ref = db.collection("pricing_config").document("control")
        snap = ref.get()
        cur = [x for x in ((snap.to_dict() or {}).get("release") or [])] if snap.exists else []
        ref.set({"release": [x for x in cur if x not in done]}, merge=True)
    except Exception as e:  # noqa: BLE001
        print(f"  Could not clear the give-back list: {type(e).__name__}")


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
        if "portals" in out[rt]:
            out[rt]["portals"] = portals_for(out[rt], rt)
        if out[rt].get("style") not in (None, "normal", "aggressive"):
            print(f"  {rt}: style {out[rt]['style']!r} is not valid; normal used.")
            out[rt]["style"] = "normal"
    return out


def portals_for(info: dict, rt: str = "?") -> list:
    """The channels to push for a room type: its "portals" setting, only valid names, in a fixed order."""
    raw = info.get("portals")
    if raw is None:
        return list(DEFAULT_PORTALS)
    names = [str(x).strip().upper() for x in raw] if isinstance(raw, (list, tuple)) else []
    good = [p for p in VALID_PORTALS if p in names]
    bad = [n for n in names if n not in VALID_PORTALS]
    if bad or not good:
        print(f"  {rt}: portals {raw!r} are not all valid ({', '.join(VALID_PORTALS)}); "
              + (f"ignoring {bad}." if good else f"{'/'.join(DEFAULT_PORTALS)} used."))
    return good or list(DEFAULT_PORTALS)


def portals_to_push(writes: list, live_rts: dict) -> list:
    """Channels to push after this run: the channels of every room type that has a price change."""
    return sorted({p for rt in {w["rt"] for w in writes} for p in portals_for(live_rts[rt], rt)}, key=VALID_PORTALS.index)


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


PUSH_TIMEOUT = 120         # seconds per try; the Expedia push takes about 60 s
CHANNEL_TOTAL_TIMEOUT = 180   # seconds for ONE channel in total (all tries); then it counts as failed and the next channel goes on


def _call_with_deadline(post, url, body, hdrs, seconds):
    """One request that can never take longer than `seconds`: it runs in a helper thread and is given up on when the time is over."""
    box = {}

    def work():
        try:
            box["resp"] = post(url, json=body, headers=hdrs, timeout=seconds)
        except BaseException as e:  # noqa: BLE001
            box["err"] = e
    t = threading.Thread(target=work, daemon=True)
    t.start()
    t.join(seconds)
    if t.is_alive():
        raise requests.exceptions.ReadTimeout(f"no answer within {seconds:g} s")
    if "err" in box:
        raise box["err"]
    return box["resp"]


def push_channels(portals: list, cookie: str, post=None, sleep=time.sleep, timeout=None, total=None, clock=time.monotonic):
    """Push each channel. A channel gets at most `total` seconds in all (3 tries inside that); if it does not answer or fails, it is
    reported as failed and the next channel goes on. Never raises for a channel problem."""
    post = post or requests.post
    total = CHANNEL_TOTAL_TIMEOUT if total is None else total
    failed = []
    for portal in portals:
        start, ok = clock(), False
        for attempt in range(3):
            left = total - (clock() - start)
            if left <= 0:
                break
            try:
                resp = _call_with_deadline(post, f"{BASE_URL}{SYNC_PATH}?Portal={portal}", {"portal": portal}, headers(cookie), min(timeout or PUSH_TIMEOUT, left))
                resp.raise_for_status()
                ok = True
                break
            except requests.exceptions.RequestException:
                if attempt < 2 and total - (clock() - start) > 10:
                    sleep(5)
        if not ok:
            failed.append(portal)
    return failed


# ---- nights that did not reach a channel: remembered, and sent again in the next run ----
PENDING_DOC = ("pricing_config", "channel_pending")
MAX_PENDING_DATES = 500


def read_pending(db) -> dict:
    """{portal: {"since": iso, "rooms": {rt: [dates]}}} of channels whose last push failed. A read problem counts as nothing pending."""
    try:
        snap = db.collection(PENDING_DOC[0]).document(PENDING_DOC[1]).get()
        raw = (snap.to_dict() or {}).get("portals") if snap.exists else None
    except Exception:
        return {}
    return {p: v for p, v in (raw or {}).items() if p in VALID_PORTALS and isinstance(v, dict)}


def write_pending(db, pending: dict):
    try:
        db.collection(PENDING_DOC[0]).document(PENDING_DOC[1]).set({"portals": pending, "updated": datetime.now().isoformat()})
    except Exception as e:  # noqa: BLE001
        print(f"  Could not save the channel re-send list: {type(e).__name__}")


def update_pending(pending: dict, attempted: list, failed: list, writes: list, live_rts: dict, now) -> dict:
    """The channels that went through leave the list; a failed channel keeps (or gets) the nights this run changed for it."""
    out = {p: v for p, v in pending.items() if p in failed or p not in attempted}
    for p in failed:
        cur = out.get(p) or {"since": now.isoformat(timespec="seconds"), "rooms": {}}
        rooms = {rt: list(ds) for rt, ds in (cur.get("rooms") or {}).items()}
        for w in writes:
            if p in portals_for(live_rts.get(w["rt"], {}), w["rt"]):
                ds = rooms.setdefault(w["rt"], [])
                if w["date"] not in ds and len(ds) < MAX_PENDING_DATES:
                    ds.append(w["date"])
        cur["rooms"] = {rt: sorted(ds) for rt, ds in rooms.items()}
        out[p] = cur
    return out


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


def log_price_events(db, result, now, portals, cfg, sent):
    """History log (pmslog): one record per changed, blocked or stopped price. Never stops or slows a run."""
    try:
        import pmslog
        run_id = now.strftime("%Y%m%d%H%M%S") + ("u" if result.get("only") else "")
        ev = pmslog.price_events(result, now, run_id, portals, pmslog.engine_version(), pmslog.settings_version(cfg.get("calm"), cfg.get("rules")), sent)
        n = pmslog.write_events(db, "price_events", ev)
        print(f"  History log: {n} price events saved.")
    except Exception as e:  # noqa: BLE001
        print(f"  History log skipped: {type(e).__name__}")


def main(argv=None, db=None, get=requests.get, post=None, cookie_fn=None, now=None):
    parser = argparse.ArgumentParser(description="Calm pricing engine, live room types")
    parser.add_argument("--dry", action="store_true", help="calculate and print; write and save nothing")
    parser.add_argument("--reset", default=None, metavar="XCV_1,XCV_2",
                        help="one-time reset: lower prices above the plain target straight to it (never raises)")
    parser.add_argument("--urgent", action="store_true", help="cancellation run: only --rooms and --dates (also PRICING_URGENT=true)")
    parser.add_argument("--rooms", default=None, help="urgent: room types, e.g. MAXELA,ROOMS (also PRICING_PROPERTIES)")
    parser.add_argument("--dates", default=None, help="urgent: nights YYYY-MM-DD,... (also PRICING_DATES)")
    args = parser.parse_args(argv)
    urgent = args.urgent or os.environ.get("PRICING_URGENT", "").lower() == "true"
    urgent_rooms = [x.strip() for x in (args.rooms if args.rooms is not None else os.environ.get("PRICING_PROPERTIES", "")).split(",") if x.strip()]
    urgent_dates = [x.strip() for x in (args.dates if args.dates is not None else os.environ.get("PRICING_DATES", "")).split(",") if x.strip()]
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

    only = None
    if urgent:
        if reset_rts:
            raise SystemExit("--urgent and --reset cannot be used together.")
        urgent_dates = sorted({d for d in urgent_dates if d >= today.isoformat() and len(d) == 10})
        wanted = [r for r in urgent_rooms if r in live_rts]
        for r in urgent_rooms:
            if r not in live_rts:
                print(f"  Cancellation run: {r} is not a live room type of the new engine; skipped.")
        if not wanted or not urgent_dates:
            print("Cancellation run: no live room type or no future night to look at. Nothing to do.")
            return {"ok": True, "writes": [], "sent": False, "urgent": True}
        live_rts = {rt: v for rt, v in live_rts.items() if rt in wanted}
        only = {"rooms": wanted, "dates": urgent_dates}
        print(f"Cancellation run: rooms {wanted}, nights {urgent_dates[:8]}{' ...' if len(urgent_dates) > 8 else ''}")

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
        if only:
            state = {k: v for k, v in state.items() if k in only["rooms"] or k == "_meta"}      # other rooms are never saved
        release = {x for x in read_release(db) if x.split("|")[0] in live_rts and (not only or (x.split("|")[0] in only["rooms"] and x.split("|")[1] in only["dates"]))}
        own_all = read_own_prices(db, today.isoformat() if hasattr(today, "isoformat") else str(today))
        own = {k: v for k, v in own_all.items() if k.split("|")[0] in live_rts and (not only or (k.split("|")[0] in only["rooms"] and k.split("|")[1] in only["dates"]))}
        result = run({"now": now, "inventory": inventory, "reservations": reservations, "shadow": False, "release_manual": sorted(release), "own_prices": own,
                      **({"reset": sorted(reset_rts)} if reset_rts else {}),
                      # a cancellation run never uses up the day's one lowering run, and only looks at its nights
                      **({"run_kind": "update", "only": only, "tonight_drop": True} if only else {})}, cfg, state)

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
        for d in [d for d in result["decisions"] if d["kind"] in ("move", "correction", "fill", "reset", "far_reset", "tonight", "own")][:20]:
            print(f"  {d['rt']:6} {d['date']} {d['currency']}: {d['current']:.0f} -> {d['proposed']:.0f}  ({d['why'][-1]})")

        report = reset_report(result, reset_rts, today) if reset_rts else None
        portals = portals_to_push(writes, live_rts)
        in_use = {p for rt_, v in live_rts.items() for p in portals_for(v, rt_)}
        pending = {p: v for p, v in read_pending(db).items() if p in in_use}
        all_portals = sorted(set(portals) | set(pending), key=VALID_PORTALS.index)
        print("  Channels it pushes after the write: " + (", ".join(portals) if portals else "none (no price change)")
              + ("  (not sent)" if args.dry else ""))
        if pending:
            print("  Channels from an earlier failed push, sent again now: " + ", ".join(sorted(pending)) + ("  (not sent)" if args.dry else ""))
        if args.dry:
            print("Dry run: nothing written to MiniHotel, nothing saved.")
            return {**result, "sent": False, "payload": payload, "portals": portals, "report": report}
        if report is not None and not report["all_ok"]:
            print("RESET STOPPED: a safety check failed; nothing written, nothing saved.")
            raise SystemExit(1)
        extra = {"hour": now.hour, "paused": paused, **({"urgent": True, "urgent_rooms": only["rooms"], "urgent_dates": only["dates"]} if only else {}), **({"reset": sorted(reset_rts)} if reset_rts else {}), "room_types": sorted(live_rts), "writes": len(writes),
                 "far_reset": far}
        if paused:
            ps.save(db, now, {}, {**result, "decisions": []}, {**extra, "note": "PAUSED: nothing written"},
                    prefix=STATE_PREFIX, daily_coll="pricing_calm_daily", runs_coll="pricing_calm_runs")
            print(f"PAUSED: {len(writes)} price changes not written.")
            return {**result, "sent": False, "payload": payload, "portals": portals}

        failed_portals = []
        if payload:
            send_prices(payload, cookie, post=post)              # raises on error: memory is then NOT saved
        if all_portals and (payload or pending):
            failed_portals = push_channels(all_portals, cookie, post=post)
        resent = [p for p in all_portals if p in pending and p not in failed_portals]
        new_pending = update_pending(pending, all_portals, failed_portals, writes, live_rts, now)
        extra["failed_portals"] = failed_portals
        extra["resent_portals"] = resent
        extra["pending_portals"] = sorted(new_pending)
        if resent:
            print(f"  Re-sent in this run: {', '.join(resent)}: OK.")
        ps.save(db, now, result["state"], result, extra,
                prefix=STATE_PREFIX, daily_coll="pricing_calm_daily", runs_coll="pricing_calm_runs")
        if new_pending != pending:
            write_pending(db, new_pending)                        # a failed channel is remembered; one that went through leaves the list
        clear_release(db, release)                                # the nights you gave back are handled: take them off the list
        if own or own_all:
            clear_own_prices(db, set(result.get("own_done") or ()), today.isoformat() if hasattr(today, "isoformat") else str(today))
            if own:
                print(f"  Prices typed on the page: {len(own)} night(s), {len(result.get('own_done') or [])} finished.")
        log_price_events(db, result, now, {rt: portals_for(v, rt) for rt, v in live_rts.items()}, cfg, bool(payload))
        print(f"Written: {len(writes)} prices for {sorted({w['rt'] for w in writes})}."
              + (f" Channel push failed for {failed_portals}." if failed_portals else ""))
        return {**result, "sent": bool(payload), "payload": payload, "portals": portals, "failed_portals": failed_portals, "report": report}


if __name__ == "__main__":
    main()
