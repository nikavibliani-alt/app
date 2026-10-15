import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from calm_pricing import seasons as sn  # noqa: E402
from calm_pricing.config import DEFAULTS, season_of as engine_season  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CONFIG = json.load(open(os.path.join(ROOT, "config.json")))


def test_todays_ranges_copy_over_exactly_and_the_engines_see_no_difference():
    ranges = sn.ranges_from_table(CONFIG["seasons"])
    assert sn.check(ranges) == []                                              # every day exactly one season
    table = sn.engine_table(ranges)
    cfg = {"seasons": table, "date_overrides": []}
    old = {"seasons": CONFIG["seasons"], "date_overrides": []}
    for md in sn.ALL_DAYS:
        day = f"2025-{md}" if md != "02-29" else "2024-02-29"
        assert engine_season(day, cfg) == engine_season(day, old) == sn.season_of(md, ranges), md
    assert DEFAULTS["seasons"] == CONFIG["seasons"]                            # the calm engine's built-in copy is the same today


def test_a_range_can_cross_new_year_and_is_split_for_the_engines():
    ranges = [{"from": "12-28", "to": "01-06", "season": "new_year"}, {"from": "01-07", "to": "12-27", "season": "mid"}]
    assert sn.check(ranges) == []
    table = {t["name"]: t["ranges"] for t in sn.engine_table(ranges)}
    assert table["new_year"] == [["01-01", "01-06"], ["12-28", "12-31"]] and table["mid"] == [["01-07", "12-27"]]
    cfg = {"seasons": sn.engine_table(ranges), "date_overrides": []}
    assert engine_season("2026-12-30", cfg) == "new_year" and engine_season("2027-01-03", cfg) == "new_year" and engine_season("2027-03-03", cfg) == "mid"


def test_gaps_and_overlaps_are_named_in_plain_words():
    base = sn.ranges_from_table(CONFIG["seasons"])
    gap = [r for r in base if r["season"] != "xmas_low"]                        # 1-23 Dec has no season
    assert sn.check(gap) == ["No season for: 1-23 Dec."]
    over = base + [{"from": "05-25", "to": "06-03", "season": "peak"}]         # overlaps High (till 30 Jun)
    msg = sn.check(over)
    assert len(msg) == 1 and "25 May - 3 Jun" in msg[0] and "High and Peak" in msg[0]
    both = [r for r in over if r["season"] != "xmas_low"]
    assert len(sn.check(both)) == 2
    assert sn.check([{"from": "01-01", "to": "12-31", "season": "mid"}, {"from": "03-01", "to": "03-05", "season": "mid"}])[0].startswith("More than one season on: 1-5 Mar")


def test_29_february_is_a_day_too():
    ranges = [{"from": "01-01", "to": "02-28", "season": "low"}, {"from": "03-01", "to": "12-31", "season": "mid"}]
    assert sn.check(ranges) == ["No season for: 29 Feb."]


def test_bad_data_never_crashes_and_the_readers_fall_back_to_config_json():
    table = CONFIG["seasons"]
    t, src, problems = sn.from_rules({}, table)
    assert t == table and "no saved season dates" in src and problems == []
    for bad in ([{"from": "13-40", "to": "01-02", "season": "low"}], "text",
                [{"from": "01-01", "to": "12-31", "season": "summer"}],
                [{"from": "01-01", "to": "12-31", "season": "low"}, {"from": "03-01", "to": "03-05", "season": "peak"}]):      # an overlap
        t, src, problems = sn.from_rules({"seasonRanges": bad}, table)
        assert t == table and "not valid" in src and problems, bad
    gappy = [{"from": "01-01", "to": "03-02", "season": "low"}, {"from": "03-15", "to": "12-31", "season": "peak"}]      # 3-14 Mar unmarked: allowed
    t, src, problems = sn.from_rules({"seasonRanges": gappy}, table)
    assert [x["name"] for x in t] == ["low", "peak"] and problems == [] and sn.unmarked_text(sn.unmarked(gappy)) == "12 days unmarked: 3-14 Mar"
    t, src, problems = sn.from_rules({"seasonRanges": []}, table)                                                     # everything unmarked: valid, all Mid
    assert t == [] and problems == [] and src == "pricing_config/rules.seasonRanges"
    good = [{"from": "01-01", "to": "06-30", "season": "low"}, {"from": "07-01", "to": "12-31", "season": "peak"}]
    t, src, problems = sn.from_rules({"seasonRanges": good}, table)
    assert [x["name"] for x in t] == ["low", "peak"] and src == "pricing_config/rules.seasonRanges" and problems == []


def test_the_loaders_read_the_saved_list_and_fall_back_to_config_json(tmp_path):
    import pricing_engine as pe
    import pricing_shadow as ps
    from test_pmslog import DB
    good = [{"from": "01-01", "to": "06-30", "season": "low"}, {"from": "07-01", "to": "12-31", "season": "peak"}]
    db = DB()
    db.collection("pricing_config").document("rules").set({"seasonRanges": good})
    rules, settings = ps.load_rules(db, CONFIG)
    assert [s["name"] for s in settings["seasons"]] == ["low", "peak"]
    from calm_pricing import merged
    assert engine_season("2026-08-01", merged(settings)) == "peak"
    cfg = {"seasons": CONFIG["seasons"]}
    assert pe.load_firestore_rules(db, cfg) is None and [s["name"] for s in cfg["seasons"]] == ["low", "peak"]
    db2 = DB()                                                                  # nothing saved yet: config.json
    _, settings2 = ps.load_rules(db2, CONFIG)
    assert settings2["seasons"] == CONFIG["seasons"]
    db3 = DB()
    db3.collection("pricing_config").document("rules").set({"seasonRanges": [{"from": "01-01", "to": "12-31", "season": "low"}, {"from": "02-01", "to": "02-03", "season": "mid"}]})   # overlap: not valid
    _, settings3 = ps.load_rules(db3, CONFIG)
    assert settings3["seasons"] == CONFIG["seasons"] and any("season dates" in w for w in ps.LOADER_WARNINGS)
    db4 = DB()                                                                  # gaps are allowed and the engines use Mid for those days
    db4.collection("pricing_config").document("rules").set({"seasonRanges": [{"from": "01-01", "to": "03-02", "season": "low"}, {"from": "03-15", "to": "12-31", "season": "peak"}]})
    _, settings4 = ps.load_rules(db4, CONFIG)
    assert engine_season("2026-03-08", merged(settings4)) == "mid" and engine_season("2026-03-01", merged(settings4)) == "low"


def test_the_migration_copies_exactly_once():
    import importlib.util
    from test_pmslog import DB
    spec = importlib.util.spec_from_file_location("seasons_migrate", os.path.join(ROOT, "scripts", "seasons_migrate.py"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    db = DB()
    assert m.run(db, CONFIG, dry=True)["written"] is False and "seasonRanges" not in (db.store.get("pricing_config", {}).get("rules") or {})
    assert m.run(db, CONFIG)["written"] is True
    saved = db.store["pricing_config"]["rules"]["seasonRanges"]
    assert sn.engine_table(saved) == sn.engine_table(sn.ranges_from_table(CONFIG["seasons"])) and len(saved) == 9
    assert m.run(db, CONFIG)["written"] is False
