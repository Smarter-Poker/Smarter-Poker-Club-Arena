# 2026-09-02 - chip standard, Lane A3: DB payers settle through fn_settle_tournament_obligation

Branch `fix/chip-std-obligations`. docs/CHIP-ACCOUNTING-STANDARD.md sections 2.2, 3.2 (MTT step 5), 3.3 (R2, R3), 5 (Lane A).

## What was found (19:41 UTC)

`tournament_obligations` and `fn_settle_tournament_obligation` were live since 19:16 UTC. None of the six DB-side payers called it. Verified by reading the live bodies from `pg_proc`, not the repo mirror:

| Function                             | Money movement before                                                                      | After                                                                                                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fn_tournament_payout_reconcile`     | `fn_credit_and_log` on `tourney:<t>:prize:<user>:<place>:reconcile`                        | `fn_settle_tournament_obligation(t, 'place', place, holder, EXPECTED, 'reconcile')`                                                                                                         |
| `fn_pay_backed_payout_shortfalls`    | delegates to the reconciler in apply mode (already)                                        | unchanged path; books `total_settled` (what was paid) instead of `total_top_up` (what was wanted)                                                                                           |
| `fn_ca_backpay_guarantee_shortfalls` | delegates to the reconciler in apply mode (already); had no repo mirror at all             | unchanged path; `distributed` = `total_settled`; now mirrored in the repo                                                                                                                   |
| `fn_backpay_spin_unpaid_winners`     | `fn_credit_and_log` on `spin:<t>:prize:<user>:unpaid_backpay`                              | `settle(t, 'place', 1, winner, paid_so_far + chips_short, 'spin_backpay')`                                                                                                                  |
| `fn_backpay_hu_winner_shortfalls`    | `fn_credit_and_log` on `tourney:<t>:prize:<user>:hu_shortfall`, then `prize_pool += delta` | `prize_pool += delta` FIRST (the settle function caps against the pool), then `settle(t, 'place', 1, winner, paid_so_far + delta, 'hu_shortfall')`; the raise is undone if nothing was paid |
| `fn_final_table_deal`                | wrote `tournament_payouts` rows (`final_table_deal`) and left wallets to the engine        | `settle(t, 'final_table_deal', NULL, user, share, 'final_table_deal')` per player; writes no payout rows itself                                                                             |

The final-table deal was also a live defect waiting to happen with the engine PR #2671: the pre-written `tournament_payouts` rows count against `prize_pool` inside the settle function's R1-lite check, so the engine's own settle of the deal would have been refused `escrow_short` on every deal. Now the deal settles in the DB function and the engine's `settleFinalTableDeal` lands on `paid 0` (probe C below).

## One line changed in the settle function itself (found by the probe)

`fn_credit_player_wallet_once` resolves WHICH club wallet to credit from a `tourney:<tournament_id>:...` key (it reads `tournament_players.club_id` for that entry). Any other key shape falls back to `fn_player_home_club`, which is the club the player joined FIRST. The settle function keyed as `obl:<obligation_id>:<n>`, so in the first rolled-back run of the reconciler 3 of 4 places landed in a different club's wallet from the one the player bought in from (the wallet at `tournament_players.club_id` moved 0.00 for three of them). No `obl:` key had ever been spent in production (`wallet_credit_idempotency` count 0), so the key is now `tourney:<tournament_id>:obl:<obligation_id>:<paid_cents>` and all four wallets moved by exactly their share. Everything else in the settle body is the 19:47 UTC live text.

`fn_tournament_obligation_paid_so_far(t, kind, place, user)` was added (read-only, service_role only): it returns exactly the figure the settle function will treat as already paid (the obligation row if it exists, else the legacy seed from `tournament_payouts` by position / refund credits), so an arm that measures a SHORTFALL can pass `paid_so_far + shortfall` as the total and the settle function pays exactly the shortfall once.

The reconciler now counts a `tournament_payouts` row as prize-pool money if its source is on the old whitelist OR its `idempotency_key LIKE 'tourney:%:obl:%'` (the engine settles under `engine.*` source names, which the whitelist would otherwise have read as unpaid and tried to top up).

A place whose holder shows wallet prizes but whose event has NO `tournament_payouts` record at all (`ledger_fallback`) is reported as `paid_without_payout_record` and not settled: the obligation ledger seeds from `tournament_payouts`, so settling it would pay the wallet a second time. Before this change the reconciler would have credited it under its own key.

## Migrations (applied once each, via the Supabase MCP, confirmed in `supabase_migrations.schema_migrations`)

- `20260902201000_db_payers_settle_through_obligations` - the helper, the settle-function key line, and the six payers, one transaction, post-apply assertions green. The repo file is the applied `statements` text byte for byte (fetched back after apply).
- `20260902201500_r3_money_path_log_only` - `ca_money_path_violations` + `fn_ca_money_path_log` + `trg_ca_money_path_log` (AFTER INSERT on `wallet_transactions`, `SET LOCAL lock_timeout = '4s'`, own transaction). Assertions green.

- `20260902203500_db_payers_state_their_grants` - REVOKE/GRANT restating the live ACL (owner + service_role only) for the settle function and the six payers, because the pre-push `check-definer-authorization` gate reads the branch, not production, and a `CREATE OR REPLACE` that says nothing about grants would rebuild them open to PUBLIC. No PostgREST reload (GRANT/REVOKE are not watched). Assertion green.

Schema fragment: `scripts/ci/schema-manifest.d/chip-std-obligations-r3.json`. No row added to `ca_money_rpc_registry`: the trigger writes no balance column and the helper is read-only.

## R3 is LOG-ONLY (Dan's risk rule)

`trg_ca_money_path_log` records every `wallet_transactions` credit whose category is `prize`, `bounty`, `refund`, `tournament_prize`, `tournament_refund` or starts with `tourney`, when `current_setting('app.money_path', true)` is not `fn_settle_tournament_obligation`. It writes `ca_money_path_violations(id, at, table_name, user_id, amount, category, description, related_entity_id, money_path, app_name, db_role)` and raises one INFO drift incident per category per hour (`r3:<category>:<hour>`, classification `unauthorized_adjustment`, layer `settlement`, global scope so it files for every union). Every statement inside it is wrapped in `EXCEPTION WHEN OTHERS THEN NULL`; it contains no `RAISE EXCEPTION` and the migration asserts that. `db_role` is `session_user` (the login role): `authenticator` = PostgREST, `postgres` = psql or a migration - which is the distinction R3 exists to surface.

First live row, 20:30:32 UTC: `prize / authenticator / PostgREST 14.5` - the old engine place-payout path, as expected until PR #2671's engine is deployed. Expect several hundred rows an hour until then; the log is the measurement of the migration onto the settle path, and it should trend to zero.

**Turning the logger into a refusal (a BEFORE trigger that rejects the row) is a separate, Dan-gated step.** It must not be enabled until `ca_money_path_violations` has been empty of engine rows for 24 hours, because a refusal today would stop every legacy place payout.

## Probes (every one inside a transaction that was ROLLED BACK; the pre-apply runs used byte-identical `pg_temp` copies of the bodies, the post-apply runs the live functions)

### A. Reconciler on a fully paid event: `b0328f0a` Evening Mystery Bounty (PLO5), pool 400.00, 4 places, completed in the last 48h

```
--- (a) fully paid event, apply=true
name | pool | expected | paid | top_up | settled | clean | issues
Evening Mystery Bounty (PLO5)|400.00|400.00|400.00|0.00|0.00|true|[]
obligation_rows = 0, new_wallet_rows = 0
wallet delta at tournament_players.club_id, all four holders: 0.00

--- (b) synthetic shortfall: UPDATE tournaments SET prize_pool = prize_pool + 1.00 (rolled back), apply=true
prize_pool 401.00, total_top_up 1.00, total_settled 1.00
actions: place 1 top_up 0.38 settled 0.38 / place 2 0.28 / place 3 0.20 / place 4 0.14
tournament_obligations: place 1 owed 153.54 paid 153.54 settled; 2: 110.56/110.56; 3: 79.60/79.60; 4: 57.30/57.30  (source reconcile)
wallet_transactions written: 0.38 / 0.28 / 0.20 / 0.14, category prize, "Tournament payout reconciliation place N (...)"
tournament_payouts written: position 1..4, source reconcile, idempotency_key tourney:b0328f0a-...:obl:<obligation_id>:15316 / :11028 / :7940 / :5716
club_members.chip_balance delta at the entering club: +0.38 / +0.28 / +0.20 / +0.14

--- (b2) second call, apply=true
total_top_up 0.00, total_settled 0.00, issues [], clean true; wallet rows still 4 (no replay)

--- (b3) the two sweeps, dry run, return their shapes
fn_pay_backed_payout_shortfalls(false,5): {"ok": true, "applied": false, "chips_paid": 0.00, "events_paid": 0, ... "money_path": "fn_settle_tournament_obligation"}
fn_ca_backpay_guarantee_shortfalls(false,5): {"ok": true, "events": 0, "funded": 0.00, "distributed": 0.00, "skipped": [], ...}
```

Query shape (the whole file is `BEGIN; ... ROLLBACK;`):

```sql
SELECT r->>'total_top_up', r->>'total_settled', r->'actions', r->'issues'
  FROM public.fn_tournament_payout_reconcile('b0328f0a-a74d-47c8-bbaa-61c18eae4a3c', true) r;
SELECT kind, place, user_id, amount_owed, amount_paid, source FROM public.tournament_obligations WHERE tournament_id = ...;
SELECT user_id, amount, category FROM public.wallet_transactions WHERE related_entity_id = ... AND created_at >= transaction_timestamp();
SELECT b.user_id, cm.chip_balance - b.chip_balance FROM _before b JOIN public.club_members cm ON cm.user_id = b.user_id AND cm.club_id = b.club_id;
```

Neither sweep had a payable event in the window (no underpaid completed MTT in the last 48h among 80 scanned, no heads-up candidate, no under-paid spin), so their apply arms were exercised through the reconciler (A) and through synthetic shortfalls (B).

### B. Spin and heads-up back-pay

Spin `a70dbaaf` 20 Chip Spin NLH (drawn 40.00, credited 40.00, recorded 40.00):

```
(a) apply=true, nothing owed: winners_paid 0, chips 0.00, refused_by_obligation 0
(b) UPDATE spin_reserve_ledger SET amount = amount - 1.00 WHERE kind='jackpot_draw' (rolled back)
    fn_spin_unpaid_settlements -> chips_short 1.00, verdict under_paid
    apply=true with prize_pool NOT raised:
      winners_paid 0, refused_by_obligation 1
      tournament_obligations: place 1 owed 41.00 paid 40.00
      financial_alerts: critical fn_settle_tournament_obligation "Refused 1.00 to 99be4f5d-... for place: the prize pool of 40.00 has already paid 40"
      (escrow_short refused; NOTHING was credited through another path)
(b2) UPDATE tournaments SET prize_pool = prize_pool + 1.00:
      winners_paid 1, chips 1.00, owed_before 1.00, owed_after 0.00
      obligation place 1 owed 41.00 paid 41.00 source spin_backpay
      wallet_transactions: 1.00 prize "Spin winner back-pay ..."
      tournament_payouts: position 1, 1.00, spin_backpay, key tourney:a70dbaaf-...:obl:a401bb14-...:4000
      spin_unpaid_backpay_log: 1.00 under_paid
(b3) direct replay of the settle: {"ok": true, "paid": 0, "already_paid": 41.00}
```

Heads-up `115b3be2` NLH Heads-Up 5 Turbo (pool 9.50, conservation delta 0.00):

```
(a) fn_backpay_hu_winner_shortfalls(5): scanned 0, paid 0
(b) INSERT tournament_conservation_baseline (115b3be2, 1.00) (rolled back) -> candidate delta 1.00
    pool_before 9.50 -> paid 1, chips 1.00 -> pool_after 10.50
    obligation place 1 owed 10.50 paid 10.50 source hu_shortfall
    wallet_transactions 1.00 prize "Heads-Up winner shortfall back-pay (NLH Heads-Up 5 Turbo)"
    tournament_payouts position 1, 1.00, hu_shortfall, key tourney:115b3be2-...:obl:5d8170dd-...:950
(b2) candidates now empty; second call scanned 0 paid 0; direct replay {"ok": true, "paid": 0, "already_paid": 10.50}
```

### C. Final-table deal

`b0328f0a` rewound inside the rollback (triggers off for the rewind only, back on before the function ran): status RUNNING, deal enabled, prize_pool 900 (400 stamped + 400 recorded = 800 awarded, so 100.00 undistributed), places 1..3 back to `playing` with 5000/3000/2000 chips.

```
fn_final_table_deal -> ok, undistributed 100.00, remainder 0.00, settled 100.00, refusals []
  payouts: 50.00 / 30.00 / 20.00, each with an obligation_id
tournament_obligations: final_table_deal, place NULL, user-keyed, 50/50, 30/30, 20/20, settled
wallet_transactions: 50.00 / 30.00 / 20.00 prize "Final table deal (even chip chop)"
tournament_payouts: position NULL, source final_table_deal, keys tourney:b0328f0a-...:obl:<id>:0
club_members delta at the entering club: +50 / +30 / +20
status COMPLETING; tournament_players.prize +50 / +30 / +20
(b) engine follow-up: settle(t, 'final_table_deal', user, amount, 'engine.settleFinalTableDeal') for each payout row -> paid 0, already_paid 50/30/20; wallet rows still 3
(c) second fn_final_table_deal -> {"ok": false, "reason": "deal_already_executed"}
```

### D. R3 logger (live trigger, rolled back)

```
(a) fn_credit_and_log(user, 0.01, 'tourney:<t>:prize:lane-a3-probe-...', 'prize', ...) -> true
    ca_money_path_violations: wallet_transactions | 09dd202d-... | 0.01 | prize | money_path NULL | app_name lane-a3-probe | db_role postgres
    ca_drift_incidents: r3:prize:2026-09-02T20 | unauthorized_adjustment | info | settlement
(b) fn_settle_tournament_obligation(t, 'place', 1, user, 153.54, 'reconcile') after prize_pool + 1.00 -> paid 0.38
    wallet rows this transaction 2 (the probe credit + the settle credit); violation rows still 1
```

## Tests

- `tests/law/DbPayersSettleThroughObligations.law.test.ts` (row in `docs/LAWS.md`): the six bodies settle through the obligation ledger and never call `fn_credit_and_log(` / `credit_player_wallet(`; the reconciler passes the full entitlement with source `reconcile`; the deal is user-keyed and writes no payout rows; the settle key names the tournament; the R3 trigger is AFTER INSERT and has no `RAISE EXCEPTION`. Negative controls mutate a passing body (call renamed, sweep turned into a dry run, logger given a RAISE) and confirm the predicate goes red.
- `npx vitest run tests/law/DbPayersSettleThroughObligations.law.test.ts tests/law-registry.law.test.ts` green; `npx tsc --noEmit` clean (root).

## Not built, and why

- **R3 enforcement (refusing the row).** Would refuse every legacy engine place payout today. Log-only; Dan-gated.
- **Backfilling obligations for the last 7 days** (standard, Lane A). The settle function seeds each obligation lazily from `tournament_payouts` the first time it is asked, which gives the reconciler the same answer without a data migration; and a backfill written from `wallet_transactions` would have to decide which of the unrecorded wallet payments (61 events, 5,515.91 chips per the sweep's own comment) are real. That is a human decision per event, not a migration.
- **`fn_collect_bounty`, `fn_finalize_bounty_pool`, `fn_mystery_bounty_pay`** (the bounty arms in the standard's Lane A list) were not in this lane's six and are untouched.
- **The two sweeps' funding side** (`fn_ca_backpay_guarantee_shortfalls` raising `prize_pool` by fiat and debiting the bank) is Lane B's escrow work; only their distribution reporting changed.

## Decisions that are Dan's

1. When to flip R3 from log to refuse (proposed: after 24h of zero engine rows in `ca_money_path_violations`).
2. Retention for `ca_money_path_violations` (it will accumulate several hundred rows an hour until the engine deploys #2671).
3. Events the reconciler now reports as `paid_without_payout_record` are owed a `tournament_payouts` backfill by hand before they can ever be reconciled; the old path would have paid them again.
