import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import idea_scorecard as sc  # noqa: E402
from test_pmslog import DB  # noqa: E402

TODAY = "2026-12-05"
NIGHTS = sc.nights_between("2026-11-01", "2026-11-20")            # 20 nights


def idea(status="rejected", cur=100, sug=90, reason=None, empty=None, to="2026-11-20", made="2026-10-20"):
    p = {"id": "i1", "property": "XCV_2", "season": "mid", "type": "startPrice", "current": cur, "suggested": sug, "status": status,
         "date": made, "evidence": {"made_on": made, "looked_at": {"from": "2026-11-01", "to": to, "nights": 20}, "empty": empty if empty is not None else NIGHTS}}
    if reason:
        p["rejection_reason"] = reason
    return p


def stays(n, created="2026-10-25", price=120.0):
    """n one-night bookings of XCV_2, one per night from 1 Nov."""
    return [{"rt": "XCV_2", "checkin": NIGHTS[i], "checkout": sc.nights_between(NIGHTS[i], NIGHTS[i])[0] and NIGHTS[i + 1] if i + 1 < len(NIGHTS) else "2026-11-21",
             "created": created, "per_night": price, "currency": "GEL"} for i in range(n)]


def test_skipped_lower_idea_that_sold_anyway_is_wrong_with_real_numbers():
    c = sc.judge(idea(), stays(18), TODAY)
    assert c["status"] == "final" and c["verdict"] == "wrong" and c["decision"] == "skipped" and c["property_id"] == "maxela"
    assert "18 of 20 nights" in c["reason"] and "anyway" in c["reason"] and "1–20 Nov 2026" in c["reason"] and c["reason"].endswith("→ Wrong")
    assert "You skipped it" in c["reason"] and "(average 120 ₾ a night)" in c["reason"]


def test_skipped_lower_idea_that_stayed_empty_is_right_and_applied_lower_that_filled_is_right():
    assert sc.judge(idea(), stays(4), TODAY)["verdict"] == "right"
    c = sc.judge(idea(status="approved"), stays(17), TODAY)
    assert c["verdict"] == "right" and c["decision"] == "applied"
    assert sc.judge(idea(status="approved"), stays(5), TODAY)["verdict"] == "wrong"


def test_raise_ideas_and_the_unclear_middle():
    assert sc.judge(idea(cur=100, sug=110), stays(18), TODAY)["verdict"] == "right"            # skipped raise, room sold well
    assert sc.judge(idea(cur=100, sug=110), stays(3), TODAY)["verdict"] == "wrong"
    assert sc.judge(idea(cur=100, sug=110, status="approved"), stays(18), TODAY)["verdict"] == "right"
    assert sc.judge(idea(), stays(12), TODAY)["verdict"] == "unclear"                         # 60%: neither


def test_replaced_is_followed_like_skipped():
    c = sc.judge(idea(reason=sc.REPLACED), stays(18), TODAY)
    assert c["decision"] == "replaced" and c["verdict"] == "wrong" and "A newer idea replaced it" in c["reason"]


def test_too_few_nights_and_no_stays_are_unclear_and_bookings_made_before_the_idea_do_not_count():
    few = sc.judge(idea(empty=NIGHTS[:3]), stays(3), TODAY)
    assert few["verdict"] == "unclear" and "too few" in few["reason"]
    assert sc.judge(idea(), [], TODAY)["verdict"] == "unclear"
    old = sc.judge(idea(), stays(18, created="2026-10-01"), TODAY)                           # booked before the idea: not an outcome
    assert old["numbers"]["sold"] == 0 and old["verdict"] == "right"


def test_still_running_until_every_night_has_passed_and_no_dates_is_said_plainly():
    c = sc.judge(idea(), stays(18), "2026-11-10")
    assert c["status"] == "tracking" and c["verdict"] is None and c["nights_left"] == 11
    assert sc.judge(idea(), stays(18), "2026-11-20")["status"] == "tracking"                 # the last night is not over yet
    old = idea(); old.pop("evidence")
    assert sc.judge(old, [], TODAY)["status"] == "no_dates"


def test_pending_ideas_are_not_followed_and_summary_counts():
    assert sc.decision_of({"status": "pending"}) is None
    cards = [sc.judge(idea(), stays(18), TODAY), sc.judge(idea(), stays(4), TODAY), sc.judge(idea(), stays(18), "2026-11-10")]
    assert sc.summary(cards) == {"property_id": "maxela", "finished": 2, "right": 1, "wrong": 1, "unclear": 0, "tracking": 1}


def test_runner_saves_cards_keeps_final_verdicts_and_writes_the_summary(monkeypatch):
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "scripts"))
    import importlib.util
    spec = importlib.util.spec_from_file_location("scorecard_job", os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "scripts", "scorecard_job.py"))
    script = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(script)
    db = DB()
    db.collection("pricing_proposals").document("i1").set({k: v for k, v in idea().items() if k != "id"})
    db.collection("pricing_proposals").document("run_2026-10-20").set({"type": "run_marker", "status": "rejected"})
    db.collection("pricing_proposals").document("w1").set({**{k: v for k, v in idea().items() if k != "id"}, "status": "pending"})
    monkeypatch.setattr(sc, "priced_stays", lambda db, today, back_days=460: stays(18))
    s = script.run(db, TODAY, dry=True)
    assert s["finished"] == 1 and "pricing_scorecard" not in db.store
    s = script.run(db, TODAY)
    assert s["wrong"] == 1 and db.store["pricing_scorecard"]["i1"]["verdict"] == "wrong" and db.store["pricing_scorecard"]["_summary"]["finished"] == 1
    monkeypatch.setattr(sc, "priced_stays", lambda db, today, back_days=460: stays(2))
    script.run(db, "2026-12-06")
    assert db.store["pricing_scorecard"]["i1"]["verdict"] == "wrong"                          # a final verdict stays
