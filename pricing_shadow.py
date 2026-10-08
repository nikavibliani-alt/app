"""
Shadow run of the calm pricing engine.

READS ONLY: MiniHotel availability and prices, Firestore rules and reservations.
WRITES NOTHING to MiniHotel and pushes nothing to Booking / Expedia / Airbnb.
Saves only its own results in Firestore:
  pricing_engine_state/shadow_<ROOMTYPE> + shadow__meta   (engine memory)
  pricing_shadow_daily/<YYYY-MM-DD>_<ROOMTYPE>             (old price vs new price per date)
  pricing_shadow_runs/<auto id>                            (run summary, alerts)

Usage:
  python pricing_shadow.py           # normal shadow run (cron, after the old engine)
  python pricing_shadow.py --print   # read and calculate, print, save nothing at all
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
from datetime import date, datetime, timedelta, timezone
from urllib.parse import urlparse

import requests

from calm_pricing import run, merged, learn_shape

TBILISI = timezone(timedelta(hours=4))
DATA_ENDPOINT = "https://ssl20.minihotelpms.com/api/ScreenA/Data"

# MiniHotel calls the Airbnb price list "EUR", but your Airbnb listings are in US dollars.
# Inside the engine it is called USD; when reading MiniHotel we read the "EUR" list.
PRICE_LIST = {"GEL": "GEL", "USD": "EUR"}

# Room types the engine knows. status: "live" = may write later, "suggest" = shadow only,
# "off" = ignored. In this shadow script nothing is ever written, whatever the status.
ROOM_TYPES = {
    "ROOMS":   {"units": 5, "group": "shartava",    "currencies": ["GEL"],        "status": "live"},
    "MAXELA":  {"units": 7, "group": "shartava",    "currencies": ["GEL"],        "status": "live"},
    "BIG_APT": {"units": 1, "group": "shartava",    "currencies": ["GEL", "USD"], "status": "live"},
    "FREEDOM": {"units": 3, "group": "freedom",     "currencies": ["GEL", "USD"], "status": "live"},
    "ORBE_1":  {"units": 2, "group": "orbeliani",   "currencies": ["GEL", "USD"], "status": "live"},
    "ORBE_2":  {"units": 1, "group": "orbeliani",   "currencies": ["USD"],        "status": "live"},
    "VGL_ST":  {"units": 2, "group": "vgl",         "currencies": ["GEL", "USD"], "status": "suggest"},
    "VGL_AP":  {"units": 2, "group": "vgl",         "currencies": ["GEL", "USD"], "status": "suggest"},
    "XCV_1":   {"units": 1, "group": "xcv",         "currencies": ["GEL", "USD"], "status": "suggest"},
    "XCV_2":   {"units": 1, "group": "xcv",         "currencies": ["GEL", "USD"], "status": "suggest"},
}

# Firestore reservations.roomCode -> room type (same codes as minihotel_reservation_sync.py).
ROOM_CODE_TO_RT = {
    **{f"0-{i}": "ROOMS" for i in range(1, 6)},
    "6-1": "MAXELA", "6-2": "MAXELA", "6-4": "MAXELA",
    "7-1": "MAXELA", "7-2": "MAXELA", "7-3": "MAXELA", "7-4": "MAXELA",
    "6-3": "BIG_APT",
    "tab-1": "FREEDOM", "tab-2": "FREEDOM", "tab-3": "FREEDOM",
    "orb-1": "ORBE_1", "orb-2": "ORBE_1", "orb-3": "ORBE_2",
    "vgl-st1": "VGL_ST", "vgl-st2": "VGL_ST", "vgl-ap3": "VGL_AP", "vgl-ap4": "VGL_AP",
    "xcv-1": "XCV_1", "xcv-2": "XCV_2",
}

# Only confirmed stays count. CL = cancelled (the WhatsApp code treats it so), WL = waiting list.
COUNTED_STATUSES = {"OK", "OK2"}
SEASONS = ["low", "mid", "high", "peak", "xmas_low", "new_year"]


MINIHOTEL_HOSTS = ("minihotelpms.com", "minihotel.cloud", "hotelpms.cloud")
LOGIN_URL = ("login.minihotel.cloud", "/login.aspx")


def _guard_check(method: str, url: str):
    """Allow reading anywhere. Toward MiniHotel, allow only GET and the login form."""
    method = (method or "GET").upper()
    if method in ("GET", "HEAD", "OPTIONS"):
        return
    u = urlparse(str(url))
    host = (u.hostname or "").lower()
    if not any(host == h or host.endswith("." + h) for h in MINIHOTEL_HOSTS):
        return                                   # e.g. Google sign-in for Firestore
    if method == "POST" and host == LOGIN_URL[0] and u.path.lower() == LOGIN_URL[1]:
        return                                   # logging in
    raise RuntimeError(f"pricing_shadow.py must never send data to MiniHotel ({method} {host}{u.path})")


class ReadOnlyGuard:
    """
    Wraps requests.Session.request, which every requests call goes through
    (requests.post, Session().post, requests.request(...)). Any write toward MiniHotel
    raises at once. Firestore saves go through the Google client and are allowed.
    """

    def __enter__(self):
        self._orig = requests.Session.request
        orig = self._orig

        def guarded(session, method, url, *a, **k):
            _guard_check(method, url)
            return orig(session, method, url, *a, **k)
        requests.Session.request = guarded
        return self

    def __exit__(self, *exc):
        requests.Session.request = self._orig
        return False


# --------------------------------------------------------------------------
# reading
# --------------------------------------------------------------------------

def init_db():
    import firebase_admin
    from firebase_admin import credentials, firestore
    if not firebase_admin._apps:
        sa = os.environ.get("FIREBASE_SERVICE_ACCOUNT")
        if not sa:
            raise SystemExit("FIREBASE_SERVICE_ACCOUNT is not set")
        cred = credentials.Certificate(json.loads(base64.b64decode(sa).decode()))
        firebase_admin.initialize_app(cred)
    return firestore.client()


def _units(x):
    """A unit count from MiniHotel: None for missing, empty or not a number (never guessed)."""
    if x is None or (isinstance(x, str) and not x.strip()):
        return None
    try:
        return int(float(x))
    except (TypeError, ValueError):
        return None


def fetch_inventory(cookie: str, today: date, days: int, get=requests.get, room_types=None) -> dict:
    wanted = list(room_types or ROOM_TYPES)
    params = {"rooms": ",".join(wanted), "dateFrom": today.strftime("%Y%m%d"),
              "dateTo": (today + timedelta(days=days)).strftime("%Y%m%d")}
    headers = {"Cookie": cookie, "Accept": "application/json, text/plain, */*",
               "X-Requested-With": "XMLHttpRequest", "User-Agent": "Mozilla/5.0"}
    resp = get(DATA_ENDPOINT, params=params, headers=headers, timeout=30)
    resp.raise_for_status()
    inv = {}
    for entry in resp.json():
        rt = entry.get("RoomTypeCode")
        if rt not in wanted:
            continue
        inv[rt] = {}
        for d in entry.get("Dates", []):
            ds = d["Date"].split("T")[0]
            # MiniHotel leaves "Availability" empty and puts the free units in "DefaultAvailability"
            # (checked on real data, 8 Oct 2026). 0 means fully booked: never replace a real 0.
            avail = _units(d.get("Availability"))
            if avail is None:
                avail = _units(d.get("DefaultAvailability"))
            prices = {}
            for cur, pl in PRICE_LIST.items():
                for r in d.get("Rates") or []:
                    if r.get("PriceList") == pl and r.get("Price"):
                        prices[cur] = float(r["Price"])
            inv[rt][ds] = {"avail": avail, "prices": prices}
    return inv


def _num(x):
    """A usable price: a positive number. Anything else (None, "", text, 0) is treated as not set."""
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if v > 0 else None


def _season_cell(table, rt, s):
    """table[rt][s] where any level may be missing or saved as null."""
    row = (table or {}).get(rt) if isinstance(table, dict) else None
    cell = row.get(s) if isinstance(row, dict) else None
    return cell


LOADER_WARNINGS: list = []
SETTINGS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "calm_settings.json")
OLD_ENGINE_RTS = {"ROOMS", "MAXELA", "BIG_APT", "FREEDOM", "ORBE_1", "ORBE_2"}


def load_settings_file(path: str | None = None) -> dict:
    """calm_settings.json in the repo: which room types are live, their style, protected/aggressive dates."""
    try:
        with open(path or SETTINGS_FILE) as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        LOADER_WARNINGS.append(f"calm_settings.json could not be read ({e}); ignored.")
        return {}


def merge_settings(base: dict, over: dict) -> dict:
    """Firestore settings (over) win over the file (base); room_types merged per room type; date_rules added."""
    out = {k: v for k, v in base.items()}
    for k, v in (over or {}).items():
        if k == "room_types" and isinstance(v, dict):
            rts = {rt: dict(x) for rt, x in (out.get("room_types") or {}).items()}
            for rt, x in v.items():
                rts.setdefault(rt, {}).update(x or {})
            out["room_types"] = rts
        elif k == "date_rules" and isinstance(v, list):
            out["date_rules"] = list(out.get("date_rules") or []) + v
        else:
            out[k] = v
    return out


def load_rules(db, repo_config: dict) -> tuple[dict, dict]:
    """
    Rules from the pricing page (Firestore), falling back to config.json; plus engine_v2 settings.
    A value saved as null, empty or text is ignored (the config.json value is used), never a crash.
    """
    LOADER_WARNINGS.clear()
    snap = db.collection("pricing_config").document("rules").get()
    page = snap.to_dict() if snap.exists else {}
    v2_snap = db.collection("pricing_config").document("engine_v2").get()
    v2 = v2_snap.to_dict() if v2_snap.exists else {}
    rules = {}
    for rt in ROOM_TYPES:
        for cur in ROOM_TYPES[rt]["currencies"]:
            for s in SEASONS:
                if cur == "GEL":
                    keys = ("priceRules", "startPrices", "floor_prices_gel", "ceiling_prices_gel", "base_prices_gel")
                else:
                    keys = ("eurRules", "startPricesEur", "floor_prices_eur", "ceiling_prices_eur", "base_prices_eur")
                cell = _season_cell(page.get(keys[0]), rt, s)
                cell = cell if isinstance(cell, dict) else {}
                mn = _num(cell.get("min")) or _num(_season_cell(repo_config.get(keys[2]), rt, s))
                mx = _num(cell.get("max")) or _num(_season_cell(repo_config.get(keys[3]), rt, s))
                st = _num(_season_cell(page.get(keys[1]), rt, s)) or _num(_season_cell(repo_config.get(keys[4]), rt, s))
                if mn and st and mx:
                    rules.setdefault(rt, {}).setdefault(cur, {})[s] = {"min": mn, "start": st, "max": mx}
    # engine_v2 rules (e.g. VGL and XCV) win over the above when present
    for rt, by_cur in (v2.get("rules") or {}).items():
        for cur, by_season in (by_cur or {}).items():
            for s, r in (by_season or {}).items():
                vals = {k: _num((r or {}).get(k)) for k in ("min", "start", "max")}
                if all(vals.values()):
                    rules.setdefault(rt, {}).setdefault(cur, {})[s] = vals
                else:
                    LOADER_WARNINGS.append(f"engine_v2 rules {rt} {cur} {s}: incomplete, ignored.")
    settings = merge_settings(load_settings_file(), v2.get("settings") or {})
    # season months and exact date ranges from the pricing page
    if page.get("dateOverrides") is not None:
        settings["date_overrides"] = page["dateOverrides"]
    return rules, settings


def _iso_day(x):
    try:
        return date.fromisoformat(str(x)[:10]).isoformat()
    except (TypeError, ValueError):
        return None


def load_reservations(db, today: date, lookback_days: int = 200) -> tuple[list, dict]:
    """
    Confirmed stays only (status OK / OK2) with a real booking date.
    A stay without a booking date is skipped, never guessed. Returns (stays, skipped counts).
    """
    cutoff = (today - timedelta(days=lookback_days)).isoformat()
    out, skipped = [], {"status": 0, "no_booking_date": 0, "unknown_room": 0}
    for doc in db.collection("reservations").where("checkin", ">=", cutoff).stream():
        r = doc.to_dict() or {}
        if str(r.get("status", "")).upper() not in COUNTED_STATUSES:
            skipped["status"] += 1
            continue
        rt = ROOM_CODE_TO_RT.get(r.get("roomCode", ""))
        ci, co = _iso_day(r.get("checkin")), _iso_day(r.get("checkout"))
        if not rt or not ci or not co:
            skipped["unknown_room"] += 1
            continue
        created = _iso_day(r.get("creationDate"))
        if not created or created > ci:
            skipped["no_booking_date"] += 1
            continue
        out.append({"rt": rt, "checkin": ci, "checkout": co, "created": created})
    return out, skipped


def load_events(db) -> dict:
    events = {}
    for doc in db.collection("pricing_events").where("status", "in", ["approved", "manual"]).stream():
        d = doc.to_dict() or {}
        ds = doc.id.replace("event_", "")
        if len(ds) != 10:
            ds = str(d.get("date", ""))[:10]
        if ds:
            events[ds] = {"label": d.get("label", "Event"), "pct": float(d.get("multiplier", 1.3)) - 1}
    return events


def load_state(db, prefix: str = "shadow_") -> dict:
    state = {}
    for rt in list(ROOM_TYPES) + ["_meta"]:
        snap = db.collection("pricing_engine_state").document(f"{prefix}{rt}").get()
        if snap.exists:
            state[rt] = (snap.to_dict() or {}).get("data", {})
    return state


# --------------------------------------------------------------------------
# saving (shadow results only)
# --------------------------------------------------------------------------

def save(db, now: datetime, state: dict, result: dict, extra: dict | None = None,
         prefix: str = "shadow_", daily_coll: str = "pricing_shadow_daily", runs_coll: str = "pricing_shadow_runs"):
    for rt, data in state.items():
        db.collection("pricing_engine_state").document(f"{prefix}{rt}").set({"data": data, "ts": now.isoformat()})
    day = now.date().isoformat()
    by_rt = {}
    for d in result["decisions"]:
        by_rt.setdefault(d["rt"], {})[f'{d["date"]}|{d["currency"]}'] = {
            "mh": d["mh_price"],                      # price in MiniHotel now (set by the current engine)
            "mh_list": PRICE_LIST.get(d["currency"], d["currency"]),   # MiniHotel price list it came from
            "virtual_before": d["current"],           # new engine's own price before this run
            "new": d["proposed"],                     # new engine's own price after this run (what is kept)
            "rejected": d.get("rejected"),            # a move calculated but not kept because the run stopped
            "target": d["target"], "min": d["min"], "max": d["max"], "status": d["status"],
            "avail": d["avail"], "kind": d["kind"], "why": d["why"][-4:], "blocked": d["blocked"][:2],
        }
    for rt, dates in by_rt.items():
        db.collection(daily_coll).document(f"{day}_{rt}").set(
            {"day": day, "rt": rt, "last_run": now.isoformat(), "dates": dates}, merge=True)
    db.collection(runs_coll).add({
        "ts": now.isoformat(), "day": day, "ok": result["ok"], "main_run": result["main_run"],
        "stopped_room_types": result.get("stopped_room_types", []),
        "alerts": result["alerts"][:20], "warnings": result["warnings"][:20],
        "moves": len(result["shadow_moves"]), "considered": result["considered"],
        "corrections": result["corrections"], **(extra or {}),
    })


# --------------------------------------------------------------------------

def build_config(rules: dict, settings: dict, events: dict) -> dict:
    cfg = merged(settings)
    cfg["room_types"] = {rt: dict(v) for rt, v in ROOM_TYPES.items()}
    for rt, over in (settings.get("room_types") or {}).items():
        cfg["room_types"].setdefault(rt, {}).update(over)
    # Room types without any minimum/start/maximum are not read or calculated at all.
    # Room types switched to the live engine are handled by pricing_calm_live.py, not here.
    cfg["room_types"] = {rt: v for rt, v in cfg["room_types"].items()
                         if rules.get(rt) and not (v.get("engine") == "live" and rt not in OLD_ENGINE_RTS)}
    cfg["rules"] = rules
    cfg["events"] = {**events, **cfg.get("events", {})}
    # Shadow test: always the fixed default booking timing (a settings document cannot switch it on).
    cfg["learn_timing"] = False
    return cfg


def main(argv=None, db=None, get=requests.get, cookie_fn=None, now=None):
    parser = argparse.ArgumentParser(description="Calm pricing engine, shadow run (reads only)")
    parser.add_argument("--print", action="store_true", help="calculate and print; save nothing")
    args = parser.parse_args(argv)

    with ReadOnlyGuard():
        now = now or datetime.now(TBILISI).replace(tzinfo=None)
        today = now.date()
        db = db or init_db()
        repo_config = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")))
        rules, settings = load_rules(db, repo_config)
        events = load_events(db)
        cfg = build_config(rules, settings, events)
        if cookie_fn is None:
            from minihotel_auth import get_session_cookie
            cookie_fn = get_session_cookie
        live_rts = [rt for rt, v in cfg["room_types"].items() if v.get("status", "live") != "off"]
        inventory = fetch_inventory(cookie_fn(), today, cfg["window_days"], get=get, room_types=live_rts)
        reservations, skipped = load_reservations(db, today)
        learned = {}
        for group in {v["group"] for v in cfg["room_types"].values()}:
            rts = {rt for rt, v in cfg["room_types"].items() if v["group"] == group}
            learned[group] = learn_shape([r for r in reservations if r["rt"] in rts], today, cfg["shape_default"])
        # During the shadow test the fixed default timing is used; the learned one is only recorded.
        curves = learned if cfg.get("learn_timing") else {}
        state = load_state(db)
        result = run({"now": now, "inventory": inventory, "reservations": reservations,
                      "curves": curves, "shadow": True}, cfg, state)

        assert result["writes"] == [], "shadow run produced MiniHotel writes"
        moves = result["shadow_moves"]
        print(f"Shadow run {now:%Y-%m-%d %H:%M} Tbilisi | ok={result['ok']} | "
              f"stopped room types={result.get('stopped_room_types') or 'none'} | main run={result['main_run']} | "
              f"{len(moves)} virtual moves | {result['corrections']} min/max corrections")
        for a in result["alerts"][:10]:
            print("  ALERT:", a)
        for w in result["warnings"][:5]:
            print("  note:", w)
        for m in moves[:15]:
            print(f"  {m['rt']:8} {m['date']} {m['currency']}: {m['from']:.0f} -> {m['price']:.0f} ({m['kind']})")
        print(f"  reservations used: {len(reservations)} | skipped: {skipped}")
        if not args.print:
            reversals = {}
            for m in moves:
                if m.get("reversal"):
                    reversals[m["rt"]] = reversals.get(m["rt"], 0) + 1
            extra = {"hour": now.hour, "skipped_reservations": skipped, "reversals_by_rt": reversals,
                     "loader_warnings": LOADER_WARNINGS[:20],
                     "learned_timing": {g: {str(k): round(v, 3) for k, v in sh.items()} for g, sh in learned.items()},
                     "room_types": live_rts}
            save(db, now, result["state"], result, extra)
            print("Saved shadow results (nothing was sent to MiniHotel).")
        return result


if __name__ == "__main__":
    main()
