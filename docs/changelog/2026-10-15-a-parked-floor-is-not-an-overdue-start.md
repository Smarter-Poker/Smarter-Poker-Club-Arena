# A Parked Floor Is Not An Overdue Start (2026-10-15)

Tournament hardening, phase 7 of 8. Migration `20261015182553_a_parked_floor_is_not_an_overdue_start_and_the_verified_aler.sql`.

## Launch Health And A Deliberate Owner Park

- Dan's operation `3d9c1ba1` (Owner Horse Wallet Reset) parked the floor of all seven clubs from 16:53 UTC, was renewed once at 17:41 when a maintenance freeze interrupted the reset, and ended with his resume `b930a4a2` at 18:10:56.
- A scoped park holds every tournament in its scope by design. The Friday Night Feature Satellite and the two 17:00 MTTs stayed in REGISTERING until the resume and started at 18:20. Every event before 16:51 started on time that day.
- `fn_ca_launch_health` read the three held events as `start_overdue` and turned the launch red.
- **Fix.** A start the operator floor is holding, or released less than 15 minutes ago, is listed under `held_by_operator` and does not colour the area. Any other late start is still red. New helper `fn_ca_launch_health_tournament_held(club, union)` is a pure STABLE read with no advisory lock.

## The Floor Hold Watchdog And Deleted Tables

- The park's `close_cash` operation `fb484cc1` closed 134 cash tables. 125 received their resume receipt at 18:10:56; the other 9 had been deleted after they closed.
- `fn_ca_launch_cash_close_resumed` joins `public.tables`, so it can never be true for a deleted table, and the watchdog's close step waited for those 9 for ever. Its alert `1af6c215` could not close.
- **Fix.** The close step only waits for closes whose table still exists. A close row for a deleted table cannot refuse a seat.

## Alerts And Incidents Closed On Their Verified Causes

| Item | Cause | Assertion |
| --- | --- | --- |
| Guard drift `7e831a2c` / `38fd1e96` | `fn_ca_raise_drift_incident` changed by migration `20261015024752` (PR #6978, merged and installed) | Live hash `b5025fd1`, migration installed, history row 55885 matches |
| Ledger refusal `56b271f4` / `67c3926b` | `fn_seed_horses_to_floor` read horse wallets twice without a lock; the guard refused and rolled back `20261015053941`; root fixed by `20261015093554` (PR #6930) | Wallet lock present, refused file not installed, no refusal since, treasury equals its ledger net under the club row lock |
| Spin fairness `3e617549` / `f5714015` / `ba5d559f` | A tail of an hourly sliding 7 day window; the draw is fair | 42 days of unlocked at-draw receipts: chi-square under 18.475 (13.05 measured) over at least 250,000 draws (271,422), one ladder equal to `spin_tier_spec`, zero off-ladder |
| Floor hold `1af6c215` / `95ae599f` / `62cc056f` | Dan's deliberate park, ended by his own resume | No hold remains, resume present, every live close resumed |

## Open Item On The Spin Detector

The 7 day reading was still above the p 0.001 line when this shipped (chi-square about 27 over 88,399 draws at 18:30 UTC, driven by 25x and 50x from Oct 9 to 13). `fn_spin_fairness_check` raises its critical verdict from one sliding window with no independent confirmation, so it can raise the same tail again until those days leave the window (expected Oct 16 to 20). The detector is not changed here.

Law: `tests/a-parked-floor-is-not-an-overdue-start.law.test.ts`.
