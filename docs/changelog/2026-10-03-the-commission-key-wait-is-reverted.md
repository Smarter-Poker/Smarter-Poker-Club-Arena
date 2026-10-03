# The commission key wait is reverted (2026-10-03)

Migration `20261003232001` reverts `20261003201157`.

That change made a finish wait for busy commission keys, holding nothing, before it took its lane and again before the union credit. Measured from 21:18 to 21:50 UTC against 21:10 to 21:17:

| measure                                   | before       | after                     |
| ----------------------------------------- | ------------ | ------------------------- |
| Spin/SNG p50                              | 2.8 to 2.9 s | 10.2 to 11.2 s            |
| union_wallets timeouts per 10 min         | 4            | 1 to 13 (no clear change) |
| in-finish commission-key waits per 10 min | 0 to 23      | 0 to 40                   |
| new holding-nothing waits per 10 min      | none         | 40 to 94                  |

Two things defeated it. A cash batch takes the key again between the early wait and the trigger that needs it, so a finish waited twice. And the engine sends one finish per club at a time, so a wait before the lane still blocks the club's queue.

Both function bodies return to their exact earlier md5s, and the helper is dropped.
