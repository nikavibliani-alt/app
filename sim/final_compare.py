import sys, json; sys.path.insert(0,'.')
from sim.simulate import simulate, CalmEngine, OldEngine
ORIG = ["ROOMS","MAXELA","BIG_APT","FREEDOM","ORBE_1","ORBE_2"]
EV = {d: 0.35 for d in ["2026-12-11","2026-12-12","2027-01-15","2027-01-16","2027-02-05","2027-02-06"]}
SCEN = {"normal": {"level": 1.0}, "weak": {"level": 0.88}, "strong": {"level": 1.12}, "events": {"level": 1.0, "events": EV}}
ENG = {"current": (lambda a,b,c: OldEngine(a,b,c), None),
       "new_your_max": (lambda a,b,c: CalmEngine(a,b,c), None),
       "new_max25": (lambda a,b,c: CalmEngine(a,b,c), 0.25)}
KEYS = ["occupancy","revenue","adr","changes_per_date","max_one_day_move","flip_flops","lowered_on_arrival_day","below_min_or_wild","far_date_moves_over_band","alerts"]
out = {}
for sn, sc in SCEN.items():
    for en, (fac, widen) in ENG.items():
        rows=[simulate(fac, sc, seed=s, days=150, room_filter=ORIG, measure_from=60, widen_max=widen) for s in (1,2,3,4,5)]
        avg={k: sum(r[k] for r in rows)/len(rows) for k in KEYS}
        avg["revenue_by_seed"] = [round(r["revenue"]) for r in rows]
        out.setdefault(sn,{})[en]=avg
        print(sn, en, {k: round(v,3) for k,v in avg.items() if k!="revenue_by_seed"}, flush=True)
json.dump(out, open("sim/final_results.json","w"), indent=1)
