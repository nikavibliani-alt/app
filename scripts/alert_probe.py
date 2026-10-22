"""Read-only: what alerts went out about pricing, and is it still happening? Writes nothing, sends nothing.
Prints the watchdog card, its last 7 days, the owner WhatsApp alerts and health-monitor state of the last 3 days (no guest text),
the last runs, and a fresh in-memory watchdog check on today's data."""
import json
import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pricing_shadow as ps  # noqa: E402
import pricing_calm_live as live  # noqa: E402
import price_watchdog as pw  # noqa: E402
from calm_pricing import merged  # noqa: E402
from calm_pricing.watchdog import check  # noqa: E402


def iso(v):
    try:
        return v.isoformat()
    except AttributeError:
        return str(v)


def main():
    print("READ-ONLY: nothing is written or sent.\n")
    db = ps.init_db()
    now = datetime.now(ps.TBILISI).replace(tzinfo=None)
    today = now.date().isoformat()
    print(f"Now (Tbilisi): {now:%Y-%m-%d %H:%M}\n")

    print("=== pricing_watchdog/latest ===")
    s = db.collection("pricing_watchdog").document("latest").get()
    d = s.to_dict() if s.exists else {}
    for k in ("ts", "day", "status", "counts", "checked", "total_issues", "main_run_done", "paused", "alerted_day", "alerted", "whatsapp_sent_at", "whatsapp_failed_at", "notes"):
        print(f"  {k}: {d.get(k)}")
    for i in (d.get("issues") or [])[:25]:
        print("  ISSUE", i.get("code"), "|", i.get("text"))

    print("\n=== pricing_watchdog_days (last 7 days) ===")
    for k in range(8):
        day = (now.date() - timedelta(days=k)).isoformat()
        x = db.collection("pricing_watchdog_days").document(day).get()
        print(f"  {day}: {(x.to_dict() or {}) if x.exists else 'no record'}")

    print("\n=== whatsapp_owner_alerts, last 3 days (only who sent it and when; no message text) ===")
    cut = (now - timedelta(days=3)).isoformat()
    rows = []
    for doc in db.collection("whatsapp_owner_alerts").stream():
        x = doc.to_dict() or {}
        t = iso(x.get("sentAt") or x.get("ts") or x.get("createdAt") or "")
        if t >= cut:
            rows.append((t, x.get("via") or "(guest bot / other)", sorted(x.keys())))
    for t, via, keys in sorted(rows):
        print(f"  {t} via {via} fields {keys}")
    print(f"  total in the last 3 days: {len(rows)}, by price_watchdog: {sum(1 for r in rows if r[1] == 'price_watchdog')}")

    print("\n=== health monitor state (config/health_monitor) ===")
    h = db.collection("config").document("health_monitor").get()
    hd = h.to_dict() if h.exists else {}
    for k in ("lastRunAt", "lastFailedCount", "lastAlertSent", "lastAlertSentMs", "updatedAt"):
        print(f"  {k}: {iso(hd.get(k))}")
    for r in hd.get("lastResults") or []:
        print(f"  {'ok ' if r.get('ok') else 'BAD'} {r.get('name')}: {str(r.get('detail'))[:200]}")

    print("\n=== pricing runs, last 3 days (newest last) ===")
    runs = []
    for k in range(4):
        day = (now.date() - timedelta(days=k)).isoformat()
        for doc in db.collection("pricing_calm_runs").where("day", "==", day).stream():
            runs.append(doc.to_dict() or {})
    runs.sort(key=lambda r: r.get("ts", ""))
    for r in runs:
        print(f"  {r.get('ts')} ok={r.get('ok')} main={r.get('main_run')} writes={r.get('writes')} stopped={r.get('stopped_room_types') or '-'} "
              f"failed_portals={r.get('failed_portals') or '-'} alerts={len(r.get('alerts') or [])} paused={r.get('paused')}")
        for a in (r.get("alerts") or [])[:3]:
            print("      alert:", str(a)[:240])

    print("\n=== fresh check now (in memory, nothing saved) ===")
    repo_config = json.load(open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config.json")))
    rules, settings = ps.load_rules(db, repo_config)
    live_rts = live.live_room_types(rules, settings)
    daily, states, today_runs = pw.load_inputs(db, today, live_rts)
    last = today_runs[-1] if today_runs else None
    if not last:
        print("  No run yet today: nothing to judge.")
    else:
        view = {"ok": last.get("ok") is not False, "failed_portals": sorted(last.get("failed_portals") or []), "stopped_room_types": sorted(last.get("stopped_room_types") or [])}
        res = check(daily, states, view, merged(settings), now, live_rts=list(live_rts))
        print(f"  Last run today: {last.get('ts')} ok={last.get('ok')} failed_portals={view['failed_portals'] or '-'} stopped={view['stopped_room_types'] or '-'}")
        print(f"  Status now: {res['status']} | checked {res['checked']} | counts {res['counts'] or 'none'}")
        for i in res["issues"][:25]:
            print("  ISSUE", i["code"], "|", i["text"])


if __name__ == "__main__":
    main()
