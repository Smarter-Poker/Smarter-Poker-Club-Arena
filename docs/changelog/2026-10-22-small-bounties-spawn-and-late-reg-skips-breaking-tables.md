# The small Sunrise/Midnight bounties spawn again; late registration skips tables being broken

Found by a production sweep of the database logs on 2026-10-22. Both are
fixed at the line that produced the wrong outcome (CLAUDE.md 10.11/10.12): no
repair job, no sweep, no new cron.

## 1. The 5-dollar Sunrise and Midnight Bounty had stopped spawning

- **Symptom.** Since 2026-10-20 the database refused every spawn of the two
  small Midway fixed-bounty events: 244 refusals an hour, "whole-dollar buy-in
  rule: buy_in_amount (5.00) + buy_in_fee (0.50)". No occurrence existed for
  Oct 24 or later; their 50-dollar twins kept spawning.
- **Cause.** Two written rules disagreed. The 2026-08-20 whole-dollar rule is
  enforced by `trg_whole_dollar_buyin` on `tournaments`. The later explicit
  owner exception of 2026-10-20 (`2026-10-20-midway-rebuy-addon-coverage.md`)
  makes Sunrise and Midnight a 5.50 entry (2 bounty + 3 prize contribution +
  0.50 fee), and `midwayStructurePolicy.ts` writes 5.00 + 0.50 at spawn. The
  trigger was never taught the exception. The later owner instruction governs
  (10.8).
- **Fix.** Migration `20261022190328`: `fn_enforce_whole_dollar_buyin` admits
  exactly that split for exactly those two Midway fixed-bounty MTTs; every
  other non-whole total is still refused. Fee 0.50 / 5.50 = 9.09%, inside the
  10% cap.
- **Proof.** Within 20 seconds of install the scheduler created the four
  missing occurrences (Midnight Oct 24 and 25 05:00 UTC, Sunrise Oct 24 and 25
  13:00 UTC) at 5.00 + 0.50 with a 2.00 bounty; refusals stopped at 19:02 UTC.
- **Pin.** `tests/the-small-midway-bounties-spawn.test.ts` holds the engine
  policy and the newest trigger definition to the same names and split.

## 2. Late registration was refused onto a table the balancer was breaking

- **Symptom.** A player tried to late-register for Coffee Break Freeroll (PLO4)
  16 times between 16:37 and 16:40 UTC, inside its open window, and got HTTP
  500 each time (`F06_SOURCE_EXCLUDED`). 85 such refusals in the day. No money
  moved (freeroll; the registration transaction rolled back whole).
- **Cause.** `fn_seat_late_registrant_before_maintenance_gate` seats a late
  entrant at the fullest running table with a free chair. A table that is the
  source of a non-terminal F06 break always has free chairs, so the chooser
  preferred it, and `f06_source_guard` correctly refused the write.
  `fn_ensure_late_registration_capacity` counted those same chairs as open
  capacity, so it would not open a new table either.
- **Fix.** Migration `20261022190338` adds one predicate to each function:
  skip a table that is the `source_table_id` of an F06 operation whose state is
  not `acknowledged` or `withdrawn_before_manifest` - the exact test the guard
  uses, served by the partial unique index `f06_one_source`. The guard is
  unchanged.
- **Checked.** Every non-terminal F06 operation still on file belongs to a
  COMPLETED or CANCELLED event, so no live table is excluded by a stale one.
