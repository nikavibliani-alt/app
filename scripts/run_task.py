"""Run one after-run task by hand: python scripts/run_task.py <scorecard|twin|twin_compare|weekly|history> <true|false = dry>"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def main(task, dry):
    flag = ["--dry"] if str(dry).lower() == "true" else []
    if task == "scorecard":
        import scorecard_job as m
        return m.main(flag)
    if task == "history":
        import pmslog_daily as m
        return m.main(flag)
    if task == "twin":
        import twin_run as m
        return m.main(flag)
    if task == "twin_compare":
        import twin_run as m
        return m.compare(dry=bool(flag))
    if task == "weekly":
        import weekly_review as m
        return m.main(flag + ["--no-send"])
    if task == "weekly_show":
        import weekly_show as m
        return m.main()
    if task == "manual_probe":
        import manual_probe as m
        return m.main()
    if task == "seasons_migrate":
        import seasons_migrate as m
        return m.main(flag)
    if task == "alert_probe":
        import alert_probe as m
        return m.main()
    if task == "weekly_probe":
        import weekly_probe as m
        return m.main()
    if task == "push_probe":
        import push_probe as m
        return m.main()
    if task == "night_probe":
        import night_probe as m
        return m.main()
    if task == "res_probe":
        import res_probe as m
        return m.main()
    if task == "window_probe":
        import window_probe as m
        return m.main()
    if task == "last_days_probe":
        import last_days_probe as m
        return m.main()
    if task == "small_rooms_probe":
        import small_rooms_probe as m
        return m.main()
    if task == "release_nights":
        import release_nights as m
        return m.main(flag)
    if task == "xcv_now_probe":
        import xcv_now_probe as m
        return m.main()
    if task == "three_weeks_probe":
        import three_weeks_probe as m
        return m.main()
    if task == "three_weeks_probe2":
        import three_weeks_probe2 as m
        return m.main()
    if task == "bigmoves_probe":
        import bigmoves_probe as m
        return m.main()
    if task == "reservations_repair":
        import reservations_repair as m
        return m.main(flag)
    if task == "vis_probe":
        import vis_probe as m
        return m.main()
    if task == "orbe2_test":
        import orbe2_test as m
        return m.main(flag)
    if task == "orbe2_test_undo":
        import orbe2_test as m
        return m.main(flag + ["--undo"])
    if task == "xcv_test_mark":
        import xcv_test_mark as m
        return m.main(flag)
    if task == "new_listing_probe":
        import new_listing_probe as m
        return m.main()
    if task == "raise_audit":
        import raise_audit as m
        return m.main()
    if task == "raise_audit2":
        import raise_audit2 as m
        return m.main()
    if task == "raise_audit3":
        import raise_audit3 as m
        return m.main()
    if task == "ideas_cleanup":
        import ideas_logic_cleanup as m
        return m.main(flag)
    raise SystemExit(f"unknown task {task}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "true")
