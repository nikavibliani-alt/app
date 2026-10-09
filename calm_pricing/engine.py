"""
Calm pricing engine.

One call = one run. The function is pure: it receives what MiniHotel shows now
(availability + current prices), recent reservations, the settings and the
engine's memory from earlier runs, and returns the decisions plus the updated
memory. It never talks to MiniHotel, Firestore or the internet itself.

Core ideas (plain words):
  * Every date's TARGET is worked out fresh from your start price, so prices
    cannot creep run after run.
  * The live price moves toward the target slowly. Limits count a rolling
    24 hours, whatever the number of runs.
  * Only the morning run may lower prices. Later runs may only raise.
  * Far-away dates may move only a little; the minimum is reached at the
    earliest on the night before arrival day, and the arrival day is never lowered.
  * Your minimum and maximum always win, even over a hand-set price.
  * Anything that looks wrong stops the whole run: nothing is written.

Shadow mode (snapshot["shadow"] = True): the engine keeps its own "virtual"
price for every date in its memory and moves that, while MiniHotel prices are
left to the old engine. Nothing is ever written. Used for the 2-week test.
"""

from __future__ import annotations

import math
from datetime import date, datetime, timedelta, timezone

import copy

from .config import season_of, AGGRESSIVE
from .curve import interpolate

STATUS_WORDS = {
    "far_ahead": "selling much faster than normal",
    "ahead": "selling faster than normal",
    "on_track": "selling as normal",
    "behind": "selling slower than normal",
    "far_behind": "selling much slower than normal",
}


# --------------------------------------------------------------------------
# small helpers
# --------------------------------------------------------------------------

def _d(x) -> date:
    return x if isinstance(x, date) and not isinstance(x, datetime) else date.fromisoformat(str(x)[:10])


def _band(days_out: int, cfg: dict) -> dict:
    for b in cfg["bands"]:
        if int(b["from"]) <= days_out <= int(b["to"]):
            return b
    return cfg["bands"][0]


def _status(gap: float, dm: dict) -> str:
    if gap >= dm["far_ahead"]:
        return "far_ahead"
    if gap >= dm["ahead"]:
        return "ahead"
    if gap <= dm["far_behind"]:
        return "far_behind"
    if gap <= dm["behind"]:
        return "behind"
    return "on_track"


def _mode(units: int) -> str:
    if units >= 5:
        return "pool"
    if units >= 2:
        return "small_pool"
    return "single"


def _fmt(cur: str, v: float) -> str:
    sym = {"GEL": "₾", "USD": "$", "EUR": "€"}.get(cur, cur)
    return f"{v:,.0f} {sym}" if cur == "GEL" else f"{sym}{v:,.0f}"


def _grid_down_to(limit: float, step: float, floor_: float) -> float:
    """Highest grid price <= limit; if it falls under floor_, use limit itself."""
    r = math.floor(limit / step + 1e-9) * step if step > 0 else limit
    return float(r if r >= floor_ - 1e-9 else limit)


def _grid_up_to(limit: float, step: float, ceil_: float) -> float:
    """Lowest grid price >= limit; if it goes over ceil_, use limit itself."""
    r = math.ceil(limit / step - 1e-9) * step if step > 0 else limit
    return float(r if r <= ceil_ + 1e-9 else limit)


def _grid_move(current: float, proposed: float, step: float, direction: int, bound: float) -> float:
    """
    Put a move on the price grid without ever crossing the current price or the
    furthest allowed price (`bound`). If the speed limit allowed less than one
    grid step, take exactly one grid step when it stays within `bound`.
    Returns `current` when no grid price fits.
    """
    if step <= 0:
        return proposed
    if direction < 0:
        cand = math.ceil(proposed / step - 1e-9) * step
        if cand >= current - 1e-9:
            cand = math.floor((current - 1e-6) / step) * step
        return float(cand) if cand >= bound - 1e-9 and cand < current else current
    cand = math.floor(proposed / step + 1e-9) * step
    if cand <= current + 1e-9:
        cand = math.ceil((current + 1e-6) / step) * step
    return float(cand) if cand <= bound + 1e-9 and cand > current else current


def _local(now: datetime, cfg: dict) -> datetime:
    """Engine works in Tbilisi time. A time with a time zone is converted."""
    if now.tzinfo is not None:
        tz = timezone(timedelta(hours=cfg.get("tz_offset_hours", 4)))
        return now.astimezone(tz).replace(tzinfo=None)
    return now


def _move_ts(m):
    return m["t"] if isinstance(m, dict) else m[0]


def _move_price(m):
    return m["p"] if isinstance(m, dict) else m[1]


def _profiles(cfg: dict) -> dict:
    """The settings used per style. 'normal' is cfg itself; 'aggressive' changes only how far and how fast prices drop."""
    ag = dict(cfg)
    ag["bands"] = copy.deepcopy(AGGRESSIVE["bands"])
    ag["demand"] = {**cfg["demand"],
                    "target_adj": {**cfg["demand"]["target_adj"], **AGGRESSIVE["target_adj"]},
                    "speed_down": {**cfg["demand"]["speed_down"], **AGGRESSIVE["speed_down"]}}
    ag["calm"] = {**cfg["calm"], "daily_down": max(cfg["calm"]["daily_down"], AGGRESSIVE["daily_down"])}
    ag["min_guard_share"] = min(cfg.get("min_guard_share", 0.25), AGGRESSIVE["min_guard_share"])
    return {"normal": cfg, "aggressive": ag}


def _date_rule(rt: str, ds: str, rules: list):
    """The last matching date rule for this room type and date, or None."""
    found = None
    for r in rules or []:
        rooms = r.get("rooms", "all")
        if str(r["from"]) <= ds <= str(r["to"]) and (rooms == "all" or rt in rooms):
            found = r
    return found


def _int_keys(d: dict) -> dict:
    return {int(k): v for k, v in d.items()}


# --------------------------------------------------------------------------
# demand signal
# --------------------------------------------------------------------------

def _build_occupancy(inventory: dict, room_types: dict):
    occ, booked, missing = {}, {}, {}
    for rt, dates in inventory.items():
        if rt not in room_types:
            continue
        units = max(1, int(room_types[rt]["units"]))
        occ[rt], booked[rt], missing[rt] = {}, {}, set()
        for ds, cell in dates.items():
            a = cell.get("avail")
            if a is None:
                missing[rt].add(ds)
                continue
            avail = max(0, min(units, int(a)))
            booked[rt][ds] = units - avail
            occ[rt][ds] = (units - avail) / units
    return occ, booked, missing


def _group_occ(group: str, ds: str, room_types: dict, booked: dict, exclude: str | None = None):
    tot_units, tot_booked = 0, 0
    for rt, info in room_types.items():
        if rt == exclude or info.get("group") != group or info.get("status", "live") == "off":
            continue
        if rt in booked and ds in booked[rt]:
            tot_units += int(info["units"])
            tot_booked += booked[rt][ds]
    return (tot_booked / tot_units, tot_units) if tot_units else (None, 0)


def _pickup_dates(reservations: list, today: date, days: int, room_types: dict):
    """Dates of each room type touched by a booking made in the last `days` (own room type only)."""
    by_rt, by_group = {}, {}
    since = today - timedelta(days=days)
    for r in reservations or []:
        rt = r.get("rt")
        if rt not in room_types:
            continue
        try:
            created, ci, co = _d(r["created"]), _d(r["checkin"]), _d(r["checkout"])
        except (KeyError, ValueError, TypeError):
            continue
        if created < since:
            continue
        n = ci - timedelta(days=1)
        while n <= co:
            by_rt.setdefault(rt, set()).add(n.isoformat())
            n += timedelta(days=1)
    return by_rt, by_group


# --------------------------------------------------------------------------
# main entry
# --------------------------------------------------------------------------

def run(snapshot: dict, cfg: dict, state: dict | None = None) -> dict:
    """
    snapshot = {
      "now": datetime (Tbilisi time, or any time zone-aware datetime),
      "inventory": {rt: {"YYYY-MM-DD": {"avail": int, "prices": {"GEL": x, "USD": y}}}},
      "reservations": [{"rt", "checkin", "checkout", "created"}]  # not cancelled
      "curves": {group: {days_before: share_of_final_bookings}}  # optional, learned timing
      "run_kind": "main" | "update" | None      # optional override
      "shadow": bool                            # optional: virtual prices, never writes
    }
    Returns {"ok", "stopped_room_types", "main_run", "alerts", "warnings", "decisions", "writes",
             "shadow_moves", "state", "changed", "considered", "corrections"}.
    """
    state = state if state is not None else {}
    meta = state.setdefault("_meta", {})
    now = _local(snapshot["now"], cfg)
    today = now.date()
    today_s = today.isoformat()
    room_types = cfg["room_types"]
    inventory = snapshot.get("inventory", {})
    shadow = bool(snapshot.get("shadow"))
    # One-time price reset (snapshot["reset"] = set of room types): see the reset block below.
    reset_rts = set(snapshot.get("reset") or ()) if not shadow else set()
    calm, dm = cfg["calm"], cfg["demand"]
    cascade = _int_keys(cfg["cascade"])
    alerts, warnings, decisions = [], [], []
    warnings.extend(cfg.get("_settings_warnings", []))
    # A problem with one room type stops only that room type; a run-wide problem stops everything.
    stopped_rts, global_stop = set(), False

    def stop_rt(rt_, msg):
        stopped_rts.add(rt_)
        alerts.append(msg + " This room type is left alone this run.")

    # ---- which run is this? only one run per day may lower prices ----
    kind = snapshot.get("run_kind")
    if kind is None:
        kind = "main" if (now.hour >= calm.get("main_run_from_hour", 9) and meta.get("last_main_day") != today_s) else "update"
    if kind == "main" and meta.get("last_main_day") == today_s:
        kind = "update"
    if reset_rts:
        kind = "update"          # a reset never uses up the day's one lowering run
    main_run = kind == "main"
    meta.setdefault("first_run_day", today_s)
    if main_run and now.hour >= calm.get("main_run_latest_hour", 12):
        warnings.append(f"No run between {calm.get('main_run_from_hour', 9):02d}:00 and "
                        f"{calm.get('main_run_latest_hour', 12) - 1:02d}:59 today: this {now:%H:%M} run is the one allowed to lower prices.")

    # ---- safety: is the data complete? ----
    def window_of(info_):
        return int(info_.get("window_days") or cfg["window_days"])

    for rt, info in room_types.items():
        if info.get("status", "live") == "off":
            continue
        dates = inventory.get(rt)
        if not dates:
            stop_rt(rt, f"{rt}: MiniHotel returned no data for this room type.")
            continue
        future = [d for d in dates if d >= today_s]
        if len(future) < cfg["safety"]["min_dates_ratio"] * window_of(info):
            stop_rt(rt, f"{rt}: MiniHotel returned only {len(future)} of {window_of(info)} days.")

    occ, booked, missing = _build_occupancy(inventory, room_types)
    for rt, ms in missing.items():
        ms_future = [m for m in ms if m >= today_s]
        if ms_future:
            stop_rt(rt, f"{rt}: availability missing for {len(ms_future)} date(s), e.g. {min(ms_future)}.")
    pick_rt, pick_group = _pickup_dates(snapshot.get("reservations", []), today, calm["pickup_days"], room_types)
    curves = snapshot.get("curves", {})

    considered, changed, corrections = 0, 0, 0
    per_rt = {rt: [0, 0, 0] for rt in room_types}   # rt -> [prices considered, prices that would move, big changes]
    # Rules seen in the last applied run, to tell a deliberate change of your prices from a typo.
    seen = meta.setdefault("rules_seen", {})
    rule_change = {}                                  # rt -> "same" | "new" | "modest" | "large"
    for rt in room_types:
        now_r = {c: {s_: [float(r["min"]), float(r["start"]), float(r["max"])] for s_, r in by_s.items()}
                 for c, by_s in (cfg["rules"].get(rt) or {}).items()}
        old_r = seen.get(rt)
        if not old_r:
            rule_change[rt] = "new"
        elif old_r == now_r:
            rule_change[rt] = "same"
        else:
            large = []
            for c, by_s in now_r.items():
                for s_, vals in by_s.items():
                    prev = (old_r.get(c) or {}).get(s_)
                    if prev and any(v > 2 * pv or v < 0.5 * pv for v, pv in zip(vals, prev) if pv > 0):
                        large.append(f"{c} {s_}: {'/'.join(f'{x:g}' for x in prev)} -> {'/'.join(f'{x:g}' for x in vals)}")
            rule_change[rt] = "large" if large else "modest"
            if large:
                warnings.append(f"{rt}: your minimum/start/maximum changed by more than double or half ({'; '.join(large[:3])}). "
                                "Big price changes from this are not allowed automatically; if it is intended, change it "
                                "in steps of at most double or half per day.")
            else:
                warnings.append(f"{rt}: your minimum/start/maximum changed; prices may follow in one step this run.")
        rule_change.setdefault(rt, "new")
        per_rt[rt].append(now_r)                      # per_rt[rt][3] = rules as seen now
    missing_price = {}   # (rt, currency) -> [dates without a price, dates checked, first such date]
    profiles = _profiles(cfg)
    for rt, info in room_types.items():
        status_rt = info.get("status", "live")
        if status_rt == "off" or rt not in inventory:
            continue
        units = max(1, int(info["units"]))
        group = info.get("group")
        mode = info.get("mode") or _mode(units)
        shape = _int_keys(curves.get(group) or curves.get(rt) or cfg["shape_default"])
        goal = cfg["occupancy_goal"].get(group, cfg["occupancy_goal"].get("default", 0.85))
        rt_state = state.setdefault(rt, {})
        # Filling empty dates: only when the next 60 days look normally priced (at least half of
        # the free dates have a price). A MiniHotel glitch that drops all prices is never "filled".
        fill_ok = {}
        if info.get("fill_missing"):
            for cur_ in info.get("currencies", ["GEL"]):
                open_ds = [d for d, c in inventory[rt].items()
                           if d >= today_s and (_d(d) - today).days <= 60
                           and c.get("avail") is not None and int(c["avail"]) > 0]
                priced = [d for d in open_ds if float((inventory[rt][d].get("prices") or {}).get(cur_) or 0) > 0]
                fill_ok[cur_] = bool(open_ds) and len(priced) / len(open_ds) >= 0.5
        can_write = status_rt == "live"
        reset_mode = rt in reset_rts

        for ds in sorted(inventory[rt]):
            if ds < today_s or ds in missing.get(rt, set()):
                continue
            cell = inventory[rt][ds]
            dday = _d(ds)
            days_out = (dday - today).days
            if days_out > window_of(info):
                continue
            avail = max(0, min(units, int(cell["avail"])))
            season = season_of(ds, cfg)

            # ---------- date rules and style ----------
            rule = _date_rule(rt, ds, cfg.get("date_rules"))
            if rule and rule["action"] == "protect":
                for cur in info.get("currencies", ["GEL"]):
                    p0 = float((cell.get("prices") or {}).get(cur) or 0)
                    st0 = rt_state.setdefault(ds, {}).setdefault(cur, {})
                    c0 = float(st0.get("shadow_price", p0)) if shadow else p0
                    decisions.append({"rt": rt, "date": ds, "currency": cur, "days_out": days_out, "season": season,
                                      "avail": avail, "units": units, "mh_price": p0, "current": c0, "proposed": c0,
                                      "min": None, "max": None, "target": None, "status": None, "write": False,
                                      "kind": "protected", "style": None, "blocked": [],
                                      "why": [f"Protected date ({rule.get('note') or 'date rule'}): left alone."]})
                continue
            style = (rule["action"] if rule else None) or info.get("style") or "normal"
            pc = profiles.get(style, cfg)
            dm, calm = pc["demand"], pc["calm"]
            goal_d = max(goal, AGGRESSIVE["occupancy_goal_floor"]) if style == "aggressive" else goal

            # ---------- demand signal (same for every currency) ----------
            own = occ[rt][ds]
            g_occ, g_units = _group_occ(group, ds, room_types, booked) if group else (None, 0)
            if mode == "pool":
                signal = own
            elif mode == "small_pool":
                signal = 0.6 * own + 0.4 * g_occ if (g_occ is not None and g_units > units) else own
            else:  # single: empty or full, nothing in between
                signal = own
            expected = goal_d * interpolate(shape, days_out)
            gap = signal - expected
            status = _status(gap, dm)
            building_busy = False
            if mode == "single" and own == 0 and days_out > 3 and status in ("behind", "far_behind"):
                o_occ, o_units = _group_occ(group, ds, room_types, booked, exclude=rt) if group else (None, 0)
                if o_occ is not None and o_units > 0 and o_occ >= expected:
                    # the rest of the building sells as normal: do not undercut it
                    status, building_busy = "on_track", True
            pickup = ds in pick_rt.get(rt, set())

            # ---------- fixed factors ----------
            wk = cfg["weekend"]["pct"] if dday.weekday() in cfg["weekend"]["nights"] else 0.0
            ev_pct, ev_label, ev_today = 0.0, "", False
            ev = cfg.get("events", {}).get(ds)
            ev_next = cfg.get("events", {}).get((dday + timedelta(days=1)).isoformat())
            if ev:
                ev_pct, ev_label, ev_today = float(ev.get("pct", 0)), ev.get("label", "event"), True
            elif ev_next:
                ev_pct, ev_label = float(ev_next.get("pct", 0)) / 2, f"night before {ev_next.get('label', 'event')}"
            lu = 0.0
            lu_cfg = cfg["last_units"]
            if units >= lu_cfg["min_units"] and avail in (1, 2):
                lu = lu_cfg["one_left"] if avail == 1 else lu_cfg["two_left"]

            for cur in info.get("currencies", ["GEL"]):
                rules = cfg["rules"].get(rt, {}).get(cur, {}).get(season)
                mh_price = float((cell.get("prices") or {}).get(cur) or 0)
                st = rt_state.setdefault(ds, {}).setdefault(cur, {})
                current = float(st.get("shadow_price", mh_price)) if shadow else mh_price
                dec = {"rt": rt, "date": ds, "currency": cur, "days_out": days_out, "season": season,
                       "avail": avail, "units": units, "mh_price": mh_price, "current": current, "proposed": current,
                       "min": None, "max": None, "style": style,
                       "target": None, "status": status, "write": False, "kind": "hold",
                       "why": [], "blocked": []}
                decisions.append(dec)

                if avail == 0:
                    if st.get("manual_until") and avail < st.get("avail_at_manual", avail):
                        for k in ("manual_until", "manual_price", "avail_at_manual"):
                            st.pop(k, None)
                        st["last_engine"] = current
                        dec["why"].append("Hand-set price released after a booking.")
                    dec["why"].append("Fully booked: price left alone.")
                    continue
                if not rules:
                    dec["why"].append(f"No minimum/start/maximum set for {season} season: price left alone.")
                    continue
                if reset_mode and current <= 0:
                    dec["why"].append("Reset: no price yet; the normal run gives it a first price. Left alone.")
                    continue
                mp = missing_price.setdefault((rt, cur), [0, 0, None])
                mp[1] += 1
                if current <= 0:
                    if fill_ok.get(cur):
                        # no price yet: start from your start price; the engine's price for this date is written
                        current = float(rules["start"])
                        dec["current"] = dec["proposed"] = current
                        dec["fill"] = True
                        dec["why"].append("No price in MiniHotel yet: the engine sets one from your start price.")
                    else:
                        mp[0] += 1
                        mp[2] = mp[2] or ds
                        dec["why"].append("No current price in MiniHotel: left alone and reported.")
                        continue
                if can_write:
                    considered += 1
                    per_rt[rt][0] += 1

                mn, start, mx = float(rules["min"]), float(rules["start"]), float(rules["max"])
                if not (0 < mn <= start <= mx):
                    msg = f"{rt} {season} {cur}: minimum/start/maximum are not in order ({mn:g}/{start:g}/{mx:g}); those dates are left alone."
                    if msg not in warnings:
                        warnings.append(msg)
                    dec["why"].append("Your minimum, start and maximum are not in order: left alone and reported.")
                    continue
                mx_eff = mx * (1 + ev_pct) if (ev_today and ev_pct > 0) else mx
                step = float(cfg["rounding"].get(cur, 1))
                dec["min"], dec["max"] = mn, round(mx_eff, 2)

                # ---- rolling 24-hour memory of moves ----
                moves = [m if isinstance(m, dict) else {"t": m[0], "p": m[1]} for m in st.get("moves", [])
                         if now - datetime.fromisoformat(_move_ts(m)) < timedelta(hours=24)]
                st["moves"] = moves
                baseline = _move_price(moves[0]) if moves else current

                # ---- 1. your minimum and maximum always win ----
                if not reset_mode and (current > mx_eff + 1e-9 or current < mn - 1e-9):
                    if current > mx_eff:
                        new = _grid_down_to(mx_eff, step, mn)
                        dec["why"].append(f"Above your maximum {_fmt(cur, mx_eff)}: brought down to it.")
                    else:
                        new = _grid_up_to(mn, step, mx_eff)
                        dec["why"].append(f"Below your minimum {_fmt(cur, mn)}: brought up to it.")
                    if st.get("manual_until"):
                        dec["why"].append("This was a hand-set price; your minimum/maximum win over it.")
                        for k in ("manual_until", "manual_price", "avail_at_manual"):
                            st.pop(k, None)
                    dec["proposed"], dec["kind"] = new, "correction"
                    dec["write"] = can_write and not shadow
                    corrections += 1
                    if can_write and abs(new - current) / current > 0.10:
                        per_rt[rt][2] += 1
                    dec["why"].append(f"Today: {_fmt(cur, current)} -> {_fmt(cur, new)}.")
                    continue

                # ---- 2. your hand-set prices win (live room types, not in shadow) ----
                if can_write and not shadow and not reset_mode:
                    last_eng = st.get("last_engine")
                    lock_until = st.get("manual_until")
                    if last_eng is not None and abs(current - last_eng) >= 0.5 and not lock_until:
                        st["manual_until"] = (now + timedelta(hours=calm["manual_lock_h"])).isoformat()
                        st["manual_price"] = current
                        st["avail_at_manual"] = avail
                        lock_until = st["manual_until"]
                    if lock_until:
                        if abs(current - st.get("manual_price", current)) >= 0.5:
                            st["manual_until"] = (now + timedelta(hours=calm["manual_lock_h"])).isoformat()
                            st["manual_price"] = current
                            st["avail_at_manual"] = avail
                        booked_since = avail < st.get("avail_at_manual", avail)
                        if now < datetime.fromisoformat(st["manual_until"]) and not booked_since:
                            dec["why"].append(
                                f"Your hand-set price {_fmt(cur, current)} is kept until "
                                f"{st['manual_until'][:16].replace('T', ' ')}.")
                            dec["kind"] = "manual"
                            continue
                        for k in ("manual_until", "manual_price", "avail_at_manual"):
                            st.pop(k, None)
                        st["last_engine"] = current
                        # keep the 24-hour memory: the hand price is the new current price,
                        # not a new starting point for the daily limits
                        dec["why"].append("Hand-set price released" + (" after a booking." if booked_since else " (time is up)."))

                # ---- 3. target ----
                base = start * (1 + wk) * (1 + ev_pct)
                adj = dm["target_adj"][status]
                raw = base * (1 + lu) * (1 + adj)
                band = _band(days_out, pc)
                high = base * (1 + float(band["up"]))
                if band["down"] == "min":
                    low = mn
                elif band["down"] == "hold":
                    low = min(current, base)
                else:
                    low = base * (1 - float(band["down"]))
                if days_out >= 2:
                    # the minimum itself is kept for the night before arrival day
                    guard = mn + pc.get("min_guard_share", 0.25) * max(0.0, start - mn)
                    low = max(low, guard) if band["down"] != "min" else max(low, mn + (guard - mn) * 0.5)
                target = min(max(raw, low), high)
                last_days_behind = 1 <= days_out <= 3 and status in ("behind", "far_behind") and not pickup
                if last_days_behind:
                    target = mn
                target = min(max(target, mn), mx_eff)
                dec["target"] = round(target, 2)

                dec["why"].append(f"{season.replace('_', ' ').capitalize()} season: start {_fmt(cur, start)}.")
                if style == "aggressive":
                    dec["why"].append("Aggressive mode (fill the month): lowers faster and further when selling slowly.")
                if wk:
                    dec["why"].append(f"{dday.strftime('%A')} night +{wk:.0%}.")
                if ev_pct:
                    dec["why"].append(f"{ev_label}: +{ev_pct:.0%}" + (f", maximum lifted to {_fmt(cur, mx_eff)}." if ev_today else
                                      f", still capped at your maximum {_fmt(cur, mx)}."))
                if lu:
                    dec["why"].append(f"Only {avail} of {units} left: +{lu:.0%}.")
                sold = units - avail
                if mode == "pool":
                    dec["why"].append(
                        f"{sold} of {units} sold, normal at {days_out} days is about {expected * units:.1f}: {STATUS_WORDS[status]}.")
                else:
                    dec["why"].append(
                        f"Demand {signal:.0%}{' (with the rest of the building)' if mode == 'small_pool' and g_units > units else ''}, "
                        f"normal at {days_out} days is {expected:.0%}: {STATUS_WORDS[status]}.")
                if building_busy:
                    dec["why"].append("The rest of the building is selling as normal: not going below the normal price.")
                if pickup:
                    dec["why"].append("A booking for this room type came in nearby in the last 3 days: no drops.")
                if last_days_behind:
                    dec["why"].append("Last days and still empty: stepping toward your minimum.")

                # ---- 3b. one-time reset: straight down to the plain target, never up ----
                if reset_mode:
                    plain = min(max(base, mn), mx_eff)          # start price x weekend x holiday, inside min/max
                    dec["base_target"] = round(plain, 2)
                    if days_out < 1:
                        dec["why"].append("Reset: today is skipped.")
                        continue
                    new = round(plain / step) * step if step > 0 else plain
                    if new < mn - 1e-9:
                        new = _grid_up_to(mn, step, mx_eff)
                    elif new > mx_eff + 1e-9:
                        new = _grid_down_to(mx_eff, step, mn)
                    new = float(new)
                    if new >= current - 1e-9:
                        dec["why"].append(f"Reset: {_fmt(cur, current)} is not above the target {_fmt(cur, new)}; left as it is.")
                        continue
                    if st.get("manual_until"):
                        dec["why"].append("This was a hand-set price; the reset brings it down to the target.")
                        for k in ("manual_until", "manual_price", "avail_at_manual"):
                            st.pop(k, None)
                    dec["proposed"], dec["kind"] = new, "reset"
                    dec["write"] = can_write and not shadow
                    dec["why"].append(f"Reset: {_fmt(cur, current)} -> {_fmt(cur, new)} (target: start x weekend x holiday).")
                    continue

                # ---- 4. direction and speed ----
                dz = max(calm["dead_zone_pct"] * current, calm["dead_zone_abs"].get(cur, 0))
                if abs(target - current) < dz:
                    dec["why"].append("Already close to the target: no change.")
                    continue
                direction = 1 if target > current else -1
                if direction > 0:
                    sp = dm["speed_up"][status]
                    if status == "far_ahead" and days_out <= 14:
                        sp = calm["daily_up_hot"]
                    if current < low:
                        sp = max(sp, 0.02)
                    proposed = min(target, current * (1 + sp))
                elif last_days_behind:
                    proposed = current - (current - mn) * float(cascade.get(days_out, 1.0))
                else:
                    sp = dm["speed_down"]["on_track" if (pickup and status in ("behind", "far_behind")) else status]
                    if current > high:
                        sp = max(sp, 0.02)          # bring prices left above the band back slowly
                    if pickup:
                        sp = 0.0
                    proposed = max(target, current * (1 - sp))

                # ---- 5. calm rules (only ever block; never reverse a move) ----
                reason = None
                last_dir, last_ts = st.get("last_change_dir"), st.get("last_change_ts")
                since_last = now - datetime.fromisoformat(last_ts) if last_ts else None
                if direction < 0:
                    if not main_run:
                        reason = "Only the morning run may lower prices."
                    elif days_out == 0:
                        reason = "Arrival day: never lowered."
                    elif proposed >= current:
                        reason = "Not allowed to lower this date now."
                    elif (last_dir == 1 and days_out > 3 and since_last is not None
                          and since_last < timedelta(hours=calm["no_drop_after_raise_h"])):
                        reason = f"Raised less than {calm['no_drop_after_raise_h']} hours ago: no drop yet."
                else:
                    booked_since_change = avail < st.get("avail_at_change", avail)
                    if days_out <= 3 and status not in ("ahead", "far_ahead"):
                        reason = "Last days: raised only if selling faster than normal."
                    elif (last_dir == -1 and not booked_since_change and since_last is not None
                          and since_last < timedelta(hours=calm["no_raise_after_drop_h"])):
                        reason = f"Lowered less than {calm['no_raise_after_drop_h']} hours ago and no booking since: no raise yet."
                if (reason is None and status == "on_track" and last_dir is not None and direction != last_dir
                        and since_last is not None and since_last < timedelta(hours=calm.get("drift_reverse_block_h", 72))
                        and not avail < st.get("avail_at_change", avail)):
                    reason = "Selling as normal and just moved the other way: holding to avoid wobbling."
                if reason:
                    dec["blocked"].append(reason)
                    continue

                # rolling 24-hour limit, applied only in the direction of the move
                if direction < 0:
                    lim = calm["daily_down_last3"] if days_out <= 3 else calm["daily_down"]
                    floor_24h = baseline * (1 - lim)
                    if proposed < floor_24h:
                        dec["blocked"].append(f"Limit: at most -{lim:.0%} in 24 hours.")
                        proposed = floor_24h
                    bound = max(target, floor_24h, mn)
                else:
                    lim = calm["daily_up_hot"] if (status == "far_ahead" and days_out <= 14) else calm["daily_up"]
                    ceil_24h = baseline * (1 + lim)
                    if proposed > ceil_24h:
                        dec["blocked"].append(f"Limit: at most +{lim:.0%} in 24 hours.")
                        proposed = ceil_24h
                    bound = min(target, ceil_24h, mx_eff)
                if (direction < 0 and bound >= current) or (direction > 0 and bound <= current):
                    if not dec["blocked"]:
                        dec["blocked"].append("No room to move within the 24-hour limits.")
                    continue

                # ---- 6. price grid: never cross the current price or the limits ----
                new = _grid_move(current, proposed, step, direction, bound)
                if new == current:
                    dec["why"].append("Next price step would go past the limits: no change.")
                    continue
                if last_days_behind and days_out == 1 and new > mn:
                    dec["why"].append(f"24-hour limit stopped it at {_fmt(cur, new)}; your minimum is {_fmt(cur, mn)}.")
                dec["proposed"], dec["kind"] = new, "move"
                dec["write"] = can_write and not shadow
                if can_write:
                    changed += 1
                    per_rt[rt][1] += 1
                    if abs(new - current) / current > 0.10:
                        per_rt[rt][2] += 1
                dec["why"].append(f"Today: {_fmt(cur, current)} -> {_fmt(cur, new)} ({(new - current) / current:+.0%}).")

                lo_s, hi_s = cfg["safety"]["price_vs_start"]
                if not (lo_s * start <= new <= max(hi_s * start, mx_eff)):
                    stop_rt(rt, f"{rt} {ds} {cur}: {new} is outside {lo_s}-{hi_s}x start {start}.")

            # ---- channel consistency check (warning only) ----
            prices = cell.get("prices") or {}
            if prices.get("GEL") and len(info.get("currencies", [])) > 1:
                for cur in info["currencies"]:
                    if cur == "GEL" or not prices.get(cur):
                        continue
                    fx = cfg["fx"].get(cur)
                    if fx:
                        ratio = prices["GEL"] / (prices[cur] * fx)
                        lo_r, hi_r = cfg["safety"]["fx_ratio"]
                        if not lo_r <= ratio <= hi_r:
                            warnings.append(f"{rt} {ds}: GEL price is {ratio:.2f}x the {cur} price; check it is intended.")

    # ---- empty dates that get a price: written even when no move was needed ----
    for dec in decisions:
        if dec.get("fill") and dec["kind"] in ("hold",) and dec["rt"] not in reset_rts:
            dec["kind"] = "fill"
            dec["write"] = room_types[dec["rt"]].get("status", "live") == "live" and not shadow
            dec["why"].append(f"Price set: {_fmt(dec['currency'], dec['proposed'])}.")

    # ---- run-level safety ----
    for (rt, cur), (n_miss, n_all, first) in missing_price.items():
        if not n_miss:
            continue
        msg = f"{rt} {cur}: MiniHotel shows no price for {n_miss} of {n_all} date(s), e.g. {first}"
        if n_miss / n_all > cfg["safety"].get("max_share_missing_price", 0.10):
            stop_rt(rt, msg + ".")
        else:
            warnings.append(msg + "; those dates were left alone.")
    # Run-wide check, over the room types that were not stopped: a big change (more than 10%
    # in one run, min/max corrections included) on many dates at once looks like a problem
    # (wrong data, a typo in your prices), not like demand. Small daily steps are the normal
    # way prices walk to their target and are not counted. Big changes right after you changed
    # your own minimum/start/maximum (by less than double or half) are allowed.
    considered = sum(v[0] for r, v in per_rt.items() if r not in stopped_rts)
    changed = sum(v[1] for r, v in per_rt.items() if r not in stopped_rts)
    big = sum(v[2] for r, v in per_rt.items() if r not in stopped_rts and rule_change.get(r) not in ("new", "modest"))
    share = big / considered if considered else 0.0
    warm = (today - _d(meta["first_run_day"])).days < cfg["safety"].get("warmup_days", 3)
    if share > cfg["safety"]["max_share_changed"]:
        msg = f"{big} of {considered} prices would change by more than 10% in one run ({share:.0%})"
        if warm:
            warnings.append(msg + "; allowed during the first days after switching on.")
        else:
            alerts.append(msg + "; whole run stopped as a precaution.")
            global_stop = True
    ok = not global_stop

    writes, shadow_moves = [], []
    for dec in decisions:
        if dec["kind"] not in ("move", "correction", "fill", "reset"):
            continue
        st = state[dec["rt"]][dec["date"]][dec["currency"]]
        if not ok or dec["rt"] in stopped_rts:
            # nothing is applied: report the price that is really kept
            dec["write"] = False
            dec["rejected"], dec["proposed"], dec["kind"] = dec["proposed"], dec["current"], "stopped"
            continue
        direction = 1 if dec["proposed"] > dec["current"] else -1
        if shadow:
            st["shadow_price"] = dec["proposed"]
            shadow_moves.append({"rt": dec["rt"], "date": dec["date"], "currency": dec["currency"],
                                 "from": dec["current"], "price": dec["proposed"], "kind": dec["kind"],
                                 "reversal": bool(st.get("last_change_dir") and st["last_change_dir"] != direction)})
        elif not dec["write"]:
            continue
        else:
            writes.append({"rt": dec["rt"], "date": dec["date"], "currency": dec["currency"], "price": dec["proposed"]})
            st["last_engine"] = dec["proposed"]
        st.setdefault("moves", []).append({"t": now.isoformat(), "p": dec["current"]})
        st["last_change_dir"] = direction
        st["last_change_ts"] = now.isoformat()
        st["avail_at_change"] = dec["avail"]

    if ok and not shadow:
        # dates seen and left alone still get a baseline for hand-set price detection
        for dec in decisions:
            st = state.get(dec["rt"], {}).get(dec["date"], {}).get(dec["currency"])
            if (st is not None and dec["rt"] not in stopped_rts and "last_engine" not in st and dec["current"] > 0
                    and not st.get("manual_until") and room_types[dec["rt"]].get("status", "live") == "live"):
                st["last_engine"] = dec["current"]
    if shadow:
        for dec in decisions:
            st = state.get(dec["rt"], {}).get(dec["date"], {}).get(dec["currency"])
            if st is not None and "shadow_price" not in st and dec["current"] > 0:
                st["shadow_price"] = dec["current"]
    if main_run and ok:
        meta["last_main_day"] = today_s
    if ok:
        for rt, v in per_rt.items():
            if rt not in stopped_rts and len(v) > 3:
                seen[rt] = v[3]

    for rt in list(state):
        if rt == "_meta":
            continue
        for ds in list(state[rt]):
            if ds < today_s:
                del state[rt][ds]

    return {"ok": ok, "stopped_room_types": sorted(stopped_rts), "main_run": main_run,
            "alerts": alerts, "warnings": warnings,
            "decisions": decisions, "writes": writes, "shadow_moves": shadow_moves, "state": state,
            "changed": changed, "considered": considered, "corrections": corrections}
