# Pricing plan

Steps (work one at a time, in order):

- Step 0
- Step 1
- Step 2a
- Step 2b
- Step 3
- Step 4
- Step 5
- Step 6
- Step 7

## Progress log

- 2026-10-08, step 2a: plain `pricing_engine.py` run (no --apply) now writes nothing anywhere (write guard, no event scan, no Claude call, no email); `--report` prints a row per room type and date; `pricing_config/control` paused switch added (engine and pricing.html). Proof: read-only check `dryrun`.
- 2026-10-08, step 2b: Claude analyst auto-apply off (all proposals pending, never writes rules; null or non-numeric values skip that proposal); engine writes no prices when Firestore or booking velocity cannot be read (logs the error, exits 1); null or missing min/max/start in pricing_config/rules is ignored instead of becoming 0; pricing_engine.yml gets a concurrency group (no schedule).
