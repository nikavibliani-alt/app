"""
Price watchdog runner. Reads what the new engine saved, checks it (calm_pricing/watchdog.py), writes
pricing_watchdog/latest for the card on pricing-v2, and sends ONE WhatsApp to the owner when the result is
red and today's 09:00 run has happened. Reads only from pricing data; writes only pricing_watchdog/*
(and whatsapp_owner_alerts/<id> so the webhook knows the message). Prints counts only, never guest data.

  python scripts/price_watchdog.py            # check, save, send when red
  python scripts/price_watchdog.py --no-send  # check and save, never send
"""

import argparse
import json
import os
import sys
from datetime import datetime, timedelta

import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pricing_shadow as ps  # noqa: E402
import pricing_calm_live as live  # noqa: E402
from calm_pricing import merged  # noqa: E402
from calm_pricing.watchdog import check, short_issues, MAX_LISTED  # noqa: E402

META_SEND_URL = "https://graph.facebook.com/v19.0/{pid}/messages"
GUEST_LABEL = "Price watchdog"
LANGUAGES = ("en", "en_US")


def _digits(v):
    return "".join(c for c in str(v or "") if c.isdigit())


def load_inputs(db, today: str, live_rts):
    daily = {}
    for rt in live_rts:
        snap = db.collection("pricing_calm_daily").document(f"{today}_{rt}").get()
        if snap.exists:
            daily[rt] = (snap.to_dict() or {}).get("dates") or {}
    states = {}
    for rt in live_rts:
        snap = db.collection("pricing_engine_state").document(f"{live.STATE_PREFIX}{rt}").get()
        if snap.exists:
            states[rt] = (snap.to_dict() or {}).get("data") or {}
    runs = [d.to_dict() for d in db.collection("pricing_calm_runs").where("day", "==", today).stream()]
    runs = [r for r in runs if r.get("day") == today]
    runs.sort(key=lambda r: r.get("ts", ""))
    return daily, states, runs


def season_notes(db) -> list:
    """Things worth a mention that are not a price problem: season days nobody marked (the engines use Mid for them)."""
    try:
        from calm_pricing import seasons as sn
        snap = db.collection("pricing_config").document("rules").get()
        raw = (snap.to_dict() or {}).get("seasonRanges") if snap.exists else None
        if isinstance(raw, list):
            um = sn.unmarked(sn.parse(raw)[0])
            if um:
                return [f"{sn.unmarked_text(um)}. They use Mid prices until you mark them."]
    except Exception:
        pass
    return []


def whatsapp_payload(to, issue, language, label=GUEST_LABEL):
    return {"messaging_product": "whatsapp", "to": to, "type": "template",
            "template": {"name": "owner_alert", "language": {"code": language},
                         "components": [{"type": "body", "parameters": [{"type": "text", "text": label},
                                                                          {"type": "text", "text": issue}]}]}}


def send_alert(to, issue, post=requests.post, env=os.environ, label=GUEST_LABEL):
    """Template first (any hour), free text as the fallback. Returns the message id or None."""
    token, pid = env.get("META_ACCESS_TOKEN", ""), env.get("META_PHONE_NUMBER_ID", "")
    if not (token and pid and to):
        print("  WhatsApp not sent: Meta secrets or the owner phone are missing.")
        return None
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    issue = " ".join(issue.split())[:480]
    bodies = [whatsapp_payload(to, issue, lang, label) for lang in LANGUAGES]
    bodies.append({"messaging_product": "whatsapp", "to": to, "type": "text",
                   "text": {"body": f"New alert from your Maxela bot. Guest: {label}. Issue: {issue}. Please check the WhatsApp chat."}})
    for body in bodies:
        try:
            r = post(META_SEND_URL.format(pid=pid), json=body, headers=headers, timeout=15)
            if r.status_code < 300:
                return ((r.json().get("messages") or [{}])[0]).get("id") or "sent"
            print(f"  WhatsApp attempt failed: HTTP {r.status_code}")
        except requests.RequestException as e:
            print(f"  WhatsApp attempt failed: {type(e).__name__}")
    return None


def main(argv=None, db=None, post=requests.post, now=None, env=os.environ):
    parser = argparse.ArgumentParser(description="Price watchdog")
    parser.add_argument("--no-send", action="store_true")
    args = parser.parse_args(argv)

    now = now or datetime.now(ps.TBILISI).replace(tzinfo=None)
    today = now.date().isoformat()
    db = db or ps.init_db()
    repo_config = json.load(open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config.json")))
    rules, settings = ps.load_rules(db, repo_config)
    live_rts = live.live_room_types(rules, settings)
    cfg = merged(settings)

    daily, states, runs = load_inputs(db, today, live_rts)
    last = runs[-1] if runs else None
    main_done = any(r.get("main_run") for r in runs)
    # The channel push and the safety stops are judged on the LAST run: a clean run after a failed one clears them.
    run_view = None
    if last:
        run_view = {"ok": last.get("ok") is not False,
                    "failed_portals": sorted(last.get("failed_portals") or []),
                    "stopped_room_types": sorted(last.get("stopped_room_types") or [])}
    if not runs:                                  # nothing has run yet today (for example just after midnight): nothing to judge
        doc = {"ts": now.isoformat(), "day": today, "status": "waiting", "counts": {}, "checked": 0, "issues": [], "total_issues": 0,
               "main_run_done": False, "rooms": sorted(live_rts), "paused": False, "notes": season_notes(db)}
        print("Watchdog: waiting | no run yet today, nothing checked")
        db.collection("pricing_watchdog").document("latest").set(doc)
        return {"result": {"status": "waiting", "issues": [], "counts": {}, "checked": 0}, "doc": doc}
    result = check(daily, states, run_view, cfg, now, live_rts=list(live_rts))
    paused = bool(last and last.get("paused"))

    issues = result["issues"][:MAX_LISTED]
    doc = {"ts": now.isoformat(), "day": today, "status": result["status"], "counts": result["counts"],
           "checked": result["checked"], "issues": issues, "total_issues": len(result["issues"]),
           "main_run_done": main_done, "rooms": sorted(live_rts), "paused": paused, "notes": season_notes(db)}
    print(f"Watchdog: {result['status']} | checked {result['checked']} prices in {len(daily)} of {len(live_rts)} rooms | "
          f"issues {result['counts'] or 'none'} | main run today: {main_done}")

    ref = db.collection("pricing_watchdog").document("latest")
    prev = ref.get()
    prev = (prev.to_dict() or {}) if prev.exists else {}
    alerted = prev.get("alerted") if prev.get("alerted_day") == today else None
    key = short_issues(result)
    doc["alerted_day"], doc["alerted"] = (today if alerted else None), alerted

    if result["status"] == "red" and main_done and not args.no_send and alerted != key:
        cfg_snap = db.collection("globals").document("config").get()
        to = _digits((cfg_snap.to_dict() or {}).get("ownerPhone") if cfg_snap.exists else "")
        mid = send_alert(to, f"Prices need a look: {key}. Open pricing-v2 to see the list.", post=post, env=env)
        if mid:
            doc["alerted_day"], doc["alerted"] = today, key
            doc["whatsapp_sent_at"] = now.isoformat()
            db.collection("whatsapp_owner_alerts").document(str(mid).replace("/", "_")).set({"via": "price_watchdog", "sentAt": now.isoformat()})
            print("  WhatsApp sent to the owner.")
        else:
            doc["whatsapp_failed_at"] = now.isoformat()
    ref.set(doc)
    try:                                                    # one line per day for the weekly review: red if it was red at any point that day
        hist = db.collection("pricing_watchdog_days").document(today)
        prev = hist.get()
        was_red = prev.exists and (prev.to_dict() or {}).get("status") == "red"
        hist.set({"property_id": "maxela", "day": today, "status": "red" if (result["status"] == "red" or was_red) else result["status"],
                  "last": result["status"], "ts": now.isoformat()})
    except Exception:
        pass
    return {"result": result, "doc": doc}


if __name__ == "__main__":
    main()
