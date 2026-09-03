# 2026-09-02 - chip standard Phase 1.2 + 1.3: the undeclared legs name their counterparty

Branch `fix/chip-std-p1-ledger-declarations`, worktree `chipstd-p1-ledger`.
Roadmap: `docs/CHIP-ACCOUNTING-ROADMAP.md` Phase 1.2 (registration debits declare
themselves) and 1.3 (suspense to zero, R9). Evidence base:
`docs/audits/2026-09-02-chip-standard-round2/lane1-chip-paths.md` C #6 #7 #8 #9, D2, D3.

THE LANE IS DECLARATION ONLY. No balance write moved, no amount changed, no refusal added.
Every edited function is the live body plus added lines around one balance write; the byte
proof is in section 3.

## 1. What was live before (read 2026-09-02 21:40-22:00 UTC)

The auto-ledger journals every balance write: `fn_club_members_ledger_writer` on
`club_members.chip_balance` (defaults: category `adjustment`, counterparty `table_stack`,
tournament from `app.ledger_tournament`) and `fn_ca_autoledger` on `clubs`, `bbj_pools`,
`spin_bonus_pools`, `union_wallets`, `unions` (defaults: `adjustment`, `settlement_suspense`).
`table_seats` has no ledger trigger. `fn_ca_declare_ledger(category, counterparty, entity,
settlement, idempotency_key, autoskip_tables[])` sets the same GUCs after validating both words
against the live CHECK text and RAISEs on a miss. All GUCs are transaction-local.

chip_ledger vocabulary (read from `pg_constraint`, all three CHECKs are `NOT VALID`):
`fee_liability` is NOT a word. `prize_liability`, `bounty_liability`, `escrow`, `union_wallet`,
`promo_wallet` are. `horse_funding`, `tournament_buyin`, `rebuy`, `addon`, `spin_prize`, `promo`
are categories. No CHECK had to grow, so there is no vocabulary migration.

24h ledger picture before apply (rows / amount):

| leg                                          | rows as journaled                                                    | count     | amount            |
| -------------------------------------------- | -------------------------------------------------------------------- | --------- | ----------------- |
| registration debit (both doors) + rebuy core | `adjustment player_wallet -> table_stack`, no tournament_id          | 21,073    | 440,187.00        |
| spin prize draw                              | `spin_prize spin_reserve -> settlement_suspense`                     | 3,505     | 196,992.00        |
| BBJ promo sweep, pool side                   | `adjustment bbj_pool -> settlement_suspense`                         | 505       | 1,430.87          |
| BBJ promo sweep, credit side                 | `adjustment settlement_suspense -> promo_wallet` / `-> union_wallet` | 254 / 252 | 1,067.39 / 364.20 |
| horse treasury-to-felt                       | `horse_funding club_treasury -> table_stack`, both entities set      | 1,100     | 125,419.00        |

## 2. What changed, per leg

### 2.1 Registration debit (roadmap 1.2)

Writers found: `fn_register_for_tournament` (authenticated, `auth.uid()`-bound, also the body
behind `fn_take_seat_and_buy_in` for spins and heads-up) and, found one minute AFTER the first
apply because undeclared rows kept arriving, `fn_register_horse_for_tournament` (service_role,
the horse fleet's door, identical shape). Both call `atomic_deduct_wallet_and_log`, which many
non-tournament writers share and which was NOT touched. The rebuy / re-entry / add-on core
`process_tournament_rebuy_before_one_minute_addon` (EXECUTE postgres only; wrapped by
`process_tournament_rebuy`, authenticated) writes `club_members` itself.

Declared, in the callers, around the one wallet write: `app.ledger_category` =
`tournament_buyin` (rebuy core: its own `v_cat`, `rebuy` or `addon`), `app.ledger_counterparty`
= `prize_liability`, `app.ledger_counterparty_entity` = the tournament, `app.ledger_tournament` =
the tournament. The four settings are saved before and restored after the write so nothing later
in the same transaction (the race refund in the `unique_violation` branch, the late seat) inherits
them. `set_config`, NOT `fn_ca_declare_ledger`: the primitive RAISEs on a vocabulary miss and a
buy-in must never be refused by a ledger word (SWARM-BRIEF-R2 rule 13); the writer trigger falls
back to `adjustment` on its own.

The fee leg: the task asked for `prize_liability` for the pool share and `fee_liability` for the
fee share. `fee_liability` is not in the vocabulary, and more to the point the whole charge
(prize + bounty + fee) is ONE wallet write and therefore ONE trigger row. Splitting it would mean
two wallet writes (a money-movement change) or a hand-written second ledger row (a ledger row
with no store write behind it). Both are outside this lane. The single row is booked against the
tournament, which holds all three buckets until it completes; the per-bucket split is the escrow
shadow's job (Lane B, `fn_ca_tournament_escrow` reads `wallet_transactions` + `rake_records`).

### 2.2 `fn_spin_settle_game` (roadmap 1.3)

The draw set only `app.ledger_category = 'spin_prize'`. When the entry had been booked at seat
time by `fn_spin_book_entry` (the normal case: the settle runs about four seconds after the last
seat) no counterparty was set and the row fell to suspense; when the entry was booked in the same
call it inherited `prize_liability` from the entry block by accident. The draw funds the spin
tournament's prize pool, which the obligation settle then pays out, so the counterparty is
`prize_liability` with the spin tournament as entity. The one `set_config` line became
`PERFORM public.fn_ca_declare_ledger('spin_prize', 'prize_liability', p_tournament_id);`
(service_role-only function, primitive used as the brief asks).

### 2.3 BBJ promo sweeps (roadmap 1.3)

Writers: `fn_sweep_bbj_promo(p_club_id)` and `fn_sweep_bbj_promo_all()` (both service_role,
called over PostgREST from outside this repo; no pg_cron job and no engine call site). Each moved
`bbj_pools.promo_balance -> 0` (journaled `bbj_pool -> suspense`) then credited
`union_wallets.promo_wallet` or `clubs.promo_balance` (journaled `suspense -> union_wallet |
promo_wallet`): two rows through suspense for one transfer.

Now: `fn_ca_declare_ledger('promo', union_wallet | promo_wallet, union_id | club_id, NULL, NULL,
ARRAY['union_wallets','clubs'])` before the pool debit, so the bbj_pools autoledger writes ONE
row `promo bbj_pool -> union_wallet(union)` or `-> promo_wallet(club)`; the credit side is
autoskipped for that write so the move is not journaled twice, and both skips are cleared right
after the credit (and after the loop in `_all`). The failure branches that put the balance back
are journaled by the same declaration in reverse (net zero). In `_all` the declaration sits inside
the per-pool `BEGIN ... EXCEPTION` block, so an exception reverts the settings with the writes.
`unions.promo_funded_from_bbj` is not an autoledgered column, so no extra row.

### 2.4 Horse treasury-to-felt funding (roadmap 1.3) - READ, NOT CHANGED

`fn_horse_fund_from_treasury` and `fn_horse_seat_from_treasury` (there is no `fn_horse_seat`)
already, since 2026-08-31, autoskip the `clubs` trigger and write an explicit
`horse_funding club_treasury(club) -> table_stack(table)` row with a `ca_ledger_write_failures`
fallback. 1,100 / 1,100 rows in the 24h window carry the category and both entities; the only
`club_treasury -> suspense` row in 24h was the one overpay debit (`fn_charge_place_overpays`,
246.82, lane1 C #14, not this lane). Nothing to declare. Whether the felt may be funded from a
treasury with no wallet leg at all is chip standard C4 - Dan's decision, not a declaration.

## 3. Byte proof

For every function: live `prosrc` dumped before the edit, edits applied by exact single-occurrence
anchors (Python, `assert s.count(anchor) == 1`), and after apply the live `md5(prosrc)` and
`length(prosrc)` compared with the file in this branch.

| function                                         | prosrc before | prosrc after | live md5 after apply == migration file | RAISE EXCEPTION before -> after |
| ------------------------------------------------ | ------------- | ------------ | -------------------------------------- | ------------------------------- |
| fn_register_for_tournament                       | 9,235         | 10,993       | 308ed471dbff862c1b88ffba28e1151d yes   | 2 -> 2                          |
| process_tournament_rebuy_before_one_minute_addon | 12,280        | 13,560       | e9be3f9b42726e1d2c20a9db771ee5ec yes   | 21 -> 21                        |
| fn_spin_settle_game                              | 8,523         | 8,795        | 5e2e4092af6d888fcd7c1cd738d9796e yes   | 3 -> 3                          |
| fn_sweep_bbj_promo                               | 2,478         | 3,488        | 7ef5584cdb49f03025598311a600f555 yes   | 0 -> 0                          |
| fn_sweep_bbj_promo_all                           | 2,974         | 3,836        | 750cd5d23b758611b14eaba739d016a0 yes   | 0 -> 0                          |
| fn_register_horse_for_tournament                 | 4,958         | 6,474        | 444a7772a989828dfbe90dbf57b1cdd5 yes   | 0 -> 0                          |

`diff live new` per function: additions only, except one replaced line in `fn_spin_settle_game`
(`PERFORM set_config('app.ledger_category', 'spin_prize', true);` -> the primitive call plus a
three-line comment). Grants unchanged (asserted in-migration with `has_function_privilege`).

## 4. Migrations (applied once each, via apply_migration)

| file in branch                                                                       | schema_migrations version / name                                              | applied (UTC) |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ------------- |
| `supabase/migrations/20260902220500_the_undeclared_legs_name_their_counterparty.sql` | 20260902220533 / `20260902220500_the_undeclared_legs_name_their_counterparty` | 22:05:33      |
| `supabase/migrations/20260902221500_the_horse_door_declares_the_same_way.sql`        | 20260902220819 / `20260902221500_the_horse_door_declares_the_same_way`        | 22:08:19      |

(apply_migration stamps its own version and keeps the passed name; the other lanes' rows show the
same shape.) Both post-apply DO blocks ran green: declarations present in live prosrc, RAISE
counts unchanged, vocabulary words present, grants exactly as before.

## 5. Probes (every one inside BEGIN ... ROLLBACK, nothing kept)

### 5.1 Registration: horse `f9a23390` into PKO `ae9de863` (DSS Tuesday $16.50 NLH Bounty Hunter)

`set_config('request.jwt.claim.sub', ...)` to stand in for `auth.uid()`, then
`fn_register_for_tournament('ae9de863-...')`. Result both times:
`{"ok": true, "cost": 15.00, "rake": 1.50, "bounty_head": 8.00, "prize_contribution": 5.50,
"bounty_contribution": 8.00, ...}`.

BEFORE (21:59 UTC, first two attempts hit the :55-:00 PLATFORM_FROZEN break, third succeeded):

```
  category  |   from_type   | from_ent |   to_type   | to_ent | amount | tid |                     description
------------+---------------+----------+-------------+--------+--------+-----+-----------------------------------------------------
 adjustment | player_wallet | f9a23390 | table_stack |        |  15.00 |     | auto-audited club_members.chip_balance delta -15.00
```

AFTER (22:06 UTC; the two `rake` rows are other sessions' hand rake landing in the same second):

```
     category     |   from_type   | from_ent |     to_type     |  to_ent  | amount |   tid    |                     description
------------------+---------------+----------+-----------------+----------+--------+----------+-----------------------------------------------------
 tournament_buyin | player_wallet | f9a23390 | prize_liability | ae9de863 |  15.00 | ae9de863 | auto-audited club_members.chip_balance delta -15.00
```

### 5.2 Spin prize draw: synthetic minimal call

A completed spin cannot be re-settled (the `jackpot_draw` guard returns `already_settled`) and a
live spin settles four seconds after its last seat, so: inside the transaction, insert the
`contribution` row `fn_spin_book_entry` would have written for a REGISTERING spin, then call
`fn_spin_settle_game(<spin>, 'fade0000-...0001', 1.00, 3, 2, 0.08)`. Result:
`{"ok": true, "prize_pool": 2.00, "pool_covered": 2.00, "entry_booked_at_seat": true, ...}`.

BEFORE (spin `a6b59648`):

```
  category  |  from_type   | from_ent |       to_type       | to_ent | amount |                    description
------------+--------------+----------+---------------------+--------+--------+----------------------------------------------------
 spin_prize | spin_reserve | 2d968239 | settlement_suspense |        |   2.00 | auto-ledgered spin_bonus_pools.balance delta -2.00
```

AFTER (spin `2ff9e87f`; `a6b59648` had started in between and refused the synthetic booking on
`uq_spin_ledger_one_booking_per_game`, which is the right refusal):

```
  category  |  from_type   | from_ent |     to_type     |  to_ent  | amount |                    description
------------+--------------+----------+-----------------+----------+--------+----------------------------------------------------
 spin_prize | spin_reserve | 2d968239 | prize_liability | 2ff9e87f |   2.00 | auto-ledgered spin_bonus_pools.balance delta -2.00
```

### 5.3 BBJ promo sweep: `fn_sweep_bbj_promo('2a1132b9-...')` (club pool `a7a65cfc`, no union)

BEFORE (`{"swept": 5.88, "destination": "club"}`):

```
  category  |      from_type      | from_ent |       from_label        |       to_type       |  to_ent  |      to_label       | amount
------------+---------------------+----------+-------------------------+---------------------+----------+---------------------+--------
 adjustment | bbj_pool            | a7a65cfc | bbj_pools.promo_balance | settlement_suspense |          |                     |   5.88
 adjustment | settlement_suspense |          |                         | promo_wallet        | 2a1132b9 | clubs.promo_balance |   5.88
```

AFTER (`{"swept": 2.79, "destination": "club"}`):

```
 category | from_type | from_ent |       from_label        |   to_type    |  to_ent  | to_label | amount
----------+-----------+----------+-------------------------+--------------+----------+----------+--------
 promo    | bbj_pool  | a7a65cfc | bbj_pools.promo_balance | promo_wallet | 2a1132b9 |          |   2.79
```

The union destination was not probed (no union pool held a balance at the time); the live rows
after apply show it: `promo bbj_pool -> union_wallet` 6.86 and `-> promo_wallet` 15.30 by 22:13.

### 5.4 Horse funding

Not probed: nothing was changed. The live shape, 24h: `horse_funding club_treasury ->
table_stack`, 1,100 rows / 125,419.00, 1,100 with both entities, 0 through suspense.

### 5.5 Rebuy core

Not probed in isolation (needs a RUNNING rebuy event with an eligible seated horse under the
stack threshold; none was available in the window). The declaration is the same eight lines as
the registration doors around a direct `UPDATE club_members`; live rows after apply are in
section 6.
