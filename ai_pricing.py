"""
AI Pricing Engine — Gemini-powered price optimizer
====================================================
Replaces rule-based occupancy tiers with Gemini AI analysis.
Called from pricing_engine.py instead of compute_prices().

The AI receives full context per property per date and returns
optimal prices within the configured floors and ceilings.
It also detects when boundaries should be adjusted and writes
recommendations to Firestore for review in pricing.html.
"""

import json
import os
import sys
import time
from datetime import datetime, timedelta

import requests
from price_tracker import get_learning_context

GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent"

CHANNEL_MATRIX = {
    "ROOMS":   {"booking": True,  "expedia": True,  "airbnb": False},
    "MAXELA":  {"booking": True,  "expedia": True,  "airbnb": False},
    "BIG_APT": {"booking": True,  "expedia": True,  "airbnb": True},
    "FREEDOM": {"booking": True,  "expedia": True,  "airbnb": True},
    "ORBE_1":  {"booking": True,  "expedia": False, "airbnb": True},
    "ORBE_2":  {"booking": False, "expedia": False, "airbnb": True},
}

FRIENDLY_NAMES = {
    "ROOMS":   "Rooms (small rooms 0-1 to 0-5)",
    "MAXELA":  "Maxela Apartments (mid-size)",
    "BIG_APT": "3-Bedroom Big Apartment",
    "FREEDOM": "Freedom Square Apartment",
    "ORBE_1":  "Orbeliani 1 Apartment",
    "ORBE_2":  "Orbeliani 3 Apartment (Airbnb only)",
}


# ---------------------------------------------------------------------------
# FETCH BOOKING VELOCITY FROM FIRESTORE
# ---------------------------------------------------------------------------

def get_booking_velocity(db, days_back: int = 14) -> dict:
    """
    Returns how many bookings came in per property in the last N days.
    Also returns which future dates just got booked.
    {
      "ROOMS":   {"bookings_last_7d": 3, "bookings_last_14d": 5, "recently_booked_dates": ["2026-07-15", ...]},
      "MAXELA":  {...},
      ...
    }
    """
    from datetime import datetime, timedelta
    from google.cloud import firestore

    cutoff_7d  = datetime.now() - timedelta(days=7)
    cutoff_14d = datetime.now() - timedelta(days=days_back)

    # Room code → property type mapping
    room_to_property = {}
    for i in range(1, 6):
        room_to_property[f"0-{i}"] = "ROOMS"
    for i in range(1, 5):
        room_to_property[f"6-{i}"] = "MAXELA"
    room_to_property["6-3"] = "BIG_APT"
    for i in [1, 2, 3]:
        room_to_property[f"tab-{i}"] = "FREEDOM"
    room_to_property["orb-1"] = "ORBE_1"
    room_to_property["orb-2"] = "ORBE_1"
    room_to_property["orb-3"] = "ORBE_2"
    for i in range(1, 5):
        room_to_property[f"7-{i}"] = "MAXELA"

    velocity = {rt: {"bookings_last_7d": 0, "bookings_last_14d": 0, "recently_booked_dates": []} 
                for rt in CHANNEL_MATRIX.keys()}

    try:
        # Get reservations created in last 14 days
        docs = db.collection("reservations").where(
            "syncedAt", ">=", cutoff_14d
        ).stream()

        for doc in docs:
            data = doc.to_dict()
            if data.get("status") in ("CANCELLED", "NO_SHOW"):
                continue
            room = data.get("roomCode", "")
            prop = room_to_property.get(room)
            if not prop:
                continue

            synced = data.get("syncedAt")
            if synced:
                synced_dt = synced.replace(tzinfo=None) if hasattr(synced, 'replace') else datetime.fromtimestamp(synced)
                if synced_dt >= cutoff_7d:
                    velocity[prop]["bookings_last_7d"] += 1
                velocity[prop]["bookings_last_14d"] += 1

            checkin = data.get("checkin", "")
            if checkin and checkin not in velocity[prop]["recently_booked_dates"]:
                velocity[prop]["recently_booked_dates"].append(str(checkin)[:10])

    except Exception as e:
        print(f"  Warning: could not fetch booking velocity: {e}", file=sys.stderr)

    return velocity


# ---------------------------------------------------------------------------
# LOAD APPROVED EVENTS
# ---------------------------------------------------------------------------

def get_approved_events(db) -> dict:
    """Returns {date_str: {label, multiplier}} for approved events."""
    events = {}
    try:
        docs = db.collection("pricing_events").where("status", "in", ["approved", "manual"]).stream()
        for doc in docs:
            data = doc.to_dict()
            date_str = doc.id.replace("event_", "")
            if date_str:
                events[date_str] = {
                    "label": data.get("label", "Event"),
                    "multiplier": data.get("multiplier", 1.3),
                }
    except Exception as e:
        print(f"  Warning: could not fetch events: {e}", file=sys.stderr)
    return events


# ---------------------------------------------------------------------------
# BUILD AI PROMPT
# ---------------------------------------------------------------------------

def build_prompt(property_data: dict, config: dict, velocity: dict, events: dict, learning_context: str = "") -> str:
    """Build the prompt for Gemini with full context."""
    today = datetime.now().strftime("%Y-%m-%d")

    prompt = f"""You are a revenue management AI for Maxela Apartments, a short-term rental business in Tbilisi, Georgia.
Today is {today}.

## BUSINESS CONTEXT
- 22 units across 6 property types in central Tbilisi
- Primary guests: Arabic countries, Russia, Turkey (NOT Georgian tourists — ignore Georgian holidays)
- Peak demand: July-August (summer travel from these markets)
- High demand: May-June, September
- Low demand: January-March, November-December
- Tbilisi events (concerts, festivals) strongly impact demand — check event list
- Rustavi (25km away) events also impact Tbilisi accommodation demand
- Most bookings come via Booking.com and Expedia (GEL pricing)
- Airbnb is secondary/backup channel (EUR pricing)
- Big Apartment (BIG_APT) sleeps 12 guests — premium pricing justified, books later than smaller units

## PRICING BEHAVIOR
- Dates 0-3 days away with availability: apply last-minute discount (guests may still book)
- Dates 4-14 days away: standard occupancy-based pricing
- Dates 15-30 days away: conservative adjustments, market is still forming
- Dates 31-90 days away: minimal changes, protect price integrity
- If a date has 3+ bookings in last 7 days for a property → demand signal → raise toward ceiling
- If a property has 0 bookings in 14 days AND dates are within 30 days → consider small drop
- Peak season (Jul-Aug): protect prices, minimal drops — these dates will fill naturally
- Weekend premium: Fri/Sat arrival dates should be 10-15% higher than Mon-Thu same property

Your job: Set optimal prices for each property for each date within the given floors and ceilings.
Return ONLY valid JSON, no explanation, no markdown.

## PROPERTY DATA
"""
    for rt, info in property_data.items():
        vel = velocity.get(rt, {})
        prompt += f"""
### {FRIENDLY_NAMES[rt]} ({rt})
- Channels: {', '.join(k for k,v in CHANNEL_MATRIX[rt].items() if v)}
- Bookings last 7 days: {vel.get('bookings_last_7d', 0)}
- Bookings last 14 days: {vel.get('bookings_last_14d', 0)}
- Recently booked arrival dates: {vel.get('recently_booked_dates', [])}
- Dates to price (date, availability, current_gel, current_eur, days_ahead, season):
"""
        for d in info["dates"][:90]:  # max 90 dates
            prompt += f"  {d['date']}: avail={d['avail']}/{d['total_units']}, gel={d['current_gel']}, eur={d['current_eur']}, days={d['days_ahead']}, season={d['season']}, floor_gel={d['floor_gel']}, ceil_gel={d['ceil_gel']}, floor_eur={d['floor_eur']}, ceil_eur={d['ceil_eur']}\n"

    if events:
        prompt += "\n## UPCOMING EVENTS (approved by manager)\n"
        for date, ev in sorted(events.items()):
            prompt += f"- {date}: {ev['label']} (suggested multiplier {ev['multiplier']}x)\n"

    prompt += """
## PRICING RULES
- Never set price below floor or above ceiling
- If availability=0, skip that date (return current price)
- Consider: occupancy trend, lead time, season, nearby events, booking velocity
- Tbilisi peak season: Jul-Aug. High: May-Jun, Sep. Low: Jan-Mar, Nov-Dec
- Weekends (Fri/Sat) typically command 10-15% premium over weekdays
- Last-minute (0-3 days): use cascade prices if available, otherwise small discount
- Far out dates (60-90 days): move prices slowly, max 3-5% change
- If a property has 0 bookings in 14 days and dates are filling up nearby → consider small price drop to attract
- If a property is booking fast (3+ in 7 days) → raise prices toward ceiling
- EUR prices for Airbnb should roughly track GEL prices at ~0.34 EUR/GEL conversion, but within their own floors/ceilings

## BOUNDARY RECOMMENDATIONS
If you detect that a floor is blocking bookings (price keeps hitting floor but dates stay empty) 
or ceiling is blocking revenue (dates book immediately when price hits ceiling) — include a recommendation.

" + learning_context + "

## RETURN FORMAT (strict JSON, no markdown):
{
  "prices": {
    "ROOMS": {
      "2026-06-25": {"gel": 120},
      "2026-06-26": {"gel": 115}
    },
    "BIG_APT": {
      "2026-07-01": {"gel": 550, "eur": 145}
    }
  },
  "recommendations": [
    {
      "property": "BIG_APT",
      "type": "raise_ceiling",
      "current": 750,
      "suggested": 850,
      "currency": "gel",
      "season": "peak",
      "reason": "Dates booked within hours of hitting 750 ceiling 3 times in last 2 weeks"
    }
  ]
}
Only include dates where the price should change from current. Skip unchanged dates.
Only include recommendations if you have strong evidence.
"""
    return prompt


# ---------------------------------------------------------------------------
# CALL GEMINI
# ---------------------------------------------------------------------------

def call_gemini(prompt: str, api_key: str) -> dict:
    """Call Gemini API and parse JSON response."""
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.2,
            "maxOutputTokens": 8192,
        }
    }
    headers = {"Content-Type": "application/json"}
    url = f"{GEMINI_API_URL}?key={api_key}"

    resp = requests.post(url, json=payload, headers=headers, timeout=60)
    resp.raise_for_status()

    data = resp.json()
    text = data["candidates"][0]["content"]["parts"][0]["text"]

    # Strip markdown if present
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1]
        text = text.rsplit("```", 1)[0]

    return json.loads(text)


# ---------------------------------------------------------------------------
# SAVE RECOMMENDATIONS TO FIRESTORE
# ---------------------------------------------------------------------------

def save_recommendations(db, recommendations: list):
    """Save AI boundary recommendations to Firestore for review in pricing.html."""
    if not recommendations:
        return
    for rec in recommendations:
        doc_id = f"rec_{rec['property']}_{rec.get('season','any')}_{rec.get('currency','gel')}"
        try:
            db.collection("pricing_recommendations").document(doc_id).set({
                **rec,
                "status": "pending",
                "created_at": datetime.now().isoformat(),
            })
            print(f"  Recommendation saved: {rec['property']} → {rec['reason'][:60]}")
        except Exception as e:
            print(f"  Warning: could not save recommendation: {e}", file=sys.stderr)


# ---------------------------------------------------------------------------
# MAIN: AI COMPUTE PRICES
# ---------------------------------------------------------------------------

def ai_compute_prices(raw_data: list, config: dict, db=None) -> dict:
    """
    AI-powered replacement for compute_prices().
    Returns same format as compute_prices() for compatibility.
    """
    from pricing_engine import (
        get_season, get_price_from_rates, days_until,
        round_price, ROOM_TYPES, CHANNEL_MATRIX
    )

    # Get Gemini API key from Firestore globals/config
    gemini_key = os.environ.get("GEMINI_KEY", "")
    if not gemini_key and db:
        try:
            snap = db.collection("globals").document("config").get()
            gemini_key = snap.data().get("geminiKey", "") if snap.exists else ""
        except Exception:
            pass

    if not gemini_key:
        print("  No Gemini key found — falling back to rule-based engine", file=sys.stderr)
        return None  # Signal to fall back to rule-based

    # Build property data structure
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
            avail = d.get("Availability") or d.get("DefaultAvailability") or 0
            avail_map[rt][date_str] = int(avail)
            price_map[rt][date_str] = {
                "gel": get_price_from_rates(d.get("Rates"), "GEL"),
                "eur": get_price_from_rates(d.get("Rates"), "EUR"),
            }

    property_data = {}
    for rt in ROOM_TYPES:
        if rt not in avail_map:
            continue
        total_units = config["unit_counts"].get(rt, 1)
        dates_list = []
        for date_str in sorted(avail_map[rt].keys()):
            avail = avail_map[rt][date_str]
            prices = price_map[rt][date_str]
            season = get_season(date_str, config)
            days = days_until(date_str)
            dates_list.append({
                "date":        date_str,
                "avail":       avail,
                "total_units": total_units,
                "current_gel": prices["gel"],
                "current_eur": prices["eur"],
                "days_ahead":  days,
                "season":      season,
                "floor_gel":   config.get("floor_prices_gel",  {}).get(rt, {}).get(season, 0),
                "ceil_gel":    config.get("ceiling_prices_gel",{}).get(rt, {}).get(season, 0),
                "floor_eur":   config.get("floor_prices_eur",  {}).get(rt, {}).get(season, 0),
                "ceil_eur":    config.get("ceiling_prices_eur",{}).get(rt, {}).get(season, 0),
            })
        property_data[rt] = {"dates": dates_list}

    # Get velocity, events and learning context from Firestore
    velocity = {}
    events = {}
    learning_context = ""
    if db:
        print("  Loading booking velocity from Firestore...")
        velocity = get_booking_velocity(db)
        events = get_approved_events(db)
        print("  Loading historical learning data...")
        learning_context = get_learning_context(db)

    # Build prompt and call Gemini
    print("  Calling Gemini AI for price optimization...")
    prompt = build_prompt(property_data, config, velocity, events, learning_context)

    # Retry up to 3 times with backoff for rate limit errors
    ai_response = None
    for attempt in range(3):
        try:
            ai_response = call_gemini(prompt, gemini_key)
            break
        except Exception as e:
            err_str = str(e)
            if "429" in err_str and attempt < 2:
                wait = (attempt + 1) * 30
                print(f"  Gemini rate limit, retrying in {wait}s...", file=sys.stderr)
                time.sleep(wait)
            else:
                print(f"  Gemini error: {e} — falling back to rule-based engine", file=sys.stderr)
                return None
    if ai_response is None:
        return None

    print("  Gemini responded OK.")

    # Save recommendations
    if db and ai_response.get("recommendations"):
        save_recommendations(db, ai_response["recommendations"])
        print(f"  {len(ai_response['recommendations'])} boundary recommendations saved.")

    # Build results in same format as compute_prices()
    ai_prices = ai_response.get("prices", {})
    results = {}
    rounding = config.get("rounding", 5)

    for rt in ROOM_TYPES:
        if rt not in avail_map:
            continue
        results[rt] = []
        rt_prices = ai_prices.get(rt, {})

        for date_str in sorted(avail_map[rt].keys()):
            avail  = avail_map[rt][date_str]
            prices = price_map[rt][date_str]
            season = get_season(date_str, config)
            days   = days_until(date_str)

            if avail == 0:
                results[rt].append({
                    "date": date_str, "days_ahead": days,
                    "current_gel": prices["gel"], "proposed_gel": prices["gel"],
                    "current_eur": prices["eur"], "proposed_eur": prices["eur"],
                    "skip": True, "reason": "fully booked (avail=0)",
                })
                continue

            ai_date = rt_prices.get(date_str, {})
            proposed_gel = prices["gel"]
            proposed_eur = prices["eur"]

            if "gel" in ai_date:
                raw_gel = float(ai_date["gel"])
                floor_gel = config.get("floor_prices_gel", {}).get(rt, {}).get(season, 0)
                ceil_gel  = config.get("ceiling_prices_gel", {}).get(rt, {}).get(season, 0)
                proposed_gel = max(raw_gel, floor_gel)
                if ceil_gel > 0:
                    proposed_gel = min(proposed_gel, ceil_gel)
                proposed_gel = round_price(proposed_gel, rounding)

            if "eur" in ai_date:
                raw_eur = float(ai_date["eur"])
                floor_eur = config.get("floor_prices_eur", {}).get(rt, {}).get(season, 0)
                ceil_eur  = config.get("ceiling_prices_eur", {}).get(rt, {}).get(season, 0)
                proposed_eur = max(raw_eur, floor_eur)
                if ceil_eur > 0:
                    proposed_eur = min(proposed_eur, ceil_eur)
                proposed_eur = round_price(proposed_eur, rounding)

            gel_changed = abs(proposed_gel - prices["gel"]) >= 1
            eur_changed = abs(proposed_eur - prices["eur"]) >= 1

            results[rt].append({
                "date":          date_str,
                "days_ahead":    days,
                "current_gel":   prices["gel"],
                "proposed_gel":  proposed_gel,
                "current_eur":   prices["eur"],
                "proposed_eur":  proposed_eur,
                "occupancy_pct": ((config["unit_counts"].get(rt,1) - avail) / config["unit_counts"].get(rt,1)) * 100,
                "season":        season,
                "skip":          False,
                "changed":       gel_changed or eur_changed,
                "reason":        f"AI: {ai_date.get('reason','optimized')}" if ai_date else "AI: no change",
            })

    return results
