# Diamond Phase 11, line 2: one Diamond cannot be spent twice

**Verdict: line 2 is done.** We raced one player's Diamonds through every door
that can spend them. We delivered the same request twice to every money door.
We killed sessions inside every door at every write, and we crashed the whole
database in the middle of a workload and restarted it. Nothing was overdrawn,
no update was lost, every refusal had a name, nothing happened twice, nothing
was left half done, and the supply identity (players + house + custody =
register) was whole after every case.

All of it ran against production's own door definitions: every function the
cases executed is byte-identical to production's. It ran in an isolated
PostgreSQL 17 that the suite creates and destroys, never against production.
The work found four defects that needed no owner decision. All four are fixed in
production by three migrations, each rehearsed and applied the estate's way.

Programme line: Phase 11 of 12, "Test transfer/store/game concurrency,
duplicate delivery and crash recovery."

## What was found and fixed

1. **A player could not buy into a Diamond cash table at all.** Two guards
   refused the client buy-in. The cash switch is closed in production, so
   nobody had tried.
   - The profile guard (`fn_guard_profile_privileged_columns`) lets a Diamond
     wallet change only from doors it names. It did not name
     `fn_poker_diamond_buyin`, so the reserve's wallet write was refused (42501)
     under a player's token.
   - The arena structure guard (`fn_poker_guard_arena_structure`) compares a
     Diamond table's row before and after, minus its play-state columns.
     `tables` has four stored generated columns (`min_buyin`, `max_buyin`,
     `min_buy_in_bb`, `max_buy_in_bb`), which are NULL in NEW inside a BEFORE
     trigger. So the buy-in's own seat-count update looked like a structure
     change and was refused ("Diamond Games Require Platform Operations").

   Fixed by `20260930121500_a_diamond_cash_buy_in_reaches_the_wallet`: the
   profile guard names the buy-in door, and the arena guard leaves generated
   columns out of its comparison. Blinds, seats and the wallet stay refused.

2. **A player's Diamond registration and the same player's Diamond cash buy-in
   deadlocked.** Two per-player locks guard a seat: the table-cap lock (the
   four-game limit) and the Daily Missions lock on the profile row, which for
   a Diamond player is the wallet. The cash doors took the table cap first. A
   registration took the profile row first and the table cap last, in the
   roster trigger. With five spenders released at once the buy-in died with
   "deadlock detected". The suite then reproduced it deterministically: a
   registration paused inside its reserve, and the same player's buy-in
   arriving meanwhile.

   Fixed by `20260930123828_a_diamond_seat_takes_the_table_cap_before_the_wallet`:
   a Diamond seat acquisition takes the table cap before the Daily Missions
   lock.

3. **That fix, alone, moved the inversion onto chip entries.** It applied only
   to Diamond events. So one player's chip registration (profile row, then
   table cap) and the same player's Diamond registration (table cap, then
   profile row) deadlocked, every time the chip registration was paused as its
   roster row went in. The same chip registration deadlocked with the same
   player's Diamond cash buy-in, a pair older than either migration that only
   the closed cash switch was hiding. Both were measured against production's
   own code before the next fix.

   Fixed by `20260930131333_every_seat_takes_the_table_cap_before_the_wallet`:
   every seat acquisition, chip and Diamond, takes the table cap before the
   Daily Missions lock. Every cash door already took the table cap first. It
   is now the first per-player lock every tournament seat takes as well. A chip
   entry charges, seats and records exactly as before. Only its lock order
   moved.

| Migration                                                             | File md5                           | Rehearsed in production, rolled back                                                                                                                                                                                                                                                                                                               | Applied                               |
| --------------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `20260930121500_a_diamond_cash_buy_in_reaches_the_wallet`             | `5e1404ec1a7a50b8ccf1acd38791b896` | before: "seat count refused by the arena guard (the defect), blinds refused, wallet write refused, identity 0.00 unchanged, switches closed"; after: "seat count admitted, blinds refused, wallet write refused, identity 0.00 unchanged, switches closed"                                                                                         | `APPLIED AND RECORDED 20260930121500` |
| `20260930123828_a_diamond_seat_takes_the_table_cap_before_the_wallet` | `465e4eaed9df290bbc7c398a920f8f43` | before: "a Diamond seat acquisition does not take (the inversion) the table-cap lock"; after: "a Diamond seat acquisition takes the table-cap lock, a non-Diamond one takes none, identity 0.00 unchanged, switches closed"                                                                                                                        | `APPLIED AND RECORDED 20260930123828` |
| `20260930131333_every_seat_takes_the_table_cap_before_the_wallet`     | `23dfd9d01fbab6fb92792301584763d3` | before: "a chip seat acquisition does not (the inversion)"; after: "a Diamond seat acquisition takes the table-cap lock; a chip seat acquisition takes it too, still holds the Daily Missions lock and answers as before; a chip registration is admitted as before (ok, chips, cost 0, one roster row); identity 0.00 unchanged, switches closed" | `APPLIED AND RECORDED 20260930131333` |

Every edit is an asserted substitution on a pinned live md5, with the reverse
substitution proved. Every `@live-proof` expression is true in production. Both
switches stayed closed, and the identity difference was 0 before and after each
migration. Each fixture is one transaction that ends in `RAISE EXCEPTION`, so
nothing it creates survives:

- `concurrency-rehearsal-fixture.sql`, md5 `ffb24bedba2f175d95681f73c3636d76`;
- `lock-order-rehearsal-fixture.sql`, md5 `8cd9f08ca079eddfcb606514b1e3ec4e`;
- `every-seat-lock-order-rehearsal-fixture.sql`, md5
  `04165f4e1edfd4c1ade97a9ce5176fef`.

## How it was tested (re-runnable)

| Evidence                                        | Where                                                                                                                                                                                                        | Command                                                                              | Result                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| The concurrency suite, isolated PostgreSQL 17   | `tests/sql/run-diamond-concurrency.py` with `diamond-concurrency-doors.sql`, its manifest, `diamond-concurrency-schema.sql` and `diamond-concurrency-seed.sql`                                               | `python3 scripts/ci/run-diamond-sql-acceptance.py --only run-diamond-concurrency.py` | 737 checks passed in about 30 seconds; runs in CI on every pull request |
| Rolled-back production rehearsals, one session  | the three fixtures above, in `docs/evidence/diamond-phase-11/`                                                                                                                                               | `rehearse.sh <migration or empty> <fixture> <agent>`                                 | the lines in the table above                                            |
| Laws on the three migration texts               | `tests/a-diamond-cash-buy-in-reaches-the-wallet.law.test.ts`, `tests/a-diamond-seat-takes-the-table-cap-before-the-wallet.law.test.ts`, `tests/every-seat-takes-the-table-cap-before-the-wallet.law.test.ts` | `npx vitest run <the three files>`                                                   | 15 passed                                                               |
| The runner is wired into CI and cannot drop out | `tests/unit/diamondAcceptanceCi.test.ts`, `scripts/ci/run-diamond-sql-acceptance.py`, `scripts/ci/classify-ci-changes.mjs`                                                                                   | `npx vitest run tests/unit/diamondAcceptanceCi.test.ts`                              | passed                                                                  |

## The cluster, and why its answers are production's

`tests/sql/run-diamond-concurrency.py` creates a PostgreSQL 17 cluster in a
temporary directory. The cluster listens on a Unix socket only
(`listen_addresses` empty), and the suite destroys it when it finishes. It loads:

- the estate's historical schema base, and the two Diamond tournament captures;
- `diamond-concurrency-doors.sql`: 185 functions read read-only from production
  with `pg_get_functiondef`, each pinned by md5. These are the money doors the
  cases call, everything they call, and the trigger functions production fires
  on the rows they write. They were captured on 2026-09-30 at 16:34 UTC, after
  the last migration;
- `diamond-concurrency-schema.sql`: the 97 tables those doors write, in
  production's exact shape: columns, constraints, indexes, triggers,
  row-level-security flags and grants. The load refuses to finish if one
  differs;
- `diamond-concurrency-seed.sql`: 200 synthetic players and a staff account,
  made through the real signup path (500 Diamonds each). The staff account
  opens sixteen Diamond cash tables and six Diamond MTTs through the staff
  doors, plus one chip club and one chip freeroll through the chip doors. Two
  players join the chip club through its join door.

**Every function a case executes must be production's text.** The server
counts every PL/pgSQL and SQL function call (`track_functions = all`). At the
end the suite compares each executed function in `public` and
`smarter_private` with the md5 pinned for it, which was read from production.
The run fails if one differs or is not pinned. 195 functions executed, and all
195 were identical to production when pinned.

**Callers are the real callers.** A client door runs as PostgREST's
`authenticated` role with the player's JWT claims and a live session: transfer,
store purchase, cash buy-in, registration and unregistration. Top-up and
cash-out run as `service_role` with the engine's headers. The rebuy money core
and the prize payer are executable by their owner only. They run as the owner
with the engine's claims, which is exactly what runs inside the engine's own
doors.

**What "whole" means.** After every case the suite checks 14 invariants:

- no wallet below zero;
- every wallet equals its journal;
- every custody row equals its movements;
- every movement names a journal row that exists;
- every arena journal row names its movement or ledger row;
- every tournament ledger row names a journal row;
- no purchase claim is left without its response;
- every live Diamond seat holds exactly its custody, and every seat custody has
  its seat;
- every transfer has both journal legs, and every transfer journal row belongs
  to a transfer;
- every store debit has exactly one receipt;
- every cash-out receipt released exactly its occupancy's custody;
- every tournament escrow equals its custody;
- the supply identity is whole: players + house + custody = register.

**Waits are proved, not assumed.** Where a case says a session waited, the
controller saw it in `pg_stat_activity` blocked on the other session's pid
(`pg_blocking_pids`), with the lock type named.

The seed opens `cash_games_enabled` and `tournaments_enabled` inside this
private cluster only. A door that refuses a closed arena cannot race, and
`poker-diamond-cash-admission-setup.sql` opens the cash switch in its own
fixture the same way. The seed refuses to run anywhere but its own socket-only
database, and production's switches were never touched.

## One balance, many spenders

One player holds 400 Diamonds in the wallet and 100 in a cash seat. Five
spenders ask for 625 in all:

- a transfer of 150;
- a store purchase of 150 (production's price for `card_back_gold`);
- a cash buy-in of 200;
- a top-up of 100;
- a tournament registration of 25.

| Case                                               | What was forced                                                                                                                                                                                    | Result                                                                                                                                                                                                                                       |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Three orders, one at a time                        | Each spender holds its transaction open while the next arrives, and the next is proved to wait on it.                                                                                              | The database paid exactly what the serial order says: transfer, purchase and top-up (wallet 0); registration, top-up and buy-in (wallet 75); buy-in, transfer and registration (wallet 25). Every refusal named.                             |
| All five released together, four times             | All five queue on one advisory barrier and are released at the same instant, in a different queue order each time.                                                                                 | Who wins is up to the scheduler. In the recorded run, transfer, top-up and registration were paid twice (wallet 125), and transfer, purchase and top-up twice (wallet 0). Every refused spender asked for more than the wallet finally held. |
| Two wallets sending to each other                  | X sends Y 300 and holds; Y sends X 700 meanwhile. Then both directions, a buy-in and a store purchase are released together.                                                                       | Y's transfer waited and then saw the 300 it needed. No deadlock, and the two wallets, the seat custody and the store price add back to the total.                                                                                            |
| Paused inside the door, five doors                 | The transfer at its journal write, the purchase at its wallet write, the buy-in and registration at their custody write, the top-up at its journal write. A transfer of the whole balance arrives. | The whole-balance transfer waited, then was refused by name on the balance the paused door left, never on the balance it had read.                                                                                                           |
| A registration meets the same player's buy-in      | The registration is paused inside its reserve while the buy-in arrives.                                                                                                                            | The buy-in waited on the table-cap lock, and both completed. Before `20260930123828` this was a deadlock.                                                                                                                                    |
| A chip entry meets the same player's Diamond doors | A chip registration is paused as its roster row goes in, while the same player's Diamond registration or Diamond cash buy-in arrives.                                                              | The Diamond door waited on the table-cap lock, and both completed. Before `20260930131333` both were deadlocks.                                                                                                                              |

The refusals by name: the transfer answers `insufficient_transferable_diamonds`
("Only Available Diamonds Outside Purchased Refund Collateral Can Be Sent"), the
store purchase "Insufficient diamonds", the buy-in and top-up
`insufficient_settled_diamonds`, the registration `insufficient_diamonds`.

## The same request, delivered twice

Nine money doors, three deliveries of each:

- **concurrently:** the second delivery waits on the first, then answers;
- **after a rolled-back first attempt:** the waiting delivery completes the
  request itself;
- **sequentially.**

A third delivery followed every case, and then the same request id came again
with a different payload. Every door made exactly one effect every time, and the
third delivery moved nothing.

| Door           | The one effect                                   | What a replay answers                                                                                           | Same id, different payload                              |
| -------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Transfer       | one transfer, two journal rows                   | the first receipt, word for word                                                                                | refused: `idempotency_payload_mismatch`                 |
| Store purchase | one debit, one grant, one receipt                | the stored first receipt, marked as a replay: cost 0, `original_cost` 150, granted false, `idempotent` true     | refused: "Request Id Already Used For Another Purchase" |
| Cash buy-in    | one custody row, one seat, one entry receipt     | the first receipt, word for word; the player reads it back as confirmed, identically every time                 | refused: `IDEMPOTENCY_KEY_REUSED`                       |
| Top-up         | one custody movement                             | the first receipt, word for word                                                                                | refused: `idempotency_payload_mismatch`                 |
| Cash-out       | one release, one cash-out receipt                | the first receipt, word for word                                                                                | refused: `CASHOUT_OCCUPANCY_SCOPE_MISMATCH`             |
| Registration   | one custody row, ledger row, roster row, receipt | the first receipt, word for word                                                                                | refused: `IDEMPOTENCY_KEY_REUSED`                       |
| Unregistration | one refund                                       | the first receipt word for word, plus `replayed` and `idempotent` true                                          | refused: `idempotency_payload_mismatch`                 |
| Rebuy          | one charge, one credit key                       | the money core answers `idempotent` true; the public door replays its stored receipt before it reaches the core | not exercised                                           |
| Prize payout   | one payment, one credit key                      | true once, then false to every replay                                                                           | pays nothing and answers false                          |

A payout of 7 is drawn from the entrants' custody rows in order, so it can write
two movements (2 from one row and 5 from the next). The payout's movement count
is therefore the one number the suite does not fix. Its custody, wallet,
journal, ledger and credit-key counts are exact, like every other door's.

## Killed in the middle

The suite adds a pause gate after every write each door makes. A gate is a row
trigger that fires after the door's own triggers; the roster entry is the one
gate that fires before the row goes in. The suite first traces each door's
writes in order, so a door that gains or loses a write fails before any kill.
There were 54 kill points:

| Door           | Kill points | Writes, in order                                                                                 |
| -------------- | ----------- | ------------------------------------------------------------------------------------------------ |
| Transfer       | 3           | journal, wallet, transfer row                                                                    |
| Store purchase | 4           | wallet, journal, grant, purchase receipt                                                         |
| Cash buy-in    | 8           | claim, custody, journal, wallet, movement, custody update, seat, receipt                         |
| Top-up         | 5           | journal, wallet, custody update, seat update, movement                                           |
| Cash-out       | 6           | seat update, wallet, journal, custody update, movement, cash-out receipt                         |
| Registration   | 10          | claim, custody, journal, wallet, movement, custody update, ledger, roster entry, roster, receipt |
| Unregistration | 5           | wallet, journal, custody update, movement, ledger                                                |
| Rebuy          | 7           | credit key, journal, wallet, custody update, movement, ledger, roster update                     |
| Prize payout   | 6           | credit key, wallet, journal, movement, custody update, ledger                                    |

At each point the controller killed the paused session with
`pg_terminate_backend` and checked four things:

- nothing moved: no wallet, custody, journal, movement, ledger, seat or receipt
  row survived;
- all 14 invariants held;
- the retry of the same request completed exactly once;
- a second retry moved nothing.

## The database crashed in the middle of a workload

The workload, all at once:

- every one of the nine doors committed once;
- nine more requests paused inside their doors, holding their locks;
- four duplicate deliveries queued behind four of those;
- a transfer and a registration answered inside transactions that never commit.

Then the suite stopped the cluster in immediate mode and restarted it. The log
shows WAL crash recovery, and the cluster was ready 1.0 second after the stop.
After recovery:

- every committed effect survived exactly, and nothing uncommitted appeared;
- all 14 invariants held;
- no paused door was still running.

Every request was then retried twice. The unfinished ones completed exactly
once, the committed ones moved nothing, and the second retry moved nothing.

`synchronous_commit` is on, so a commit the suite counts was in the WAL before
the client heard it. `fsync` is off: that loses nothing in a process crash like
this one, only in an operating-system crash.

## What this is not

- It is not a production load test. Nothing concurrent ran against production.
  The production work was single-session rehearsals that roll back, read-only
  selects, and the three applies.
- The public rebuy door (`process_tournament_rebuy`) needs bust evidence from a
  hand the engine dealt, which an isolated database cannot produce. The rebuy
  cases drive its money core (`fn_ca_process_tournament_chip_purchase_money_v1`),
  as Phase 9 did.
- The chip side is a freeroll, used only for its locks. Chip money was not
  under test.

## Open for Dan

1. **Should every door answer a replay with its first receipt, word for word?**
   Five do. The store purchase answers a replay with cost 0 and granted false.
   Unregistration adds `replayed` and `idempotent` markers. The rebuy core
   answers `idempotent`, and the prize payer answers false. Every one of them
   takes effect exactly once, so nothing is wrong with the money. The question
   is what a client or the engine should read.
2. **Should the prize payer refuse a reused key with a different amount by
   name?** `fn_poker_diamond_tournament_pay` answers false and pays nothing.
   Every other door refuses that case by name. The payer is engine-internal, so
   the answer depends on what the engine does with false.
