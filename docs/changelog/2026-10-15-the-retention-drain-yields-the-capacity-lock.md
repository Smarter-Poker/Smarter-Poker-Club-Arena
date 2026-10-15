# The Retention Drain Yields The Capacity Lock

## What Was Wrong

`scripts/ci/drain-horse-adaptive-retention.mjs` called
`public.fn_prune_horse_adaptive_journal()` back to back with no pause between
successful calls. The owner holds the advisory lock
`horse-adaptive-work-capacity-v1` for its whole call (about 5 seconds on the
grouped retirement path), and the engine's journal writes,
`fn_queue_horse_adaptive_batch` and `fn_append_horse_adaptive_observations`,
only try that lock and give up at once when it is held.

Measured on production on 2026-10-15:

| Window (UTC) | Drain running | Observation batches recorded |
| --- | --- | --- |
| 05:00 to 05:40 | no | 140 |
| 05:40 to 11:20 | yes (run 38688005802, from 05:40) | 9 |
| 11:20 to 11:50 | no | 119 |
| 11:50 to 14:35 | yes (run 38717431723) | 2 |

One queued journal batch was deferred 91 times between 12:56 and 14:34, and
the engine reported the capture lane as `deferred`. While ingestion was
starved, hands kept qualifying and being retired. Their observations are then
refused by the enqueue as `retention_compacted`, so the starvation was not
only a delay.

The engine's own retention lane never collides like this: it runs a journal
work item and then a retention call, one after the other, in a single loop.
Only an outside caller can hold the lock continuously.

## The Fix

`scripts/ci/horse-adaptive-drain-yield.mjs` holds the policy and the drain
follows it:

- before every owner call it reads, read-only, whether any journal work is
  queued and due within two seconds, or leased and in flight; if so it waits
  two seconds and asks again instead of taking the lock;
- after every owner call it stays off the lock for at least as long as the
  call held it (minimum 1 second, maximum 10), so the engine has at least half
  of the time, and all of it whenever it has work waiting.

The owner function, its budgets and every retention rule are unchanged. The
drain still adds no SQL logic beyond that read.

`tests/the-retention-drain-yields-the-capacity-lock.test.ts` pins the pause
and the order (ready-work check, then the call, then the pause).

## Note

A drain run already in progress, or queued, keeps the script of the commit it
was dispatched from. Those runs have to be cancelled to stop the starvation;
this change only governs later dispatches.
