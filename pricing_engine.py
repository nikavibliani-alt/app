"""
Maxela Pricing Engine
======================

Reads availability + current prices from MiniHotel, applies occupancy-based
pricing rules from config.json, and writes updated prices back.

Rules:
  - availability = 0  → fully booked → SKIP (don't touch)
  - price = 0         → not set yet  → SET based on season base price
  - price > 0         → already set  → ADJUST based on occupancy tier
  - Last-minute cascade overrides engine for ROOMS/MAXELA/BIG_APT within 3 days
  - Never go below floor price
  - Lead time modifiers control max drop/raise depending on how far out date is
  - dry_run = true    → only prints what would change, no writes

Usage:
  python3 pricing_engine.py              # dry run: writes NOTHING anywhere
  python3 pricing_engine.py --report     # dry run + full table of every date
  python3 pricing_engine.py --apply      # actually write to MiniHotel
                                         # (does nothing but log if pricing_config/control is paused)
  python3 pricing_engine.py --days 60    # override window (default 90)
"""

import argparse
import json
import sys
import time
from datetime import datetime, timedelta

import requests
from minihotel_auth import get_session_cookie
from event_scanner import scan_and_update as scan_events
import os
from ai_pricing import get_booking_velocity
from claude_pricing import claude_write_daily_proposal
from price_tracker import (
    snapshot_prices, record_outcomes,
    load_experiment_locks, detect_manual_experiments,
    update_engine_prices_in_locks, record_experiment_outcome,
)
from velocity_engine import compute_prices_velocity

# ---------------------------------------------------------------------------
# CONFIG
# ---------------------------------------------------------------------------

BASE_URL       = "https://ssl20.minihotelpms.com"
DATA_ENDPOINT  = f"{BASE_URL}/api/ScreenA/Data"
WRITE_ENDPOINT = f"{BASE_URL}/api/ScreenA"
SYNC_ENDPOINT  = f"{BASE_URL}/api/ScreenA/Portals/SendPrices"

ROOM_TYPES = ["ROOMS", "MAXELA", "BIG_APT", "FREEDOM", "ORBE_1", "ORBE_2"]

CHANNEL_MATRIX = {
    "ROOMS":   {"booking": True,  "expedia": True,  "airbnb": False},
    "MAXELA":  {"booking": True,  "expedia": True,  "airbnb": False},
    "BIG_APT": {"booking": True,  "expedia": True,  "airbnb": True},
    "FREEDOM": {"booking": True,  "expedia": True,  "airbnb": True},
    "ORBE_1":  {"booking": True,  "expedia": False, "airbnb": True},
    "ORBE_2":  {"booking": False, "expedia": False, "airbnb": True},
}

# Session cookie — populated at startup via auto-login
_COOKIE = None

def get_headers():
    return {
        "Cookie": _COOKIE,
        "Accept": "application/json, text/plain, */*",
        "X-Requested-With": "XMLHttpRequest",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0",
    }


# ---------------------------------------------------------------------------
# HELPERS
# ---------------------------------------------------------------------------

def load_config(path="config.json"):
    with open(path) as f:
        return json.load(f)


def get_season(date_str: str, config: dict) -> str:
    md = date_str[5:]  # "MM-DD"
    # Firestore dateOverrides take priority (recurring yearly, cross-year aware)
    for ov in config.get("dateOverrides", []):
        frm, to = ov.get("from", ""), ov.get("to", "")
        if not frm or not to or not ov.get("season"):
            continue
        if frm <= to:
            if frm <= md <= to:
                return ov["season"]
        else:  # wraps across year boundary (e.g. 12-30 → 01-07)
            if md >= frm or md <= to:
                return ov["season"]
    # Fall back to static season ranges from config.json
    for season in config["seasons"]:
        for start, end in season["ranges"]:
            if start <= md <= end:
                return season["name"]
    return "mid"


def get_occupancy_adjustment(occupancy_pct: float, config: dict) -> float:
    for tier in config["occupancy_tiers"]:
        if tier["min_pct"] <= occupancy_pct < tier["max_pct"]:
            return tier["adjustment"]
    return 0.0


def get_lead_time_limits(days_ahead: int, config: dict, season: str = None) -> tuple:
    # Season-level override takes highest priority (e.g. new_year, peak)
    if season:
        season_override = config.get("season_lead_time_overrides", {}).get(season)
        if season_override:
            return season_override["max_drop_pct"], season_override["max_raise_pct"]
    # Lead time modifiers
    default = config.get("max_daily_change_pct", 0.15)
    for lt in config.get("lead_time_modifiers", []):
        if lt["days_min"] <= days_ahead <= lt["days_max"]:
            return lt["max_drop_pct"], lt["max_raise_pct"]
    return default, default


def get_cascade_price(rt: str, days_ahead: int, config: dict):
    cascade = config.get("last_minute_cascade", {}).get(rt)
    if not cascade:
        return None
    for entry in cascade:
        if entry["days"] == days_ahead:
            return entry["price_gel"]
    return None


def round_price(price: float, rounding: int) -> float:
    return round(price / rounding) * rounding


def get_price_from_rates(rates: list, code: str) -> float:
    for r in rates or []:
        if r.get("PriceList") == code:
            return float(r.get("Price") or 0)
    return 0.0


def days_until(date_str: str) -> int:
    today  = datetime.now().date()
    target = datetime.strptime(date_str, "%Y-%m-%d").date()
    return (target - today).days



def get_ceiling(rt: str, season: str, config: dict) -> float:
    """Return ceiling price for a property/season, or 0 if no ceiling defined."""
    return config.get("ceiling_prices_gel", {}).get(rt, {}).get(season, 0)


def load_todays_changes(db) -> dict:
    """
    Load prices already changed today from Firestore.
    Returns {rt: {date_str: price_gel}} for changes made today.
    """
    from datetime import datetime
    today = datetime.now().strftime("%Y-%m-%d")
    try:
        doc = db.collection("pricing_state").document(f"daily_{today}").get()
        if doc.exists:
            return doc.to_dict() or {}
    except Exception:
        pass
    return {}


def save_todays_changes(db, changes: dict):
    """Save today's price changes to Firestore so subsequent runs skip them."""
    from datetime import datetime
    today = datetime.now().strftime("%Y-%m-%d")
    try:
        db.collection("pricing_state").document(f"daily_{today}").set(changes, merge=True)
    except Exception as e:
        print(f"  Warning: could not save daily state: {e}", file=sys.stderr)


# ---------------------------------------------------------------------------
# FETCH
# ---------------------------------------------------------------------------

def fetch_data(date_from: str, date_to: str) -> list:
    params = {
        "rooms": ",".join(ROOM_TYPES),
        "dateFrom": date_from,
        "dateTo": date_to,
    }
    resp = requests.get(DATA_ENDPOINT, params=params, headers=get_headers(), timeout=30)
    if resp.status_code in (401, 403):
        print(f"ERROR: Auth failed ({resp.status_code}).", file=sys.stderr)
        sys.exit(1)
    resp.raise_for_status()
    return resp.json()


# ---------------------------------------------------------------------------
# CORE ENGINE
# ---------------------------------------------------------------------------

def compute_prices(raw_data: list, config: dict, todays_changes: dict = None) -> dict:
    if todays_changes is None:
        todays_changes = {}
    avail_map = {}
    price_map = {}

    for entry in raw_data:
        rt = entry.get("RoomTypeCode")
        if rt not in ROOM_TYPES:
            continue
        avail_map[rt] = {}
        price_map[rt] = {}
        for d in entry.get("Dates", []):
            date_str = d["Date"].split("T")[0] if "T" in d["Date"] else d["Date"]
            avail = d.get("Availability")
            if avail is None:
                avail = d.get("DefaultAvailability") or 0
            avail_map[rt][date_str] = int(avail)
            price_map[rt][date_str] = {
                "gel": get_price_from_rates(d.get("Rates"), "GEL"),
                "eur": get_price_from_rates(d.get("Rates"), "EUR"),
                "min_stay": d.get("MinimumNights"),
                "closed": d.get("Close", False),
            }

    results = {}

    for rt in ROOM_TYPES:
        if rt not in avail_map:
            continue

        total_units = config["unit_counts"].get(rt, 1)
        channels    = CHANNEL_MATRIX[rt]
        results[rt] = []

        for date_str in sorted(avail_map[rt].keys()):
            avail  = avail_map[rt][date_str]
            prices = price_map[rt][date_str]
            season = get_season(date_str, config)
            days   = days_until(date_str)

            # --- SKIP: fully booked ---
            if avail == 0:
                results[rt].append({
                    "date": date_str, "days_ahead": days,
                    "current_gel": prices["gel"], "proposed_gel": prices["gel"],
                    "current_eur": prices["eur"], "proposed_eur": prices["eur"],
                    "skip": True, "reason": "fully booked (avail=0)",
                })
                continue

            # --- Occupancy % ---
            booked        = total_units - avail
            occupancy_pct = (booked / total_units) * 100

            # --- Event premium ---
            event_mult  = 1.0
            event_label = ""
            if date_str in config.get("event_premiums", {}):
                ev          = config["event_premiums"][date_str]
                event_mult  = ev.get("multiplier", 1.0)
                event_label = ev.get("label", "event")

            # --- GEL price ---
            proposed_gel = prices["gel"]
            reason       = ""

            if channels.get("booking") or channels.get("expedia"):
                base_gel  = config["base_prices_gel"].get(rt, {}).get(season, 0)
                floor_gel = config["floor_prices_gel"].get(rt, {}).get(season, 0)

                date_override = config.get("date_overrides", {}).get(rt, {}).get(date_str)
                if date_override:
                    floor_gel = max(floor_gel, date_override)

                # Last-minute cascade takes priority
                cascade_price = get_cascade_price(rt, days, config)
                if cascade_price is not None:
                    proposed_gel = max(cascade_price * event_mult, floor_gel)
                    proposed_gel = round_price(proposed_gel, config.get("rounding", 5))
                    reason = f"CASCADE day={days} → {cascade_price}₾"
                    if event_label:
                        reason += f" +event({event_label})"

                elif base_gel > 0:
                    adj               = get_occupancy_adjustment(occupancy_pct, config)
                    max_drop, max_raise = get_lead_time_limits(days, config, season)
                    ceiling_gel       = config.get("ceiling_prices_gel", {}).get(rt, {}).get(season, 0)

                    if prices["gel"] == 0:
                        proposed_gel = base_gel * event_mult
                        reason = f"unset→base {base_gel}₾ season={season}"
                    else:
                        # Per-day cap: skip if already changed today and no event premium
                        already_today = todays_changes.get(rt, {}).get(date_str)
                        # Handle both old format (float) and new format (dict)
                        already_gel = already_today.get("gel") if isinstance(already_today, dict) else already_today
                        if already_gel and event_mult == 1.0:
                            proposed_gel = prices["gel"]
                            reason = "already updated today"
                        else:
                            target = prices["gel"] * (1 + adj) * event_mult
                            if target > prices["gel"]:
                                proposed_gel = min(target, prices["gel"] * (1 + max_raise))
                            else:
                                proposed_gel = max(target, prices["gel"] * (1 - max_drop))
                            reason = (
                                f"occ={occupancy_pct:.0f}% ({booked}/{total_units}) "
                                f"adj={adj:+.0%} lead={days}d "
                                f"drop={max_drop:.0%} raise={max_raise:.0%}"
                            )
                    if event_label:
                        reason += f" +event({event_label} ×{event_mult})"

                    proposed_gel = max(proposed_gel, floor_gel)
                    if ceiling_gel > 0:
                        proposed_gel = min(proposed_gel, ceiling_gel)
                    proposed_gel = round_price(proposed_gel, config.get("rounding", 5))

            # --- EUR price (Airbnb) ---
            proposed_eur = prices["eur"]
            if channels.get("airbnb"):
                base_eur  = config["base_prices_eur"].get(rt, {}).get(season, 0)
                floor_eur = config["floor_prices_eur"].get(rt, {}).get(season, 0)

                if base_eur > 0:
                    adj               = get_occupancy_adjustment(occupancy_pct, config)
                    max_drop, max_raise = get_lead_time_limits(days, config, season)

                    if prices["eur"] == 0:
                        proposed_eur = base_eur * event_mult
                    else:
                        # Per-day EUR tracking
                        already_today_eur = todays_changes.get(rt, {}).get(date_str)
                        already_eur = already_today_eur.get("eur") if isinstance(already_today_eur, dict) else None
                        if already_eur and event_mult == 1.0:
                            proposed_eur = prices["eur"]
                        else:
                            target = prices["eur"] * (1 + adj) * event_mult
                            if target > prices["eur"]:
                                proposed_eur = min(target, prices["eur"] * (1 + max_raise))
                            else:
                                proposed_eur = max(target, prices["eur"] * (1 - max_drop))

                    proposed_eur = max(proposed_eur, floor_eur)
                    ceiling_eur = config.get("ceiling_prices_eur", {}).get(rt, {}).get(season, 0)
                    if ceiling_eur > 0:
                        proposed_eur = min(proposed_eur, ceiling_eur)
                    proposed_eur = round_price(proposed_eur, config.get("rounding", 5))

            gel_changed = abs(proposed_gel - prices["gel"]) >= 1
            eur_changed = abs(proposed_eur - prices["eur"]) >= 1

            results[rt].append({
                "date":          date_str,
                "days_ahead":    days,
                "current_gel":   prices["gel"],
                "proposed_gel":  proposed_gel,
                "current_eur":   prices["eur"],
                "proposed_eur":  proposed_eur,
                "occupancy_pct": occupancy_pct,
                "season":        season,
                "skip":          False,
                "changed":       gel_changed or eur_changed,
                "reason":        reason or f"occ={occupancy_pct:.0f}% no-change",
            })

    return results


# ---------------------------------------------------------------------------
# WRITE
# ---------------------------------------------------------------------------

def build_write_payload(results: dict) -> list:
    payload = []
    for rt, dates in results.items():
        channels     = CHANNEL_MATRIX[rt]
        date_updates = []
        for d in dates:
            if d.get("skip") or not d.get("changed"):
                continue
            rates = []
            if (channels.get("booking") or channels.get("expedia")) and abs(d["proposed_gel"] - d["current_gel"]) >= 1:
                rates.append({"PriceList": "GEL",  "Price": d["proposed_gel"]})
            if channels.get("airbnb") and abs(d["proposed_eur"] - d["current_eur"]) >= 1:
                rates.append({"PriceList": "EUR",  "Price": d["proposed_eur"]})
                rates.append({"PriceList": "*ALL", "Price": d["proposed_eur"]})
            if rates:
                date_updates.append({"Date": d["date"], "Rates": rates})
        if date_updates:
            payload.append({"roomTypeCode": rt, "Dates": date_updates})
    return payload


def write_prices(payload: list):
    resp = requests.post(WRITE_ENDPOINT, json=payload, headers=get_headers(), timeout=30)
    if resp.status_code in (401, 403):
        print(f"ERROR: Auth failed on write ({resp.status_code}).", file=sys.stderr)
        sys.exit(1)
    resp.raise_for_status()


def sync_channels(results: dict):
    portals_needed = set()
    for rt, dates in results.items():
        has_changes = any(not d.get("skip") and d.get("changed") for d in dates)
        if not has_changes:
            continue
        ch = CHANNEL_MATRIX[rt]
        if ch.get("booking"):  portals_needed.add("BOOKING")
        if ch.get("expedia"):  portals_needed.add("EXPEDIA")
        if ch.get("airbnb"):   portals_needed.add("AIRBNB")

    for portal in portals_needed:
        print(f"  Syncing {portal}...")
        for attempt in range(3):
            try:
                resp = requests.post(
                    f"{SYNC_ENDPOINT}?Portal={portal}",
                    json={"portal": portal},
                    headers=get_headers(),
                    timeout=20,
                )
                resp.raise_for_status()
                break
            except (requests.exceptions.ReadTimeout, requests.exceptions.ConnectionError) as e:
                if attempt < 2:
                    print(f"  [{portal}] attempt {attempt+1}/3 failed: {e} — retrying in 5s...", file=sys.stderr)
                    time.sleep(5)
                else:
                    print(f"  [{portal}] all 3 attempts failed: {e} — skipping channel.", file=sys.stderr)
        time.sleep(2)



# ---------------------------------------------------------------------------
# WRITE GUARD + PAUSE SWITCH
# ---------------------------------------------------------------------------

_WRITES_BLOCKED = False
_GUARD_HITS = []
_MH_HOSTS = ("minihotelpms.com", "minihotel.cloud", "hotelpms.cloud")
_LOGIN_URL = "https://login.minihotel.cloud/login.aspx"


def _blocked(what: str):
    _GUARD_HITS.append(what)
    raise RuntimeError(f"WRITE BLOCKED (read-only run): {what}")


def install_write_guard():
    """
    Belt and braces for runs that must not write (dry run, paused).
    Any Firestore write, any non-GET HTTP request (MiniHotel, SendGrid, ...)
    raises while _WRITES_BLOCKED is True. The login form POST is allowed.
    """
    global _WRITES_BLOCKED
    _WRITES_BLOCKED = True
    try:
        from google.cloud.firestore_v1.document import DocumentReference
        from google.cloud.firestore_v1.batch import WriteBatch
        for name in ("set", "update", "delete", "create"):
            orig = getattr(DocumentReference, name)

            def make(orig, name):
                def guarded(self, *a, **k):
                    if _WRITES_BLOCKED:
                        _blocked(f"firestore {name} {getattr(self, 'path', '?')}")
                    return orig(self, *a, **k)
                return guarded
            setattr(DocumentReference, name, make(orig, name))
        orig_commit = WriteBatch.commit

        def guarded_commit(self, *a, **k):
            if _WRITES_BLOCKED:
                _blocked("firestore batch commit")
            return orig_commit(self, *a, **k)
        WriteBatch.commit = guarded_commit
    except Exception as e:  # firestore not installed: nothing to guard
        print(f"  (firestore guard not installed: {e})", file=sys.stderr)

    orig_request = requests.Session.request

    def guarded_request(self, method, url, *a, **k):
        if _WRITES_BLOCKED and str(method).upper() not in ("GET", "HEAD"):
            host = str(url).split("/")[2].lower() if "//" in str(url) else ""
            is_login = str(method).upper() == "POST" and str(url).split("?")[0].lower() == _LOGIN_URL
            # Google's OAuth token refresh (needed to READ Firestore) is a POST to googleapis.com
            is_google_auth = host == "oauth2.googleapis.com" or host == "www.googleapis.com"
            if not (is_login or is_google_auth):
                _blocked(f"http {str(method).upper()} {str(url).split('/')[2] if '//' in str(url) else url}")
        return orig_request(self, method, url, *a, **k)
    requests.Session.request = guarded_request


def allow_writes():
    global _WRITES_BLOCKED
    _WRITES_BLOCKED = False


def _firestore_client():
    import firebase_admin
    from firebase_admin import credentials, firestore as fs
    import base64, json as _json
    if not firebase_admin._apps:
        sa = os.environ.get("FIREBASE_SERVICE_ACCOUNT")
        if not sa:
            return None
        firebase_admin.initialize_app(credentials.Certificate(_json.loads(base64.b64decode(sa).decode())))
    return fs.client()


def read_paused() -> bool:
    """
    pricing_config/control {paused: true|false}. Missing doc = not paused.
    No Firestore credentials = cannot know, so not paused. A read ERROR counts as
    paused: a failed switch check must never turn into a live price write.
    """
    try:
        db = _firestore_client()
        if db is None:
            return False
        snap = db.collection("pricing_config").document("control").get()
        return bool(snap.exists and (snap.to_dict() or {}).get("paused") is True)
    except Exception as e:
        print(f"  Could not read pause switch ({e}); treating as PAUSED.", file=sys.stderr)
        return True


# ---------------------------------------------------------------------------
# FIRESTORE LOG
# ---------------------------------------------------------------------------

def write_firestore_log(results: dict, dry_run: bool, error: str = None, trigger: str = "scheduled",
                        paused_count: int = None):
    """Write run summary to Firestore pricing_log collection."""
    try:
        import firebase_admin
        from firebase_admin import credentials, firestore as fs
        import base64, json as _json, os

        if not firebase_admin._apps:
            sa = os.environ.get("FIREBASE_SERVICE_ACCOUNT")
            if not sa:
                return
            cred_dict = _json.loads(base64.b64decode(sa).decode())
            cred = credentials.Certificate(cred_dict)
            firebase_admin.initialize_app(cred)

        db = fs.client()

        total_changes = sum(
            len([d for d in dates if not d.get("skip") and d.get("changed")])
            for dates in results.values()
        ) if results else 0

        entry = {
            "timestamp":     fs.SERVER_TIMESTAMP,
            "dry_run":       dry_run,
            "changes_count": total_changes,
            "trigger":       trigger,
            "message":       f"{'DRY RUN' if dry_run else 'LIVE'}: {total_changes} price updates",
        }
        if paused_count is not None:
            entry["changes_count"] = 0
            entry["paused"] = True
            entry["message"] = f"PAUSED: {paused_count} changes not written"
        if error:
            entry["error"] = error

        db.collection("pricing_log").add(entry)
        print("  Log written to Firestore.")
        if paused_count is not None:
            return  # paused: one log entry only, no history card

        # Write engine_run summary to pricing_changes for the history card
        if not dry_run and results:
            all_changes = []
            for rt, dates in results.items():
                for d in dates:
                    if d.get("skip") or not d.get("changed"):
                        continue
                    if abs(d.get("proposed_gel", 0) - d.get("current_gel", 0)) >= 1:
                        all_changes.append({"property": rt, "date": d["date"],
                                            "old": d["current_gel"], "new": d["proposed_gel"], "currency": "gel"})
                    if abs(d.get("proposed_eur", 0) - d.get("current_eur", 0)) >= 1:
                        all_changes.append({"property": rt, "date": d["date"],
                                            "old": d["current_eur"], "new": d["proposed_eur"], "currency": "eur"})
            all_changes.sort(key=lambda x: abs(x["new"] - x["old"]), reverse=True)
            extra = len(all_changes) - 50
            kept = all_changes[:50]
            detail = f"{total_changes} prices changed" + (f" (+{extra} more)" if extra > 0 else "")
            try:
                db.collection("pricing_changes").add({
                    "ts":      datetime.now(),
                    "type":    "engine_run",
                    "detail":  detail,
                    "changes": kept,
                })
            except Exception as ce:
                print(f"  Warning: could not write pricing_changes: {ce}", file=sys.stderr)
    except Exception as e:
        print(f"  Firestore log error: {e}", file=sys.stderr)


def load_approved_events(config: dict) -> dict:
    """Load approved events from Firestore and merge into config event_premiums."""
    try:
        import firebase_admin
        from firebase_admin import credentials, firestore as fs
        import base64, json as _json, os

        if not firebase_admin._apps:
            sa = os.environ.get("FIREBASE_SERVICE_ACCOUNT")
            if not sa:
                return config
            cred_dict = _json.loads(base64.b64decode(sa).decode())
            cred = credentials.Certificate(cred_dict)
            firebase_admin.initialize_app(cred)

        db = fs.client()
        docs = db.collection("pricing_events").where("status", "in", ["approved", "manual"]).stream()

        premiums = {k: v for k, v in config.get("event_premiums", {}).items() if not k.startswith("_")}
        count = 0
        for doc in docs:
            data = doc.to_dict()
            # Doc ID is event_YYYY-MM-DD
            date_str = doc.id.replace("event_", "")
            if not date_str or len(date_str) != 10:
                # fallback to date field
                date_str = data.get("date", "")
            if date_str:
                premiums[date_str] = {
                    "label":      data.get("label", "Event"),
                    "multiplier": data.get("multiplier", 1.30),
                }
                count += 1

        if count:
            print(f"  Loaded {count} approved events from Firestore.")
        config["event_premiums"] = premiums
        return config
    except Exception as e:
        print(f"  Firestore events error: {e}", file=sys.stderr)
        return config


# ---------------------------------------------------------------------------
# REPORT
# ---------------------------------------------------------------------------

def print_report(results: dict, dry_run: bool):
    total_changes = 0
    total_skipped = 0

    print(f"\n{'='*80}")
    print(f"MAXELA PRICING ENGINE — {'DRY RUN (no changes written)' if dry_run else '*** LIVE RUN ***'}")
    print(f"{'='*80}\n")

    for rt, dates in results.items():
        changes = [d for d in dates if not d.get("skip") and d.get("changed")]
        skipped = [d for d in dates if d.get("skip")]
        total_changes += len(changes)
        total_skipped += len(skipped)

        if not changes:
            print(f"{rt}: no changes needed ({len(skipped)} dates fully booked)\n")
            continue

        print(f"{rt}: {len(changes)} changes  ({len(skipped)} dates fully booked)")
        print(f"  {'Date':<12} {'Days':>4} {'CurGEL':>7} {'NewGEL':>7} {'CurEUR':>7} {'NewEUR':>7}  Reason")
        print(f"  {'-'*80}")

        for d in changes:
            has_airbnb = CHANNEL_MATRIX[rt].get("airbnb")
            eur_str    = f"{d['current_eur']:>6.0f}→{d['proposed_eur']:<6.0f}" if has_airbnb else "     —      "
            gel_str    = f"{d['current_gel']:>6.0f}→{d['proposed_gel']:<6.0f}"
            print(f"  {d['date']}  {d['days_ahead']:>4}  {gel_str}  {eur_str}  {d['reason']}")
        print()

    print(f"TOTAL: {total_changes} price updates, {total_skipped} dates skipped (fully booked)\n")


def print_table(results: dict):
    """--report: one line per room type and date, nothing else (no guest data)."""
    print("\nREPORT TABLE (R | room type | date | days | cur GEL | new GEL | cur EUR | new EUR | reason)")
    for rt, dates in results.items():
        for d in dates:
            reason = d.get("reason") or ""
            if d.get("skip"):
                reason = d.get("reason") or "skipped"
            elif not d.get("changed"):
                reason = reason or "no change"
            print(f"R | {rt} | {d['date']} | {d['days_ahead']} | {d['current_gel']:.0f} | "
                  f"{d['proposed_gel']:.0f} | {d['current_eur']:.0f} | {d['proposed_eur']:.0f} | {reason}")
    print()


# ---------------------------------------------------------------------------
# MAIN
# ---------------------------------------------------------------------------

def main():
    global _COOKIE

    # Urgent mode — triggered by cancellation fast-path
    urgent = os.environ.get("PRICING_URGENT", "").lower() == "true"
    urgent_props = [p.strip() for p in os.environ.get("PRICING_PROPERTIES", "").split(",") if p.strip()]
    urgent_dates = [d.strip() for d in os.environ.get("PRICING_DATES", "").split(",") if d.strip()]

    parser = argparse.ArgumentParser(description="Maxela Pricing Engine")
    parser.add_argument("--apply", action="store_true",
                        help="Write prices to MiniHotel (default: dry run)")
    parser.add_argument("--days", type=int, default=None,
                        help="Override run window in days")
    parser.add_argument("--report", action="store_true",
                        help="Print a table of every room type/date (current vs new prices)")
    args = parser.parse_args()

    config  = load_config()
    # Only --apply writes. (config.json "dry_run" no longer turns a plain run live.)
    paused  = read_paused() if args.apply else False
    # read_only = dry run or paused: nothing may be written except the one PAUSED log line
    read_only = (not args.apply) or paused
    dry_run   = not args.apply
    if paused:
        print("PAUSED: pricing_config/control says paused. Calculating only; nothing will be written to MiniHotel.")
    if read_only:
        install_write_guard()

    if urgent:
        # Narrow window for speed: cover only the near-term cancellation dates
        if urgent_dates:
            max_days = max((days_until(d) for d in urgent_dates if d), default=14)
            window = max(max_days + 2, 7)
        else:
            window = 14
        print(f"URGENT MODE: cancellation reprice — properties={urgent_props or 'all'}, dates={urgent_dates or 'near-term'}, window={window}d")
    else:
        window = args.days or config.get("run_window_days", 90)

    # Scan for Tbilisi events and update config
    if read_only:
        print("Skipping event scan (read-only run).")
    else:
        print("Scanning for events...")
        scan_events()
    print()

    # Auto-login — no manual cookie needed
    print("Logging into MiniHotel...")
    _COOKIE = get_session_cookie()
    print("Login OK.")

    today     = datetime.now()
    date_from = today.strftime("%Y%m%d")
    date_to   = (today + timedelta(days=window)).strftime("%Y%m%d")

    print(f"Fetching data {date_from} → {date_to} ({window} days)...")
    raw = fetch_data(date_from, date_to)

    # Load approved events from Firestore into config
    print("Loading approved events...")
    config = load_approved_events(config)

    # Initialize Firestore client for AI and tracking
    _data_error = None
    _db_for_ai = None
    try:
        import firebase_admin
        from firebase_admin import firestore as _fs_ai
        if firebase_admin._apps:
            _db_for_ai = _fs_ai.client()
    except Exception:
        pass

    # Log urgent cancellation runs to pricing_changes for history card
    if urgent and _db_for_ai and not read_only:
        try:
            _db_for_ai.collection("pricing_changes").add({
                "ts":     datetime.now(),
                "type":   "urgent_run",
                "detail": f"Urgent cancellation reprice — props={urgent_props or 'all'}, dates={urgent_dates or 'near-term'}",
            })
        except Exception:
            pass

    # Record any new booking outcomes before computing new prices
    if _db_for_ai and not read_only:
        record_outcomes(raw)

    # Load pricing rules from Firestore (set from pricing page)
    if _db_for_ai:
        try:
            rules_snap = _db_for_ai.collection("pricing_config").document("rules").get()
            rules_data = rules_snap.to_dict() if rules_snap.exists else {}
            if rules_data.get("base_price_pct"):
                config["base_price_pct"] = rules_data["base_price_pct"]
            # A null / missing / non-numeric start, min or max is ignored (the config.json
            # value stays). It must never become 0, which means "no limit".
            def _ok(v):
                return isinstance(v, (int, float)) and not isinstance(v, bool)
            for _key in ("startPrices", "startPricesEur"):
                for rt, seasons in (rules_data.get(_key) or {}).items():
                    for s, v in (seasons or {}).items():
                        if _ok(v):
                            config.setdefault(_key, {}).setdefault(rt, {})[s] = v
            for _rkey, _fkey, _ckey in (("priceRules", "floor_prices_gel", "ceiling_prices_gel"),
                                        ("eurRules", "floor_prices_eur", "ceiling_prices_eur")):
                for rt, seasons in (rules_data.get(_rkey) or {}).items():
                    for s, vals in (seasons or {}).items():
                        vals = vals or {}
                        if _ok(vals.get("min")):
                            config.setdefault(_fkey, {}).setdefault(rt, {})[s] = vals["min"]
                        if _ok(vals.get("max")):
                            config.setdefault(_ckey, {}).setdefault(rt, {})[s] = vals["max"]
            if rules_data.get("dateOverrides") is not None:
                config["dateOverrides"] = rules_data["dateOverrides"]
            print(f"  Loaded pricing rules from Firestore.")
        except Exception as _bpe:
            print(f"  Warning: could not load pricing rules: {_bpe}", file=sys.stderr)
            _data_error = f"could not load pricing rules from Firestore: {_bpe}"

    print("Computing prices...")

    # Load booking velocity. get_booking_velocity() swallows its own errors and returns
    # zeros, so its warning is captured here: velocity 0 must never be used for pricing.
    velocity = {}
    if _db_for_ai:
        print("  Loading booking velocity...")
        import contextlib, io
        _cap = io.StringIO()
        with contextlib.redirect_stderr(_cap):
            velocity = get_booking_velocity(_db_for_ai)
        if _cap.getvalue():
            sys.stderr.write(_cap.getvalue())
        if "could not fetch booking velocity" in _cap.getvalue():
            _data_error = _data_error or "could not fetch booking velocity from Firestore"
    if _db_for_ai is None:
        _data_error = _data_error or "Firestore could not be reached (no client)"

    if _data_error:
        msg = f"NO PRICES WRITTEN: {_data_error}"
        print(msg, file=sys.stderr)
        if not dry_run:
            allow_writes()  # the one error log line is the only write
            write_firestore_log({}, dry_run=False, error=msg, trigger="cancellation" if urgent else "scheduled")
        sys.exit(1)

    # Load and detect manual experiment locks before computing prices
    experiment_locks = {}
    if _db_for_ai:
        today_iso   = today.strftime("%Y-%m-%d")
        date_to_iso = (today + timedelta(days=window)).strftime("%Y-%m-%d")
        print("  Checking for manual price experiments...")
        experiment_locks = load_experiment_locks(_db_for_ai, today_iso, date_to_iso)
        experiment_locks = detect_manual_experiments(_db_for_ai, raw, experiment_locks, write=not read_only)

    # Claude daily strategy analyst — runs once per day, updates config before velocity engine
    # Skipped for urgent/cancellation runs to keep them fast
    if _db_for_ai and not urgent and not read_only:
        print("  Running Claude strategy analyst...")
        config = claude_write_daily_proposal(config, _db_for_ai, velocity)

    # Run velocity engine as baseline for all properties
    print("  Running velocity-adjusted pricing engine...")
    results = compute_prices_velocity(raw, config, velocity, experiment_locks=experiment_locks)

    # Filter to urgent properties only when in urgent mode
    if urgent and urgent_props:
        results = {rt: dates for rt, dates in results.items() if rt in urgent_props}

    print_report(results, dry_run or paused)
    if args.report:
        print_table(results)

    trigger = "cancellation" if urgent else "scheduled"

    if dry_run:
        print("DRY RUN — nothing was written. Run with --apply to write changes to MiniHotel.")
        if _GUARD_HITS:
            print(f"Write guard blocked {len(_GUARD_HITS)} attempted write(s): {_GUARD_HITS[:5]}")
        return

    if paused:
        pending = sum(
            len([d for d in dates if not d.get("skip") and d.get("changed")])
            for dates in results.values()
        )
        print(f"PAUSED: {pending} changes not written.")
        allow_writes()  # the single pricing_log entry is the only write allowed
        write_firestore_log(results, dry_run=False, trigger=trigger, paused_count=pending)
        return

    payload = build_write_payload(results)
    if not payload:
        print("No changes to write.")
        return

    total_updates = sum(len(p["Dates"]) for p in payload)
    print(f"Writing {total_updates} date updates to MiniHotel...")
    write_prices(payload)
    print("Write OK.")

    if _db_for_ai:
        # Record completed manual experiments before snapshotting
        for rt, dates in results.items():
            for d in dates:
                if d.get("_experiment_released"):
                    record_experiment_outcome(
                        _db_for_ai, rt, d["date"],
                        d["_experiment_lock"],
                        booked=d.get("_experiment_booked", False),
                    )
        # Update last_engine_price baseline for future experiment detection
        update_engine_prices_in_locks(_db_for_ai, results, experiment_locks)
        # Snapshot prices for learning
        snapshot_prices(results)

    print("Syncing channels...")
    sync_channels(results)
    print("Done.")
    write_firestore_log(results, dry_run=False, trigger=trigger)


if __name__ == "__main__":
    main()
