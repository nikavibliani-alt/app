"""Read-only: what MiniHotel shows right now for XCV (all prices), the engine's memory of each night, the give-back list, and what the last runs pushed.
Writes NOTHING. Prints room, dates and prices only."""
import json
import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pricing_shadow as ps  # noqa: E402
import pricing_calm_live as live  # noqa: E402


def main():
    db = ps.init_db()
    repo_config = json.load(open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config.json")))
    rules, settings = ps.load_rules(db, repo_config)
    live_rts = live.live_room_types(rules, settings)
    now = datetime.now(ps.TBILISI).replace(tzinfo=None)
    today = now.date()
    from minihotel_auth import get_session_cookie
    inv = ps.fetch_inventory(get_session_cookie(), today, 10, room_types=list(live_rts))
    state = ps.load_state(db, prefix=live.STATE_PREFIX)
    ctl = (db.collection("pricing_config").document("control").get().to_dict() or {})
    print(f"Now {now.isoformat(timespec='minutes')} Tbilisi")
    print("Give-back list:", ctl.get("release"), "| typed prices waiting:", ctl.get("setprice"))
    for rt in ("XCV_1", "XCV_2"):
        print(f"\n{rt}  channels {live.portals_for(live_rts[rt], rt)}")
        for k in range(0, 8):
            ds = (today + timedelta(days=k)).isoformat()
            c = inv.get(rt, {}).get(ds)
            if not c:
                continue
            st = ((state.get(rt) or {}).get(ds) or {})
            mem = {cur: {x: v for x, v in (m or {}).items() if x in ("manual_until", "manual_price", "last_engine")} for cur, m in st.items()}
            print(f"  {ds} free {c['avail']} MiniHotel {c.get('prices')} memory {json.dumps(mem, default=str)}")
    runs = [r.to_dict() for r in db.collection("pricing_calm_runs").order_by("ts", direction="DESCENDING").limit(3).stream()]
    for r in runs:
        print("\nlast run:", r.get("ts"), {k: r.get(k) for k in ("ok", "main_run", "written", "failed_portals", "resent_portals", "pending_portals") if k in r})
    pend = db.collection("pricing_config").document("channel_pending").get()
    print("channel_pending:", json.dumps((pend.to_dict() or {}) if pend.exists else {}, default=str)[:600])
    print("PROBE FINISHED")


if __name__ == "__main__":
    main()
