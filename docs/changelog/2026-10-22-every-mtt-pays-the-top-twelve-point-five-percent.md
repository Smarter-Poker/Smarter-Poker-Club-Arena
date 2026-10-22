# Every MTT Pays The Top 12.5% Of The Field (2026-10-22)

Dan, 2026-10-21: "STARTING TOMORROW ALL MTT TOURNAMENTS MUST PAY OUT THE TOP 12.5% OF THE FIELD. ANYTHING LESS IS WRONG. CORRECT THIS AND MAKE SURE ALL FUTURE TOURNAMENTS HAVE THIS IMPLEMENTED. (STAND ALONE CLUBS CAN SET IT TO WHAT EVER THEY WANT, BUT THE DEFAULT SHOULD BE 12.5%)"

## What Was Wrong

Every MTT paid `ceil(field * payout_percent / 100)` places, with `payout_percent` a smallint restricted to 10, 15 or 20, and every live event held 10. 12.5 could not be stored, and changing that column's type rewrites a 1.25 GB hot table under ACCESS EXCLUSIVE.

## What Changed (Production, Applied And Verified)

- `20261022014607`: metadata-only column `tournaments.payout_depth_percent numeric(5,2)`, range (0, 100]. Trigger `ca_mtt_payout_depth_guard` (BEFORE INSERT OR UPDATE OF payout_depth_percent, payout_percent) is the single authority for every write path:
  - Midway, any union and Diamond Arena MTTs: 12.5, always.
  - Standalone club MTTs: the club's choice; 12.5 when none. A legacy explicit 15 or 20 in `payout_percent` is honoured; legacy 10 was the old default.
  - Satellites, Spins and Sit & Gos: NULL, untouched.
  - A finalized prize pool freezes the depth.
  
  Both ladder builders (`fn_finalize_tournament_entry_pool_locked`, `fn_ca_fund_overlay_on_lock`) read `fn_ca_effective_payout_depth(payout_depth_percent, payout_percent)` through md5-pinned substitutions. `fn_create_tournament` persists a requested depth, the Diamond creator parses `payoutPercent` tolerantly and the welcome package sends 12.5.
- `20261022014651`: DML only. Every live uncommitted MTT moved to 12.5.
- `20261022021443`: declares the trigger in `ca_declared_money_triggers`.

All three files are byte-exact recordings registered in `scripts/ci/recorded-migrations.manifest.json`.

## Code

Spawners, recurring templates, Free Buy and restart clones write `payout_depth_percent` (legacy `payout_percent` stays 10/15/20). Creator forms default to 12.5 and offer 12.5, 10, 15 and 20. Law: `tests/every-mtt-pays-the-top-twelve-point-five-percent.law.test.ts`.

## Paid Places At 12.5%

| Field | Paid |
| --- | --- |
| 8 | 1 |
| 9 | 2 |
| 17 | 3 |
| 45 | 6 |
| 100 | 13 |
| 137 | 18 |
