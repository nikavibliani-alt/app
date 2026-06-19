"""
Tbilisi Event Scanner
======================
Uses SerpAPI Google Events to find upcoming major events in Tbilisi
and updates config.json event_premiums automatically.

Only flags events that look significant (concerts, festivals, sports).
Small/regular events are ignored.

Runs as part of the pricing engine workflow.
"""

import json
import os
import re
import sys
from datetime import datetime, timedelta

import requests

# ---------------------------------------------------------------------------
# CONFIG
# ---------------------------------------------------------------------------

SERP_API_KEY = os.environ.get("SERPAPI_KEY", "866181d84d5f19fae9a7db5c0488b3f30afe4710f8d886a14e11836dc1eccc87")
SERPAPI_URL  = "https://serpapi.com/search.json"

# Search queries to run
SEARCH_QUERIES = [
    "concerts in Tbilisi",
    "festivals in Tbilisi",
    "events in Tbilisi Georgia",
]

# Keywords that suggest a MAJOR event worth a price premium
MAJOR_KEYWORDS = [
    "concert", "festival", "show", "tour", "live", "performance",
    "championship", "match", "final", "gala", "opening",
    "კონცერტი", "ფესტივალი",  # Georgian
]

# Keywords that suggest a SMALL/regular event — skip these
SKIP_KEYWORDS = [
    "comedy open mic", "free", "weekly", "every tuesday", "every friday",
    "workshop", "class", "meetup", "networking", "webinar", "online",
    "yoga", "meditation", "guided tour", "walking tour",
]

# Price multiplier based on estimated event size
# We use number of ticket sources as a proxy for event size
DEFAULT_MULTIPLIER = 1.25
LARGE_EVENT_MULTIPLIER = 1.40  # 4+ ticket sources = probably big


# ---------------------------------------------------------------------------
# FETCH EVENTS
# ---------------------------------------------------------------------------

def fetch_events(query: str) -> list:
    params = {
        "engine": "google_events",
        "q": query,
        "hl": "en",
        "api_key": SERP_API_KEY,
        "num": 10,
    }
    try:
        resp = requests.get(SERPAPI_URL, params=params, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        return data.get("events_results", [])
    except Exception as e:
        print(f"  Warning: SerpAPI query '{query}' failed: {e}", file=sys.stderr)
        return []


# ---------------------------------------------------------------------------
# PARSE DATE
# ---------------------------------------------------------------------------

def parse_event_date(date_info: dict) -> str | None:
    """
    Try to extract a YYYY-MM-DD date from the event date info.
    SerpAPI returns dates like 'Jan 3', 'Sat, 03 Jan', 'Jun 21' etc.
    """
    when = date_info.get("when", "") or date_info.get("start_date", "")
    if not when:
        return None

    current_year = datetime.now().year

    # Try common patterns
    patterns = [
        r"(\w{3})\s+(\d{1,2}),\s+(\d{4})",   # Jan 3, 2026
        r"(\w{3,}),\s+\d{1,2}\s+(\w{3}),?\s+(\d{4})?",  # Sat, 21 Jun, 2026
        r"(\w{3})\s+(\d{1,2})",               # Jun 21
        r"(\d{1,2})\s+(\w{3})",               # 21 Jun
    ]

    months = {
        "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
        "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12
    }

    # Try "Jun 21" or "Jan 3" style
    m = re.search(r"(\b\w{3,9}\b)\s+(\d{1,2})", when, re.IGNORECASE)
    if m:
        month_str = m.group(1).lower()[:3]
        day = int(m.group(2))
        month = months.get(month_str)
        if month:
            # Determine year — if month is before current month, assume next year
            today = datetime.now()
            year = current_year
            if month < today.month or (month == today.month and day < today.day):
                year = current_year + 1
            try:
                return datetime(year, month, day).strftime("%Y-%m-%d")
            except ValueError:
                pass

    return None


# ---------------------------------------------------------------------------
# CLASSIFY EVENT
# ---------------------------------------------------------------------------

def is_major_event(event: dict) -> bool:
    """Return True if this looks like a significant event worth a price bump."""
    title       = (event.get("title") or "").lower()
    description = (event.get("description") or "").lower()
    text        = title + " " + description

    # Skip small/regular events
    for kw in SKIP_KEYWORDS:
        if kw in text:
            return False

    # Must have at least one major keyword
    has_major = any(kw in text for kw in MAJOR_KEYWORDS)
    if not has_major:
        return False

    # Must have at least 2 ticket sources (proxy for real event)
    ticket_sources = len(event.get("ticket_info", []))
    if ticket_sources < 2:
        return False

    return True


def get_multiplier(event: dict) -> float:
    """Determine price multiplier based on estimated event size."""
    ticket_sources = len(event.get("ticket_info", []))
    if ticket_sources >= 4:
        return LARGE_EVENT_MULTIPLIER
    return DEFAULT_MULTIPLIER


# ---------------------------------------------------------------------------
# MAIN
# ---------------------------------------------------------------------------

def scan_and_update(config_path: str = "config.json", dry_run: bool = False) -> dict:
    """
    Scan for Tbilisi events and update config event_premiums.
    Returns dict of newly found events.
    """
    print("Scanning for Tbilisi events via SerpAPI...")

    today    = datetime.now().date()
    max_date = today + timedelta(days=90)

    found_events = {}  # date_str -> event info

    for query in SEARCH_QUERIES:
        print(f"  Searching: '{query}'...")
        events = fetch_events(query)
        print(f"  Found {len(events)} results")

        for event in events:
            if not is_major_event(event):
                continue

            date_str = parse_event_date(event.get("date", {}))
            if not date_str:
                continue

            event_date = datetime.strptime(date_str, "%Y-%m-%d").date()
            if event_date < today or event_date > max_date:
                continue

            multiplier = get_multiplier(event)
            title      = event.get("title", "Unknown event")

            # Keep highest multiplier if date already found
            if date_str not in found_events or multiplier > found_events[date_str]["multiplier"]:
                found_events[date_str] = {
                    "label":      title[:60],
                    "multiplier": multiplier,
                }
                print(f"  ✓ {date_str}: {title[:50]} (×{multiplier})")

    if not found_events:
        print("  No major events found.")
        return {}

    # Update config.json
    if not dry_run:
        with open(config_path) as f:
            config = json.load(f)

        existing = config.get("event_premiums", {})
        # Remove _comment key before merging
        existing = {k: v for k, v in existing.items() if not k.startswith("_")}

        # Merge — keep manual overrides, add/update scanned events
        merged = {**existing}
        for date_str, info in found_events.items():
            if date_str not in merged:
                merged[date_str] = info
                print(f"  Added: {date_str} → {info['label']}")
            else:
                # Update multiplier if scanned one is higher
                if info["multiplier"] > merged[date_str].get("multiplier", 1.0):
                    merged[date_str]["multiplier"] = info["multiplier"]

        merged["_comment"] = (
            "Auto-updated by event_scanner.py + manual entries. "
            "Add events manually: '2026-07-15': {'label': 'Big Concert', 'multiplier': 1.35}"
        )
        config["event_premiums"] = merged

        with open(config_path, "w") as f:
            json.dump(config, f, indent=2)

        print(f"  config.json updated with {len(found_events)} events.")
    else:
        print("  DRY RUN — config.json not updated.")

    return found_events


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Scan Tbilisi events and update config")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    events = scan_and_update(dry_run=args.dry_run)
    print(f"\nTotal major events found: {len(events)}")
    for date, info in sorted(events.items()):
        print(f"  {date}: {info['label']} (×{info['multiplier']})")
