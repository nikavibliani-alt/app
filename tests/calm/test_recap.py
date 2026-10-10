"""Pure helpers of the read-only recap check (scripts/pricing_recap.py)."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "scripts"))
import pricing_recap as rc  # noqa: E402


def test_after_reset_steps_back_over_a_later_move():
    daily = {"XCV_1": {"2026-12-10|GEL": {"kind": "move", "virtual_before": 150, "mh": 150, "new": 155},
                       "2026-12-11|GEL": {"kind": "hold", "mh": 160, "new": 160},
                       "2026-12-12|GEL": {"kind": "reset", "mh": 200, "new": 170},
                       "2026-12-13|GEL": {"kind": "hold", "mh": 0, "new": 0}}}
    out = rc.after_reset_prices(daily)
    assert out == {("XCV_1", "2026-12-10", "GEL"): 150.0, ("XCV_1", "2026-12-11", "GEL"): 160.0,
                   ("XCV_1", "2026-12-12", "GEL"): 170.0}


def test_month_table_and_biggest_moves():
    before = {("XCV_1", "2026-12-10", "GEL"): 150, ("XCV_1", "2026-12-11", "GEL"): 160, ("XCV_1", "2027-01-01", "GEL"): 100}
    now = {("XCV_1", "2026-12-10", "GEL"): 160, ("XCV_1", "2026-12-11", "GEL"): 160}
    rows = rc.month_table(before, now)
    assert rows == [("XCV_1", "GEL", "2026-12", 2, 155.0, 160.0, 1)]
    mv = rc.biggest_moves(before, now)
    assert len(mv) == 1 and mv[0][1:4] == ("XCV_1", "2026-12-10", "GEL") and round(mv[0][0], 1) == 6.7


def test_shadow_distance_skips_full_dates():
    d = {"2026-10-10|GEL": {"mh": 100, "new": 110, "avail": 1}, "2026-10-11|GEL": {"mh": 100, "new": 100, "avail": 1},
         "2026-10-12|GEL": {"mh": 100, "new": 50, "avail": 0}}
    st = rc.shadow_distance(d)["GEL"]
    assert st["n"] == 2 and st["same"] == 1 and st["avg"] == 5.0 and st["max_abs"] == 10.0


def test_run_days_counts_lowering_runs():
    runs = [{"ts": "2026-10-09T16:03", "main_run": False}, {"ts": "2026-10-10T09:03", "main_run": True},
            {"ts": "2026-10-10T13:03", "main_run": False}]
    assert rc.run_days(runs) == {"2026-10-09": (1, 0), "2026-10-10": (2, 1)}


def test_reservation_rows_use_no_names_and_split_cancellations():
    docs = [{"roomCode": "xcv-1", "checkin": "2026-12-20", "nights": 3, "source": "booking.com", "status": "OK",
             "debit": 450, "currency": "GEL", "creationDate": "2026-10-09", "guest": "SECRET", "reservationNumber": "123"},
            {"roomCode": "vgl-st1", "checkin": "2026-11-01", "nights": 2, "source": "airbnb", "status": "CL",
             "debit": 0, "currency": "USD", "creationDate": "2026-10-10"},
            {"roomCode": "xcv-2", "checkin": "2026-11-01", "nights": 1, "status": "OK", "creationDate": "2026-10-08"}]
    out = rc.reservation_rows(docs, {"xcv-1": "XCV_1", "vgl-st1": "VGL_ST", "xcv-2": "XCV_2"}, "2026-10-09")
    assert out["new"] == [("XCV_1", "2026-12-20", 3, "booking.com", "150 GEL", "OK", "2026-10-09")]
    assert out["cancelled_new"][0][0] == "VGL_ST" and out["cancelled_new"][0][4] == "not stored"
    assert "SECRET" not in str(out) and "123" not in str(out)
