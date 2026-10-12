import importlib.util
import json
import os
import sys
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
spec = importlib.util.spec_from_file_location("weekly_review", os.path.join(ROOT, "scripts", "weekly_review.py"))
wr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wr)

import weekly_ai as ai  # noqa: E402
import weekly_numbers as wn  # noqa: E402
from test_pmslog import DB  # noqa: E402

FROM, TO = "2026-10-06", "2026-10-12"


def ev(rt, date, day, old, new, kind="move", days_out=10, written=True, **kw):
    return {"rt": rt, "date": date, "day": day, "old": old, "new": new, "kind": kind, "days_out": days_out, "written": written, "min": 100, "max": 200, **kw}


def sample():
    pe = [ev("M", "2026-10-20", "2026-10-07", 150, 140), ev("M", "2026-10-21", "2026-10-08", 140, 150), ev("M", "2026-10-22", "2026-10-09", 120, 100),
          ev("M", "2026-10-13", "2026-10-12", 130, 110, days_out=1, kind="move"),
          ev("M", "2026-10-12", "2026-10-12", 160, 100, kind="tonight", days_out=0),
          ev("M", "2026-10-13", "2026-10-12", 160, 130, kind="tonight", days_out=1),
          ev("M", "2026-10-30", "2026-10-10", 150, 150, written=False, blocked=["Protected by your date rule", "kept by hold"]),
          ev("M", "2026-09-01", "2026-09-01", 1, 2)]                                                   # last week: not counted
    stays = [{"rt": "M", "checkin": "2026-10-12", "checkout": "2026-10-13", "created": "2026-10-12", "per_night": 100.0, "currency": "GEL"},
             {"rt": "M", "checkin": "2026-10-13", "checkout": "2026-10-15", "created": "2026-10-12", "per_night": 130.0, "currency": "GEL"},
             {"rt": "M", "checkin": "2026-10-01", "checkout": "2026-10-03", "created": "2026-09-20", "per_night": 90.0, "currency": "GEL"}]
    return {"price_events": pe, "booking_events": [{"rt": "M", "day": "2026-10-09", "event": "cancellation"}, {"rt": "M", "day": "2026-10-10", "event": "booking"},
                                                                                                      {"rt": "M", "day": "2026-10-12", "event": "cancellation"}],
            "runs": [{"day": "2026-10-07", "failed_portals": ["EXPEDIA"]}, {"day": "2026-10-08", "failed_portals": []}, {"day": "2026-10-09", "urgent": True, "stopped_room_types": ["M"]}],
            "watchdog_days": {"2026-10-07": "red", "2026-10-08": "green"}, "stays": stays, "limits": lambda rt, n: (150, 100, 200),
            "scorecard": {"finished": 14, "right": 9, "wrong": 3, "unclear": 2, "tracking": 1}, "twin_results": [{"status": "final", "diff_pct": -10}, {"status": "final", "diff_pct": 20}],
            "events": [{"status": "approved", "date": "2026-10-20"}, {"status": "pending", "date": "2026-12-01"}], "room_ids": ["M", "N"], "since": "2026-10-09"}


def test_numbers_count_the_week_only_and_are_exact():
    n = wn.build(sample(), FROM, TO)
    m = n["rooms"]["M"]
    assert n["property_id"] == "maxela" and n["week"] == {"from": FROM, "to": TO, "key": "2026-W42"}
    assert m["price_up"] == 1 and m["price_down"] == 5                    # 140->150 up; 150->140, 120->100, 130->110, 160->100, 160->130 down
    assert m["nights_hit_min"] == 2 and m["nights_hit_max"] == 0         # 100 on 22 Oct and on 12 Oct
    assert m["last3_drops"] == 1 and m["last3_drops_sold"] == 1          # 13 Oct dropped to 110 on 12 Oct and was booked that day
    assert (m["cancel_drops_tonight"], m["cancel_drops_tonight_sold"], m["cancel_drops_tomorrow"], m["cancel_drops_tomorrow_sold"]) == (1, 1, 1, 1)
    assert m["blocked_by_protect"] == 1 and m["blocked_by_hold"] == 1 and m["blocked_other"] == 0
    assert m["bookings"] == 1 and m["cancellations"] == 1 and m["bookings_made"] == 2 and m["nights_sold"] == 3
    assert m["avg_sold_price_gel"] == 120 and m["avg_start_gel"] == 150 and m["avg_min_gel"] == 100 and m["avg_max_gel"] == 200
    assert m["sold_at_or_near_min"] == 1 and m["sold_at_or_near_max"] == 0
    a = n["all"]
    assert a["runs"] == 3 and a["urgent_runs"] == 1 and a["channel_push_failures"] == {"EXPEDIA": 1} and a["runs_with_stopped_rooms"] == 1
    assert a["watchdog_red_days"] == 1 and a["watchdog_days_recorded"] == 2
    assert a["ideas"] == {"finished": 14, "right": 9, "wrong": 3, "unclear": 2, "tracking": 1}
    assert a["twin"]["finished"] == 2 and a["twin"]["avg_difference_pct"] == 5
    assert a["events"] == {"saved": 2, "approved": 1, "in_the_next_14_days": 1}
    assert n["rooms"]["N"]["nights_sold"] == 0 and any("watchdog result was recorded for 2 of 7" in x for x in n["data_notes"])


def test_thin_data_is_said_not_hidden():
    n = wn.build({"room_ids": ["M"], "since": "2026-10-12"}, FROM, TO)
    notes = " ".join(n["data_notes"])
    assert "only exists since 2026-10-12" in notes and "No idea has finished" in notes and "No bookings were made" in notes


def test_number_check_catches_numbers_that_are_not_in_the_data():
    n = wn.build(sample(), FROM, TO)
    assert wn.unsupported_numbers("Prices went down 5 times and up 1 time on 12 Oct 2026; 120 ₾ on average; last 3 days", n) == []
    assert wn.unsupported_numbers("Prices went down 17 times and the average was 333 ₾", n) == ["17", "333"]


class Fake:
    """A fake Claude client: each call returns the next scripted reply."""
    def __init__(self, *replies):
        self.replies = list(replies)
        self.calls = []
        self.messages = self

    def create(self, **kw):
        self.calls.append(kw)

        class B:
            text = json.dumps(self.replies.pop(0))

        class M:
            content = [B()]
        return M()


def draft():
    return {"headline": "A quiet week with 5 price drops.",
            "worked": [{"text": "Cancellation drops tonight sold: 1 of 1.", "refs": ["rooms.M.cancel_drops_tonight_sold"]},
                       {"text": "Prices rose 42 times, a record.", "refs": ["rooms.M.price_up"]}],
            "didnt": [{"text": "The Expedia push failed 1 time.", "refs": ["all.channel_push_failures.EXPEDIA"]}],
            "upgrades": [{"text": "Check why Expedia failed (1 failure).", "refs": ["all.channel_push_failures"]},
                         {"text": "Invented claim without numbers about the future.", "refs": []}]}


def test_checker_removes_unsupported_claims_and_the_number_check_backs_it_up():
    n = wn.build(sample(), FROM, TO)
    check = {"headline": {"verdict": "yes"}, "items": [
        {"id": "worked.0", "verdict": "yes"}, {"id": "worked.1", "verdict": "yes"},                    # checker wrongly says yes to 42: the number check removes it
        {"id": "didnt.0", "verdict": "yes"}, {"id": "upgrades.0", "verdict": "partly", "fixed_text": "Check why Expedia failed."},
        {"id": "upgrades.1", "verdict": "no", "note": "made up"}]}
    out = ai.apply_check(n, draft(), check)
    assert [i["text"] for i in out["worked"]] == ["Cancellation drops tonight sold: 1 of 1."]
    assert out["didnt"][0]["text"] == "The Expedia push failed 1 time."
    assert [i["text"] for i in out["upgrades"]] == ["Check why Expedia failed."] and out["edited"] == 1
    assert {r["id"] for r in out["removed"]} == {"worked.1", "upgrades.1"}
    assert "42" in [r for r in out["removed"] if r["id"] == "worked.1"][0]["why"]
    assert out["headline"] == "A quiet week with 5 price drops."


def test_no_checker_answer_means_nothing_is_trusted():
    n = wn.build(sample(), FROM, TO)
    out = ai.apply_check(n, draft(), None)
    assert out["worked"] == out["didnt"] == out["upgrades"] == [] and len(out["removed"]) == 5 and "could not be confirmed" in out["headline"]


def test_two_separate_calls_and_failures_never_crash():
    n = wn.build(sample(), FROM, TO)
    a, c = Fake(draft()), Fake({"headline": {"verdict": "yes"}, "items": [{"id": "worked.0", "verdict": "yes"}]})
    out = ai.review(n, "key", a, c)
    assert len(a.calls) == 1 and len(c.calls) == 1 and a is not c and out["checked"] and len(out["worked"]) == 1
    assert "NUMBERS" in c.calls[0]["messages"][0]["content"] and "REPORT" in c.calls[0]["messages"][0]["content"]
    assert "NUMBERS" in a.calls[0]["messages"][0]["content"] and "REPORT" not in a.calls[0]["messages"][0]["content"]

    class Boom:
        messages = None

        def __init__(self):
            self.messages = self

        def create(self, **kw):
            raise RuntimeError("down")
    assert ai.review(n, "k", Boom(), Boom())["worked"] == []
    out = ai.review(n, "k", Fake(draft()), Boom())
    assert out["checked"] is False and out["error"].startswith("checker failed") and out["worked"] == []


def test_runner_saves_one_report_per_week_and_sends_one_whatsapp(monkeypatch):
    db = DB()
    for e in sample()["price_events"][:3]:
        db.collection("pmslog_price_events").document(f"{e['day']}_{e['date']}").set({**e, "property_id": "maxela"})
    sent = []
    now = datetime(2026, 10, 12, 21, 0)
    monkeypatch.setattr(wn, "load", lambda db, now: (sample(), FROM, TO))
    kw = dict(db=db, now=now, send=lambda to, msg: (sent.append(msg), True)[1], env={"ANTHROPIC_API_KEY": "k"})
    r = wr.main([], analyst_client=Fake(draft()), checker_client=Fake({"headline": {"verdict": "yes"}, "items": [{"id": "worked.0", "verdict": "yes"}]}), **kw)
    doc = db.store["pricing_weekly"]["2026-W42"]
    assert doc["property_id"] == "maxela" and doc["ai_calls"] == 2 and doc["report"]["checked"] and doc["whatsapp"]
    assert sent == ["Weekly pricing report is ready. https://app.maxelaapartments.com/pricing-v2.html#/weekly"]
    wr.main([], analyst_client=Fake(draft()), checker_client=Fake({"headline": {"verdict": "yes"}, "items": []}), **kw)
    assert len(sent) == 1                                                            # same week: no second message
    d = wr.main(["--dry"], **kw)
    assert "numbers" in d
    wr.main(["--no-send"], db=DB(), now=now, send=lambda *a: sent.append("x"), env={})
    assert len(sent) == 1
