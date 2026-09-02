# 2026-09-02 chip-std controls (Lane E): kill switch, four-eyes adjustments, per-account trial balance, direct-write log

Branch `fix/chip-std-controls`. Standard: `docs/CHIP-ACCOUNTING-STANDARD.md`
sections 2.7, 3.3 (R6, R8, R9, R10), 3.4 (layers 4 and 6). Brief:
`SWARM-BRIEF-R2.md`. Dan's rule for this lane, binding: nothing here may
refuse or block live play or a legitimate payout. Everything below records,
reports, or is a switch only a person throws.

Two earlier attempts at this lane died before landing anything. Nothing of
theirs was in production; this started from the live schema
(`pg_get_functiondef` of every function it touches or depends on).

## Migrations (applied once each, in order)

| File in repo                                                                            | Recorded as (version, name)                                                       |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `supabase/migrations/20260902203000_chip_std_controls.sql`                              | `20260902200808`, `20260902203000_chip_std_controls`                              |
| `supabase/migrations/20260902204500_chip_std_controls_total_is_the_sum_of_its_rows.sql` | `20260902201134`, `20260902204500_chip_std_controls_total_is_the_sum_of_its_rows` |
| `supabase/migrations/20260902205500_chip_std_controls_a_named_actor_can_reject.sql`     | `20260902201647`, `20260902205500_chip_std_controls_a_named_actor_can_reject`     |

The second and third are one `CREATE OR REPLACE` each, for defects the first
live run and the first rolled-back probe found (below). Each was a single
transaction, applied once. The second timed out in the MCP client at 60s
(its post-apply assertion runs the 24h trial balance twice) but had committed
server-side; verified by `prosrc` and `schema_migrations` before doing
anything else, not re-applied.

No hot table was touched: three new relations, seven functions, one cron
job. No `lock_timeout` transaction was needed because item 4 became a view
(below), not a trigger on `club_members`.

## 1. `ca_payout_freeze`: the kill switch is a table a human writes

`fn_settle_tournament_obligation` already consulted
`to_regclass('public.ca_payout_freeze')` and refused every settle with
`payout_frozen` while a row with `scope = 'tournament_payouts'` and
`cleared_at IS NULL` existed. The table did not exist, so the branch was
dead. It exists now, EMPTY, with:

- `CHECK (scope IN ('tournament_payouts'))`, `CHECK (length(btrim(reason)) >= 10)`,
  `CHECK (cleared_at IS NULL OR cleared_at >= opened_at)`;
- a partial UNIQUE index `(scope) WHERE cleared_at IS NULL` so opening twice
  is idempotent and the settle function's probe is an index hit;
- RLS on, `REVOKE ALL FROM anon, authenticated`, and `INSERT/UPDATE/DELETE`
  REVOKED from `service_role` too: the only writers are the two functions.
- Extra columns beyond the brief: `opened_by_label`, `cleared_by_label`
  (application_name or a caller-supplied label, for service callers with no
  `auth.uid()`).

`fn_ca_open_payout_freeze(scope, reason, actor_label)` and
`fn_ca_clear_payout_freeze(id, actor_label)`: SECURITY DEFINER, service_role
only, management check copied from `fn_ca_incident_dashboard` into
`fn_ca_caller_is_management()` (recipient, club owner, union owner, or
admin/god profile when a JWT is present; service callers pass). Open files a
`warning` financial alert (`freeze:<id>`); clear resolves it and files an
`info` one. NOTHING opens it automatically; law test below.

### Probe transcript (one transaction, rolled back)

Tournament `da057cee` "PLO4 Heads-Up 20 Turbo" (COMPLETED), user `4de21b58`,
kind `bounty`, 0.01 chips.

| step | call                                                  | result                                                                                  |
| ---- | ----------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 0    | before                                                | open_freezes 0, wallet 414550.00                                                        |
| 1    | `fn_ca_open_payout_freeze('tournament_payouts', ...)` | ok, freeze_id 2f908111, already_open false                                              |
| 2    | open again                                            | ok, SAME freeze_id, already_open true                                                   |
| 3    | `fn_settle_tournament_obligation(... bounty, 0.01)`   | **ok false, paid 0, refused_reason `payout_frozen`**                                    |
| 4    | `fn_ca_clear_payout_freeze(2f908111)`                 | ok, cleared_at set                                                                      |
| 5    | settle again                                          | **ok true, paid 0.01**, obligation 2fd87260, key `obl:2fd87260...:0`                    |
| 6    | settle replay                                         | ok true, paid 0, already_paid 0.01                                                      |
| 7    | clear again                                           | ok false, `not_open`                                                                    |
| 8    | after                                                 | open_freezes 0, freeze_rows 1, alerts: FROZEN (warning, resolved true), UNFROZEN (info) |

Then `ROLLBACK`. Wallet, freeze table and alerts are as before.

### Found by the probe: the settle function pays into the player's HOME club, not the tournament's club (Lane A, blocking)

Step 5 paid 0.01 and the wallet in the tournament's club (`fade0000`, Midway)
stayed at 414550.00. The credit landed on the same user's membership in club
`a41434bb` (199911.51 to 199911.52). Cause, read from the live body of
`fn_credit_player_wallet_once`: it resolves the club from the idempotency key
ONLY when the key starts with `tourney:`; every other key falls through to
`fn_player_home_club(user)`. The new settle function's keys are
`obl:<obligation_id>:<n>`, so every payout it makes for a player whose home
club differs from the tournament's club posts cross-club (ledger row
`club_id` = the home club, category bounty/prize/refund).

Production has ZERO `obl:` keys in `wallet_credit_idempotency` as of 20:16
UTC, so no money has gone the wrong way yet. It will the moment an engine
payer (Lane A2) or a repair arm starts calling it. Lane A owns
`fn_settle_tournament_obligation`; the fix is either to stamp the tournament
club into `fn_credit_player_wallet_once` (a parameter or an `app.` setting)
or to give the obligation key a `tourney:<id>:` prefix so the existing club
resolution fires. Not touched here (not my function, and a wrong fix there is
a money bug).

## 2. `ca_manual_adjustments`: four eyes (R6)

Columns as briefed (`id, actor, approver, reason, amount, target_kind,
target_id, tournament_id, status, created_at, approved_at`) plus
`rejected_by, rejected_at, decision_note, actor_label, approver_label`.
CHECKs: reason >= 20 chars; `amount <> 0` at 2dp (positive credits the
target, negative debits it); `target_kind` in the ledger's account types;
status in `proposed/approved/settled/rejected`;
**`approver IS NULL OR approver <> actor`**; approved/settled rows must
carry approver + approved_at; rejected rows must carry rejected_by +
rejected_at. RLS on, service_role SELECT only; writes only through:

- `fn_ca_propose_manual_adjustment(reason, amount, target_kind, target_id, tournament_id, actor, actor_label)`
- `fn_ca_approve_manual_adjustment(id, approver, approver_label, note)`:
  approver = `auth.uid()` or the named actor; refuses `four_eyes_violated`
  when approver = actor and files a warning alert saying who tried;
- `fn_ca_reject_manual_adjustment(id, note, rejecter, rejecter_label)`: a
  proposer may withdraw their own (does not touch `approver`).

`fn_settle_tournament_obligation` already accepts `p_adjustment_id` and
ignores it. **Follow-up for Lane A3 (owns that function today): when
`p_adjustment_id` is non-null, require a `ca_manual_adjustments` row in
status `approved` with matching `tournament_id` (and amount), and set it to
`settled` on payment; when it is null and the caller is not an engine payer,
refuse.** Not done here.

### Probe transcript (one transaction, rolled back)

| step | call                                                        | result                                                                                                     |
| ---- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1    | propose with a 9-char reason                                | ok false, `reason_too_short`                                                                               |
| 2    | agent-a proposes +10 to player_wallet                       | ok, id e1297514, status proposed                                                                           |
| 3    | agent-a approves its own                                    | ok false, **`four_eyes_violated`**                                                                         |
| 4    | direct `UPDATE ... SET approver = actor` (bypassing the fn) | **23514 `ca_manual_adjustments_four_eyes`** (caught in a sub-block)                                        |
| 5    | agent-b approves                                            | ok, status approved, approver 2222...                                                                      |
| 6    | agent-c approves again                                      | ok false, `not_proposed` (status approved)                                                                 |
| 7    | agent-a proposes -5 to club_treasury, then withdraws it     | ok, status rejected, rejected_by agent-a                                                                   |
| 8    | rows                                                        | [approved: actor agent-a, approver agent-b, 10.00], [rejected: agent-a, -5.00]                             |
| 9    | alerts                                                      | PROPOSED (info, resolved by the reject), APPROVED (info), Self-approval REFUSED (warning), PROPOSED (info) |
| 10   | wallet sum for the target user                              | 639441.51, unchanged (no row here moves money)                                                             |

The first run of step 7 raised `23503 financial_alerts_resolved_by_fkey`:
the reject resolved the board row with `resolved_by = the rejecter`, and that
column is a foreign key to `auth.users`, which a named service actor is not.
Fixed in the third migration (`resolved_by = auth.uid()`, NULL for service
callers; who rejected is on the row). Probe re-run green as tabled.

## 3. `fn_ca_trial_balance(p_since)`: the trial balance names the account (R8, R9)

Returns one row per account: `balance_delta` (from `ca_supply_snapshots`,
the snapshot at/after `p_since` to the latest), `ledger_net` (chip_ledger
rows in that window, in minus out for the account's types), `difference`,
`writers` (top five `application_name/db_role` pairs by row count touching
the account, from `fn_ca_chip_ledger_enrich`'s `actor_service`/`db_role`
stamps), and the window bounds. Rows with `category = 'correction'` posted
via `fn_ca_post_correction` are excluded, as the snapshot excludes them.
`total_supply` is the SUM of the account rows (standard 1.2), against
issuance (`fn_ca_noncirculating_chip_stores`).

### The mapping

| account               | balance column (`ca_supply_snapshots`) | chip_ledger `from_type`/`to_type`                                            |
| --------------------- | -------------------------------------- | ---------------------------------------------------------------------------- |
| player_wallets        | member_wallets                         | player_wallet                                                                |
| promo_wallets         | member_promo                           | promo_wallet                                                                 |
| table_stack           | felt                                   | table_stack                                                                  |
| tournament_liability  | tournament_liability                   | prize_liability, bounty_liability, refund_payable                            |
| bbj_pools             | bbj_pools                              | bbj_pool                                                                     |
| spin_reserve          | spin_pools                             | spin_reserve                                                                 |
| club_treasuries       | treasuries                             | club_treasury                                                                |
| club_chip_pools       | chip_pools                             | (none: `clubs.chip_pool` has no ledger type)                                 |
| union_banks           | union_wallets                          | union_bank, union_wallet, insurance_bank                                     |
| agent_wallets         | agent_wallets                          | agent_wallet                                                                 |
| club_wallets          | club_wallets                           | club_wallet                                                                  |
| leaderboard_liability | leaderboard_liability                  | opening_setup, leaderboard_round                                             |
| settlement_suspense   | (no balance; always 0)                 | settlement_suspense                                                          |
| total_supply          | sum of the rows above                  | mint minus burn: system_mint, system_burn, issuance_reserve, chip_retirement |

Deliberately unmapped: `escrow` (chip_escrow, cashier withdrawals, not in
the snapshot), `rakeback_payable`, `credit_facility`, `credit_receivable`
(none used in the last 7 days).

### The table, last 24h (window 2026-09-01 21:05:02 to 2026-09-02 20:05:01 UTC)

| account               | balance_delta | ledger_net | difference | writers                                                                     |
| --------------------- | ------------- | ---------- | ---------- | --------------------------------------------------------------------------- |
| agent_wallets         | 0.00          | 0.00       | 0.00       |                                                                             |
| bbj_pools             | 3546.97       | 3546.97    | 0.00       | PostgREST 14.5/postgres:39253, pg_cron/postgres:42                          |
| club_chip_pools       | 0.00          | 0.00       | 0.00       |                                                                             |
| club_treasuries       | -57254.07     | -57254.07  | 0.00       | PostgREST 14.5/postgres:21034, mgmt-api/postgres:1                          |
| club_wallets          | 6610.23       | 6610.23    | 0.00       | PostgREST 14.5/postgres:4411                                                |
| leaderboard_liability | 0.00          | 0.00       | 0.00       |                                                                             |
| player_wallets        | -4594.63      | -4594.63   | 0.00       | PostgREST 14.5/postgres:30431, mgmt-api/postgres:1364, pg_cron/postgres:13  |
| promo_wallets         | 0.00          | 857.36     | -857.36    | PostgREST 14.5/postgres:241                                                 |
| settlement_suspense   | 0.00          | 176761.56  | -176761.56 | PostgREST 14.5/postgres:4110, mgmt-api/postgres:1                           |
| spin_reserve          | -1161.52      | -1161.52   | 0.00       | PostgREST 14.5/postgres:6290, mgmt-api/postgres:1                           |
| table_stack           | 50044.17      | 60936.90   | -10892.73  | PostgREST 14.5/postgres:100314, mgmt-api/postgres:1191, pg_cron/postgres:57 |
| total_supply          | 17303.72      | 0.00       | 17303.72   |                                                                             |
| tournament_liability  | 0.50          | -205772.37 | 205772.87  | PostgREST 14.5/postgres:11842, mgmt-api/postgres:208                        |
| union_banks           | 20112.07      | 20069.57   | 42.50      | PostgREST 14.5/postgres:14606, mgmt-api/postgres:34, pg_cron/postgres:2     |

What it says, account by account:

- **Exact to the cent**: player_wallets, club_treasuries, club_wallets,
  bbj_pools, spin_reserve, agent_wallets. The ledger writers on those
  columns are complete.
- **union_banks +42.50**: union balance moved 42.50 more than the ledger
  says. Standard 2.1 already names the back-pay function that writes with
  `ledger_autoskip`.
- **promo_wallets -857.36**: the ledger type `promo_wallet` is shared by
  `club_members.promo_balance` (in the snapshot) and `clubs.promo_balance`
  (NOT in the snapshot; funded ~857/day from settlement_suspense by the
  `auto-ledgered clubs.promo_balance` rows). Every chip of this row is club
  promo pool funding. `clubs.promo_balance` is a chip store the supply
  identity does not count; for Dan (below).
- **table_stack -10,892.73 and tournament_liability +205,772.87**: the two
  halves of one structural fact. Tournament buy-ins are journaled
  `player_wallet -> table_stack` (the ledger writer's DEFAULT counterparty,
  because the registration path declares no `app.ledger_counterparty`),
  prizes `table_stack -> player_wallet`, and spins `prize_liability ->
spin_reserve` without a matching credit to prize_liability at entry. The
  felt gets the tournament traffic the liability account should have. This
  is exactly what Lane B's `tournament_escrow` fixes; until then these two
  rows will fire an info incident every day, and that is correct.
- **settlement_suspense -176,761.56 (R9)**: 4,110 rows in 24h parked money
  in suspense, 3,268 of them `spin_reserve -> settlement_suspense` spin
  prizes (184,142.00 in the earlier 24h sample). R9 says this must be zero.
  It is not, by a lot, every day, and the row now says so with the writer.
- **total_supply +17,303.72 with issuance 0.00**: the same leak the standard
  measures at ~500/hour (here ~720/hour). Now decomposed: it is the sum of
  the rows above, which is the point of the function.

### `fn_ca_trial_balance_watch()` hourly

pg_cron `ca-trial-balance-hourly`, `20 * * * *`, under an advisory lock.
Default window `now() - 75 minutes` so at :20 it compares the :05 snapshot
of the previous hour with the :05 snapshot of this hour. Files one
**info** incident per account with `|difference| > 100`, dedupe
`tb:<account>:<YYYY-MM-DD>` (one per account per UTC day; recurrences bump
`occurrences`), source `fn_ca_trial_balance_watch`, classification
`ledger_imbalance`, layer `ledger`, metadata carrying the four numbers, the
writers and the window. Never critical, never a push
(`fn_ca_raise_drift_incident` does not notify for info). `total_supply` is
left to `fn_ca_supply_snapshot`, which already files `supply-unexplained`.
Swallows its own errors with a WARNING and returns -1 so a cron failure is
visible in `cron.job_run_details`, never a stuck lock.

### Found by the first live run: the stored total was re-based

The first 24h run reported `total_supply` balance_delta 4,364,262.71 with
issuance 0.00. The per-account rows were sane. `ca_supply_snapshots.total`
was re-based at 2026-09-01 23:45:22 UTC (a snapshot with `delta_vs_prev`
NULL): before it, `total` sat 4,350,390.20 BELOW the sum of its own
component columns; after it, `total` equals that sum to the cent. Fixed in
the second migration: `total_supply` is now the sum of the per-account
deltas the same call reports, which is the identity in standard 1.2 and is
immune to any future re-basing of the stored column. Post-apply assertion:
total row = sum of the others over 24h, green.

## 4. `ca_direct_balance_writes`: a view, not a trigger (R10, log-only)

Checked before building, as the brief asked. `fn_club_members_ledger_writer`
already journals every `club_members.chip_balance` write that arrives with
no `app.ledger_category` as category `adjustment` with description
`auto-audited club_members.chip_balance delta <d>`, and
`fn_ca_chip_ledger_enrich` (BEFORE INSERT on chip_ledger) already stamps
`actor_service = current_setting('application_name')` and `db_role =
current_user` on every ledger row. So the evidence the brief wants is
already captured, and `ca_direct_balance_writes` is a `security_invoker`
VIEW over `chip_ledger` (`at, table_name, user_id, delta, application_name,
db_role, club_id, tournament_id, ledger_id, description`), service_role
SELECT only. No new trigger on `club_members`, no `lock_timeout` migration,
nothing that can refuse.

What the view cannot show, honestly: `app.money_path` (the brief's first
condition; it is not journaled anywhere, so the view is a superset that
includes writes made under a money path that declared no category) and
`session_user` (every ledger row shows `db_role = postgres` because the
writer trigger is SECURITY DEFINER and stamps `current_user`). Rows whose
declared category was REJECTED by the CHECK (description ends `rejected)`)
are excluded: they declared something. If `session_user` matters, the
follow-up is a statement-level trigger, which is a Dan-approved hot-table
change.

### Count, last 24h, by application_name

| application_name | db_role  | rows   | credits | debits | net         |
| ---------------- | -------- | ------ | ------- | ------ | ----------- |
| PostgREST 14.5   | postgres | 19,875 | 504     | 19,371 | -401,194.00 |
| pg_cron          | postgres | 9      | 9       | 0      | +1,693.35   |
| mgmt-api         | postgres | 1      | 1       | 0      | +24.00      |

Sampled 300 of the PostgREST rows against `wallet_transactions` within 2s:
293 are tournament buy-ins (`tournament_buyin` debit), 4 bounty credits, 3
rebuys. So "direct writes" today are overwhelmingly the tournament
registration path debiting the wallet through the ledger writer's default
(category `adjustment`, counterparty `table_stack`) rather than declaring
`tournament_buyin` / `prize_liability`. That is Lane B's path and is the
single biggest reason the `tournament_liability` and `table_stack` rows above
do not reconcile. The 9 pg_cron credits (1,693.35) are worth a look by
whoever owns the cron repair arms: a scheduled job credited wallets with no
category declared.

## Law test

`tests/law/PayoutFreezeIsHumanOnly.law.test.ts` (row in `docs/LAWS.md`):
scans EVERY migration in the repo and fails if any `INSERT INTO
ca_payout_freeze` lies outside the body of `fn_ca_open_payout_freeze`, if any
`cron.schedule` body or any other function body calls the opener, and pins
that the controls migration asserts the table is created empty and that the
settle function still consults it. Negative controls: an INSERT appended as
a DO block is caught; an INSERT smuggled inside `fn_ca_trial_balance_watch`'s
loop is caught; the genuine file passes.

## Tests run

    npx vitest run tests/law/PayoutFreezeIsHumanOnly.law.test.ts tests/law-registry.law.test.ts
    npx tsc --noEmit

Output in the PR body.

## Not built, and why (Dan's rule)

- **R10 proper (`REVOKE UPDATE` on balance columns from non-definer
  roles).** Can refuse a live path. The 19,875 PostgREST rows above are the
  engine's own tournament registrations arriving as "direct" writes; a
  REVOKE today would block buy-ins. Log-only shipped (the view).
- **Automatic kill switch (standard 3.4 layer 6).** An opener driven by the
  trial balance would have fired on the re-based total at 23:45 UTC last
  night and refused every payout for as long as it took someone to notice.
  The threshold is Dan's (standard 6.2). Only the human opener exists, and
  the law test keeps it that way.
- **Wiring `p_adjustment_id` into `fn_settle_tournament_obligation`.** Lane
  A3 owns the function today; spec above.
- **Alert-board owner / auto-resolve / SLA (standard 5, Lane E).** Touches
  `financial_alerts` semantics every detector relies on; not a low-risk
  control and not started.
- **`chip_ledger(created_at)` index.** The trial balance and the supply
  snapshot both range-scan `chip_ledger` by `created_at` with no index on
  it (454,504 rows, 311 MB, 0.6s per scan today). `CREATE INDEX
CONCURRENTLY` cannot run inside a migration transaction; leaving it as a
  suggestion rather than a locking `CREATE INDEX` on a hot table.

## For Dan (retirements and decisions; nothing retired in this lane)

1. **Retire `chip_escrow_holds`** (standard 2.1: FK to the dead `wallets`
   pool, zero callers), **`chip_supply_snapshots`** (superseded by
   `ca_supply_snapshots`), **`atomic_tournament_register`** and
   **`fn_tournament_atomic_register`** (superseded register paths). Each is
   a DROP; each needs a "nothing reads it" sweep on the day.
2. **Kill switch threshold and automation.** The switch is built and
   human-only. If you want a detector to throw it, say the threshold and
   accept that a false alarm refuses every tournament payout until cleared.
3. **`clubs.promo_balance` is outside the supply identity.** It is funded
   ~857 chips/day from settlement_suspense and counted nowhere. Either add
   it to `fn_ca_supply_snapshot` as a component or say it is not circulating.
4. **settlement_suspense is +176K/day, almost all spin prizes.** R9 says
   zero. The spin settle path should credit `prize_liability` (or Lane B's
   escrow) directly; until it does, the daily info incident on this account
   is the record.
5. **The cross-club payout in `fn_credit_player_wallet_once`** (section 1
   above) is a Lane A blocker, not a decision, but you should know it exists
   before any payer is pointed at the settle function.

## Cron result (first scheduled run, 2026-09-02 20:20 UTC)

`cron.job_run_details`: started 20:20:00.69, ended 20:20:08.17, succeeded.
Window 19:05 to 20:05. Three info incidents filed, none critical, no push:

| dedupe_key                         | discrepancy | suspected_cause (as filed)                                                                                                                                     |
| ---------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tb:settlement_suspense:2026-09-02  | -6050.00    | settlement_suspense moved 0.00 in its balance column but 6050.00 in the ledger between 19:05 and 20:05; writers PostgREST 14.5/postgres:144                    |
| tb:table_stack:2026-09-02          | -4208.12    | table_stack moved 32191.62 in its balance column but 36399.74 in the ledger between 19:05 and 20:05; writers PostgREST 14.5/postgres:8897, pg_cron/postgres:26 |
| tb:tournament_liability:2026-09-02 | 10265.70    | tournament_liability moved 4764.00 in its balance column but -5501.70 in the ledger between 19:05 and 20:05; writers PostgREST 14.5/postgres:322               |

The other ten accounts were within 100 chips for the hour. The next 23 runs
today will bump `occurrences` on these three keys rather than file again.
