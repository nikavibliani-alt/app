"""
Velocity-Adjusted Dynamic Pricing Engine
==========================================
Replaces the old occupancy-tier system with a smarter algorithm based on:
  1. Target Occupancy Curve — what occupancy SHOULD be at this lead time
  2. Booking Velocity — are bookings actually arriving? (60% weight)
  3. Occupancy Deficit — how far behind target are we? (40% weight)
  4. Hybrid step drops — prevents runaway price crashes
  5. Last-minute cascade — gradual drops in final 3 days
  6. Max 5% change per run, max ~12% per day

Big Apartment has its own curve and uses a 14-30 day velocity window.
"""

import os
import sys
from datetime import datetime, timedelta
from typing import Optional


# ---------------------------------------------------------------------------
# TARGET OCCUPANCY CURVES
# ---------------------------------------------------------------------------

# Standard properties (Rooms, Maxela, Freedom, Orbe)
STANDARD_CURVE = [
    {"days_min": 61, "days_max": 90, "target_min": 0,  "target_max": 10},
    {"days_min": 31, "days_max": 60, "target_min": 5,  "target_max": 10},
    {"days_min": 15, "days_max": 30, "target_min": 15, "target_max": 25},
    {"days_min":  4, "days_max": 14, "target_min": 45, "target_max": 65},
    {"days_min":  0, "days_max":  3, "target_min": 85, "target_max": 100},
]

# Big Apartment — books earlier, larger groups
BIG_APT_CURVE = [
    {"days_min": 61, "days_max": 90, "target_min": 10, "target_max": 15},
    {"days_min": 31, "days_max": 60, "target_min": 20, "target_max": 30},
    {"days_min": 15, "days_max": 30, "target_min": 40, "target_max": 50},
    {"days_min":  4, "days_max": 14, "target_min": 65, "target_max": 80},
    {"days_min":  0, "days_max":  3, "target_min": 85, "target_max": 100},
]

# Last-minute cascade percentages (fraction of way from current to floor)
# Only applies if behind target AND within 3 days
CASCADE_STEPS = {
    3: 0.15,   # 3 days: 15% of way toward floor
    2: 0.45,   # 2 days: 45% of way toward floor
    1: 0.75,   # 1 day:  75% of way toward floor
    0: 1.00,   # same day: floor price
}

# Hybrid step drops based on Price Score
# Score = (occ_deficit% × 0.4) + (vel_deficit% × 0.6)
STEP_DROPS = [
    {"score_min":  0, "score_max": 10, "action": "hold",   "pct": 0.00},
    {"score_min": 10, "score_max": 25, "action": "drop",   "pct": 0.03},
    {"score_min": 25, "score_max": 50, "action": "drop",   "pct": 0.07},
    {"score_min": 50, "score_max": 100,"action": "drop",   "pct": 0.12},
]

STEP_RAISES = [
    {"score_min":  0, "score_max": 10, "action": "hold",   "pct": 0.00},
    {"score_min": 10, "score_max": 25, "action": "raise",  "pct": 0.03},
    {"score_min": 25, "score_max": 50, "action": "raise",  "pct": 0.07},
    {"score_min": 50, "score_max": 100,"action": "raise",  "pct": 0.10},
]

MAX_CHANGE_PER_RUN = 0.05  # Never change more than 5% per run


# ---------------------------------------------------------------------------
# HELPERS
# ---------------------------------------------------------------------------

def get_target_occupancy(days_ahead: int, is_big_apt: bool = False) -> tuple:
    """Return (target_min%, target_max%) for given lead time."""
    curve = BIG_APT_CURVE if is_big_apt else STANDARD_CURVE
    for band in curve:
        if band["days_min"] <= days_ahead <= band["days_max"]:
            return band["target_min"], band["target_max"]
    return 0, 10  # fallback for > 90 days


def get_occupancy_deficit(occ_pct: float, target_min: float, target_max: float) -> float:
    """
    How far behind target are we?
    Positive = behind target (should consider dropping)
    Negative = ahead of target (should consider raising)
    """
    target_mid = (target_min + target_max) / 2
    return target_mid - occ_pct  # positive = deficit, negative = surplus


def get_velocity_deficit(
    velocity_7d: int,
    days_ahead: int,
    total_units: int,
    is_big_apt: bool = False
) -> float:
    """
    Velocity deficit as a percentage.
    Compares actual bookings in velocity window vs expected pace.
    Returns positive if booking too slowly, negative if booking fast.
    """
    # Expected bookings per week based on lead time and target curve
    target_min, target_max = get_target_occupancy(days_ahead, is_big_apt)
    target_mid = (target_min + target_max) / 2

    # Expected weekly booking rate to reach target from 0
    # Simple approximation: target% of units / (days_ahead/7) weeks
    if days_ahead <= 0:
        return 0
    weeks_remaining = max(days_ahead / 7, 0.5)
    expected_weekly = (target_mid / 100 * total_units) / weeks_remaining

    # Actual velocity vs expected
    velocity_deficit = expected_weekly - velocity_7d
    # Normalize to 0-100 scale
    if expected_weekly > 0:
        return min(100, max(-100, (velocity_deficit / expected_weekly) * 100))
    return 0


def calculate_price_score(occ_deficit: float, vel_deficit: float) -> float:
    """
    Combined score: positive = should drop, negative = should raise.
    Velocity has 60% weight, occupancy 40%.
    """
    return (occ_deficit * 0.4) + (vel_deficit * 0.6)


def apply_step(
    current_price: float,
    score: float,
    floor: float,
    ceiling: float,
    max_change: float = MAX_CHANGE_PER_RUN,
) -> tuple:
    """
    Apply hybrid step drops/raises based on score.
    Returns (proposed_price, action_taken, pct_change).
    max_change overrides MAX_CHANGE_PER_RUN for high-demand situations.
    """
    abs_score = abs(score)

    if score > 0:
        steps = STEP_DROPS
        direction = -1
    else:
        steps = STEP_RAISES
        direction = 1

    pct = 0.0
    action = "hold"
    for step in steps:
        if step["score_min"] <= abs_score < step["score_max"]:
            pct = step["pct"]
            action = step["action"]
            break

    pct = min(pct, max_change)
    proposed = current_price * (1 + direction * pct)

    proposed = max(proposed, floor)
    proposed = min(proposed, ceiling)

    return proposed, action, pct * direction


def calculate_gravity_adjustment(current_price: float, start_price: float) -> float:
    """
    Returns the fraction to move current price toward start price per run.
    Larger gaps → stronger pull, so prices far from target recover faster.
    """
    if start_price <= 0 or current_price <= 0:
        return 0.0
    abs_diff = abs(current_price - start_price) / start_price
    if abs_diff > 0.30:
        return 0.15
    if abs_diff > 0.20:
        return 0.10
    if abs_diff > 0.10:
        return 0.05
    if abs_diff > 0.05:
        return 0.02
    return 0.0


def apply_cascade(current_price: float, floor: float, days_ahead: int) -> float:
    """Apply last-minute cascade — gradual move toward floor."""
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
    experiment_locks: dict = None,
) -> dict:
    """
    Main pricing function using velocity-adjusted dynamic pricing.

    velocity format (from price_tracker.get_booking_velocity):
    {
      "ROOMS": {"bookings_last_7d": 3, "bookings_last_14d": 5, ...},
      ...
    }

    Returns same format as old compute_prices() for compatibility.
    """
    from pricing_engine import (
        get_season, get_price_from_rates, days_until,
        ROOM_TYPES, CHANNEL_MATRIX
    )

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
        # BIG_APT uses 14-30d window, others use 7d
        vel_bookings = vel_data.get("bookings_last_14d", 0) if is_big_apt else vel_data.get("bookings_last_7d", 0)
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

            # ── MANUAL EXPERIMENT LOCK ──
            _experiment_released = False
            _experiment_booked   = False
            _experiment_lock     = None
            lock = (experiment_locks or {}).get(rt, {}).get(date_str)

            if lock and lock.get("manual_lock", False):
                manual_price         = lock.get("manual_price", prices["gel"])
                manual_avail_at_set  = lock.get("manual_avail_at_set", avail)
                baseline_gel         = lock.get("baseline_price", manual_price)
                baseline_eur         = lock.get("baseline_price_eur", prices["eur"])
                _experiment_lock     = lock

                # Timeout: past next 12:00 UTC after the experiment was set
                timed_out = False
                manual_set_at_str = lock.get("manual_set_at", "")
                if manual_set_at_str:
                    try:
                        set_time  = datetime.fromisoformat(manual_set_at_str)
                        next_noon = set_time.replace(hour=12, minute=0, second=0, microsecond=0)
                        if set_time.hour >= 12:
                            next_noon += timedelta(days=1)
                        timed_out = datetime.now() >= next_noon
                    except Exception:
                        pass

                if avail >= manual_avail_at_set and not timed_out:
                    # No booking yet and not timed out — hold the lock, skip this date
                    print(
                        f"  Manual experiment active for {rt} {date_str} — "
                        f"locked at {manual_price:.0f} GEL, avail unchanged at {avail}"
                    )
                    results[rt].append({
                        "date":          date_str,
                        "days_ahead":    days,
                        "current_gel":   prices["gel"],
                        "proposed_gel":  prices["gel"],
                        "current_eur":   prices["eur"],
                        "proposed_eur":  prices["eur"],
                        "occupancy_pct": (total_units - avail) / total_units * 100,
                        "season":        get_season(date_str, config),
                        "skip":          True,
                        "reason":        f"manual experiment locked at {manual_price:.0f} GEL",
                    })
                    continue

                # Booking happened or timed out — release the lock
                _experiment_released = True
                _experiment_booked   = avail < manual_avail_at_set
                prev_avail           = manual_avail_at_set

                if _experiment_booked:
                    print(
                        f"  Manual experiment concluded for {rt} {date_str} — "
                        f"{prev_avail}→{avail} booked at {manual_price:.0f} GEL, "
                        f"resuming from baseline"
                    )
                else:
                    print(
                        f"  Manual experiment timed out for {rt} {date_str} — "
                        f"no booking, resuming from {manual_price:.0f} GEL"
                    )

                # Engine continues FROM baseline_price (= manual_price), not last_engine_price
                prices = {**prices, "gel": baseline_gel, "eur": baseline_eur}

            # Get boundaries
            floor_gel   = config.get("floor_prices_gel",   {}).get(rt, {}).get(season, 0)
            ceiling_gel = config.get("ceiling_prices_gel", {}).get(rt, {}).get(season, 0)
            floor_eur   = config.get("floor_prices_eur",   {}).get(rt, {}).get(season, 0)
            ceiling_eur = config.get("ceiling_prices_eur", {}).get(rt, {}).get(season, 0)

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

            # Occupancy %
            booked      = total_units - avail
            occ_pct     = (booked / total_units) * 100

            # Target occupancy for this lead time
            tgt_min, tgt_max = get_target_occupancy(days, is_big_apt)

            # Occupancy deficit
            occ_deficit = get_occupancy_deficit(occ_pct, tgt_min, tgt_max)

            # Velocity deficit
            vel_deficit = get_velocity_deficit(vel_bookings, days, total_units, is_big_apt)

            # Combined score
            score = calculate_price_score(occ_deficit, vel_deficit)

            # ── DEBUG LOG ──
            # Prints full math for dates with high occupancy (≥70%) or within 14 days
            _debug_dates = set(os.environ.get("PRICE_DEBUG_DATES", "").split(",")) - {""}
            _debug_all   = os.environ.get("PRICE_DEBUG", "") == "1"
            if _debug_all or date_str in _debug_dates or (occ_pct >= 70 and days <= 14):
                weeks_rem = max(days / 7, 0.5) if days > 0 else 0.5
                exp_wk = (((tgt_min + tgt_max) / 2) / 100 * total_units) / weeks_rem if weeks_rem else 0
                print(
                    f"  [DBG] {rt} {date_str}: avail={avail}/{total_units} "
                    f"occ={occ_pct:.0f}% tgt={tgt_min}-{tgt_max}% "
                    f"occ_deficit={occ_deficit:+.1f} | "
                    f"vel={vel_bookings}bk exp_wk={exp_wk:.2f} vel_deficit={vel_deficit:+.1f} | "
                    f"score={score:+.1f} | "
                    f"gel={prices['gel']} floor={floor_gel} ceil={ceiling_gel}",
                    file=sys.stderr,
                )

            # ── GEL PRICE ──
            proposed_gel = prices["gel"]
            gel_reason   = ""

            if channels.get("booking") or channels.get("expedia"):
                base_gel = config.get("base_prices_gel", {}).get(rt, {}).get(season, 0)

                if prices["gel"] == 0 and base_gel > 0:
                    # Not set yet — use base
                    proposed_gel = base_gel * event_mult
                    gel_reason   = f"unset→base {base_gel}₾ season={season}"

                elif prices["gel"] > 0:
                    # Last-minute cascade (if behind target)
                    if days <= 3 and occ_deficit > 5 and floor_gel > 0:
                        proposed_gel = apply_cascade(prices["gel"], floor_gel, days)
                        gel_reason   = f"CASCADE day={days} occ={occ_pct:.0f}% target={tgt_min}-{tgt_max}%"
                    else:
                        # Fix 1: snap to floor before any percentage calculation
                        eff_gel = max(prices["gel"], floor_gel) if floor_gel > 0 else prices["gel"]
                        extra_reason = ""
                        if eff_gel != prices["gel"]:
                            extra_reason += f" floor-snap({prices['gel']}→{eff_gel})"

                        # Fix 3: start-price gravity — pull toward start price if far away
                        start_gel = config.get("startPrices", {}).get(rt, {}).get(season, 0)
                        gravity = calculate_gravity_adjustment(eff_gel, start_gel) if start_gel > 0 else 0.0
                        if gravity > 0:
                            gravity_dir = 1 if start_gel > eff_gel else -1
                            eff_gel = eff_gel * (1 + gravity_dir * gravity)
                            if floor_gel > 0:
                                eff_gel = max(eff_gel, floor_gel)
                            if ceiling_gel > 0:
                                eff_gel = min(eff_gel, ceiling_gel)
                            extra_reason += f" grav({gravity:+.0%}→{start_gel:.0f})"

                        # Fix 2: faster step cap for high-demand short-window dates
                        max_change = 0.15 if (occ_pct >= 70 and days <= 14) else MAX_CHANGE_PER_RUN

                        eff_score = score * event_mult
                        proposed_gel, action, pct = apply_step(
                            eff_gel, eff_score, floor_gel, ceiling_gel or 99999, max_change
                        )
                        gel_reason = (
                            f"occ={occ_pct:.0f}% tgt={tgt_min}-{tgt_max}% "
                            f"vel={vel_bookings}bk score={score:.0f} {action}({pct:+.1%})"
                            + extra_reason
                        )
                        if event_label:
                            gel_reason += f" +{event_label}"
                        if _debug_all or date_str in _debug_dates or (occ_pct >= 70 and days <= 14):
                            print(
                                f"  [DBG] {rt} {date_str}: eff_gel={eff_gel:.1f} grav={gravity:.2f} "
                                f"max_chg={max_change} apply_step(score={score:.0f}, "
                                f"floor={floor_gel}, ceil={ceiling_gel}) → {proposed_gel} ({action} {pct:+.1%})",
                                file=sys.stderr,
                            )

                if ceiling_gel > 0:
                    proposed_gel = min(proposed_gel, ceiling_gel)
                proposed_gel = max(proposed_gel, floor_gel) if floor_gel > 0 else proposed_gel
                proposed_gel = round_price(proposed_gel, rounding)

            # ── EUR PRICE ──
            proposed_eur = prices["eur"]

            if channels.get("airbnb"):
                base_eur = config.get("base_prices_eur", {}).get(rt, {}).get(season, 0)

                if prices["eur"] == 0 and base_eur > 0:
                    proposed_eur = base_eur * event_mult

                elif prices["eur"] > 0:
                    if days <= 3 and occ_deficit > 5 and floor_eur > 0:
                        proposed_eur = apply_cascade(prices["eur"], floor_eur, days)
                    else:
                        # Fix 1: snap to floor before percentage calculation
                        eff_eur = max(prices["eur"], floor_eur) if floor_eur > 0 else prices["eur"]

                        # Fix 3: start-price gravity for EUR
                        start_eur = config.get("startPricesEur", {}).get(rt, {}).get(season, 0)
                        gravity_eur = calculate_gravity_adjustment(eff_eur, start_eur) if start_eur > 0 else 0.0
                        if gravity_eur > 0:
                            g_dir = 1 if start_eur > eff_eur else -1
                            eff_eur = eff_eur * (1 + g_dir * gravity_eur)
                            if floor_eur > 0:
                                eff_eur = max(eff_eur, floor_eur)
                            if ceiling_eur > 0:
                                eff_eur = min(eff_eur, ceiling_eur)

                        # Fix 2: faster step cap for high-demand short-window dates
                        max_change_eur = 0.15 if (occ_pct >= 70 and days <= 14) else MAX_CHANGE_PER_RUN

                        proposed_eur, _, _ = apply_step(
                            eff_eur, score, floor_eur, ceiling_eur or 99999, max_change_eur
                        )

                if ceiling_eur > 0:
                    proposed_eur = min(proposed_eur, ceiling_eur)
                proposed_eur = max(proposed_eur, floor_eur) if floor_eur > 0 else proposed_eur
                proposed_eur = round_price(proposed_eur, rounding)

            gel_changed = abs(proposed_gel - prices["gel"]) >= 1
            eur_changed = abs(proposed_eur - prices["eur"]) >= 1

            entry = {
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
                "reason":        gel_reason or f"occ={occ_pct:.0f}% score={score:.0f}",
            }
            if _experiment_released:
                entry["_experiment_released"] = True
                entry["_experiment_booked"]   = _experiment_booked
                entry["_experiment_lock"]     = _experiment_lock
            results[rt].append(entry)

    return results
