"""
Pricing Utilities
==================
Shared helper functions for the pricing pipeline:
  - get_booking_velocity   — recent booking counts per property from Firestore
  - get_approved_events    — manager-approved event multipliers from Firestore
"""

import sys
from datetime import datetime, timedelta

CHANNEL_MATRIX = {
    "ROOMS":   {"booking": True,  "expedia": True,  "airbnb": False},
    "MAXELA":  {"booking": True,  "expedia": True,  "airbnb": False},
    "BIG_APT": {"booking": True,  "expedia": True,  "airbnb": True},
    "FREEDOM": {"booking": True,  "expedia": True,  "airbnb": True},
    "ORBE_1":  {"booking": True,  "expedia": False, "airbnb": True},
    "ORBE_2":  {"booking": False, "expedia": False, "airbnb": True},
}


def get_booking_velocity(db, days_back: int = 14) -> dict:
    """
    Returns booking counts and recently booked dates per property.
    {
      "ROOMS": {"bookings_last_7d": 3, "bookings_last_14d": 5, "recently_booked_dates": [...]},
      ...
    }
    """
    cutoff_7d  = datetime.now() - timedelta(days=7)
    cutoff_14d = datetime.now() - timedelta(days=days_back)

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

    velocity = {
        rt: {"bookings_last_7d": 0, "bookings_last_14d": 0, "recently_booked_dates": []}
        for rt in CHANNEL_MATRIX
    }

    try:
        docs = db.collection("reservations").where("syncedAt", ">=", cutoff_14d).stream()
        for doc in docs:
            data = doc.to_dict()
            if data.get("status") in ("CANCELLED", "NO_SHOW"):
                continue
            prop = room_to_property.get(data.get("roomCode", ""))
            if not prop:
                continue
            synced = data.get("syncedAt")
            if synced:
                synced_dt = synced.replace(tzinfo=None) if hasattr(synced, "replace") else datetime.fromtimestamp(synced)
                if synced_dt >= cutoff_7d:
                    velocity[prop]["bookings_last_7d"] += 1
                velocity[prop]["bookings_last_14d"] += 1
            checkin = data.get("checkin", "")
            if checkin and checkin not in velocity[prop]["recently_booked_dates"]:
                velocity[prop]["recently_booked_dates"].append(str(checkin)[:10])
    except Exception as e:
        print(f"  Warning: could not fetch booking velocity: {e}", file=sys.stderr)

    return velocity


def get_approved_events(db) -> dict:
    """Returns {date_str: {label, multiplier}} for manager-approved events."""
    events = {}
    try:
        docs = db.collection("pricing_events").where("status", "in", ["approved", "manual"]).stream()
        for doc in docs:
            data = doc.to_dict()
            date_str = doc.id.replace("event_", "")
            if date_str:
                events[date_str] = {
                    "label":      data.get("label", "Event"),
                    "multiplier": data.get("multiplier", 1.3),
                }
    except Exception as e:
        print(f"  Warning: could not fetch events: {e}", file=sys.stderr)
    return events
