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
