# 2026-10-22 log sweep: small bounties spawn, late registration skips breaking tables, Spin sweep and Hand History read by index

Found by a production sweep of the database logs on 2026-10-22. Each is
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

## 3. The Spin sweep timed out about four times an hour

- **Symptom.** `fn_spin_sweep_unbooked` hit the 8 s statement timeout all day,
  inside `fn_poker_diamond_tournament`.
- **Cause.** Its candidate scan filters `COALESCE(started_at, created_at)`, on
  purpose, but the index built for it is on `started_at` alone, so every call
  walked all 479,125 RUNNING/COMPLETED Spins (1.29 s warm, past 8 s cold).
- **Fix.** Migration `20261022191059`: a partial index on that exact
  expression, built concurrently. The scan is an index scan at 0.20 s. No
  function or row changed.

## 4. Hand History timed out for players with few hands

- **Symptom.** About five `57014` statement timeouts an hour on
  `hand_history?players=cs.[...]&order=hand_number.desc&limit=25`, from the
  cross-table Hand History page, for players with fewer retained hands than
  the page asked for (a 0-hand account: TIMEOUT after 30 s as `authenticated`).
- **Cause.** Under the `hand_history_authenticated_select` RLS policy the
  planner answers that read by walking the global `hand_number` index
  backwards and filtering every row. A player whose 25th hand does not exist
  makes it read the whole table. The client's seed/floor shortcut only applied
  when the player already had enough indexed hands, so it never helped them.
- **Fix.** Migration `20261022191846` adds
  `fn_player_hand_history_page_ids(user, limit, offset)`, security invoker, so
  RLS is still the door. It bounds the read by what the player has: a floor
  from their own `ca_hand_player_idx` rows when they have enough, otherwise
  their whole (small) history through the players GIN index. The page then
  resolves those ids through `getHandsByIds` and the one column list.
- **Proof.** As `authenticated`: 0 hands 0.019 s, 339 hands 0.036 s (offset
  300: 0.224 s), 57k hands 0.012 s (offset 300: 0.093 s). Pages are identical
  to the original read, id for id.
- **Pin.** `tests/unit/handArchiveIndexedRead.test.ts`.

## 5. The Spin sweep still timed out on its 14-day pass

- **Symptom.** After section 3 the sweep still hit 8 s once every quarter hour.
- **Cause.** `/api/cron/spin-sweep` asks with a 14-day lookback, and both
  scans evaluated `fn_poker_diamond_tournament` inside the index scan for every
  Spin in the window: 192,835 calls to find zero unbooked games, 6.8 s a scan.
- **Fix.** Migration `20261022193319`: the cheap predicates and the reserve
  ledger anti-join run first in a materialized CTE, so the Diamond and entrant
  tests run only for unbooked Spins. Same rows, order, limit and result.
  Measured 1.3 s for the same window.

## 6. Horses were sent to tournaments they had no wallet to pay for

- **Symptom.** 966 refusals a day, "player ... has no active wallet at club
  e14bc9f7" (Lightning Internal Pilot, Daily 25 Chip Freezeout), from
  `fn_register_horse_for_tournament`.
- **Cause.** The engine's bankroll gate reads wallets with status active or
  approved. A suspended member has no such row, and the gate treated that
  absence as "unread" and let the horse through, so the database refused the
  entry exactly as it refuses a human with no active wallet.
- **Fix.** `TournamentRecurringService.pickFreeHorses`: on a complete read, a
  horse with no active wallet row in the charged clubs is not offered the
  seat. Same rule a human meets. Fail-open is unchanged for an incomplete page,
  a thrown read, or an unreadable balance. Engine change: ships with the daily
  04:00 Chicago release.
- **Pin.** `server/src/services/HorseTournamentBankroll.test.ts`.

## 7. A placeholder id was sent to the balance RPC

- **Symptom.** `invalid input syntax for type uuid: "guest"` from
  `fn_player_spendable_balance`, 28 a day, each retried five times.
- **Cause.** The table page holds the `'guest'` placeholder until its player
  resolves, and `readPlayerBalance` sent whatever it was given.
- **Fix.** `WalletService.readPlayerBalance` answers "unknown" (its documented
  failure value) for any id that is not a UUID, without asking the server.
- **Pin.** `tests/unit/BalancesComeFromTheLivePool.test.ts`.
