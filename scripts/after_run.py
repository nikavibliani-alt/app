"""
After every real pricing run (the last job of pricing_engine.yml, which cron-job.org already starts). It decides by itself
what is due, so no GitHub "schedule:" and no extra cron-job.org entry is needed:

  every run             the "what if" twin (step 3)            -> scripts/twin_run.py
  once a day            nightly: history log + export, idea scorecard, twin comparison
                        (the first run from 04:00 Tbilisi; a marker pricing_jobs/<task>_<day> says it is done)
  once a week           weekly review bots (Sunday from 20:00 Tbilisi; marker pricing_jobs/weekly_<week>)

Each task is wrapped: one failing never stops the others, and nothing here can change a price or send to a channel.
Prints counts only.
"""

import importlib
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pricing_shadow as ps  # noqa: E402

NIGHTLY_FROM_HOUR = 4          # Tbilisi
WEEKLY_FROM_HOUR = 20          # Tbilisi, Sunday


def marker(db, name):
    return db.collection("pricing_jobs").document(name)


def week_key(now):
    y, w, _ = now.isocalendar()
    return f"{y}-W{w:02d}"


def nightly_open(now):
    return now.hour >= NIGHTLY_FROM_HOUR


def weekly_open(now):
    return now.weekday() == 6 and now.hour >= WEEKLY_FROM_HOUR


def run_once(db, name, key, fn, now):
    """Run a task unless its marker says it already finished for this day or week; the marker is set only when it succeeded."""
    ref = marker(db, f"{name}_{key}")
    if ref.get().exists:
        return None
    ok = attempt(name, fn)
    if ok:
        ref.set({"done_at": now.isoformat(), "property_id": "maxela"})
    return ok


def attempt(name, fn):
    try:
        fn()
        return True
    except SystemExit as e:
        print(f"  {name}: stopped ({e})")
    except Exception as e:  # noqa: BLE001
        print(f"  {name}: failed ({type(e).__name__})")
    return False


def task(module, fn_name="main", *args, **kw):
    """Import lazily so a step that does not exist yet (or fails to import) never stops the others."""
    def go():
        mod = importlib.import_module(module)
        return getattr(mod, fn_name)(*args, **kw)
    return go


def main(db=None, now=None, tasks=None):
    now = now or datetime.now(ps.TBILISI).replace(tzinfo=None)
    db = db or ps.init_db()
    t = tasks or {
        "twin": task("twin_run", "main", [], db=db, now=now),
        "history": task("pmslog_daily", "main", [], db=db, now=now),
        "scorecard": task("idea_scorecard", "main", [], db=db, now=now),
        "twin_compare": task("twin_run", "compare", db=db, now=now),
        "weekly": task("weekly_review", "main", [], db=db, now=now),
    }
    done = {"twin": attempt("twin", t["twin"])}
    if nightly_open(now):
        day = now.date().isoformat()
        for name in ("history", "scorecard", "twin_compare"):
            r = run_once(db, name, day, t[name], now)
            if r is not None:
                done[name] = r
    if weekly_open(now):
        r = run_once(db, "weekly", week_key(now), t["weekly"], now)
        if r is not None:
            done["weekly"] = r
    print("After-run:", {k: v for k, v in done.items()})
    return done


if __name__ == "__main__":
    main()
