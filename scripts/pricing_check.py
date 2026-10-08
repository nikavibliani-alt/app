#!/usr/bin/env python3
"""
Read-only pricing diagnostics, run from GitHub Actions (pricing_check.yml).

NEVER WRITES. Firestore: .get() / .stream() only. MiniHotel: GET endpoints plus
the login form POST. Any other non-GET request to a MiniHotel host raises.

The repo and its Actions logs are public, so this prints summary numbers only:
no guest names, phones, emails or reservation numbers.
"""
import argparse
import base64
import json
import os
import re
import signal
import subprocess
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import requests

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

TBILISI = ZoneInfo("Asia/Tbilisi")
MH_HOSTS = ("minihotelpms.com", "minihotel.cloud", "hotelpms.cloud")
LOGIN_URL = "https://login.minihotel.cloud/login.aspx"
DATA_URL = "https://ssl20.minihotelpms.com/api/ScreenA/Data"
RES_URL = "https://emea5.hotelpms.cloud/api/Reservations"
KNOWN_ROOM_TYPES = ["ROOMS", "MAXELA", "BIG_APT", "FREEDOM", "ORBE_1", "ORBE_2"]
EXTRA_ROOM_TYPES = ["VGL_ST", "VGL_AP", "XCV_1", "XCV_2"]


# ---------------------------------------------------------------------------
# Write guard
# ---------------------------------------------------------------------------

BLOCKED = []  # attempted non-GET requests to MiniHotel (always stays empty in a clean run)
_orig_request = requests.Session.request


def _guarded_request(self, method, url, *args, **kwargs):
    m = str(method).upper()
    host = (re.sub(r"^https?://", "", str(url)).split("/")[0]).lower()
    if any(host == h or host.endswith("." + h) for h in MH_HOSTS):
        is_login_post = m == "POST" and str(url).split("?")[0].lower() == LOGIN_URL
        if m not in ("GET", "HEAD") and not is_login_post:
            BLOCKED.append(f"{m} {host}")
            raise RuntimeError(f"BLOCKED non-GET request to MiniHotel host: {m} {host}")
    return _orig_request(self, method, url, *args, **kwargs)


requests.Session.request = _guarded_request


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def hdr(t):
    print(f"\n{'=' * 70}\n{t}\n{'=' * 70}")


def pct(n, d):
    return f"{(100.0 * n / d):.0f}%" if d else "n/a"


def init_firestore():
    import firebase_admin
    from firebase_admin import credentials, firestore
    sa = os.environ.get("FIREBASE_SERVICE_ACCOUNT")
    if not sa:
        raise SystemExit("FIREBASE_SERVICE_ACCOUNT not set")
    cred = credentials.Certificate(json.loads(base64.b64decode(sa).decode()))
    if not firebase_admin._apps:
        firebase_admin.initialize_app(cred)
    return firestore.client()


def to_tbilisi(ts):
    if ts is None:
        return None
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts.astimezone(TBILISI)


def mh_session():
    """Own login (no cookie values printed). Returns a requests.Session."""
    from bs4 import BeautifulSoup
    s = requests.Session()
    s.headers["User-Agent"] = "Mozilla/5.0"
    r = s.get(LOGIN_URL, timeout=30)
    soup = BeautifulSoup(r.text, "html.parser")

    def f(i):
        t = soup.find("input", {"id": i})
        return t["value"] if t and t.get("value") else ""

    resp = s.post(LOGIN_URL, data={
        "LoginButton": "Login", "__EVENTARGUMENT": "",
        "__VIEWSTATE": f("__VIEWSTATE"),
        "__VIEWSTATEGENERATOR": f("__VIEWSTATEGENERATOR"),
        "__EVENTVALIDATION": f("__EVENTVALIDATION"),
        "txt_hotel_code": os.environ.get("MINIHOTEL_HOTEL", ""),
        "txt_username": os.environ.get("MINIHOTEL_USER", ""),
        "txt_password": os.environ.get("MINIHOTEL_PASS", ""),
        "hdd_language": "en", "txt_agent_username": "", "txt_agent_password": "",
    }, allow_redirects=True, timeout=30)
    if "login" in resp.url.lower() or "dashboard" not in resp.url.lower():
        raise RuntimeError("MiniHotel login failed")
    return s


def mh_cookie_header():
    """Same cookie string pricing_engine.py uses for the ScreenA host."""
    from minihotel_auth import get_session_cookie
    return get_session_cookie()


# ---------------------------------------------------------------------------
# 3a. pricing_config/rules
# ---------------------------------------------------------------------------

def check_rules(db):
    hdr("A. pricing_config/rules")
    snap = db.collection("pricing_config").document("rules").get()
    if not snap.exists:
        print("pricing_config/rules does not exist")
        return
    d = snap.to_dict() or {}
    print("top-level keys:", sorted(d.keys()))

    def block(label, start_key, rules_key):
        start = d.get(start_key) or {}
        rules = d.get(rules_key) or {}
        print(f"\n-- {label}: {start_key} + {rules_key}")
        flags = []
        rts = sorted(set(start) | set(rules))
        print("room types:", rts)
        for rt in rts:
            seasons = sorted(set((start.get(rt) or {})) | set((rules.get(rt) or {})))
            for s in seasons:
                st = (start.get(rt) or {}).get(s)
                rr = (rules.get(rt) or {}).get(s) or {}
                mn, mx = rr.get("min"), rr.get("max")
                line = f"  {rt:9} {s:12} min={mn} start={st} max={mx}"
                problems = []
                try:
                    if st and mx is not None and mx < st * 1.15:
                        problems.append("max < start+15%")
                    if st and mn is not None and mn > st * 0.85:
                        problems.append("min > start-15%")
                    if st and mn is not None and mn > st:
                        problems.append("min > start")
                    if st and mx is not None and st > mx:
                        problems.append("start > max")
                except TypeError:
                    problems.append("non-numeric value")
                if st is None:
                    problems.append("no start price")
                print(line + ("   <-- " + "; ".join(problems) if problems else ""))
                if problems:
                    flags.append((rt, s, problems))
        print(f"flagged rows: {len(flags)}")
        return rts

    gel = block("GEL", "startPrices", "priceRules")
    eur = block("EUR", "startPricesEur", "eurRules")
    print("\nRules present under these exact names?")
    for name in ["VGL_ST", "VGL_AP", "XCV_1", "XCV_2"]:
        print(f"  {name}: GEL={'yes' if name in gel else 'no'}  EUR={'yes' if name in eur else 'no'}")
    print("\nother keys:", {k: (type(v).__name__) for k, v in d.items()
                            if k not in ("startPrices", "priceRules", "startPricesEur", "eurRules")})


# ---------------------------------------------------------------------------
# 3b. pricing_changes last 14 days
# ---------------------------------------------------------------------------

def check_changes(db):
    hdr("B. pricing_changes, last 14 days")
    cutoff = datetime.now(timezone.utc) - timedelta(days=14)
    docs = list(db.collection("pricing_changes").where("ts", ">=", cutoff).stream())
    print(f"documents: {len(docs)}")
    types = Counter()
    events = defaultdict(list)  # (prop, date, cur) -> [(ts, old, new)]
    for doc in docs:
        x = doc.to_dict() or {}
        types[x.get("type")] += 1
        ts = x.get("ts")
        if ts is None:
            continue
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        for c in x.get("changes") or []:
            try:
                events[(c["property"], c["date"], c.get("currency", "gel"))].append(
                    (ts, float(c["old"]), float(c["new"])))
            except (KeyError, TypeError, ValueError):
                pass
    print("doc types:", dict(types))
    print("NOTE: each run stores at most its 50 biggest changes, so counts are a floor.")
    if not events:
        print("no per-date changes found")
        return

    # per property: changes per (date, tbilisi day)
    per_prop_day = defaultdict(lambda: defaultdict(int))     # prop -> (date,day,cur) -> n
    biggest = defaultdict(lambda: (0.0, None))               # prop -> (pct, key)
    dud_total = 0
    scored = []
    for key, evs in events.items():
        prop, date, cur = key
        evs.sort()
        by_day = defaultdict(list)
        for ts, old, new in evs:
            day = to_tbilisi(ts).date().isoformat()
            per_prop_day[prop][(date, day, cur)] += 1
            by_day[day].append((old, new))
        swing = 0.0
        for day, lst in by_day.items():
            first_old, last_new = lst[0][0], lst[-1][1]
            if first_old:
                mv = abs(last_new - first_old) / first_old * 100
                swing = max(swing, mv)
                if mv > biggest[prop][0]:
                    biggest[prop] = (mv, key)
        # down-up-down inside 48h
        signs = [(ts, 1 if new > old else -1 if new < old else 0) for ts, old, new in evs]
        signs = [s for s in signs if s[1] != 0]
        dud = 0
        for i in range(len(signs) - 2):
            a, b, c = signs[i], signs[i + 1], signs[i + 2]
            if a[1] == -1 and b[1] == 1 and c[1] == -1 and (c[0] - a[0]) <= timedelta(hours=48):
                dud += 1
        if dud:
            dud_total += 1
        scored.append((dud, swing, len(evs), key))

    print("\nPer room type: changes per date per day (avg / max), biggest one-day move")
    for prop in sorted(per_prop_day):
        counts = list(per_prop_day[prop].values())
        mv, key = biggest[prop]
        print(f"  {prop:9} avg={sum(counts) / len(counts):.2f} max={max(counts)} "
              f"(date-days={len(counts)})  biggest one-day move={mv:.1f}%"
              + (f" on {key[1]} {key[2]}" if key else ""))
    print(f"\nDates (property+date+currency) with a down-up-down inside 48h: {dud_total} "
          f"of {len(events)}")
    scored.sort(key=lambda t: (t[0], t[1], t[2]), reverse=True)
    print("10 worst dates (down-up-down patterns, biggest one-day swing %, changes in 14d):")
    for dud, swing, n, (prop, date, cur) in scored[:10]:
        print(f"  {prop:9} {date} {cur}: DUD={dud} swing={swing:.1f}% changes={n}")


# ---------------------------------------------------------------------------
# 3c. pricing_log last 7 days
# ---------------------------------------------------------------------------

def check_log(db):
    hdr("C. pricing_log, last 7 days (Tbilisi time)")
    cutoff = datetime.now(timezone.utc) - timedelta(days=7)
    docs = list(db.collection("pricing_log").where("timestamp", ">=", cutoff).stream())
    print(f"runs: {len(docs)}")
    runs = []
    for doc in docs:
        x = doc.to_dict() or {}
        t = to_tbilisi(x.get("timestamp"))
        if t:
            runs.append((t, x))
    runs.sort(key=lambda r: r[0])
    by_day = defaultdict(list)
    for t, x in runs:
        by_day[t.date().isoformat()].append((t, x))
    for day in sorted(by_day):
        lst = by_day[day]
        errs = sum(1 for _, x in lst if x.get("error"))
        print(f"\n{day}: {len(lst)} runs, {errs} with errors, "
              f"{sum(int(x.get('changes_count') or 0) for _, x in lst)} changes total")
        for t, x in lst:
            print(f"   {t.strftime('%H:%M')}  trigger={x.get('trigger')} dry={x.get('dry_run')} "
                  f"changes={x.get('changes_count')}" + (f"  ERROR: {str(x['error'])[:80]}" if x.get("error") else ""))
    sched = [t for t, x in runs if x.get("trigger") == "scheduled"]
    print(f"\ntriggers: {dict(Counter(x.get('trigger') for _, x in runs))}")
    if sched:
        hours = Counter(t.strftime("%H") for t in sched)
        minutes = Counter(t.strftime("%M") for t in sched)
        print("scheduled runs by Tbilisi hour:", dict(sorted(hours.items())))
        print("most common minutes past the hour:", minutes.most_common(5))
        times = Counter(t.strftime("%H:%M") for t in sched)
        print("most common run times (HH:MM):", times.most_common(12))


# ---------------------------------------------------------------------------
# 3d. reservations
# ---------------------------------------------------------------------------

def group_of(code):
    c = (code or "").lower()
    if re.fullmatch(r"[067]-\d+", c):
        return "Shartava"
    if re.fullmatch(r"tab-\d+", c):
        return "Freedom"
    if re.fullmatch(r"orb-\d+", c):
        return "Orbeliani"
    if c.startswith("vgl-"):
        return "VGL"
    if c.startswith("xcv"):
        return "XCV"
    return None


BUCKETS = [("<0", None, -1), ("0-3", 0, 3), ("4-7", 4, 7), ("8-14", 8, 14),
           ("15-30", 15, 30), ("31-60", 31, 60), ("61+", 61, 10 ** 6)]


def bucket(days):
    for name, lo, hi in BUCKETS:
        if lo is None:
            if days < 0:
                return name
        elif lo <= days <= hi:
            return name


def check_reservations(db):
    hdr("D. reservations")
    # select() limits what is read; no names/phones/emails are ever fetched
    q = db.collection("reservations").select(["status", "creationDate", "checkin", "roomCode"])
    status_counts, other_status = Counter(), Counter()
    no_creation = Counter()
    rows = []  # (group, room, lead, checkin, creation)
    total = 0
    exists_73 = Counter()
    for doc in q.stream():
        x = doc.to_dict() or {}
        total += 1
        st = str(x.get("status") or "").upper()
        key = st if st in ("OK", "OK2", "CL", "WL") else "other"
        status_counts[key] += 1
        if key == "other":
            other_status[st or "(empty)"] += 1
        cd = x.get("creationDate")
        if not cd:
            no_creation[key] += 1
        if x.get("roomCode") == "7-3":
            exists_73[st or "(empty)"] += 1
        if key in ("OK", "OK2") and cd and x.get("checkin"):
            try:
                ci = datetime.strptime(str(x["checkin"])[:10], "%Y-%m-%d").date()
                cr = datetime.strptime(str(cd)[:10], "%Y-%m-%d").date()
            except ValueError:
                continue
            rows.append((group_of(x.get("roomCode")), x.get("roomCode") or "(none)", (ci - cr).days, ci, cr))
    print(f"total reservation docs: {total}")
    print("by status:", dict(status_counts), "| other raw:", dict(other_status))
    print("no creationDate by status:", dict(no_creation),
          f"(total {sum(no_creation.values())})")
    print(f"OK/OK2 with creationDate and checkin: {len(rows)}")
    if rows:
        print(f"creationDate range: {min(r[4] for r in rows)} -> {max(r[4] for r in rows)}")
        print(f"checkin range:      {min(r[3] for r in rows)} -> {max(r[3] for r in rows)}")

    ungrouped = Counter(r[1] for r in rows if r[0] is None)
    print("roomCodes not in Shartava/Freedom/Orbeliani/VGL/XCV groups:",
          dict(ungrouped) if ungrouped else "none")
    xcv = Counter(r[1] for r in rows if r[0] == "XCV")
    print("XCV codes seen:", dict(xcv) if xcv else "none")

    print("\nShare booked N days before arrival (OK/OK2 with creationDate):")
    names = [b[0] for b in BUCKETS]
    print(f"  {'group':10} {'n':>6}  " + "  ".join(f"{n:>6}" for n in names))
    for g in ["Shartava", "Freedom", "Orbeliani", "VGL", "XCV", None]:
        sel = [r for r in rows if r[0] == g]
        if not sel:
            continue
        c = Counter(bucket(r[2]) for r in sel)
        print(f"  {(g or 'other'):10} {len(sel):>6}  " + "  ".join(f"{pct(c[n], len(sel)):>6}" for n in names))
        gr = [r[4] for r in sel]
        print(f"  {'':10} data goes back to creationDate {min(gr)}, checkin {min(r[3] for r in sel)}")
    print(f"\nReservations for room 7-3 (any status): {sum(exists_73.values())} {dict(exists_73)}")


# ---------------------------------------------------------------------------
# 3e. ScreenA
# ---------------------------------------------------------------------------

def check_screen_a():
    hdr("E. MiniHotel /api/ScreenA/Data")
    cookie = mh_cookie_header()
    headers = {"Cookie": cookie, "Accept": "application/json, text/plain, */*",
               "X-Requested-With": "XMLHttpRequest", "User-Agent": "Mozilla/5.0"}
    today = datetime.now(TBILISI).date()
    # same date format pricing_engine.py uses: YYYYMMDD
    d_from, d_to = today.strftime("%Y%m%d"), (today + timedelta(days=90)).strftime("%Y%m%d")

    def fetch(rooms):
        params = {"dateFrom": d_from, "dateTo": d_to}
        if rooms:
            params["rooms"] = ",".join(rooms)
        r = requests.get(DATA_URL, params=params, headers=headers, timeout=60)
        return r.status_code, (r.json() if r.status_code == 200 else None)

    code, data = fetch(None)
    print(f"call without rooms param: HTTP {code}, entries={len(data) if isinstance(data, list) else 'n/a'}")
    src = "all (no rooms param)"
    if not isinstance(data, list) or not data:
        code, data = fetch(KNOWN_ROOM_TYPES)
        src = "the 6 types pricing_engine.py uses"
        print(f"call with the 6 known types: HTTP {code}, entries={len(data) if isinstance(data, list) else 'n/a'}")
        data = data if isinstance(data, list) else []
        # probe the other names one by one (a bad name may make the whole call fail)
        for name in EXTRA_ROOM_TYPES:
            c, extra = fetch([name])
            n = len(extra) if isinstance(extra, list) else "n/a"
            print(f"probe {name}: HTTP {c}, entries={n}")
            if isinstance(extra, list):
                data += [e for e in extra if e.get("RoomTypeCode") not in {x.get("RoomTypeCode") for x in data}]
    if not data:
        print("no data returned")
        return
    print("room-type source:", src)
    first = data[0]
    print("entry keys:", sorted(first.keys()))
    dates0 = first.get("Dates") or []
    if dates0:
        print("date keys:", sorted(dates0[0].keys()))
        rates0 = dates0[0].get("Rates") or []
        if rates0:
            print("rate keys:", sorted(rates0[0].keys()))
    codes = [e.get("RoomTypeCode") for e in data]
    print("room types returned:", codes)
    missing = [n for n in EXTRA_ROOM_TYPES if n not in codes]
    print("not returned among VGL_ST/VGL_AP/XCV_1/XCV_2:", missing or "none")

    next3 = {(today + timedelta(days=i)).isoformat() for i in range(3)}
    for e in data:
        rt = e.get("RoomTypeCode")
        ds = e.get("Dates") or []
        print(f"\n-- {rt}  (days returned: {len(ds)})")
        pl_names = set()
        for d in ds:
            for r in d.get("Rates") or []:
                pl_names.add(r.get("PriceList"))
        print("   PriceList names (90 days):", sorted(str(n) for n in pl_names))
        print("   any *ALL price list:", any(str(n).upper().endswith("ALL") for n in pl_names))
        for d in ds:
            ds_ = str(d.get("Date", "")).split("T")[0]
            if ds_ in next3:
                prices = {r.get("PriceList"): r.get("Price") for r in d.get("Rates") or []}
                print(f"   {ds_}: Avail={d.get('Availability')} Default={d.get('DefaultAvailability')} "
                      f"MinNights={d.get('MinimumNights')} Closed={d.get('Close')} prices={prices}")
        full = []
        for d in ds:
            av = d.get("Availability")
            eff = av if av is not None else d.get("DefaultAvailability")
            if eff == 0:
                full.append(f"{str(d.get('Date')).split('T')[0]}(A={av},D={d.get('DefaultAvailability')})")
        print(f"   fully booked dates next 90 days: {len(full)}")
        if full:
            print("     " + ", ".join(full))


# ---------------------------------------------------------------------------
# 3f. Reservations API, October 2025
# ---------------------------------------------------------------------------

def check_res_api():
    hdr("F. MiniHotel Reservations API, October 2025 (counts only)")
    s = mh_session()
    url = f"{RES_URL}?FromDate=2025-09-30T20:00:00.000Z&ToDate=2025-10-31T20:00:00.000Z"
    r = s.get(url, headers={"Accept": "application/json", "Content-Type": "application/json"}, timeout=90)
    print(f"HTTP {r.status_code}")
    if r.status_code != 200:
        return
    data = r.json()
    res = data.get("reservations", []) or []
    print(f"reservations returned: {len(res)}; rooms returned: {len(data.get('rooms', []) or [])}")
    if not res:
        return
    print("reservation keys:", sorted(res[0].keys()))

    def has(k):
        return sum(1 for x in res if x.get(k))

    for k in ("creationDate", "checkIn", "checkOut", "roomNumber", "status"):
        print(f"  with {k}: {has(k)}")
    print("  status counts:", dict(Counter(str(x.get("status")) for x in res)))
    cis = sorted(x["checkIn"] for x in res if x.get("checkIn"))
    cos = sorted(x["checkOut"] for x in res if x.get("checkOut"))
    crs = sorted(x["creationDate"] for x in res if x.get("creationDate"))
    if cis:
        print(f"  checkIn range: {cis[0]} -> {cis[-1]}")
    if cos:
        print(f"  checkOut range: {cos[0]} -> {cos[-1]}")
    if crs:
        print(f"  creationDate range: {crs[0]} -> {crs[-1]}")
    oct_in = sum(1 for c in cis if c.startswith("202510"))
    print(f"  checkIn inside October 2025: {oct_in}")


# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# --check dryrun: prove pricing_engine.py --report writes nothing
# ---------------------------------------------------------------------------

DRYRUN_COLLECTIONS = ["pricing_events", "pricing_outcomes", "pricing_locks", "pricing_log",
                      "pricing_proposals", "pricing_changes", "pricing_snapshots"]


def count_docs(db):
    out = {}
    for name in DRYRUN_COLLECTIONS:
        out[name] = sum(1 for _ in db.collection(name).select([]).stream())
    return out


def check_dryrun():
    hdr("DRY RUN PROOF: python pricing_engine.py --report (no --apply)")
    for k in ("ANTHROPIC_API_KEY", "SENDGRID_KEY", "SERPAPI_KEY"):
        print(f"  {k} present in environment: {'yes' if os.environ.get(k) else 'no'}")
    db = init_firestore()
    before = count_docs(db)
    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
    # -u + faulthandler: if the engine hangs we get a stack trace instead of silence
    p = subprocess.Popen([sys.executable, "-u", "-X", "faulthandler", "pricing_engine.py", "--report"],
                         cwd=root, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    timed_out = False
    try:
        out, err = p.communicate(timeout=300)
    except subprocess.TimeoutExpired:
        timed_out = True
        p.send_signal(signal.SIGABRT)  # faulthandler prints all thread stacks to stderr
        try:
            out, err = p.communicate(timeout=20)
        except subprocess.TimeoutExpired:
            p.kill()
            out, err = p.communicate()
    after = count_docs(db)

    class proc:  # keep the names used below
        returncode = -1 if timed_out else p.returncode
    if timed_out:
        print("\nENGINE TIMED OUT after 300 s. Last output lines:")
        print("\n".join(l for l in out.splitlines() if not l.startswith("R | "))[-1500:])
        print("\nstack at the time of the hang (stderr tail):")
        print(err[-2500:])

    print(f"\nengine exit code: {proc.returncode}")
    print(f"{'collection':20} {'before':>8} {'after':>8}")
    equal = True
    for name in DRYRUN_COLLECTIONS:
        flag = "" if before[name] == after[name] else "   <-- CHANGED"
        equal &= before[name] == after[name]
        print(f"{name:20} {before[name]:>8} {after[name]:>8}{flag}")
    print("\nRESULT:", "PASS, all counts equal" if equal else "FAIL, a count changed")

    blocked = [l for l in (out + err).splitlines() if "WRITE BLOCKED" in l or "Write guard blocked" in l]
    print(f"write attempts blocked by the engine's own guard: {len(blocked)}")
    for l in blocked[:5]:
        print("  ", l[:160])
    for l in out.splitlines():
        if l.startswith(("DRY RUN", "TOTAL:", "Skipping event scan")):
            print(l[:160])

    rows = [l for l in out.splitlines() if l.startswith("R | ")]
    print(f"\nreport rows: {len(rows)}")
    for rt in ("MAXELA", "BIG_APT"):
        sel = [l for l in rows if l.split(" | ")[1] == rt]
        print(f"\nfirst 15 rows for {rt} (of {len(sel)}): room | date | days | cur GEL | new GEL | cur EUR | new EUR | reason")
        for l in sel[:15]:
            print("  " + l[4:][:200])
    if proc.returncode != 0:
        print("\nengine stderr (tail):")
        print("\n".join(err.splitlines()[-15:])[:1500])
    if not equal or proc.returncode != 0:
        sys.exit(1)

# ---------------------------------------------------------------------------
# --check shadow: run the calm engine in print-only mode
# ---------------------------------------------------------------------------
SHADOW_BANDS = [("0-3", 0, 3), ("4-7", 4, 7), ("8-14", 8, 14), ("15-30", 15, 30), ("31-60", 31, 60), ("61-90", 61, 10 ** 6)]
SHADOW_STATUSES = ["far_behind", "behind", "on_track", "ahead", "far_ahead"]


def _band(days):
    for name, lo, hi in SHADOW_BANDS:
        if lo <= days <= hi:
            return name
    return None


def shadow_summary(result, cfg):
    """Per room type and currency: up/down/same, bands, demand status, 5 biggest down moves.
    'Change' = the new engine's price after this run versus the price now in MiniHotel."""
    hdr("SHADOW SUMMARY (new engine price vs the price now in MiniHotel; nothing saved)")
    print("Fully booked = no free unit. 'not priced' = no min/start/max set, or no price in MiniHotel.")
    print("Demand status counts leave out fully booked dates.")
    groups = defaultdict(list)
    for d in result["decisions"]:
        groups[(d["rt"], d["currency"])].append(d)
    for (rt, cur) in sorted(groups):
        decs = groups[(rt, cur)]
        up, down, same, full, unpriced = [], [], [], 0, 0
        band = {b[0]: {"up": 0, "down": 0, "same": 0, **{st: 0 for st in SHADOW_STATUSES}} for b in SHADOW_BANDS}
        for d in decs:
            b = _band(d["days_out"])
            if d["avail"] == 0:
                full += 1
                continue
            if d["min"] is None or d["mh_price"] <= 0:
                unpriced += 1
                continue
            change = (d["proposed"] - d["mh_price"]) / d["mh_price"] * 100
            kind = "up" if d["proposed"] > d["mh_price"] else "down" if d["proposed"] < d["mh_price"] else "same"
            {"up": up, "down": down, "same": same}[kind].append(change)
            if b:
                band[b][kind] += 1
                if d["status"] in SHADOW_STATUSES:
                    band[b][d["status"]] += 1

        def avg(l):
            return f"{sum(l) / len(l):+.1f}%" if l else "n/a"
        print(f"\n=== {rt} {cur} ===  dates {len(decs)}")
        print(f"  up {len(up)} (avg {avg(up)}) | down {len(down)} (avg {avg(down)}) | same {len(same)} | "
              f"fully booked {full} | not priced {unpriced}")
        print(f"  {'days':6} {'up':>4} {'down':>5} {'same':>5} | " + " ".join(f"{st:>10}" for st in SHADOW_STATUSES))
        for name, _, _ in SHADOW_BANDS:
            r = band[name]
            print(f"  {name:6} {r['up']:>4} {r['down']:>5} {r['same']:>5} | " + " ".join(f"{r[st]:>10}" for st in SHADOW_STATUSES))
        downs = [d for d in decs if d["avail"] != 0 and d["min"] is not None and d["mh_price"] > 0 and d["proposed"] < d["mh_price"]]
        downs.sort(key=lambda d: (d["proposed"] - d["mh_price"]) / d["mh_price"])
        if downs:
            print("  5 biggest down moves: date | days | MiniHotel | new | target | min | start | max | demand | last reasons")
            for d in downs[:5]:
                start = ((cfg.get("rules") or {}).get(rt, {}).get(cur, {}).get(d["season"]) or {}).get("start")
                tgt = d["target"]
                pct = (d["proposed"] - d["mh_price"]) / d["mh_price"] * 100
                print(f"    {d['date']} | {d['days_out']} | {d['mh_price']:g} | {d['proposed']:g} ({pct:+.1f}%) | "
                      f"{'-' if tgt is None else format(tgt, 'g')} | {d['min']:g} | {'-' if start is None else format(start, 'g')} | "
                      f"{d['max']:g} | {d['status']} | {' / '.join(d['why'][-3:])[:230]}")
        else:
            print("  no down moves")


def check_shadow():
    hdr("SHADOW CHECK: pricing_shadow.py --print (calculates and prints, saves nothing)")
    import pricing_shadow
    captured = {}
    _orig_build = pricing_shadow.build_config

    def _capture(*a, **k):  # keep the engine's config to read the start prices (no extra reads)
        captured["cfg"] = _orig_build(*a, **k)
        return captured["cfg"]
    pricing_shadow.build_config = _capture
    result = pricing_shadow.main(["--print"])
    print(f"\nMiniHotel writes produced by the shadow engine: {len(result['writes'])}")
    print(f"Attempted non-GET requests to MiniHotel (blocked by the check's guard): {len(BLOCKED)}")
    print("Nothing was sent to MiniHotel and nothing was saved (--print).")
    shadow_summary(result, captured.get("cfg") or {})
    if result["writes"] or BLOCKED:
        sys.exit(1)

# ---------------------------------------------------------------------------
# --check live: the calm engine's live job in dry mode (writes and saves nothing)
# ---------------------------------------------------------------------------

def check_live():
    hdr("LIVE CHECK: pricing_calm_live.py --dry (calculates and prints; writes nothing, saves nothing)")
    import pricing_calm_live
    result = pricing_calm_live.main(["--dry"])
    print(f"\nPrice changes it would send (not sent): {len(result.get('writes') or [])}")
    print(f"Sent to MiniHotel: {bool(result.get('sent'))}")
    print(f"Attempted non-GET requests to MiniHotel (blocked by the check's guard): {len(BLOCKED)}")
    if result.get("sent") or BLOCKED:
        sys.exit(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", default="step1")
    args = ap.parse_args()
    if args.check == "dryrun":
        check_dryrun()
        return
    if args.check == "shadow":
        check_shadow()
        return
    if args.check == "live":
        check_live()
        return
    if args.check != "step1":
        raise SystemExit(f"unknown check: {args.check}")

    print(f"pricing_check step1 at {datetime.now(TBILISI).isoformat(timespec='minutes')} (Tbilisi)")
    db = init_firestore()
    for name, fn in [
        ("A", lambda: check_rules(db)),
        ("B", lambda: check_changes(db)),
        ("C", lambda: check_log(db)),
        ("D", lambda: check_reservations(db)),
        ("E", check_screen_a),
        ("F", check_res_api),
    ]:
        try:
            fn()
        except Exception as e:  # keep going; one failed section must not hide the rest
            print(f"\n[section {name} FAILED] {type(e).__name__}: {str(e)[:200]}")


if __name__ == "__main__":
    main()
