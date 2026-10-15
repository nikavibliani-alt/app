"""
Season date ranges: one list kept in Firestore (pricing_config/rules.seasonRanges) that the pricing page edits and every engine reads.

  seasonRanges = [{"from": "12-28", "to": "01-06", "season": "new_year"}, ...]     every year; a range with from > to crosses New Year

Rules: a day has at most one season (29 Feb included); only the six known seasons. Days with no season are "unmarked": allowed, the engines use Mid for them. The engines work with the older table
form [{"name", "ranges": [["MM-DD", "MM-DD"], ...]}] whose ranges never cross New Year, so `engine_table` splits those ranges in two.
If the saved list is missing or not valid, readers fall back to config.json (which holds today's ranges): see `from_rules`.
"""

from __future__ import annotations

from datetime import date, timedelta

SEASON_NAMES = ("low", "mid", "xmas_low", "high", "peak", "new_year")
LABELS = {"low": "Low", "mid": "Mid", "xmas_low": "Early December", "high": "High", "peak": "Peak", "new_year": "New Year"}
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def all_days() -> list:
    """Every MM-DD of a leap year, in order."""
    d = date(2024, 1, 1)
    return [(d + timedelta(days=k)).strftime("%m-%d") for k in range(366)]


ALL_DAYS = all_days()
INDEX = {md: i for i, md in enumerate(ALL_DAYS)}


def valid_md(x) -> bool:
    return isinstance(x, str) and x in INDEX


def days_of(frm: str, to: str) -> list:
    a, b = INDEX[frm], INDEX[to]
    return ALL_DAYS[a:b + 1] if a <= b else ALL_DAYS[a:] + ALL_DAYS[:b + 1]


def md_text(md: str) -> str:
    return f"{int(md[3:])} {MONTHS[int(md[:2]) - 1]}"


def range_text(days: list) -> str:
    """['12-01','12-02','12-03'] -> '1-3 Dec'; one day -> '1 Dec'; across months -> '28 Dec - 6 Jan'."""
    if len(days) == 1:
        return md_text(days[0])
    a, b = days[0], days[-1]
    return f"{int(a[3:])}-{md_text(b)}" if a[:2] == b[:2] else f"{md_text(a)} - {md_text(b)}"


def runs(days: list) -> list:
    """Group MM-DD days into runs of consecutive days (December wraps to January)."""
    out = []
    for md in sorted(set(days), key=INDEX.get):
        if out and (INDEX[md] - INDEX[out[-1][-1]]) % 366 == 1 and INDEX[md] > INDEX[out[-1][-1]]:
            out[-1].append(md)
        else:
            out.append([md])
    if len(out) > 1 and out[0][0] == "01-01" and out[-1][-1] == "12-31":
        out[0] = out.pop() + out[0]
    return out


def parse(raw) -> tuple:
    """(clean list, problems). A clean entry is {"from", "to", "season"}. Anything malformed is a problem, never a crash."""
    problems, out = [], []
    if not isinstance(raw, list):
        return [], ["no season dates"]
    for i, r in enumerate(raw):
        if not isinstance(r, dict) or not valid_md(r.get("from")) or not valid_md(r.get("to")) or r.get("season") not in SEASON_NAMES:
            problems.append(f"range {i + 1} is not a valid from/to/season")
            continue
        out.append({"from": r["from"], "to": r["to"], "season": r["season"]})
    return out, problems


def coverage(ranges: list) -> dict:
    cov = {md: [] for md in ALL_DAYS}
    for r in ranges:
        for md in days_of(r["from"], r["to"]):
            cov[md].append(r["season"])
    return cov


def unmarked(ranges: list) -> list:
    """Days (MM-DD) that no range covers. Allowed: the engines use Mid for them and the pricing page warns until they are marked."""
    cov = coverage(ranges)
    return [md for md in ALL_DAYS if not cov[md]]


def unmarked_text(days: list) -> str:
    """'12 days unmarked: 3-14 Mar' for the page, the watchdog and the weekly report."""
    n = len(days)
    return f"{n} day{'s' if n != 1 else ''} unmarked: " + ", ".join(range_text(g) for g in runs(days))


def overlaps(ranges: list) -> list:
    """Days with two seasons (the page never makes these)."""
    cov = coverage(ranges)
    by_pair = {}
    for md, s in cov.items():
        if len(s) > 1:
            by_pair.setdefault(tuple(dict.fromkeys(s)) if len(set(s)) > 1 else (s[0], s[0]), []).append(md)
    out = []
    for pair, days in by_pair.items():
        names = " and ".join(LABELS[x] for x in pair) if pair[0] != pair[1] else f"{LABELS[pair[0]]} twice"
        out.append(f"More than one season on: {', '.join(range_text(g) for g in runs(days))} ({names}).")
    return out


def check(ranges: list) -> list:
    """Plain-language problems: days with no season and days with two. Empty list = every day has exactly one season."""
    cov = coverage(ranges)
    problems = []
    gaps = [md for md, s in cov.items() if not s]
    if gaps:
        problems.append("No season for: " + ", ".join(range_text(g) for g in runs(gaps)) + ".")
    by_pair = {}
    for md, s in cov.items():
        if len(s) > 1:
            by_pair.setdefault(tuple(sorted(set(s))) if len(set(s)) > 1 else (s[0], s[0]), []).append(md)
    for pair, days in by_pair.items():
        names = " and ".join(LABELS[x] for x in dict.fromkeys(pair)) if pair[0] != pair[1] else f"{LABELS[pair[0]]} twice"
        problems.append(f"More than one season on: {', '.join(range_text(g) for g in runs(days))} ({names}).")
    return problems


def season_of(md: str, ranges: list) -> str:
    for r in ranges:
        if md in days_of(r["from"], r["to"]):
            return r["season"]
    return "mid"


def engine_table(ranges: list) -> list:
    """The table the engines use: one entry per season, ranges that never cross New Year."""
    by = {}
    for r in ranges:
        a, b = r["from"], r["to"]
        parts = [[a, b]] if INDEX[a] <= INDEX[b] else [[a, "12-31"], ["01-01", b]]
        by.setdefault(r["season"], []).extend(parts)
    order = ["new_year", "low", "mid", "high", "peak", "xmas_low"]
    return [{"name": s, "ranges": sorted(by[s])} for s in order + [x for x in by if x not in order] if s in by]


def ranges_from_table(table: list) -> list:
    """The other way: config.json's table -> a list of ranges, in calendar order (a range ending 12-31 and one starting 01-01 of the
    same season are kept as the two rows they are, so nothing is merged or changed)."""
    out = []
    for s in table or []:
        for a, b in s.get("ranges", []):
            out.append({"from": a, "to": b, "season": s["name"]})
    out.sort(key=lambda r: INDEX[r["from"]])
    return out


def from_rules(page: dict, fallback_table: list) -> tuple:
    """(engine table, source, problems). Uses pricing_config/rules.seasonRanges when it is there and valid; else the config.json table."""
    raw = (page or {}).get("seasonRanges")
    if raw is None:
        return fallback_table, "config.json (no saved season dates yet)", []
    ranges, problems = parse(raw)
    problems = problems + (overlaps(ranges) if not problems else [])        # days nobody marked are allowed: the engines use Mid for them
    if problems:
        return fallback_table, "config.json (the saved season dates are not valid)", problems
    return engine_table(ranges), "pricing_config/rules.seasonRanges", []
