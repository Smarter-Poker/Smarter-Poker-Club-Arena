# A deleted-wallet return takes the lock the stage holds (2026-10-17)

## What happened

The 2026-10-05 Midway union close paid rounds 1 and 2. Both attempts that
reached round 3 (12:15 and 15:10 UTC) were rolled back with the same error:

    deadlock detected ... while locking tuple in relation "clubs"
    fn_ca_deleted_wallet_bank_return line 32
    fn_settle_accounting_rakeback_stage line 352
    fn_settle_round3_agents_to_players

The rakeback stage locks each paying club `FOR NO KEY UPDATE`, then every
routed wallet `FOR NO KEY UPDATE`, and pays. Then, for a deleted account
among those wallets, it calls `fn_ca_deleted_wallet_bank_return`, which asked
for the same rows again `FOR UPDATE`. That is a stronger lock: it conflicts
with `FOR KEY SHARE`, which every insert into a table with a foreign key to
`clubs` takes (`agent_commissions`, `rake_records`,
`accounting_cash_rake_sources`, `chip_transactions` and others, on every
hand). A hand holding that key share and waiting on a wallet the stage
already held closed the cycle.

A deadlocked close also waits for the next :40 tick, because job 272 re-runs
a failed close every 5 minutes only after a time-budget failure.

## The fix

`20261017161610` changes those three locks to `FOR NO KEY UPDATE`. The
function only changes balance columns, so that is the lock its own `UPDATE`s
take, and the lock the stage already holds. Nothing else changes: lock order,
amounts, checks, refusals, receipts, ledger declarations and return values.

The function is not one of the 40 sealed inventory sources. The sealed
`original_erased_cash_base_discharge` pins an older body (`bccd3022`). The
live body has differed from that pin since `20261017065530`, and the
discharger has had no caller since its 7 discharges ended on 2026-10-13.

## Verified

- `scripts/ci/fixtures/deleted-wallet-return-lock/reproduce.sh` (two real
  sessions on native PG16): with the late `FOR UPDATE` the stage dies with
  40P01 "while locking tuple in relation clubs"; with `FOR NO KEY UPDATE`
  both commit and the balances are exact.
- The migration runs twice on native PG16 from the live preimage
  (`975a6eb2`). The postimage is `43efd888`, matching the read-only
  production derivation. ACL, `SECURITY DEFINER` and config are unchanged.

## Pinned by

`tests/a-deleted-wallet-return-takes-the-lock-the-stage-holds.law.test.ts`.
