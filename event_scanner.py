"""
Tbilisi Event Scanner
======================
Uses SerpAPI Google Events to find upcoming major events in Tbilisi/Rustavi.
Saves pending events to Firestore for approval in SleepyPMS.
Sends email notification for newly found events.
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

SERP_API_KEY   = os.environ.get("SERPAPI_KEY", "")
SENDGRID_KEY   = os.environ.get("SENDGRID_KEY", "")
NOTIFY_EMAIL   = "nikavibliani@gmail.com"
FROM_EMAIL     = "nikavibliani@gmail.com"

SERPAPI_URL    = "https://serpapi.com/search.json"
SENDGRID_URL   = "https://api.sendgrid.com/v3/mail/send"

SEARCH_QUERIES = [
    "concerts in Tbilisi Georgia 2026",
    "festivals in Tbilisi Georgia 2026",
    "concerts Rustavi International Motorpark 2026",
    "major events Tbilisi 2026",
    "international concerts Tbilisi 2026",
    "Ricky Martin Tbilisi 2026",
    "Till Lindemann Tbilisi 2026",
]

# Known major venues — any event here is significant regardless of ticket count
MAJOR_VENUES = [
    "rustavi international motorpark",
    "rustavi motorpark",
    "boris paichadze",
    "dinamo arena",
    "tbilisi sports palace",
    "lisi wonderland",
    "expo georgia",
]

# 6+ ticket sources = major event
MIN_TICKET_SOURCES = 2

SKIP_KEYWORDS = [
    "free", "weekly", "every tuesday", "every friday", "every saturday",
    "workshop", "class", "meetup", "networking", "webinar", "online",
    "yoga", "meditation", "guided tour", "walking tour", "comedy open mic",
    "open mic", "karaoke", "trivia",
]

DEFAULT_MULTIPLIER     = 1.30
LARGE_EVENT_MULTIPLIER = 1.45  # 10+ ticket sources


# ---------------------------------------------------------------------------
# FIRESTORE
# ---------------------------------------------------------------------------

def get_firestore_client():
    import firebase_admin
    from firebase_admin import credentials, firestore

    if not firebase_admin._apps:
        sa = os.environ.get("FIREBASE_SERVICE_ACCOUNT")
        if sa:
            import base64, json as _json
            cred_dict = _json.loads(base64.b64decode(sa).decode())
            cred = credentials.Certificate(cred_dict)
        else:
            cred = credentials.ApplicationDefault()
        firebase_admin.initialize_app(cred)

    return firestore.client()


# ---------------------------------------------------------------------------
# EMAIL
# ---------------------------------------------------------------------------

def send_email(subject: str, body: str):
    payload = {
        "personalizations": [{"to": [{"email": NOTIFY_EMAIL}]}],
        "from": {"email": FROM_EMAIL, "name": "Maxela Pricing"},
        "subject": subject,
        "content": [{"type": "text/plain", "value": body}],
    }
    headers = {
        "Authorization": f"Bearer {SENDGRID_KEY}",
        "Content-Type": "application/json",
    }
    try:
        resp = requests.post(SENDGRID_URL, json=payload, headers=headers, timeout=15)
        if resp.status_code in (200, 202):
            print(f"  Email sent: {subject}")
        else:
            print(f"  Email failed ({resp.status_code}): {resp.text[:200]}", file=sys.stderr)
    except Exception as e:
        print(f"  Email error: {e}", file=sys.stderr)


# ---------------------------------------------------------------------------
# FETCH EVENTS
# ---------------------------------------------------------------------------

def fetch_events(query: str) -> list:
    params = {
        "engine":  "google_events",
        "q":       query,
        "hl":      "en",
        "api_key": SERP_API_KEY,
    }
    try:
        resp = requests.get(SERPAPI_URL, params=params, timeout=15)
        resp.raise_for_status()
        return resp.json().get("events_results", [])
    except Exception as e:
        print(f"  Warning: SerpAPI '{query}' failed: {e}", file=sys.stderr)
        return []


# ---------------------------------------------------------------------------
# PARSE DATE
# ---------------------------------------------------------------------------

def parse_event_date(date_info: dict) -> str | None:
    when = date_info.get("when", "") or date_info.get("start_date", "")
    if not when:
        return None

    months = {
        "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
        "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12
    }

    m = re.search(r"(\b\w{3,9}\b)\s+(\d{1,2})", when, re.IGNORECASE)
    if m:
        month_str = m.group(1).lower()[:3]
        day       = int(m.group(2))
        month     = months.get(month_str)
        if month:
            today = datetime.now()
            year  = today.year
            if month < today.month or (month == today.month and day < today.day):
                year = today.year + 1
            try:
                return datetime(year, month, day).strftime("%Y-%m-%d")
            except ValueError:
                pass
    return None


# ---------------------------------------------------------------------------
# CLASSIFY
# ---------------------------------------------------------------------------

def is_major_event(event: dict) -> bool:
    title = (event.get("title") or "").lower()
    desc  = (event.get("description") or "").lower()
    text  = title + " " + desc

    for kw in SKIP_KEYWORDS:
        if kw in text:
            return False

    # Always include events at major venues
    venue = event.get("venue", {})
    venue_name = (venue.get("name", "") if isinstance(venue, dict) else str(venue)).lower()
    if any(v in venue_name for v in MAJOR_VENUES):
        return True

    ticket_sources = len(event.get("ticket_info", []))
    return ticket_sources >= MIN_TICKET_SOURCES


def get_multiplier(event: dict) -> float:
    ticket_sources = len(event.get("ticket_info", []))
    return LARGE_EVENT_MULTIPLIER if ticket_sources >= 10 else DEFAULT_MULTIPLIER


# ---------------------------------------------------------------------------
# MAIN
# ---------------------------------------------------------------------------

def scan_and_update(config_path: str = "config.json", dry_run: bool = False) -> dict:
    print("Scanning for Tbilisi/Rustavi events via SerpAPI...")

    today     = datetime.now().date()
    today_str = today.strftime("%Y-%m-%d")
    max_date  = today + timedelta(days=90)

    # Once-per-day gate: skip if already scanned today
    if not dry_run:
        try:
            _db = get_firestore_client()
            _ls = _db.collection("pricing_events").document("last_scan").get()
            if _ls.exists and _ls.to_dict().get("scanned_at") == today_str:
                print(f"  Already scanned today ({today_str}) — skipping SerpAPI calls.")
                return {}
        except Exception as _e:
            print(f"  Warning: could not check last_scan: {_e}", file=sys.stderr)

    found_events = {}

    for query in SEARCH_QUERIES:
        print(f"  Searching: '{query}'...")
        events = fetch_events(query)
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
            title      = event.get("title", "Unknown")
            venue      = ""
            if event.get("venue"):
                venue = event["venue"].get("name", "")
            ticket_count = len(event.get("ticket_info", []))

            if date_str not in found_events or multiplier > found_events[date_str]["multiplier"]:
                found_events[date_str] = {
                    "label":        title[:80],
                    "venue":        venue,
                    "multiplier":   multiplier,
                    "ticket_count": ticket_count,
                    "status":       "pending",
                    "source":       "serpapi",
                    "found_at":     datetime.now().isoformat(),
                }
                print(f"  ✓ {date_str}: {title[:50]} ({ticket_count} ticket sources, ×{multiplier})")

    if not found_events:
        print("  No major events found.")
        if not dry_run:
            try:
                get_firestore_client().collection("pricing_events").document("last_scan").set(
                    {"scanned_at": today_str, "ts": datetime.now().isoformat()}
                )
            except Exception:
                pass
        return {}

    if dry_run:
        print(f"  DRY RUN — {len(found_events)} events found, not saved.")
        return found_events

    # Save to Firestore
    try:
        db         = get_firestore_client()
        collection = db.collection("pricing_events")
        new_events = []

        for date_str, info in found_events.items():
            doc_id  = f"event_{date_str}"
            doc_ref = collection.document(doc_id)
            existing = doc_ref.get()

            if existing.exists:
                print(f"  Already in Firestore: {date_str} (skipping)")
                continue

            doc_ref.set(info)
            new_events.append((date_str, info))
            print(f"  Saved to Firestore: {date_str} → {info['label']}")

        # Send email for new events
        if new_events:
            lines = []
            for date_str, info in sorted(new_events):
                lines.append(f"• {date_str}: {info['label']} @ {info['venue']} (×{info['multiplier']})")

            send_email(
                subject=f"🎵 {len(new_events)} major event(s) detected near Tbilisi — review in SleepyPMS",
                body=(
                    f"Hi Nika,\n\n"
                    f"The pricing engine found {len(new_events)} major upcoming event(s) near Tbilisi:\n\n"
                    + "\n".join(lines) +
                    f"\n\nLogin to SleepyPMS → Pricing to approve or dismiss:\n"
                    f"https://app.maxelaapartments.com/pricing.html\n\n"
                    f"Approved events will automatically raise prices on those dates.\n\n"
                    f"— Maxela Pricing Engine"
                )
            )

        collection.document("last_scan").set({"scanned_at": today_str, "ts": datetime.now().isoformat()})
        print(f"  Scan gate updated: scanned_at = {today_str}")

    except Exception as e:
        print(f"  Firestore error: {e}", file=sys.stderr)

    return found_events


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    events = scan_and_update(dry_run=args.dry_run)
    print(f"\nTotal: {len(events)} major events found")
