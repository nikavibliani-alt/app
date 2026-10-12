"""
Weekly review runner. Bot 1 (numbers, code) -> Bot 2 (analyst, Claude) -> Bot 3 (checker, Claude) -> saves pricing_weekly/<week>
(shown on pricing-v2, Weekly report) -> ONE short WhatsApp to the owner. Changes no price, no rule, no idea.
Started by scripts/after_run.py (Sunday evening Tbilisi) or by hand. Prints counts only.

  python scripts/weekly_review.py            # full run: save, then WhatsApp
  python scripts/weekly_review.py --no-send  # save, no WhatsApp
  python scripts/weekly_review.py --dry      # Bot 1 only: print counts, save nothing, no AI call
"""

import argparse
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pricing_shadow as ps  # noqa: E402
import weekly_ai  # noqa: E402
import weekly_numbers as wn  # noqa: E402

LINK = "https://app.maxelaapartments.com/pricing-v2.html#/weekly"
MESSAGE = f"Weekly pricing report is ready. {LINK}"          # sent as: Guest: Weekly pricing report. Issue: ...


def _digits(v):
    return "".join(c for c in str(v or "") if c.isdigit())


def notify(db, send=None):
    from price_watchdog import send_alert
    snap = db.collection("globals").document("config").get()
    to = _digits((snap.to_dict() or {}).get("ownerPhone") if snap.exists else "")
    return (send or (lambda t, m: send_alert(t, m, label="Weekly pricing report")))(to, MESSAGE)


def main(argv=None, db=None, now=None, send=None, analyst_client=None, checker_client=None, env=os.environ):
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--no-send", action="store_true")
    args = ap.parse_args(argv)
    now = now or datetime.now(ps.TBILISI).replace(tzinfo=None)
    db = db or ps.init_db()
    data, week_from, week_to = wn.load(db, now)
    numbers = wn.build(data, week_from, week_to)
    key = numbers["week"]["key"]
    tot = {k: sum(r.get(k) or 0 for r in numbers["rooms"].values()) for k in ("bookings_made", "nights_sold", "price_up", "price_down", "cancellations")}
    print(f"Weekly numbers {week_from} to {week_to}: {len(numbers['rooms'])} rooms | {tot} | runs {numbers['all']['runs']} | notes {len(numbers['data_notes'])}")
    if args.dry:
        print("Dry run: no AI call, nothing saved, nothing sent.")
        return {"numbers": numbers}
    api = env.get("ANTHROPIC_API_KEY", "")
    if api or analyst_client:
        report = weekly_ai.review(numbers, api, analyst_client, checker_client)
    else:
        report = {"headline": "The written report could not be made (no AI key); the numbers are below.", "removed": [], "edited": 0, "checked": False,
                  **{n: [] for n in weekly_ai.LISTS}}
    doc = {"property_id": wn.PROPERTY_ID, "stream": "weekly", "week_key": key, "from": week_from, "to": week_to, "ts": now.isoformat(),
           "numbers": numbers, "report": report, "ai_calls": 0 if not (api or analyst_client) else (2 if report.get("checked") else 1), "whatsapp": None}
    ref = db.collection("pricing_weekly").document(key)
    if not args.no_send:
        old = ref.get()
        if old.exists and (old.to_dict() or {}).get("whatsapp"):
            doc["whatsapp"] = old.to_dict()["whatsapp"]                      # one message per week
        elif notify(db, send):
            doc["whatsapp"] = now.isoformat()
    ref.set(doc)
    print(f"Weekly review {key} saved | checked {report.get('checked')} | items kept {sum(len(report.get(n) or []) for n in weekly_ai.LISTS)} "
          f"| removed {len(report.get('removed') or [])} | edited {report.get('edited')} | WhatsApp {'sent' if doc['whatsapp'] else 'not sent'}")
    return {"numbers": numbers, "report": report, "doc": doc}


if __name__ == "__main__":
    main()
