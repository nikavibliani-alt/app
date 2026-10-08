"""
Learn the normal booking curve from your own reservations.

Question answered: for a night that has already passed, what share of ITS FINAL
bookings was already in 1, 3, 7, 14, 30, 60, 90 days before that night?
That is the timing of your bookings (how early guests book). The engine then
multiplies it by your occupancy goal (for example 85%) to get the normal
occupancy at each number of days before arrival.

Why timing and not the level: if the engine learned the level from its own
results, a slow period would start to look "normal" and the engine would stop
reacting. The goal is set by you; only the timing is learned.
"""

from datetime import date, timedelta

CHECKPOINTS = [0, 1, 3, 7, 14, 30, 60, 90]


def _d(x) -> date:
    return x if isinstance(x, date) else date.fromisoformat(str(x)[:10])


def learn_curve(reservations: list, units: int, today, default: dict,
                lookback_days: int = 180, full_weight_nights: int = 120) -> dict:
    """
    reservations: [{"checkin", "checkout", "created", "units"(optional, default 1)}]
                  already filtered to one group and to non-cancelled stays.
    units:        total units in the group.
    Returns {days_before: expected_share} for CHECKPOINTS, blended with `default`
    when there is little history, and never increasing as days_before grows.
    """
    today = _d(today)
    if units <= 0:
        return dict(default)
    nights = [today - timedelta(days=i) for i in range(1, lookback_days + 1)]
    stays = []
    for r in reservations:
        try:
            ci, co, cr = _d(r["checkin"]), _d(r["checkout"]), _d(r["created"])
        except (KeyError, ValueError, TypeError):
            continue
        if co <= ci:
            continue
        stays.append((ci, co, min(cr, ci), int(r.get("units", 1) or 1)))

    sums = {d: 0.0 for d in CHECKPOINTS}
    counted = 0
    for n in nights:
        covering = [(cr, u) for ci, co, cr, u in stays if ci <= n < co]
        if not covering:
            # An empty past night is real information too (nothing was booked).
            counted += 1
            continue
        counted += 1
        for d in CHECKPOINTS:
            cutoff = n - timedelta(days=d)
            booked = sum(u for cr, u in covering if cr <= cutoff)
            sums[d] += min(1.0, booked / units)

    if counted == 0 or not stays:
        return dict(default)

    learned = {d: sums[d] / counted for d in CHECKPOINTS}
    nights_with_data = sum(1 for n in nights if any(ci <= n < co for ci, co, _, _ in stays))
    w = min(1.0, nights_with_data / full_weight_nights)
    out = {}
    for d in CHECKPOINTS:
        base = interpolate(default, d)
        out[d] = w * learned[d] + (1 - w) * base
    # never increasing with more days before arrival
    prev = 1.0
    for d in CHECKPOINTS:
        out[d] = min(out[d], prev)
        prev = out[d]
    return out


def interpolate(curve: dict, days_out: int) -> float:
    """Expected share booked at `days_out`, straight-line between checkpoints."""
    pts = sorted((int(k), float(v)) for k, v in curve.items())
    if days_out <= pts[0][0]:
        return pts[0][1]
    for (d0, v0), (d1, v1) in zip(pts, pts[1:]):
        if d0 <= days_out <= d1:
            if d1 == d0:
                return v0
            return v0 + (v1 - v0) * (days_out - d0) / (d1 - d0)
    return pts[-1][1]


def learn_shape(reservations: list, today, default_shape: dict,
                lookback_days: int = 180, full_weight_nights: int = 120) -> dict:
    """
    Share of a night's final bookings already made N days before it.
    Returns {days_before: share 0..1}, 1.0 at 0 days, never increasing with days.
    Blends with `default_shape` when few past nights had bookings.
    """
    today = _d(today)
    stays = []
    for r in reservations:
        try:
            ci, co, cr = _d(r["checkin"]), _d(r["checkout"]), _d(r["created"])
        except (KeyError, ValueError, TypeError):
            continue
        if co <= ci:
            continue
        stays.append((ci, co, min(cr, ci), int(r.get("units", 1) or 1)))
    sums = {d: 0.0 for d in CHECKPOINTS}
    nights_used = 0
    for i in range(1, lookback_days + 1):
        n = today - timedelta(days=i)
        covering = [(cr, u) for ci, co, cr, u in stays if ci <= n < co]
        final = sum(u for _, u in covering)
        if final <= 0:
            continue
        nights_used += 1
        for d in CHECKPOINTS:
            cutoff = n - timedelta(days=d)
            sums[d] += sum(u for cr, u in covering if cr <= cutoff) / final
    w = min(1.0, nights_used / full_weight_nights) if nights_used else 0.0
    out, prev = {}, 1.0
    for d in CHECKPOINTS:
        learned = sums[d] / nights_used if nights_used else 0.0
        v = w * learned + (1 - w) * interpolate(default_shape, d)
        v = min(v, prev)
        out[d] = v
        prev = v
    out[0] = 1.0 if out[0] > 0 else out[0]
    return out
