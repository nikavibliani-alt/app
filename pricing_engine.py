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
  python3 pricing_engine.py              # dry run (safe, no writes)
  python3 pricing_engine.py --apply      # actually write to MiniHotel
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
from ai_pricing import ai_compute_prices

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
    md = date_str[5:]
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
        resp = requests.post(
            f"{SYNC_ENDPOINT}?Portal={portal}",
            json={"portal": portal},
            headers=get_headers(),
            timeout=60,
        )
        resp.raise_for_status()
        time.sleep(2)



# ---------------------------------------------------------------------------
# FIRESTORE LOG
# ---------------------------------------------------------------------------

def write_firestore_log(results: dict, dry_run: bool, error: str = None):
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
            "message":       f"{'DRY RUN' if dry_run else 'LIVE'}: {total_changes} price updates",
        }
        if error:
            entry["error"] = error

        db.collection("pricing_log").add(entry)
        print("  Log written to Firestore.")
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


# ---------------------------------------------------------------------------
# MAIN
# ---------------------------------------------------------------------------

def main():
    global _COOKIE

    parser = argparse.ArgumentParser(description="Maxela Pricing Engine")
    parser.add_argument("--apply", action="store_true",
                        help="Write prices to MiniHotel (default: dry run)")
    parser.add_argument("--days", type=int, default=None,
                        help="Override run window in days")
    args = parser.parse_args()

    config  = load_config()
    dry_run = not args.apply and config.get("dry_run", True)
    window  = args.days or config.get("run_window_days", 90)

    # Scan for Tbilisi events and update config
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

    # Load today's already-changed prices to avoid running up prices 3x per day
    todays_changes = {}
    try:
        import firebase_admin
        from firebase_admin import firestore as _fs
        if firebase_admin._apps:
            _db = _fs.client()
            todays_changes = load_todays_changes(_db)
            if todays_changes:
                print(f"  Found {sum(len(v) for v in todays_changes.values() if isinstance(v,dict))} prices already changed today.")
    except Exception as _e:
        print(f"  Warning: could not load daily state: {_e}", file=sys.stderr)

    print("Computing prices (AI mode)...")
    # Try AI pricing first, fall back to rule-based if Gemini unavailable
    _db_for_ai = None
    try:
        import firebase_admin
        from firebase_admin import firestore as _fs_ai
        if firebase_admin._apps:
            _db_for_ai = _fs_ai.client()
    except Exception:
        pass

    results = ai_compute_prices(raw, config, db=_db_for_ai)
    if results is None:
        print("  Falling back to rule-based pricing engine...")
        results = compute_prices(raw, config, todays_changes)
    else:
        print("  AI pricing applied.")

    print_report(results, dry_run)

    if dry_run:
        print("DRY RUN — run with --apply to write changes to MiniHotel")
        write_firestore_log(results, dry_run=True)
        return

    payload = build_write_payload(results)
    if not payload:
        print("No changes to write.")
        return

    total_updates = sum(len(p["Dates"]) for p in payload)
    print(f"Writing {total_updates} date updates to MiniHotel...")
    write_prices(payload)
    print("Write OK.")
    # Save today's changes so next run knows what was already updated
    try:
        import firebase_admin
        from firebase_admin import firestore as _fs2
        if firebase_admin._apps:
            _db2 = _fs2.client()
            daily_state = {}
            for rt, dates in results.items():
                changed = {d["date"]: {"gel": d["proposed_gel"], "eur": d["proposed_eur"]} 
                          for d in dates if d.get("changed") and not d.get("skip")}
                if changed:
                    daily_state[rt] = changed
            save_todays_changes(_db2, daily_state)
    except Exception as _e2:
        print(f"  Warning: could not save daily state: {_e2}", file=sys.stderr)

    print("Syncing channels...")
    sync_channels(results)
    print("Done.")
    write_firestore_log(results, dry_run=False)


if __name__ == "__main__":
    main()
