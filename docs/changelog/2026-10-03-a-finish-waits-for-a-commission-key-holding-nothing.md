# A finish waits for a commission key holding nothing (2026-10-03)

Migration `20261003201157`. Law `tests/a-finish-waits-for-a-commission-key-holding-nothing.law.test.ts`.

## What production said

- A finish waited for a cash batch's `agent-commission:<club>` key inside recognition. That wait came after `increment_union_wallet` had taken the union's single `union_wallets` row, so every raked hand in the union queued behind a finish that was itself only waiting. Measured: 123 finish waits on that key between 19:00 and 20:10 UTC, and 166 `union_wallets` statement timeouts on hands between 19:20 and 19:40.
- The credit cannot move to the end of the transaction. Recognition needs the id of the `union_wallet_transactions` row the credit writes, and every rake evidence row is refused once the tournament is COMPLETED.
- From existing rows (receipt `settled_at`, obligation-event and manager-wake `clock_timestamp()` markers, and hands' lock-acquired times), p50 for the steps of one finish:

| step                                                                        | p50                     |
| --------------------------------------------------------------------------- | ----------------------- |
| transaction start to first payout                                           | about 0.55 s            |
| first payout to the COMPLETED stamp (rake and the union credit happen here) | about 0.8 s (p95 2.5 s) |
| stamp to the seat-clearing triggers                                         | about 0.2 s             |
| stamp to commit (when hands are released)                                   | 0.8 to 1.9 s            |

## What changed

`fn_ca_await_commission_keys_free(tournament)` waits for those keys without holding them. It takes a shared session lock, which is granted only when no exclusive holder remains, and releases it on the next statement. It is called twice:

- by `fn_complete_tournament_terminal`, before it asks for the finish lane;
- by `fn_settle_tournament_rake`, immediately before the union credit.

The keys are still taken where they always were. Nothing new is held, the money paths and checks are unchanged, and the engine is unchanged.
