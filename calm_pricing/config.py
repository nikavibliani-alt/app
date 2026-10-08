"""
Default settings for the calm pricing engine.

Every number here is a starting value that can be changed from the pricing page
later. Nothing in this file talks to MiniHotel, Firestore or the internet.
"""

import copy

# Days-before-arrival bands. "down"/"up" are the furthest the TARGET may sit
# below/above the start price for that band. "min" means the band may go all
# the way to the user's minimum (last days before arrival).
DEFAULT_BANDS = [
    {"from": 61, "to": 10_000, "down": 0.03, "up": 0.08},
    {"from": 31, "to": 60,     "down": 0.05, "up": 0.12},
    {"from": 15, "to": 30,     "down": 0.08, "up": 0.15},
    {"from": 8,  "to": 14,     "down": 0.12, "up": 0.20},
    {"from": 4,  "to": 7,      "down": 0.15, "up": 0.20},
    {"from": 1,  "to": 3,      "down": "min", "up": 0.20},
    {"from": 0,  "to": 0,      "down": "hold", "up": 0.20},   # arrival day: never lower
]

# Normal share of units already booked at N days before arrival.
# Used until the engine has learned the real curve from your own bookings.
DEFAULT_CURVE = {0: 0.85, 1: 0.80, 3: 0.75, 7: 0.60, 14: 0.45, 30: 0.25, 60: 0.10, 90: 0.05}

# The same curve as "share of final bookings already made" (timing only).
DEFAULT_SHAPE = {d: round(v / DEFAULT_CURVE[0], 4) for d, v in DEFAULT_CURVE.items()}

DEFAULTS = {
    "window_days": 90,
    "rounding": {"GEL": 5, "USD": 1, "EUR": 1},
    # Lari per unit of currency; only used for sanity checks between channels.
    "fx": {"USD": 2.65, "EUR": 2.95},
    "bands": DEFAULT_BANDS,
    "demand": {
        # status thresholds: occupancy signal minus normal occupancy (in share points)
        "far_ahead": 0.25, "ahead": 0.10, "behind": -0.10, "far_behind": -0.25,
        # where the target sits relative to start, per status
        "target_adj": {"far_ahead": 0.15, "ahead": 0.08, "on_track": 0.0,
                       "behind": -0.06, "far_behind": -0.12},
        # how fast the live price may move toward the target, per day
        "speed_up":   {"far_ahead": 0.08, "ahead": 0.04, "on_track": 0.02,
                       "behind": 0.02, "far_behind": 0.02},
        "speed_down": {"far_ahead": 0.0, "ahead": 0.0, "on_track": 0.02,
                       "behind": 0.02, "far_behind": 0.04},
    },
    "weekend": {"nights": [4, 5], "pct": 0.08},     # Friday and Saturday nights (Mon=0)
    "last_units": {"min_units": 5, "two_left": 0.05, "one_left": 0.10},
    # Last days: share of the remaining distance to the minimum covered today.
    # Day 1 = the night before arrival day reaches the minimum.
    "cascade": {3: 1 / 3, 2: 1 / 2, 1: 1.0},
    # Before the last night, prices stay above the lowest quarter of your min-start range.
    "min_guard_share": 0.25,
    "calm": {
        "daily_down": 0.05,          # max drop per date per day (all runs together)
        "daily_up": 0.08,            # max raise per date per day
        "daily_down_last3": 0.15,    # last 3 days, to reach the minimum in steps
        "daily_up_hot": 0.15,        # far ahead and within 14 days
        "dead_zone_pct": 0.03,       # ignore targets closer than 3% ...
        "dead_zone_abs": {"GEL": 10, "USD": 3, "EUR": 3},  # ... or closer than this
        "no_raise_after_drop_h": 36,   # covers the next morning run too
        "no_drop_after_raise_h": 48,
        "drift_reverse_block_h": 72,  # "selling as normal": no back-and-forth within 3 days
        "manual_lock_h": 48,         # a hand-set price is left alone this long
        "pickup_days": 3,            # a booking in the last 3 days blocks drops nearby
        "main_run_from_hour": 9,     # the first run of the day from 09:00 Tbilisi may lower prices
        "main_run_latest_hour": 12,  # if that first run is 12:00 or later, a warning is recorded
    },
    "safety": {
        "max_share_changed": 0.40,   # more dates than this changing in one run -> stop
        "max_share_missing_price": 0.10,  # more dates of a room type without a price -> stop
        "price_vs_start": [0.5, 2.0],
        "fx_ratio": [0.6, 1.6],      # GEL vs foreign price; outside -> warning only
        "min_dates_ratio": 0.9,      # MiniHotel must return at least 90% of the window
        "warmup_days": 3,            # first days after switching on: many moves allowed (warning only)
    },
    "tz_offset_hours": 4,            # Tbilisi
    "curve_default": DEFAULT_CURVE,   # kept for reference
    "shape_default": DEFAULT_SHAPE,
    # Occupancy you aim for on the night itself. Per group, e.g. {"vgl": 0.90}.
    "occupancy_goal": {"default": 0.85},
    # Learn booking timing from your reservations (False = use the default curve above).
    "learn_timing": False,
    "seasons": [
        {"name": "new_year", "ranges": [["01-01", "01-14"], ["12-24", "12-31"]]},
        {"name": "low", "ranges": [["01-15", "03-15"]]},
        {"name": "mid", "ranges": [["03-16", "04-30"], ["10-01", "11-30"]]},
        {"name": "high", "ranges": [["05-01", "06-30"], ["09-01", "09-30"]]},
        {"name": "peak", "ranges": [["07-01", "08-31"]]},
        {"name": "xmas_low", "ranges": [["12-01", "12-23"]]},
    ],
    "date_overrides": [],   # [{"from": "MM-DD", "to": "MM-DD", "season": "peak"}]
    "events": {},           # {"YYYY-MM-DD": {"label": "...", "pct": 0.30}}
    "room_types": {},       # filled by the caller
    "rules": {},            # {rt: {currency: {season: {"min":, "start":, "max":}}}}
}


# Settings whose keys are numbers of days: replaced as a whole, keys made numeric
# (settings saved as JSON come back with text keys like "3").
WHOLE_DAY_TABLES = ("cascade", "curve_default", "shape_default")


# Hard limits for settings that can be changed from Firestore. A value outside its range,
# or not a number, falls back to the default and is reported. The defaults sit well inside.
HARD_LIMITS = {
    ("window_days",): (30, 120),
    ("calm", "daily_down"): (0.0, 0.10),
    ("calm", "daily_up"): (0.0, 0.12),
    ("calm", "daily_down_last3"): (0.0, 0.20),
    ("calm", "daily_up_hot"): (0.0, 0.20),
    ("calm", "dead_zone_pct"): (0.0, 0.10),
    ("calm", "no_raise_after_drop_h"): (12, 96),
    ("calm", "no_drop_after_raise_h"): (12, 96),
    ("calm", "drift_reverse_block_h"): (24, 168),
    ("calm", "manual_lock_h"): (0, 168),
    ("calm", "pickup_days"): (0, 7),
    ("calm", "main_run_from_hour"): (6, 14),
    ("calm", "main_run_latest_hour"): (8, 18),
    ("safety", "max_share_changed"): (0.05, 0.60),
    ("safety", "max_share_missing_price"): (0.0, 0.25),
    ("safety", "min_dates_ratio"): (0.80, 1.0),
    ("safety", "warmup_days"): (0, 7),
    ("weekend", "pct"): (0.0, 0.25),
    ("last_units", "two_left"): (0.0, 0.20),
    ("last_units", "one_left"): (0.0, 0.25),
    ("min_guard_share",): (0.0, 0.5),
    ("tz_offset_hours",): (3, 5),
}
BAND_LIMITS = {"down": (0.0, 0.25), "up": (0.0, 0.35)}
DEMAND_LIMITS = {"target_adj": (-0.20, 0.25), "speed_up": (0.0, 0.15), "speed_down": (0.0, 0.10)}


def _check(value, default, lo, hi, name, problems):
    try:
        v = float(value)
    except (TypeError, ValueError):
        problems.append(f"setting {name}={value!r} is not a number; default {default} used.")
        return default
    if not lo <= v <= hi:
        problems.append(f"setting {name}={v:g} is outside {lo:g}-{hi:g}; default {default} used.")
        return default
    return int(round(v)) if isinstance(default, int) and not isinstance(default, bool) else v


def apply_limits(cfg: dict) -> list:
    """Clamp every changeable safety setting back to its default when it is unsafe. Returns the problems."""
    problems = []
    for path, (lo, hi) in HARD_LIMITS.items():
        node, dnode = cfg, DEFAULTS
        for k in path[:-1]:
            node, dnode = node.setdefault(k, {}), dnode[k]
        if not isinstance(node, dict):
            continue
        node[path[-1]] = _check(node.get(path[-1]), dnode[path[-1]], lo, hi, ".".join(path), problems)
    pv = cfg["safety"].get("price_vs_start")
    if not (isinstance(pv, (list, tuple)) and len(pv) == 2
            and 0.3 <= _check(pv[0], 0.5, 0, 9, "x", []) <= 0.9 and 1.2 <= _check(pv[1], 2.0, 0, 9, "x", []) <= 3.0):
        if pv != DEFAULTS["safety"]["price_vs_start"]:
            problems.append(f"setting safety.price_vs_start={pv!r} is unsafe; default used.")
        cfg["safety"]["price_vs_start"] = list(DEFAULTS["safety"]["price_vs_start"])
    bands = cfg.get("bands")
    ok_bands = isinstance(bands, list) and bands
    if ok_bands:
        for b in bands:
            if not isinstance(b, dict) or "from" not in b or "to" not in b:
                ok_bands = False
                break
            for k, (lo, hi) in BAND_LIMITS.items():
                if b.get(k) in ("min", "hold") and k == "down":
                    continue
                try:
                    v = float(b.get(k))
                except (TypeError, ValueError):
                    ok_bands = False
                    break
                if not lo <= v <= hi:
                    ok_bands = False
        # the last 3 days and arrival day must keep their special rules
        if ok_bands:
            day0 = [b for b in bands if int(b["from"]) <= 0 <= int(b["to"])]
            ok_bands = bool(day0) and day0[0].get("down") == "hold"
    if not ok_bands:
        if bands != DEFAULTS["bands"]:
            problems.append("setting bands is unsafe or incomplete; default bands used.")
        cfg["bands"] = copy.deepcopy(DEFAULTS["bands"])
    for table, (lo, hi) in DEMAND_LIMITS.items():
        t = cfg["demand"].get(table)
        for status, dv in DEFAULTS["demand"][table].items():
            cur = t.get(status) if isinstance(t, dict) else None
            cfg["demand"].setdefault(table, {})
            if not isinstance(cfg["demand"][table], dict):
                cfg["demand"][table] = {}
            cfg["demand"][table][status] = _check(cur, dv, lo, hi, f"demand.{table}.{status}", problems)
    casc = cfg.get("cascade") or {}
    if not (isinstance(casc, dict) and all(0 < float(v) <= 1 for v in casc.values()) and float(casc.get(1, 0)) == 1.0):
        problems.append("setting cascade is unsafe; default used.")
        cfg["cascade"] = dict(DEFAULTS["cascade"])
    for g, v in list((cfg.get("occupancy_goal") or {}).items()):
        cfg["occupancy_goal"][g] = _check(v, 0.85, 0.5, 0.98, f"occupancy_goal.{g}", problems)
    return problems


def merged(overrides: dict | None = None) -> dict:
    """
    Return a deep copy of DEFAULTS with overrides merged in (one level deep per key).
    Unsafe values are put back to their defaults; the problems are listed in cfg["_settings_warnings"].
    """
    cfg = copy.deepcopy(DEFAULTS)
    for k, v in (overrides or {}).items():
        if k in WHOLE_DAY_TABLES and isinstance(v, dict):
            cfg[k] = {int(kk): vv for kk, vv in v.items()}
            continue
        if isinstance(v, dict) and isinstance(cfg.get(k), dict):
            for k2, v2 in v.items():
                if isinstance(v2, dict) and isinstance(cfg[k].get(k2), dict):
                    cfg[k][k2] = {**cfg[k][k2], **v2}
                else:
                    cfg[k][k2] = v2
        else:
            cfg[k] = copy.deepcopy(v)
    try:
        cfg["_settings_warnings"] = apply_limits(cfg)
    except Exception as e:                      # any malformed settings: back to all defaults
        cfg = copy.deepcopy(DEFAULTS)
        cfg["_settings_warnings"] = [f"settings could not be read ({e}); all defaults used."]
    return cfg


def season_of(date_str: str, cfg: dict) -> str:
    md = date_str[5:]
    for ov in cfg.get("date_overrides", []):
        frm, to, s = ov.get("from", ""), ov.get("to", ""), ov.get("season")
        if not (frm and to and s):
            continue
        if (frm <= md <= to) if frm <= to else (md >= frm or md <= to):
            return s
    for season in cfg["seasons"]:
        for start, end in season["ranges"]:
            if start <= md <= end:
                return season["name"]
    return "mid"
