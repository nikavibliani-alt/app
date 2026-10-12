import importlib.util
import os
import sys
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("after_run", os.path.join(ROOT, "scripts", "after_run.py"))
ar = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ar)
from test_pmslog import DB  # noqa: E402


def tasks(log, fail=()):
    def mk(n):
        def f():
            log.append(n)
            if n in fail:
                raise RuntimeError("x")
        return f
    return {n: mk(n) for n in ("twin", "history", "scorecard", "twin_compare", "weekly")}


def at(day, hour):
    return datetime(2026, 10, day, hour, 0)             # 12 Oct 2026 is a Monday, 18 Oct a Sunday


def test_twin_every_run_nightly_once_a_day_after_04():
    db, log = DB(), []
    ar.main(db, at(13, 1), tasks(log)); assert log == ["twin"]                        # before 04:00 Tbilisi: not yet
    log.clear(); ar.main(db, at(13, 5), tasks(log)); assert log == ["twin", "history", "scorecard", "twin_compare"]
    log.clear(); ar.main(db, at(13, 9), tasks(log)); assert log == ["twin"]           # already done today
    log.clear(); ar.main(db, at(14, 5), tasks(log)); assert "history" in log          # next day


def test_a_failing_task_does_not_stop_the_others_and_is_tried_again_next_run():
    db, log = DB(), []
    ar.main(db, at(13, 5), tasks(log, fail=("history",)))
    assert log == ["twin", "history", "scorecard", "twin_compare"]
    log.clear(); ar.main(db, at(13, 9), tasks(log)); assert log == ["twin", "history"]


def test_weekly_only_on_sunday_evening_once():
    db, log = DB(), []
    ar.main(db, at(18, 12), tasks(log)); assert "weekly" not in log                    # Sunday noon
    ar.main(db, at(18, 21), tasks(log)); assert log.count("weekly") == 1
    ar.main(db, at(18, 23), tasks(log)); assert log.count("weekly") == 1
    ar.main(db, at(19, 21), tasks(log)); assert log.count("weekly") == 1               # Monday
    ar.main(db, at(25, 21), tasks(log)); assert log.count("weekly") == 2               # next Sunday
