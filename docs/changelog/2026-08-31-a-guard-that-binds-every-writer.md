# A guard that binds every writer, not just the RPC

2026-08-31. The last phase of the game-creation audit. The earlier phases fixed
what the create-table form does; this one fixes the fact that **three quarters
of the platform never went through the guarded path at all.**

## The shape of every bug in this area

Four paths create a tournament:

| path                                            | guarded?             |
| ----------------------------------------------- | -------------------- |
| `fn_create_tournament` (the owner-facing modal) | yes                  |
| `TournamentRecurringService`                    | writes rows directly |
| `ScheduledTournamentService`                    | writes rows directly |
| `HorseOrchestrator`                             | writes rows directly |

Every defect found in this area over two days is a symptom of that one fact.
Heads-up games were charged 10% instead of 5% because the fee rule lived in the
RPC (18 rows, measured 2026-08-27). 39,046 rows carry a `table_size` no writer
ever set. A schedule row with two seats and a five-place preset would create a
two-handed game paying five, because only the RPC checks.

The database already knew the answer. `tournaments` carries thirteen triggers —
guarantee affordability, the multi-day refusal, union ownership, whole-dollar
buy-ins — and every one binds all four writers because it lives on the TABLE.
`tables` got the same treatment earlier the same day.

## What is now enforced for everyone

Measured against all 52,407 live rows before a line was written:

| rule                            | violating rows | outcome                      |
| ------------------------------- | -------------- | ---------------------------- |
| `max_players <= 0`              | 0              | **ENFORCED**                 |
| paid places `>` seats           | 0              | **ENFORCED**                 |
| paid places `>=` seats          | 21             | not enforced, see below      |
| `table_size` beyond the deck    | 5,000          | fixed in the writers instead |
| `buy_in_fee` off the seats rule | 9,357          | reported, see below          |

A guard that refuses rows a live writer creates every hour is not a guard, it
is an outage. So the two with zero casualties became law and the rest are
recorded with their numbers.

`tournaments_creation_guard` is BEFORE INSERT only. It never fires on UPDATE,
because a guard that can refuse an update can strand a running tournament.

## `>=` is not the rule, though the RPC uses it

`fn_create_tournament` refuses `paid >= max_players`. That is stricter than
reality and it refuses this platform's own live product: **every Spin & Go is
three seats paying three places, 80/12/8**, and 21 of them are sitting in the
table completed and paid. Paying every seat is unusual, not impossible.

What is genuinely impossible is paying more places than can finish, so that is
the law: `>`, not `>=`. It still catches the two-seat five-place case while
leaving the Spin structure alone. The RPC keeps its stricter rule because
relaxing it changes what an owner may author by hand — a product decision, and
Dan's. **The divergence is deliberate and documented rather than accidental.**

## The writers, fixed at the source

**`table_size` on MTT and XMTT.** Neither insert wrote the column, and it is
`NOT NULL DEFAULT 9` — the same omission already found and fixed for SNG
(10,315 rows) and Spin (28,731 rows). Live before the fix: 5,000 PLO6
tournaments at `table_size` 9 against a deck that can serve 7. The row was not
merely wrong, it disagreed with the felt — `TournamentManagerBase` clamps at
deal time and logs "deck cannot serve more". Both inserts now write through
`clampSeatsForVariant`, **the same function the engine applies**, so the row
states what will actually be dealt.

This was fixed in the writers rather than by a trigger deliberately: a blocking
guard would refuse the creation, where the honest fix is to correct the number.

**Paid places in `ScheduledTournamentService`.** Non-empty was the only test on
that array. The database refuses it now too, but a Postgres error in a
background poll names the constraint, not the schedule — so the check stays one
layer earlier, where it can name which schedule is misconfigured.

**`guaranteed_prize` in `HorseOrchestrator`.** Both paths wrote the REALISED
pool into it after registration — `max(guarantee, registered × buyIn)` on the
MTT path, and `registered × buyIn` on the SNG path, which inserts
`guaranteed_prize: null` and therefore **invented a house promise where the
config made none.** That column is not a display total:
`trg_tournaments_guarantee_affordable` reads it to decide whether the bank can
cover the event and `fn_apply_prize_guarantee` reads it to top a short pool up
to it. A well-attended tournament silently raised its own guarantee to whatever
it had collected. The guarantee is what the config says; the realised pool is
derived where it is displayed.

**`tournament_type` in `HorseOrchestrator`.** Never written on either path, so
every Sit & Go it created landed on the column default `'MTT'`. Both paths state
their format now. Its `variant: 'SNG'` was also upper case where every reader
compares lower case.

## The pin

`tests/unit/oneTournamentWriter.test.ts`, the sibling of `oneTableWriter`, and
it exists for a sharper reason: a cash table has two writers and a tournament
has four. It pins the writer list, that the owner-facing path still goes through
the RPC, that both server writers state `table_size`, that the seat clamp goes
through the seat law rather than by hand, that the variant map is one complete
map rather than four hand-kept copies, and each of the fixes above.

## Attaching a trigger to `tournaments` deadlocks against Realtime

Worth writing down, because it cost six attempts. `CREATE TRIGGER` needs
`AccessExclusiveLock` on `tournaments`; Supabase Realtime is subscribed to that
table, holds `realtime.subscription` and then wants `AccessShareLock` on
`tournaments`, and the two form a cycle. The blocker is **not** a stuck
transaction — `pg_stat_activity` showed it idle, having just committed. It is
ordinary high-frequency traffic.

What worked: create the FUNCTION in its own migration (it needs no lock on the
table), then attach the trigger in a second migration that is nothing but DROP +
CREATE TRIGGER with a **short** `lock_timeout`, so each attempt fails fast
instead of sitting in the queue long enough to deadlock. 1500ms caught the
window after 4s and 8s had both deadlocked. Do not raise the timeout to "try
harder" — a longer wait makes a deadlock more likely, not less.

## Still Dan's

- **`buy_in_fee` off the seats rule on 9,357 rows.** Money, and history. A
  blocking trigger would refuse creations tomorrow over a rule not applied
  yesterday.
- **The RPC's `>=`**, above.
- **`{ sb: 5, bb: 5 }` in `RAKE_SCHEDULE`**, which no legal table can match.
- **The tournament seat clamp uses the CASH cap.** `TournamentManagerBase`
  clamps with `maxSeatsForVariant` (PLO6 → 6) while the deck allows 7 and
  `server/src/config/tableSeating.ts` says in its own header that nothing there
  "may be applied to a table with a tournament_id". It errs in the safe
  direction, which is exactly why an audit should not be the thing that loosens
  it. Raising it to the deck limit would also cost a PLO6 table its third
  run-it board, which is why the cash cap is 6 in the first place.

## Verification

`tsc` clean both sides. Client unit **490 files / 6,913 tests**; client
non-unit **251 / 3,490**; server services + config **68 / 739**; server
tournament **38 / 478**. Twelve `scripts/ci` gates run locally, all green.
Migrations applied to production and probed inside a rolled-back transaction:
zero seats refused, five-places-on-two-seats refused, a 100-seat MTT accepted, a
3-seat Spin paying 80/12/8 accepted, zero probe rows written.
