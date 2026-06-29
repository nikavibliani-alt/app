"""
Velocity-Adjusted Dynamic Pricing Engine (Inverted Model)
===========================================================
Architecture: Start HIGH, drop only when behind target curve.

Key principles:
1. Default price = near ceiling (set in config as base_prices_gel)
2. Engine ONLY drops prices — never raises from occupancy alone
3. Raises only when significantly AHEAD of target curve (demand proven)
4. Cancellation safe: room opens at last high price, not floor
5. Floor = absolute last resort (same day, still empty)

Pipeline:
  Market State → Target Curve Check → Score → Step → Safety Limits → Publish

Target Occupancy Curve (when should X% be booked):
  Standard: 61-90d=0%, 31-60d=5-10%, 15-30d=15-25%, 4-14d=45-65%, 0-3d=85-100%
  BIG_APT:  61-90d=10-15%, 31-60d=20-30%, 15-30d=40-50%, 4-14d=65-80%, 0-3d=85-100%
"""

from datetime import datetime
from typing import Optional


# ---------------------------------------------------------------------------
# TARGET OCCUPANCY CURVES
# ---------------------------------------------------------------------------

STANDARD_CURVE = [
    {"days_min": 61, "days_max": 90, "target_min": 0,  "target_max": 10},
    {"days_min": 31, "days_max": 60, "target_min": 5,  "target_max": 10},
    {"days_min": 15, "days_max": 30, "target_min": 15, "target_max": 25},
    {"days_min":  4, "days_max": 14, "target_min": 45, "target_max": 65},
    {"days_min":  0, "days_max":  3, "target_min": 85, "target_max": 100},
]

BIG_APT_CURVE = [
    {"days_min": 61, "days_max": 90, "target_min": 10, "target_max": 15},
    {"days_min": 31, "days_max": 60, "target_min": 20, "target_max": 30},
    {"days_min": 15, "days_max": 30, "target_min": 40, "target_max": 50},
    {"days_min":  4, "days_max": 14, "target_min": 65, "target_max": 80},
    {"days_min":  0, "days_max":  3, "target_min": 85, "target_max": 100},
]

# Last-minute cascade: fraction of way from current to floor
# Only triggers when behind target AND within 3 days
CASCADE_STEPS = {
    3: 0.10,   # 3 days: 10% toward floor (gentle nudge)
    2: 0.35,   # 2 days: 35% toward floor
    1: 0.65,   # 1 day:  65% toward floor
    0: 1.00,   # same day: floor
}

MAX_CHANGE_PER_RUN = 0.05  # Never change more than 5% per run


# ---------------------------------------------------------------------------
# HELPERS
# ---------------------------------------------------------------------------

def get_target_occupancy(days_ahead: int, is_big_apt: bool = False) -> tuple:
    curve = BIG_APT_CURVE if is_big_apt else STANDARD_CURVE
    for band in curve:
        if band["days_min"] <= days_ahead <= band["days_max"]:
            return band["target_min"], band["target_max"]
    return 0, 10


def normalize_velocity(raw_bookings: int, total_units: int, lookback_days: int = 7) -> float:
    """Normalize booking count to % of max possible room nights."""
    max_possible = total_units * lookback_days
    room_nights = min(raw_bookings, max_possible)
    return (room_nights / max_possible * 100) if max_possible > 0 else 0


def calculate_score(
    occ_pct: float,
    tgt_min: float,
    tgt_max: float,
    vel_pct: float,
    days_ahead: int,
) -> tuple:
    """
    Calculate pricing action score.
    
    Returns (score, action) where:
      score > 0 → behind target → consider DROP
      score < 0 → ahead of target → consider RAISE  
      score ≈ 0 → on target → HOLD
      
    Velocity has 60% weight, occupancy deficit 40%.
    """
    tgt_mid = (tgt_min + tgt_max) / 2

    # Occupancy deficit: positive = behind
    occ_deficit = tgt_mid - occ_pct

    # Velocity deficit: are bookings arriving fast enough?
    # Expected weekly velocity = target% / weeks remaining
    weeks_remaining = max(days_ahead / 7, 0.5)
    expected_vel_pct = tgt_mid / weeks_remaining
    vel_deficit = expected_vel_pct - vel_pct

    # Combined score (positive = should drop, negative = could raise)
    score = (occ_deficit * 0.4) + (vel_deficit * 0.6)

    if score > 50:
        action = "drop_large"
    elif score > 25:
        action = "drop_medium"
    elif score > 10:
        action = "drop_small"
    elif score < -25:
        action = "raise"
    else:
        action = "hold"

    return score, action


def apply_inverted_step(
    current_price: float,
    action: str,
    floor: float,
    ceiling: float,
) -> tuple:
    """
    Apply price change based on action.
    Inverted model: drops are common, raises are rare.
    Returns (proposed_price, pct_change)
    """
    drop_map  = {"drop_large": 0.07, "drop_medium": 0.04, "drop_small": 0.02}
    raise_pct = 0.03  # Raises are small and cautious

    if action in drop_map:
        pct = min(drop_map[action], MAX_CHANGE_PER_RUN)
        proposed = current_price * (1 - pct)
    elif action == "raise":
        pct = min(raise_pct, MAX_CHANGE_PER_RUN)
        proposed = current_price * (1 + pct)
        pct = -pct  # negative = raise
    else:
        return current_price, 0.0

    # Enforce boundaries
    proposed = max(proposed, floor)
    if ceiling > 0:
        proposed = min(proposed, ceiling)

    actual_pct = (proposed - current_price) / current_price if current_price > 0 else 0
    return proposed, actual_pct


def apply_cascade(current_price: float, floor: float, days_ahead: int) -> float:
    """Last-minute cascade toward floor."""
    if days_ahead not in CASCADE_STEPS:
        return current_price
    fraction = CASCADE_STEPS[days_ahead]
    return current_price + (floor - current_price) * fraction


def round_price(price: float, rounding: int = 5) -> float:
    return round(price / rounding) * rounding


# ---------------------------------------------------------------------------
# MAIN COMPUTE FUNCTION
# ---------------------------------------------------------------------------

def compute_prices_velocity(
    raw_data: list,
    config: dict,
    velocity: dict,
    todays_changes: dict = None,
) -> dict:
    """
    Inverted-model pricing engine.
    
    - Starts from base_prices_gel (set near ceiling)
    - Only drops when behind target occupancy curve
    - Raises cautiously when significantly ahead of target
    - Last-minute cascade only for genuinely empty near dates
    - Never changes more than 5% per run
    """
    from pricing_engine import (
        get_season, get_price_from_rates, days_until,
        ROOM_TYPES, CHANNEL_MATRIX
    )

    if todays_changes is None:
        todays_changes = {}

    rounding = config.get("rounding", 5)

    # Parse raw data
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

    results = {}

    for rt in ROOM_TYPES:
        if rt not in avail_map:
            continue

        total_units  = config["unit_counts"].get(rt, 1)
        channels     = CHANNEL_MATRIX[rt]
        is_big_apt   = (rt == "BIG_APT")
        vel_data     = velocity.get(rt, {})
        lookback_days = 14 if is_big_apt else 7
        vel_raw      = vel_data.get("bookings_last_14d", 0) if is_big_apt else vel_data.get("bookings_last_7d", 0)
        vel_pct      = normalize_velocity(vel_raw, total_units, lookback_days)
        results[rt]  = []

        for date_str in sorted(avail_map[rt].keys()):
            avail  = avail_map[rt][date_str]
            prices = price_map[rt][date_str]
            season = get_season(date_str, config)
            days   = days_until(date_str)

            # Skip fully booked
            if avail == 0:
                results[rt].append({
                    "date": date_str, "days_ahead": days,
                    "current_gel": prices["gel"], "proposed_gel": prices["gel"],
                    "current_eur": prices["eur"], "proposed_eur": prices["eur"],
                    "skip": True, "reason": "fully booked (avail=0)",
                })
                continue

            # Get boundaries from config
            floor_gel   = config.get("floor_prices_gel",   {}).get(rt, {}).get(season, 0)
            ceiling_gel = config.get("ceiling_prices_gel", {}).get(rt, {}).get(season, 0)
            floor_eur   = config.get("floor_prices_eur",   {}).get(rt, {}).get(season, 0)
            ceiling_eur = config.get("ceiling_prices_eur", {}).get(rt, {}).get(season, 0)
            # Base price = ceiling × base_price_pct (adjustable per property)
            # Base prices from startPrices/startPricesEur (set in pricing page)
            # Fall back to base_price_pct of ceiling if not set
            base_pct    = config.get("base_price_pct", {}).get(rt, 0.90)
            sp_gel      = config.get("startPrices", {}).get(rt, {}).get(season, 0)
            sp_eur      = config.get("startPricesEur", {}).get(rt, {}).get(season, 0)
            base_gel    = sp_gel if sp_gel > 0 else (round_price(ceiling_gel * base_pct, rounding) if ceiling_gel > 0 else 0)
            base_eur    = sp_eur if sp_eur > 0 else (round_price(ceiling_eur * base_pct, rounding) if ceiling_eur > 0 else 0)

            # Per-date manual floor override
            date_override = config.get("date_overrides", {}).get(rt, {}).get(date_str)
            if date_override:
                floor_gel = max(floor_gel, date_override)

            # Event premium
            event_mult  = 1.0
            event_label = ""
            events = config.get("event_premiums", {})
            if date_str in events and not str(date_str).startswith("_"):
                ev = events[date_str]
                if isinstance(ev, dict):
                    event_mult  = ev.get("multiplier", 1.0)
                    event_label = ev.get("label", "event")

            # Occupancy
            booked  = total_units - avail
            occ_pct = (booked / total_units) * 100

            # Target curve
            tgt_min, tgt_max = get_target_occupancy(days, is_big_apt)

            # Score and action
            score, action = calculate_score(occ_pct, tgt_min, tgt_max, vel_pct, days)

            # ── GEL PRICE ──
            proposed_gel = prices["gel"]
            gel_reason   = ""

            if channels.get("booking") or channels.get("expedia"):

                if prices["gel"] == 0 and base_gel > 0:
                    # Not set yet — start at base (near ceiling)
                    proposed_gel = base_gel * event_mult
                    gel_reason   = f"unset→base {base_gel}₾"

                elif prices["gel"] > 0:
                    # Check per-day cap
                    already_today = todays_changes.get(rt, {}).get(date_str)
                    already_gel   = already_today.get("gel") if isinstance(already_today, dict) else already_today

                    if already_gel and event_mult == 1.0:
                        proposed_gel = prices["gel"]
                        gel_reason   = "already updated today"
                    else:
                        # Last-minute cascade (only if genuinely behind)
                        if days <= 3 and score > 20 and floor_gel > 0:
                            proposed_gel = apply_cascade(prices["gel"], floor_gel, days)
                            gel_reason   = f"CASCADE day={days} occ={occ_pct:.0f}% tgt={tgt_min}-{tgt_max}%"
                        else:
                            # Apply inverted step
                            eff_action = action
                            if event_mult > 1.0:
                                eff_action = "raise"
                            proposed_gel, pct = apply_inverted_step(
                                prices["gel"], eff_action, floor_gel, ceiling_gel or 99999
                            )
                            gel_reason = (
                                f"occ={occ_pct:.0f}% tgt={tgt_min}-{tgt_max}% "
                                f"vel={vel_raw}bk({vel_pct:.0f}%) score={score:.0f} {eff_action}({pct:+.1%})"
                            )
                            if event_label:
                                gel_reason += f" +{event_label}"

                # STRICT boundary enforcement
                if ceiling_gel > 0 and event_mult == 1.0:
                    proposed_gel = min(proposed_gel, ceiling_gel)
                # Correct prices already above ceiling — bypasses score and daily cap
                if ceiling_gel > 0 and prices["gel"] > ceiling_gel:
                    proposed_gel = ceiling_gel
                    gel_reason = f"above-ceiling correction: {prices['gel']:.0f}₾ → {ceiling_gel:.0f}₾"
                if floor_gel > 0:
                    proposed_gel = max(proposed_gel, floor_gel)
                proposed_gel = round_price(proposed_gel, rounding)

            # ── EUR PRICE ──
            proposed_eur = prices["eur"]

            if channels.get("airbnb"):
                if prices["eur"] == 0 and base_eur > 0:
                    proposed_eur = base_eur * event_mult

                elif prices["eur"] > 0:
                    already_today = todays_changes.get(rt, {}).get(date_str)
                    already_eur   = already_today.get("eur") if isinstance(already_today, dict) else None

                    if already_eur and event_mult == 1.0:
                        proposed_eur = prices["eur"]
                    else:
                        if days <= 3 and score > 20 and floor_eur > 0:
                            proposed_eur = apply_cascade(prices["eur"], floor_eur, days)
                        else:
                            eff_action = "raise" if event_mult > 1.0 else action
                            proposed_eur, _ = apply_inverted_step(
                                prices["eur"], eff_action, floor_eur, ceiling_eur or 99999
                            )

                if ceiling_eur > 0 and event_mult == 1.0:
                    proposed_eur = min(proposed_eur, ceiling_eur)
                # Correct prices already above ceiling — bypasses score and daily cap
                if ceiling_eur > 0 and prices["eur"] > ceiling_eur:
                    proposed_eur = ceiling_eur
                if floor_eur > 0:
                    proposed_eur = max(proposed_eur, floor_eur)
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
                "occupancy_pct": occ_pct,
                "season":        season,
                "skip":          False,
                "changed":       gel_changed or eur_changed,
                "reason":        gel_reason or f"occ={occ_pct:.0f}% score={score:.0f} {action}",
            })

    return results
