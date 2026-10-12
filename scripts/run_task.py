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
    raise SystemExit(f"unknown task {task}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "true")
