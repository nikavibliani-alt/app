"""
Claude AI Pricing Layer
========================
Calls Claude claude-sonnet-4-6 per property per run to suggest optimized prices.
Non-blocking: if Claude fails for a property, the velocity engine result is kept.
Falls back entirely if ANTHROPIC_API_KEY is missing.
"""

import json
import os
import sys
from datetime import datetime

import anthropic
from price_tracker import get_learning_context

CHANNEL_MATRIX = {
    "ROOMS":   {"booking": True,  "expedia": True,  "airbnb": False},
    "MAXELA":  {"booking": True,  "expedia": True,  "airbnb": False},
    "BIG_APT": {"booking": True,  "expedia": True,  "airbnb": True},
    "FREEDOM": {"booking": True,  "expedia": True,  "airbnb": True},
    "ORBE_1":  {"booking": True,  "expedia": False, "airbnb": True},
    "ORBE_2":  {"booking": False, "expedia": False, "airbnb": True},
}

FRIENDLY_NAMES = {
    "ROOMS":   "Rooms (small rooms 0-1 to 0-5, 5 units)",
    "MAXELA":  "Maxela Apartments (mid-size, 7 units)",
    "BIG_APT": "3-Bedroom Big Apartment (1 unit, sleeps 12)",
    "FREEDOM": "Freedom Square Apartment (3 units)",
    "ORBE_1":  "Orbeliani 1 Apartment (2 units)",
    "ORBE_2":  "Orbeliani 3 Apartment — Airbnb only (1 unit)",
}

SYSTEM_PROMPT = """You are a revenue management AI for Maxela Apartments, a short-term rental business in Tbilisi, Georgia.

BUSINESS CONTEXT:
- 22 units across 6 property types in central Tbilisi
- Primary guests: Arabic countries, Russia, Turkey (NOT Georgian tourists — ignore Georgian holidays)
- Peak demand: July-August. High: May-June, September. Low: January-March, November-December
- Tbilisi and Rustavi (25km) concerts/festivals strongly impact demand
- Self-service apartments — no breakfast, no reception, no daily cleaning
- Guests compare to hotels; never price so high that a hotel becomes cheaper
- Better to fill at a good price than sit empty at a high price

PRICING RULES:
- Never set price below floor or above ceiling
- Skip dates where avail=0 (fully booked — don't touch)
- 0-3 days ahead with availability: apply last-minute discount if occupancy <50%
- 4-14 days: standard occupancy-based adjustment, max ±10% from current
- 15-60 days: conservative, max ±5% change from current price
- High occupancy (>70%): raise toward ceiling; low occupancy (<30%): consider small drop
- Fri/Sat arrival dates: 10-15% premium over Mon-Thu for same property
- Only include dates where you recommend a price change from current
- EUR prices (Airbnb) should roughly track GEL at ~0.34 EUR/GEL, within their own floors/ceilings

RESPONSE FORMAT — return only valid JSON, no markdown fences, no text outside JSON:
{
  "dates": {
    "2026-07-15": {"gel": 250, "reason": "occ 80%, raising toward ceiling"},
    "2026-07-20": {"gel": 200, "eur": 55, "reason": "low occ, small drop"}
  },
  "summary": "One-sentence strategy for this property today"
}
Only include "eur" for Airbnb-enabled properties. Only include dates where price changes."""


def build_user_prompt(
    rt: str,
    dates: list,
    config: dict,
    velocity: dict,
    events: dict,
    learning_context: str,
) -> str:
    today = datetime.now().strftime("%Y-%m-%d")
    vel = velocity.get(rt, {})
    total_units = config["unit_counts"].get(rt, 1)
    is_big_apt = rt == "BIG_APT"
    lookback = 14 if is_big_apt else 7
    raw_bk = vel.get("bookings_last_14d", 0) if is_big_apt else vel.get("bookings_last_7d", 0)
    max_possible = total_units * lookback
    vel_pct = (raw_bk / max_possible * 100) if max_possible > 0 else 0
    channels = ", ".join(k for k, v in CHANNEL_MATRIX[rt].items() if v)

    lines = [
        f"Today: {today}",
        f"Property: {FRIENDLY_NAMES.get(rt, rt)} ({rt})",
        f"Channels: {channels}",
        f"Bookings last {lookback}d: {raw_bk} ({vel_pct:.1f}% of max inventory)",
        f"Recently booked arrival dates: {vel.get('recently_booked_dates', [])}",
    ]

    if events:
        lines.append("\nUPCOMING EVENTS (approved by manager):")
        for date_str, ev in sorted(events.items()):
            lines.append(f"  {date_str}: {ev['label']} (multiplier {ev['multiplier']}x)")

    if learning_context:
        lines.append(learning_context)

    lines.append("\nDATES TO PRICE (date | avail/total | gel | eur | days_ahead | season | floor_gel-ceil_gel | floor_eur-ceil_eur):")
    for d in dates[:60]:
        lines.append(
            f"  {d['date']} | {d['avail']}/{d['total_units']} | "
            f"{d['current_gel']}gel {d['current_eur']}eur | "
            f"{d['days_ahead']}d | {d['season']} | "
            f"{d['floor_gel']}-{d['ceil_gel']}gel | "
            f"{d['floor_eur']}-{d['ceil_eur']}eur"
        )

    return "\n".join(lines)


def call_claude(user_prompt: str, api_key: str, timeout: float = 30.0) -> dict:
    client = anthropic.Anthropic(api_key=api_key, timeout=timeout)
    msg = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=4096,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_prompt}],
    )
    text = msg.content[0].text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()
    return json.loads(text)


def save_recommendations(db, recommendations: list):
    for rec in recommendations:
        doc_id = f"rec_{rec.get('property','?')}_{rec.get('season','any')}_{rec.get('currency','gel')}"
        try:
            db.collection("pricing_recommendations").document(doc_id).set({
                **rec,
                "status": "pending",
                "created_at": datetime.now().isoformat(),
            })
        except Exception as e:
            print(f"  Warning: could not save recommendation: {e}", file=sys.stderr)


def claude_compute_prices(
    raw_data: list,
    config: dict,
    db=None,
    velocity: dict = None,
) -> dict:
    """
    Returns a dict of {rt: [date_results]} for properties Claude handled,
    or None if ANTHROPIC_API_KEY is absent (full fallback to velocity engine).
    Properties where Claude fails are absent from the returned dict
    so pricing_engine.py keeps their velocity results.
    """
    from pricing_engine import (
        get_season, get_price_from_rates, days_until,
        round_price, ROOM_TYPES,
    )

    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        print("  No ANTHROPIC_API_KEY — skipping Claude pricing", file=sys.stderr)
        return None

    # Parse raw MiniHotel data
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

    # Build per-property date context (next 60 days)
    property_dates = {}
    for rt in ROOM_TYPES:
        if rt not in avail_map:
            continue
        total_units = config["unit_counts"].get(rt, 1)
        dates_list = []
        for date_str in sorted(avail_map[rt].keys()):
            days = days_until(date_str)
            if days > 60:
                continue
            avail = avail_map[rt][date_str]
            prices = price_map[rt][date_str]
            season = get_season(date_str, config)
            dates_list.append({
                "date":        date_str,
                "avail":       avail,
                "total_units": total_units,
                "current_gel": prices["gel"],
                "current_eur": prices["eur"],
                "days_ahead":  days,
                "season":      season,
                "floor_gel":   config.get("floor_prices_gel",   {}).get(rt, {}).get(season, 0),
                "ceil_gel":    config.get("ceiling_prices_gel", {}).get(rt, {}).get(season, 0),
                "floor_eur":   config.get("floor_prices_eur",   {}).get(rt, {}).get(season, 0),
                "ceil_eur":    config.get("ceiling_prices_eur", {}).get(rt, {}).get(season, 0),
            })
        if dates_list:
            property_dates[rt] = dates_list

    # Load events and learning context from Firestore
    events = {}
    learning_context = ""
    if db:
        from ai_pricing import get_approved_events
        events = get_approved_events(db)
        learning_context = get_learning_context(db, days_back=30)

    velocity = velocity or {}
    rounding = config.get("rounding", 5)

    print("  Calling Claude for price optimization...")
    results = {}
    all_recommendations = []

    for rt, dates_list in property_dates.items():
        try:
            prompt = build_user_prompt(rt, dates_list, config, velocity, events, learning_context)
            response = call_claude(prompt, api_key)
            claude_date_prices = response.get("dates", {})
            summary = response.get("summary", "")
            if response.get("recommendations"):
                all_recommendations.extend(response["recommendations"])

            # Build full results list for this property
            rt_results = []
            total_units = config["unit_counts"].get(rt, 1)
            for d in dates_list:
                date_str = d["date"]
                avail  = d["avail"]
                prices = price_map[rt][date_str]
                season = d["season"]
                days   = d["days_ahead"]

                if avail == 0:
                    rt_results.append({
                        "date": date_str, "days_ahead": days,
                        "current_gel": prices["gel"], "proposed_gel": prices["gel"],
                        "current_eur": prices["eur"], "proposed_eur": prices["eur"],
                        "skip": True, "reason": "fully booked (avail=0)",
                    })
                    continue

                proposed_gel = prices["gel"]
                proposed_eur = prices["eur"]
                reason = "Claude: no change"

                if date_str in claude_date_prices:
                    cd = claude_date_prices[date_str]
                    if "gel" in cd:
                        floor_gel = d["floor_gel"]
                        ceil_gel  = d["ceil_gel"]
                        proposed_gel = max(float(cd["gel"]), floor_gel) if floor_gel else float(cd["gel"])
                        if ceil_gel:
                            proposed_gel = min(proposed_gel, ceil_gel)
                        proposed_gel = round_price(proposed_gel, rounding)
                    if "eur" in cd:
                        floor_eur = d["floor_eur"]
                        ceil_eur  = d["ceil_eur"]
                        proposed_eur = max(float(cd["eur"]), floor_eur) if floor_eur else float(cd["eur"])
                        if ceil_eur:
                            proposed_eur = min(proposed_eur, ceil_eur)
                        proposed_eur = round_price(proposed_eur, rounding)
                    reason = f"Claude: {cd.get('reason', 'optimized')}"

                gel_changed = abs(proposed_gel - prices["gel"]) >= 1
                eur_changed = abs(proposed_eur - prices["eur"]) >= 1
                rt_results.append({
                    "date":          date_str,
                    "days_ahead":    days,
                    "current_gel":   prices["gel"],
                    "proposed_gel":  proposed_gel,
                    "current_eur":   prices["eur"],
                    "proposed_eur":  proposed_eur,
                    "occupancy_pct": ((total_units - avail) / total_units) * 100,
                    "season":        season,
                    "skip":          False,
                    "changed":       gel_changed or eur_changed,
                    "reason":        reason,
                })

            changes = sum(1 for d in rt_results if d.get("changed"))
            print(f"    {rt}: {changes} changes — {summary[:80]}")
            results[rt] = rt_results

        except Exception as e:
            print(f"    {rt}: Claude failed ({e}) — velocity result kept", file=sys.stderr)

    if all_recommendations and db:
        save_recommendations(db, all_recommendations)
        print(f"  {len(all_recommendations)} boundary recommendations saved.")

    # Also cover dates beyond 60 days using velocity results
    # (Claude only prices next 60 days; velocity engine handles the rest)
    # These will be filled in by pricing_engine.py from the velocity baseline.

    if not results:
        print("  Claude returned no usable prices — full fallback to velocity engine", file=sys.stderr)
        return None

    return results
