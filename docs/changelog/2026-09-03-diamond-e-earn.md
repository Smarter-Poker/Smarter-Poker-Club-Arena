# Diamond Lane E: every earn engine has a budget line and a daily cap ledger

Date: 2026-09-03 (UTC). Branch `fix/diamond-e-earn`.
Migration: `supabase/migrations/20260903002841_diamond_e_every_earn_engine_has_a_budget_line.sql`,
applied once to production `kuklfnapbkmacvwxktbh`, registered as version `20260903002841`.

Everything below is observed. Numbers come from queries run in this session
against production; probe transcripts are from transactions that were rolled
back. No em dashes, no emoji.

## What was wrong

`docs/audits/2026-09-02-diamond-economy/lane3-earn-engines-and-transfers.md`
section 17 target A: only one of the eleven diamond earn engines debited any
budget, and the budget it debited (`diamond_platform_budget`) is a counter
whose ceiling is a constant inside the single function that spends it. Nothing
was funded, nothing reconciled, and there was no per-user per-day cap anywhere
in the database.

Measured over the 30 days to 2026-09-03, journal CREDITS only, attributed by
the engine function this migration adds and run over the live journal as a
plain SELECT:

| engine        | rows | diamonds | players | horse rows | first | last  |
| ------------- | ---- | -------- | ------- | ---------- | ----- | ----- |
| trivia        | 489  | 14,260   | 5       | 244        | 08-06 | 08-23 |
| catalog_v2    | 55   | 2,460    | 7       | 0          | 08-05 | 09-02 |
| other         | 2    | 440      | 2       | 0          | 08-06 | 08-06 |
| legacy_credit | 1    | 20       | 1       | 0          | 08-21 | 08-21 |

Total 17,180 diamonds across 547 credit rows, which is every positive row in
the window (`count(*) FILTER (WHERE amount > 0)` = 547, `sum` = 17,180), so the
attribution leaves nothing unclassified by accident.

Reading that table: 14,260 of the 17,180 (83 percent) is the `pvp_refund`
replay incident of 08-13 to 08-23, not ordinary earning. Outside it the
platform issued 2,920 diamonds in a month, of which 2,460 (catalog_v2) was the
only budgeted issuance. The two `other` rows are the 2026-08-06 make-goods for
the easter-egg clamp bug (`makegood_millionaire_egg_cap_2026-08-06` +295 and
`makegood_beta_tester_egg_cap_2026-08-06` +145), both `type` and
`transaction_type` = `adjustment`. They land in `other` on purpose: an admin
make-good is not an earn engine, and once Lane C's `issuance_class` is being
set by writers these rows will carry `admin` and the trigger will skip them
entirely.

Three further defects from the same audit are closed here:
`enter_trivia_tournament_v2` kept `floor(10 percent)` of every entry fee out of
the prize pool and credited it to nothing (216 diamonds gone across three
completed events); `award_diamonds_v2` read the profile balance with no lock
and wrote it back as an absolute value; and the three catalogs that price every
diamond award on the platform had no version, no trigger and no history.

## What shipped, and what it does not do

LOG-ONLY, in the sense of Dan's risk rule (swarm brief 12). DR7 in the standard
asks for `CHECK (spent <= budget)` and a cap enforced by constraint. A
constraint that refuses an award stops a player being paid for something they
have already done, so what shipped is the ledger and the alarm, not the
refusal. Nothing in this migration can refuse a movement.

New tables (all RLS on, `REVOKE ALL FROM PUBLIC, anon, authenticated`,
`service_role` only):

- `diamond_engine_daily_caps(engine PK, max_per_user_per_day, note)`
- `diamond_user_daily_awards(user_id, engine, day, awarded)` PK on all three
- `ca_diamond_house_ledger(id, at, delta, balance_after, reason, reference UNIQUE, user_id, tournament_id)`
- `diamond_reward_catalog_history`, `daily_challenge_catalog_history`,
  `trivia_diamond_award_limits_history` (op, old_row jsonb, new_row jsonb,
  changed_at, db_role, app_name)

New functions:

- `fn_ca_diamond_engine_of(type, transaction_type, source, description, reference_id)`,
  IMMUTABLE and pure, mapping a journal row to one of eleven engine names by
  reference shape, then source, then type, then description, with `other` as
  the fallback. It is pure precisely so it can be run over history, which is
  how the table above was produced.
- `fn_ca_diamond_earn_ledger()`, the AFTER INSERT trigger on
  `diamond_transactions` `WHEN (NEW.amount > 0)`.
- `fn_ca_diamond_catalog_history()`, the AFTER INSERT OR UPDATE OR DELETE
  trigger on the three catalogs.

The earn ledger skips rows that are not promotional issuance
(`issuance_class IN ('purchased','transferred','refund','admin','arena')`, or
`type`/`transaction_type` = `purchase`), because a purchase, a transfer between
two players and a refund are movements between accounts rather than new
issuance and charging them to an earn budget would be double counting. The
whole body is wrapped in `EXCEPTION WHEN OTHERS` which files
`DR7:ledger_write_failed`, so the trigger cannot abort an insert into the
journal even if every table it writes is missing.

Budget lines seeded: 11 engines x 2 periods (2026-09 and 2026-10) = 22 rows at
2,500,000 each. Daily caps seeded: `catalog_v2` 110, `trivia` 2,000, the other
nine NULL.

**These numbers are PROPOSED PLACEHOLDERS and the migration says so in its
header, in a COMMENT on each table, and in the `note` column of every cap
row.** 2,500,000 is the `c_platform_budget` constant already inside
`award_diamonds_v2`, reused so no engine starts at zero and files a false
incident on its first award. 110 is what `award_diamonds_v2` enforces today for
a non-VIP. 2,000 is the largest solo award ceiling in
`trivia_diamond_award_limits`, and it is a per-award maximum today rather than
a per-day cap. NULL means "no cap is enforced anywhere in the code today",
which is a statement of fact and not a recommendation. Dan sets the real
numbers; a fix lane must not invent them.

## award_diamonds_v2: how the edit was proved minimal

The live body is 25,090 characters. Rather than copy it into the migration by
hand, the migration reads `pg_get_functiondef()` AT APPLY TIME and performs two
textual replacements on it, under four assertions that all had to hold or the
transaction would abort:

1. `md5(prosrc)` equals `902c18015fd648bc50ca75525340c8e7`, the body this
   migration was written against;
2. the profile-read fragment occurs exactly once;
3. the journal-insert fragment occurs exactly once;
4. `length(new) - length(old)` equals exactly the sum of the two fragment
   deltas, so no third character can have moved.

This is stronger than reconstructing the body and diffing it, and it is also
concurrency safe: had another lane replaced `award_diamonds_v2` between the
read and the apply, assertion 1 would have aborted rather than silently
clobbering their work.

The diff, which is the two replacement pairs in full:

```
--- edit 1: the profile read (lost-update fix)
       FROM public.profiles
      WHERE id = p_user_id;
+++
       FROM public.profiles
      WHERE id = p_user_id
        FOR UPDATE;

--- edit 2: the journal INSERT column list
         balance_after, reference_id, metadata, created_at
     ) VALUES (
+++
         balance_after, reference_id, metadata, created_at,
         counterparty, issuance_class
     ) VALUES (

--- edit 2 continued: the journal INSERT value list
         v_metadata,
         v_now
     );
+++
         v_metadata,
         v_now,
         'promo_budget:catalog_v2',
         'promotional'
     );
```

Verified after apply: `length(prosrc)` went 25,090 to 25,204. The delta is 114,
which is exactly 18 (edit 1) + 38 (column list) + 58 (value list). The count of
`FOR UPDATE` in the body went 1 to 2: the budget period row it already locked,
plus the profile row it now locks. Lock order is unchanged in substance,
because the budget lock is taken after the profile read, so profile then budget
remains the only ordering in the function and no new deadlock edge exists.

## Probes (every one rolled back, nothing committed)

### (a) The earn ledger, on a horse

Horse `91dfbccd-e521-4821-9cdc-3d058a0060e4` (`is_horse` true, VIP lifetime,
500 diamonds). Two inserts of a positive journal row, inside BEGIN/ROLLBACK.
The append-only trigger permits INSERT, so this works without any bypass.

First insert, 200 diamonds, `type` and `transaction_type` `easter_egg`:

```
row_kind    | k1                                   | k2         | v1         | v2
------------+--------------------------------------+------------+------------+-----
budget      | 2026-09                              | catalog_v2 | 2500000    | 200
daily_award | 91dfbccd-e521-4821-9cdc-3d058a0060e4 | catalog_v2 | 2026-09-02 | 200
incident    | DR7:user_over_daily_cap              | warning    | 200        | {"day":"2026-09-02","engine":"catalog_v2","awarded_today":200,"max_per_user_per_day":110,...}
```

Then a second insert of 2,000 in the same rolled-back transaction:

```
row_kind    | k1                      | v1      | v2
------------+-------------------------+---------+------------------
budget      | catalog_v2              | 2500000 | 2200
daily_award | catalog_v2              | 2026-09-02 | 2200
incident    | DR7:user_over_daily_cap | 200     | 200 vs cap 110
incident    | DR7:user_over_daily_cap | 2000    | 2200 vs cap 110
```

Observed honestly: the cap incident fires on BOTH inserts, not only the second.
That is correct behaviour and worth stating plainly, because the task that
commissioned this lane expected it on the second only: 200 already exceeds the
proposed cap of 110, so the first insert is over the cap the moment it lands.
The budget incident did not fire, because 2,200 is far under 2,500,000.

Note also that the engine came out as `catalog_v2` from the `type` alone: the
probe's reference (`probe:<uuid>`) matches no documented shape, so attribution
fell through to the type list, which is the intended order.

After ROLLBACK: `diamond_reward_budgets` rows with non-zero spend 0,
`diamond_user_daily_awards` 0 rows, `ca_diamond_incidents` DR7 rows 0, journal
rows matching `probe:%` 0, and the horse still holds 500 diamonds.

### (b) A catalog edit

```sql
BEGIN;
UPDATE public.diamond_reward_catalog SET diamonds = diamonds + 1 WHERE action_key = 'follow';
SELECT ... FROM public.diamond_reward_catalog_history;
ROLLBACK;
```

```
id | op     | action_key | old_diamonds | new_diamonds | db_role  | app_name | changed_at
---+--------+------------+--------------+--------------+----------+----------+---------------------------
1  | UPDATE | follow     | 2            | 3            | postgres | mgmt-api | 2026-09-03 00:29:45.385+00
```

The history row names the role and the application that made the change, which
is what D21 asks for. After ROLLBACK: 0 rows.

### (c) The trivia tournament cut

Constructed inside the rolled-back transaction: `request.jwt.claims` set to
`{"role":"service_role"}` so the function's own `auth.role()` gate is exercised
as the real caller would exercise it, plus one `trivia_tournaments` row
(`status` registration, `entry_fee` 25). The horse above supplied the VIP
profile the function requires; no profile was modified to make the probe pass.

`enter_trivia_tournament_v2` returned:

```json
{"success": true, "new_balance": 475, "new_prize_pool": 23, "entries_count": 1, "entry": {...}}
```

and the state inside the transaction was:

```
row_kind      | a   | b                             | c
--------------+-----+-------------------------------+--------------------------------------------------
house_balance | 2   |                               |
house_ledger  | 2   | 2                             | trivia_tournament_entry_cut | trivia_tourn_cut_00000000-...-ee_91dfbccd-...
journal_debit | -25 | 475                           | tournament_entry | trivia_tourn_entry_00000000-...-ee_91dfbccd-...
prize_pool    | 23  | 25                            | fee minus cut
conservation  | 0   | fee - pool - house, must be 0 |
```

25 collected, 23 to the pool, 2 to the house, nothing unaccounted for. Before
this change the same entry would have left 2 diamonds nowhere at all. After
ROLLBACK: `ca_diamond_house.balance` 0, `ca_diamond_house_ledger` 0 rows, the
probe tournament gone, the horse back at 500.

## Post-apply assertions (all green, inside the migration transaction)

22 budget lines for the current and next period; 11 daily cap rows;
`trg_ca_diamond_earn_ledger` present on `diamond_transactions`; three catalog
history triggers present; six new tables present; `award_diamonds_v2` holds
exactly 2 `FOR UPDATE` clauses and contains both `promo_budget:catalog_v2` and
`issuance_class`; `enter_trivia_tournament_v2` references `ca_diamond_house`;
and `fn_ca_diamond_engine_of` returns the documented engine for five sample
shapes including the `other` fallback. A failure of any one would have aborted
the whole migration.

## Horses are players (CLAUDE.md 10.5)

Nothing in this migration branches on `is_horse`. The budget ledger and the
daily-award ledger count a horse's diamonds exactly as they count a human's,
and probe (a) was deliberately run on a horse for that reason: 244 of the 489
`trivia` rows in the 30-day table above belong to horses and they are in the
totals, not filtered out of them.

## What was NOT built, and why

- **Auto-claiming daily challenges for horses.** 897,095 diamonds sit
  completed-and-unclaimed, 11,662 of those rows belonging to horses who have no
  browser to press Claim with. Under 10.5 the engine owes them the claim, but
  the amount is 87 percent of the entire diamond supply and Dan has not ruled
  (standard 6.3). Not built. The `daily_challenges` budget line exists and is
  seeded, so whichever way he rules the accounting is ready.
- **Expiring challenges.** Same decision, same reason. Not built.
- **Capping referrals or `vip_stipend`.** Standard 6.15. Both sit outside the
  `award_diamonds_v2` daily and monthly caps today; `referral_qualified` and
  `referral_vip_conversion` are 500 x 20 per day each and `vip_stipend` is 500
  per day. Their cap rows are seeded NULL, which records the fact rather than
  inventing a limit. Not built.
- **`CHECK (spent <= budget)` and a cap enforced by constraint.** This is DR7
  as written, and it is the part that can refuse an award. Held for Dan under
  risk rule 12. The ledger and the incidents are the evidence he would need to
  set the numbers first.
- **Changing the trivia cut from floor(10 percent) to a rounded 10 percent.**
  Standard 6.8, Dan's. The rate is untouched; only its destination changed.
- **Reconciling `diamond_reward_budgets.spent_diamonds` to the journal.** The
  ledger is forward-only from this migration: it does not backfill the 17,180
  diamonds of the last 30 days, and it does not decrement when a journal row is
  deleted through the `app.ledger_maintenance` bypass (2,860 rows have been
  deleted that way since 09-01). A spend that happened is a spend that happened,
  so an upward-only budget line is the right shape, but the consequence is that
  `spent_diamonds` and a `sum(amount)` over the surviving journal will diverge
  and no detector compares them yet. That belongs with Lane G's trial balance.

## Decisions that are Dan's

1. The real per-engine monthly budgets. Eleven lines are seeded at 2,500,000 as
   placeholders; only `catalog_v2` has ever had a number at all, and that
   number is a constant in a function rather than a funded account.
2. The real per-user per-day caps. Two are seeded from what the code enforces
   today, nine are NULL.
3. Whether the engine claims completed daily challenges for horses, whether
   challenges expire, and for whom (standard 6.3). 897,095 diamonds.
4. Whether referrals and `vip_stipend` join the caps or get their own line
   (standard 6.15).
5. Whether the trivia cut becomes a rounded 10 percent (standard 6.8). It is
   banked to the house now either way.
6. When the log-only ledger becomes a refusal: DR7 as the standard writes it is
   a CHECK constraint, and turning it on is a decision about whether an award
   may ever be refused, not a technical step.
