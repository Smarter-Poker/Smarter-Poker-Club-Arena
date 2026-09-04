# 2026-09-03 - Chip Accounting Standard, Phase 2, lane 2.5: doors closed (F9) and the adjustments report (F10, advisory)

Branch `fix/chip-std-p2-doors-closed`. Audit: `docs/audits/2026-09-02-chip-standard-round2/lane2-hierarchy.md` sections 2.2 and 3.1.

Migration `20260903201301_two_orphan_money_doors_are_closed_and_manual_movements_are_reported.sql`, applied to production 2026-09-03 20:13 UTC in one transaction with a self-check, mirrored byte-exact (body md5 `ae835e61e769467b74a2433aa48dc9fd`, 23,576 bytes, plus one trailing newline).

Law: `tests/a-money-door-nothing-calls-is-closed.law.test.ts` (18 tests).

## Part A - F9: the seven orphan doors, re-verified one by one

Method for each: live grants via `has_function_privilege`; grep of the bare name across club-arena `src/`, `server/src/`, `supabase/functions/` and World Hub `pages/api/`, `src/`, `lib/`; every other `pg_proc` body; `cron.job`; triggers; and 30 days of `chip_transactions`, `wallet_transactions`, `union_wallet_transactions` shaped the way each function writes. `pg_stat_user_functions` is EMPTY on production: `track_functions = none`, and `pg_stat_get_db_stat_reset_time` is NULL, so call counts were not available and the ledgers were the evidence.

| Function                                                           | Grants before (pub/anon/auth/svc) | Callers found                                                                                                                                                               | 30-day ledger evidence                                                                                                                                         | Decision                                                                                                                                      |
| ------------------------------------------------------------------ | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `fn_wallet_claim_back(uuid,uuid,numeric,text,text,text,text)`      | f/f/T/T                           | none (only a comment inside `fn_cashier_claim_back`)                                                                                                                        | 0 rows of `club_bank_claim` / `promo_claim` / `agent_claim` with its metadata shape                                                                            | CLOSED: revoked from PUBLIC, anon, authenticated, service_role                                                                                |
| `fn_union_send_chips_to_club(uuid,uuid,numeric,text)`              | f/f/f/T                           | none (comments only: `UnionDashboardPage.tsx:2169`, WH `union-wallet.js:106`, `mint_club_chips` body)                                                                       | 0 `union_wallet_transactions` rows with `tx_type='send_to_club'` or `wallet='main'`                                                                            | CLOSED: revoked from PUBLIC, anon, authenticated, service_role                                                                                |
| `fn_cashier_claim_back(uuid,uuid,numeric,text,text)`               | f/f/f/T                           | none since #871 (2026-08-25) rewired `CashierTradePage`                                                                                                                     | ONE call: `peer_transfer` 1.00 chip, 2026-08-21 02:27:51, notes "Trade view verification claim 2", two matching `wallet_transactions` rows - the pre-#871 page | NOT TOUCHED: a call inside 30 days. Eligible 2026-09-21                                                                                       |
| `fn_union_send_to_club_atomic(uuid,uuid,numeric,text,uuid,uuid)`   | f/f/f/T                           | LIVE: WH `pages/api/club-arena/union-wallet.js:260` (`supabaseAdmin.rpc`)                                                                                                   | 0 `manual_transfer` rows in 30 days                                                                                                                            | NOT TOUCHED: live caller                                                                                                                      |
| `fn_union_deposit_from_wallet(uuid,numeric,text,uuid)`             | f/f/T/T                           | LIVE: `src/pages/UnionDashboardPage.tsx:1834` (`supabase.rpc`, browser)                                                                                                     | 0 `owner_deposit` rows                                                                                                                                         | NOT TOUCHED: live caller (the audit says it raises at runtime because `wallets` is frozen; that is for its owner to fix, not this lane)       |
| `mint_club_chips(uuid,numeric,uuid,numeric,text)`                  | f/f/f/T                           | WH `pages/api/club-arena/mint-chips.js:247` in a block marked `LEGACY (unreachable ...)`; `guard_wallet_balance_write` allow-list names it                                  | 0 `mint` rows into `chip_pool`                                                                                                                                 | NOT TOUCHED: a textual caller exists; already service_role only. Remove the dead block in World Hub first, then revoke                        |
| `calculate_cascading_commission(uuid,uuid,uuid,numeric,uuid,uuid)` | T/T/T/T                           | LIVE: `settle_hand_atomically` (pg_proc), WH `record-rake.js:104`, WH `LobbyManager.js:1016`, `src/services/CommissionService.ts:293` (wrong parameter names, but a caller) | commission accrual, not a chip movement                                                                                                                        | NOT TOUCHED: live callers. Its anon + PUBLIC EXECUTE is reported for a follow-up once the browser caller in `CommissionService.ts` is retired |

Grants after (pub/anon/auth/svc): `fn_wallet_claim_back` f/f/f/f, `fn_union_send_chips_to_club` f/f/f/f, `proacl = {postgres=X/postgres}` on both. Every other row unchanged. `fn_agent_wallet_send` (the live door beside them) f/f/T/T before and after.

### Registry and drift

- `ca_money_rpc_registry.status` already existed (`text default 'approved'`, CHECK approved/legacy/retired/system). The CHECK gained `closed`; no existing row changed value. The two closed doors are `status='closed'` with a dated note.
- `fn_ca_money_rpc_drift` keeps its body byte for byte and gains one loop: a registry row with `status='closed'` whose function is executable by anon, authenticated or service_role raises `rpc-closed-door-open:<name>` through `fn_ca_raise_drift_incident` and is returned, which also fails `fn_ca_epoch3_preflight` and `fn_ca_midway_burnin_gate` (both count its rows). Run after apply as service_role: 0 rows.

### Probe transcript (BEGIN ... ROLLBACK, production, 2026-09-03 20:16 UTC)

```
request.jwt.claims = {sub: <a non-admin profile>, role: authenticated}; SET LOCAL ROLE authenticated
auth.uid()/auth.role()                                                   04e36aea-... / authenticated
has_function_privilege fn_wallet_claim_back as authenticated             false
has_function_privilege fn_union_send_chips_to_club as authenticated      false
has_function_privilege fn_ca_adjustments_report as authenticated         false
has_function_privilege fn_agent_wallet_send as authenticated (live door) true
CALL fn_wallet_claim_back as authenticated                               refused: 42501 permission denied for function fn_wallet_claim_back
CALL fn_union_send_chips_to_club as authenticated                        refused: 42501 permission denied for function fn_union_send_chips_to_club
CALL fn_ca_adjustments_report as authenticated non-management            refused: 42501 permission denied for function fn_ca_adjustments_report
RESET ROLE; request.jwt.claims = {role: service_role}; SET LOCAL ROLE service_role
has_function_privilege fn_wallet_claim_back as service_role              false
has_function_privilege fn_union_send_chips_to_club as service_role       false
fn_ca_adjustments_report() as service_role, last 1 day                   rows=320 total=3891394.00 single_actor=320 max=1030092.00
fn_ca_money_rpc_drift() as service_role (rows returned)                  0
ROLLBACK
```

## Part B - F10: `fn_ca_adjustments_report(p_since timestamptz default now() - interval '1 day')`

Read side only. One row per ledger row: `source, moved_at, actor, action, from_account, from_entity, to_account, to_entity, amount, club_id, union_id, reference, single_actor, row_id`. SECURITY DEFINER, `search_path = public, pg_temp`, STABLE, revoked from PUBLIC/anon/authenticated, granted to service_role, and for a JWT caller the same gate as `fn_ca_post_correction` (`ca_incident_recipients.active` or `profiles.role in (admin, god)`). No INSERT/UPDATE/DELETE, no cron, no threshold. `single_actor` is true unless an APPROVED `ca_manual_adjustments` row by a different person matches the reference, `metadata.adjustment_id`, or the target and amount within seven days (the table has 0 rows today, so every row is single actor).

Sources: `chip_transactions` (the manual hierarchy types only - sends, claims, grants, mints, corrections, treasury credits/debits, union transfers and P&L; never cashout, buy-ins, rake, sweeps), `union_wallet_transactions` (manual types), `ca_mint_ledger` (every row; its asset is diamonds today), `chip_ledger` (mint, club_bank_send, club_bank_claim, agent_send, agent_claim, union_settlement, union_send, correction, reversal, and `adjustment` only when the description is not `auto-%` - the autoledger writes 148,433 `adjustment` rows a week of table activity). The same movement can appear from two sources; `source` keeps them apart.

### The 7-day numbers for the threshold decision (2026-08-27 20:20 to 2026-09-03 20:20 UTC)

All rows single actor (`ca_manual_adjustments` is empty).

| Band            | All sources: rows / total | Chips only (excluding `ca_mint_ledger`, which is diamonds): rows / total |
| --------------- | ------------------------- | ------------------------------------------------------------------------ |
| every movement  | 814 / 27,288,553.48       | 499 / 23,797,177.48                                                      |
| above 10,000    | 66 / 22,726,765.26        | 63 / 19,636,489.26                                                       |
| above 100,000   | 36 / 19,726,765.26        | 33 / 16,636,489.26                                                       |
| above 1,000,000 | 5 / 10,590,276.00         | 2 / 7,500,000.00                                                         |

By source and action: `chip_transactions.agent_wallet_send` 414 rows / 12,840,000 (max 600,000); `chip_transactions.club_bank_send` 2 / 7,500,000 (max 3,750,000); `ca_mint_ledger mint/diamonds` 213 / 2,165,684 (max 1,030,092); `ca_mint_ledger burn/diamonds` 102 / 1,325,692; `chip_transactions.club_opening_grant` 13 / 1,300,000 (13 x 100,000); `chip_ledger.mint` 11 / 1,100,000; `chip_ledger.correction` 7 / 600,018 (max 100,000); `chip_transactions.agent_wallet_self_stake` 32 / 320,000 (max 10,000); `union_wallet_transactions adjustment/debit` 1 / 136,489.26; `chip_ledger.reversal` 16 / 360; `chip_transactions.treasury_debit` 3 / 310.22.

Largest single-actor movements:

| Amount       | When                | Actor (role)                         | Action            | From -> to                      | Club                                |
| ------------ | ------------------- | ------------------------------------ | ----------------- | ------------------------------- | ----------------------------------- |
| 3,750,000    | 2026-09-01 14:02:19 | kingfish (god)                       | club_bank_send    | club_bank -> agent_wallet       | Deep Stack Society                  |
| 3,750,000    | 2026-09-01 14:02:18 | kingfish (god)                       | club_bank_send    | club_bank -> agent_wallet       | Deep Stack Society                  |
| 1,030,092    | 2026-09-03 01:05    | (no actor recorded)                  | mint/diamonds     | issuance_reserve -> circulation | - (baseline:diamonds:2026-09-03:v2) |
| 1,030,092    | 2026-09-03 01:05    | (no actor recorded)                  | burn/diamonds     | house -> issuance_reserve       | - (baseline reversal)               |
| 1,030,092    | 2026-09-03 00:22    | (no actor recorded)                  | mint/diamonds     | issuance_reserve -> house       | - (baseline)                        |
| 600,000 x 30 | 2026-09-01 14:02    | lyricmontrose and a9ff80c3... (user) | agent_wallet_send | agent_wallet -> agent_wallet    | Deep Stack Society                  |

Reading for Dan: a threshold of 100,000 would have put 33 chip movements in the last week in front of a second pair of eyes (the two 3.75M bank sends, the thirty 600,000 agent sends, one 136,489 union adjustment); 1,000,000 would have caught two. Every `ca_mint_ledger` row of the week carries `performed_by = NULL`, so the mint register cannot name an actor until that is fixed.

## Not built, and why

- `fn_cashier_claim_back`, `fn_union_send_to_club_atomic`, `fn_union_deposit_from_wallet`, `mint_club_chips`, `calculate_cascading_commission`: a caller or a 30-day call exists (table above). The lane rule is do not touch; each is reported with its evidence.
- No threshold, no blocking, no `ca_manual_adjustments` gate on any door: roadmap decision 6 is Dan's.
- Nothing scheduled: the report is a function; a daily job is a one-line `cron.schedule` once Dan wants it delivered.
- Nothing dropped: the roadmap drops after one clean week.
- The report's `single_actor` join is by reference, adjustment_id, or target+amount within 7 days; a stricter link needs the writing doors to record an `adjustment_id`, which is the enforcement side.
