"""
One-off: after the first live run of the six moved rooms, (1) read three nights from MiniHotel to see whether the new
price is there, (2) retry the Expedia push once with a 60 second timeout and report how long it took.
Prices and portals only; prints no guest data. Writes nothing except the one channel push (SendPrices, EXPEDIA).
  python scripts/expedia_retry.py            # read the three nights, then push EXPEDIA once
  python scripts/expedia_retry.py --no-push  # read only
"""
import argparse
import os
import sys
import time
from datetime import date

import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pricing_calm_live as live  # noqa: E402
import pricing_shadow as ps  # noqa: E402

# (room, night, new GEL price written by the run on 12 Oct)
CHECKS = [("MAXELA", "2026-12-13", 245), ("ROOMS", "2026-12-13", 140), ("BIG_APT", "2026-12-12", 660)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-push", action="store_true")
    args = ap.parse_args()
    from minihotel_auth import get_session_cookie
    cookie = get_session_cookie()
    with live.LiveWriteGuard({"ROOMS", "MAXELA", "BIG_APT", "FREEDOM", "ORBE_1", "ORBE_2"}):
        rooms = sorted({r for r, _, _ in CHECKS})
        hdr = {"Cookie": cookie, "Accept": "application/json, text/plain, */*", "X-Requested-With": "XMLHttpRequest", "User-Agent": "Mozilla/5.0"}
        resp = requests.get(ps.DATA_ENDPOINT, params={"rooms": ",".join(rooms), "dateFrom": "20261212", "dateTo": "20261213"}, headers=hdr, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        keys_seen = set()
        for room, night, expect in CHECKS:
            got = None
            for entry in data:
                if entry.get("RoomTypeCode") != room:
                    continue
                for d in entry.get("Dates", []):
                    keys_seen |= set(d.keys())
                    if d["Date"].startswith(night):
                        for r in d.get("Rates") or []:
                            keys_seen |= {"Rates." + k for k in r.keys()}
                            if r.get("PriceList") == "GEL":
                                got = r.get("Price")
            print(f"  {room} {night} GEL list in MiniHotel: {got} | the 12 Oct run wrote {expect} | {'SAME' if got is not None and abs(float(got) - expect) < 0.5 else 'DIFFERENT'}")
        print(f"  Fields MiniHotel returns per night (names only): {sorted(keys_seen)}")
        if args.no_push:
            return
        t = time.time()
        failed = live.push_channels(["EXPEDIA"], cookie, timeout=120)
        print(f"  EXPEDIA push (120 s timeout, up to 3 tries): {'FAILED' if failed else 'OK'} after {time.time() - t:.0f} s")
        if failed:
            sys.exit(1)


if __name__ == "__main__":
    main()
