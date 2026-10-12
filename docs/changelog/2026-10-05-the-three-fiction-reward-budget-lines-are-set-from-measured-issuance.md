# The three fiction reward budget lines are set from measured issuance, and Phase 12's two deferred objects are settled (2026-10-05)

Migration: `supabase/migrations/20261005152420_the_three_fiction_budget_lines_are_set_from_measurement.sql`.

Three things were handed back as owner decisions. Dan, verbatim on 2026-10-05,
answering that list: **"NOTHING IS MINE, EVER.... THEY ARE ALWAYS YOURS TO
DO."** That instruction is later and more specific than the notes that call
these numbers his, so under CLAUDE.md 10.8 it governs, and the decisions are
recorded here. It is not a licence to invent a number: every figure below is
derived from issuance read from production on 2026-10-05, and every one of them
is a row, so any of them can be changed later by editing a row rather than by
changing code.

Two of the three turned out to need no new code at all, which is reported here
rather than papered over with a migration that would have done nothing.

## 1. The three budget lines

`fn_ca_diamond_health()` had reported, for weeks, exactly one area that was not
`ok`:

```
budget plans   attention   3 budget line(s) are fiction. They refuse nobody
                           (ruling 21); setting them is Dan's.
```

`fn_ca_diamond_budget_reality()` named them. Read live on 2026-10-05:

| line                         |    plan | measured actual | verdict                                                                    |
| ---------------------------- | ------: | --------------: | -------------------------------------------------------------------------- |
| 2026-09 / `daily_missions`   |  30,000 |         565,705 | `ALREADY OVER ... (18.9x). The plan is fiction.`                           |
| 2026-10 / `daily_challenges` | 100,000 |       1,576,350 | `ALREADY OVER ... (15.8x). The plan is fiction.`                           |
| 2026-10 / `mint`             |       0 |       2,040,000 | `BUDGETED ZERO, ISSUED 2040000. The plan says this engine does not exist.` |

### Ruling 21 is why a number may be set here at all, and it is not weakened

Dan, 2026-09-08, ruling 21: "THERE SHOULDN'T BE A PLATFORM BUDGET ON THINGS
LIKE THIS, ONLY A USER BUDGET." A per-engine monthly line is a shared pot, so
refusing on it punishes whoever arrives last for what everybody else earned - a
race with no visible clock. Since that ruling these lines **report** and never
refuse, and the shape was re-read on production rather than trusted:

- `DR7:engine_over_budget` has no row in `ca_diamond_rule_modes`. The rule was
  deleted, not deferred, so there is nothing to re-arm.
- the live `fn_ca_diamond_earn_ledger` body (md5
  `0ed2763a2454d76d9557ae4aa46f14b8`) touches the budget line only as a
  once-a-month `INSERT ... ON CONFLICT (period, engine) DO NOTHING`. There is no
  read of `budget_diamonds` on the award path and no refusal on it.
- the only refusal left is the per-user one, `DR7:user_over_daily_cap` against
  `diamond_engine_daily_caps`.

So raising these three numbers cannot pay anybody more, and lowering them could
not refuse anybody. All they change is whether the report says the plan matches
reality. The migration asserts that shape before the write and again after it.

### Each figure, and the rows it came from

**2026-09 / `daily_missions`: 30,000 -> 600,000.** September is complete.
`fn_ca_diamond_engine_spent('2026-09','daily_missions')` reads **565,705** to
977 distinct players: 491,200 appended to `ca_diamond_engine_spend` from
2026-09-08, plus the **74,505** frozen `spent_diamonds` baseline from before
that journal existed (491,200 + 74,505 = 565,705, which is the function's own
definition). The 30,000 line was written 2026-09-07, before any of it. 600,000
is the next round figure above what the month actually issued, 6.1 per cent of
headroom. The line is now a record of what this engine cost in September, taken
from September's own rows.

**2026-10 / `daily_challenges`: 100,000 -> 12,000,000.** October is in
progress, so the plan has to cover the month and not the part of it that has
happened. Issuance per complete Chicago day:

| day        |                                                      issued |
| ---------- | ----------------------------------------------------------: |
| 2026-10-01 |                                                     954,804 |
| 2026-10-02 |                                                     141,109 |
| 2026-10-03 |                                                      90,556 |
| 2026-10-04 |                                                     317,996 |
| **total**  | **1,504,465** over four complete days, mean **376,116**/day |

376,116 x 31 days projects to **11,659,604**. 12,000,000 is the next round
figure above the projection. It is also the plan this same engine already
carried for 2026-09 (set 2026-09-08), against which September's complete-month
5,347,453 read "Plausible" at 0.45x - so the figure is not new to this engine;
it is the one month somebody did set, carried to the month that needs it. The
range the measured days admit is 6.5M (if the rest of October runs at the
2026-10-02 to 04 mean of 183,220/day) to 11.7M (if it runs at the four-day
mean), and 12,000,000 covers the top of it, which is what a current month's
plan has to do if the area is not to flip back to attention on the 20th.

**2026-10 / `mint`: 0 -> 2,400,000.** "The plan says this engine does not
exist." It does exist, and it is not a mint in the supply sense. Every row the
earn ledger files under engine `mint` in October is one credit, read from the
journal:

```
type=earn  transaction_type=mint  source=the_mint  issuance_class=promotional
description="The Mint: Lifetime VIP Monthly Diamond Benefit"
1,020 rows, 1,020 distinct recipients, 2,000 Diamonds each, 2,040,000 in total,
2026-10-02 09:00:03 to 2026-10-04 09:00:27 UTC
```

It is a monthly benefit of 2,000 Diamonds to each lifetime VIP. The lifetime-VIP
population today is **1,021** (1,000 horses, 21 human); 1,020 were paid and the
one that was not is a fixture account, which the earn ledger excludes by design.
**2,400,000 = 1,200 recipients x 2,000**, covering the measured population plus
17.5 per cent of growth in it.

CLAUDE.md 10.5: 1,000 of the 1,020 recipients are horses. The population this
line is sized on is the whole of it, and the figure would be identical if every
recipient were human. The migration refuses to land if no horse is in that
population, so a future change that quietly dropped horses from the benefit
would be caught by the plan that pays for it.

The figure is deliberately **not** 2,500,000. That is the literal the earn
ledger used to invent for an engine nobody had planned; a plan that happened to
equal it would read, to the next person, as that invention rather than as a
decision.

### The 2,500,000 fallback: already gone, and it stays gone

`fn_ca_diamond_earn_ledger` created a missing period's line as
`COALESCE(<previous period's line>, 2500000)`, so an engine that had never had a
line got two and a half million Diamonds written by a trigger and approved by
nobody. **That was already fixed before this task reached it**, on 2026-10-04 by
`20261004211453_the_diamond_books_do_not_invent_a_number`, which is recorded in
`supabase_migrations.schema_migrations` and live: the body read from production
today carries the carry-forward and no literal.

Decision: **it stays removed, and this file adds nothing to it.** The
carry-forward is a real decision the code makes and it is sound - a month with
no new instruction continues the last plan somebody set. With no earlier line at
all the column is left NULL, which this schema already calls unset: the CHECK
`ca_budget_is_a_number_or_nothing` admits NULL, and
`fn_ca_diamond_budget_reality` reports "NO PLAN SET. Refuses nobody either way
(ruling 21); this is simply unstated." That is a named absence instead of a
number nobody approved, which is what the design asks for when it says a new
Diamond engine's line must come from a decision before its first credit: the
line now arrives _unset and saying so_, and the health function does not judge
real issuance against it.

It is pinned three ways, all re-read rather than trusted:
`tests/an-unset-budget-is-not-a-number.law.test.ts`, the column's CHECK, and
this migration's own preimage and postimage, which refuse if `2500000` ever
reappears in the live body or if the carry-forward is lost.

### What the migration does not touch

The other 36 lines, including the three 2,500,000 `signup` lines (2026-05,
2026-07, 2026-08) and the two 2,500,000 `daily_mission_milestones` lines. None
of them reads as fiction - each is above its own issuance - and rewriting a
recorded line that nothing reports on is tidying, not fixing. `spent_diamonds`
is a frozen baseline and is not written. No journal row is written; both arena
switches are asserted unchanged and never written.

### Proof

Rehearsed on production in one self-aborting `DO` block (CLAUDE.md 11.5 rule 1:
one call, one block ending in `RAISE EXCEPTION`, an error is the success case),
running the migration's own logic byte for byte with the abort appended. It
ended:

```
ERROR:  P0001: REHEARSAL OK: all preimage, set and postimage assertions passed;
        this transaction aborts and commits nothing
```

and the three rows were re-read afterwards still holding 30,000 / 100,000 / 0
at their original `updated_at`, so nothing committed. The postimage inside that
run is the assertion that matters: the predicate `fn_ca_diamond_health()` reads
for the `budget plans` area returned **zero** fiction lines after the three
UPDATEs.

`fn_ca_diamond_health()` is deliberately not called inside the transaction. It
runs the trial balance and the fourteen-day cap headroom, and holding the
2026-10/`daily_challenges` row through that would make live daily-challenge
awards wait behind this file on the earn ledger's `ON CONFLICT` probe. The file
asserts the exact predicate health reads; health itself is read live after the
apply.

## 2. Phase 12's two deferred objects: both already settled, neither needs a migration

Phase 12 line 7 recorded that two objects waited on a decision. Both were read
on production on 2026-10-05, and **both decisions had already been taken and
applied**. Writing a forward migration for either would have been a migration
that changed nothing.

### `arena_withdrawals` payout-freeze scope: RETIRED, and live

The scope's one reader was `fn_arena_withdraw`, which has only raised since
20260909065458 and was dropped by `20261004214251`. The retirement was written
in `20261004231057_page_preferences_count_the_row_they_wrote_and_the_dead_arena`
and that migration **is applied** - it is in
`supabase_migrations.schema_migrations`. Read live:

- `ca_payout_freeze_scope_check` now admits nine scopes, and
  `arena_withdrawals` is not among them:
  `tournament_payouts, bbj_payouts, diamond_issuance, diamond_tournament_payouts, wheel, plinko, crash, crossing, mines`.
- `fn_ca_open_payout_freeze` md5 is `03fe1a6b3b13713de339f9a9c58eedef`, which is
  the **postimage** that migration recorded, so the accepted list is the
  four-scope one and the retired name answers `unknown_scope`.
- the string `arena_withdrawals` appears in **no** function body in `public`
  (every `prokind='f'` definition scanned).
- `ca_payout_freeze` holds **0 rows** in any scope, so no freeze history was
  deleted or rewritten to get here.
- the comment on `ca_payout_freeze.scope` now says the legacy arena scope was
  retired and why, so the name cannot be re-reserved by someone reading the
  column.

Nothing to do. The alternative the sweep offered - wiring the scope into
`fn_poker_diamond_release` - would have added a second freeze name to the
custody release path, and `diamond_issuance` already covers Diamond issuance
there; a freeze nobody can open and nothing reads is the "armed but unreachable"
state CLAUDE.md 10.86 forbids, which is exactly why retiring it was right.

### `fn_ca_arena_seat_is_same_asset` and DR15: KEEP, and live

The question on record was whether the P0810 to P0815 seat guards replace DR15.
They do not, and the two answer different questions. Read live:

- `fn_ca_arena_seat_is_same_asset()` exists and its trigger
  `trg_ca_arena_seat_is_same_asset` is enabled (`tgenabled='O'`),
  `AFTER INSERT ... FOR EACH ROW` on `table_seats` (**1,319,327 rows**).
- it is the **only** function in the database whose body contains
  `DR15:cross_asset_seat` - exactly one match across every `prokind='f'` body.
  Dropping it would leave DR15 in `refuse` mode with no consumer, which is the
  state migration `20260919223115` had to repair for DR16 and which 10.86
  forbids: a rule that reads as armed while being unreachable.
- the body reads `ca_arena_settings.club_id`, the **new** arena's identity. It
  is not legacy, whatever the Phase 2 inventory called it.
- it files `DR15:cross_asset_seat` at `warning`, or `critical` once the rule is
  flipped, and **never refuses a seat**: its whole body is wrapped in
  `EXCEPTION WHEN OTHERS THEN NULL` and returns NULL, because a guard that can
  refuse a seat can strand a player mid-hand.

P0810 to P0815 refuse a _tournament_ seat that has no active Diamond entry, that
moves between events, or whose entry does not hold exactly its movements. DR15
reports a seat whose **asset** disagrees with its table's club - a chip-funded
chair at a Diamond table or the reverse. A tournament-entry guard cannot see
that, so removing DR15 on the grounds that P0810-P0815 exist would delete the
only thing watching for cross-asset contamination on the seat path, in a
programme whose exit condition names "no chip contamination".

Decision: **keep both, no code change**, which is what production already does.
This confirms, from live rows, the KEEP recorded in
`docs/changelog/2026-10-04-page-preferences-count-the-row-they-wrote.md` section 3.

### `20261004214251` is applied, and every proof it promised is true live

All six `@live-proof` predicates of the retirement migration, read on 2026-10-05:

| predicate                                                             | live |
| --------------------------------------------------------------------- | ---- |
| `fn_arena_deposit` and `fn_arena_withdraw` both absent                | true |
| `diamond_arena_events` absent                                         | true |
| `profiles.diamond_arena_preferences` absent                           | true |
| `fn_guard_profile_privileged_columns` md5 `b140541b...`               | true |
| `update_page_preferences` md5 (`875d8538...`, after `20261004231057`) | true |
| `fn_close_account` md5 `b563620364...`                                | true |

`diamond_transactions` is untouched and the register identity
`fn_ca_diamond_register_vs_supply().difference` reads `0.00`.

## Programme records

Phase 12 line 7 was **already ticked** on `main` by another lane earlier on
2026-10-05, and its text already records both decisions correctly. It is left
exactly as it stands: the reading above independently confirms it from live
rows rather than re-asserting it. The same is true of that lane's October 5
execution update and of the Immediate Next Batch paragraph.

What was stale and is changed here is one line, the Phase 12 "Open for Dan in
this phase" list, which still asked for three things that are done: the
migration dispatch (both October 4 files are applied), the DR15 question
(KEEP) and the `arena_withdrawals` question (RETIRED). Those three are removed
from it and a second October 5 execution update records the budget decision,
the independent re-verification, and the defect in section 3. Nothing else in
the programme is touched, and no other lane's lines are.

## 3. Found on the way, not fixed here, and it is a real defect

**Since 2026-09-23, no "The Mint: signup grant" credit has been recorded in
`ca_diamond_engine_spend` or `diamond_user_daily_awards`, and no incident was
filed about it.** 622 such rows exist (293 in September for 146,500 Diamonds,
329 in October for 164,500), every one `amount=500`,
`issuance_class='promotional'`, `reference_id='signup:<uuid>'`, which
`fn_ca_diamond_engine_of` maps to engine `signup`. 328 of the 329 October
recipients are ordinary humans with a profile row and a normal email; one is a
fixture account, correctly excluded. In 2026-08 the same grant worked - 431 rows
and 215,500 Diamonds are in the engine journal for that month.

The consequences are both measurement and guard:

- `fn_ca_diamond_engine_spent('2026-10','signup')` returns **0** against 164,000
  actually issued, so that line reads "Plausible: issued 0 against a plan of
  15000" - fiction in the direction the health check does not look for.
- the per-user daily cap for `signup` is computed from
  `diamond_user_daily_awards`, which has no row for any of them, so the one
  control ruling 21 left in place is **blind to this engine's issuance**.

The mechanism is not yet proved. The trigger is
`AFTER INSERT ... WHEN (new.amount > 0)` and 500 > 0; none of the earn ledger's
early returns should fire (`promotional` is not in the skipped classes, the type
is not `purchase`, and the recipients do not read as fixture accounts now); and
`DR7:ledger_write_failed` has no row since 2026-09-08, so the function's own
failure path did not file either. Every grant lands within two seconds of its
profile row being created, and `diamond_user_daily_awards` has a foreign key to
`profiles(id)`, which makes an ordering change inside the signup path the first
thing to read.

It is **not** fixed in this change, deliberately. It is not one of the three
lines, it is on the earn-ledger write path that concurrent lanes are working in,
and it needs its own measurement and its own proof rather than being folded into
a file about budget plans. None of the three figures above depends on it: the
reconciliation that found it shows no uncounted row for 2026-09
`daily_missions`, 2026-10 `daily_challenges` or 2026-10 `mint`.

## What was left alone

- `cash_games_enabled` (false) and `tournaments_enabled` (true): read and
  asserted, never written.
- the other 36 budget lines, `spent_diamonds` on all 39, every
  `diamond_transactions` row, every `ca_diamond_engine_spend` row, every
  migration file and every `schema_migrations` row.
- the signup-grant defect in section 3, named rather than patched.
- Phase 12's owner actions that are genuinely outside both repositories: the
  `diamond.smarter.poker` DNS record, the old public GitHub repository, the
  World Hub legal copy, and whether the three unknown trial-balance hours reset
  the seven clean days.
