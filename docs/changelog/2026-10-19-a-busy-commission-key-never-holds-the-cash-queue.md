# A busy commission key never holds the cash queue (2026-10-19)

Migration `20261019171753_a_busy_commission_key_never_holds_the_cash_queue`. Law: `tests/a-busy-commission-key-never-holds-the-cash-queue.law.test.ts`. This is a database change only; the engine is unchanged.

## What happened

After `20261019094914` was installed at 15:11 UTC, the cash refusal queue kept draining in order through the afternoon. Every retry receipt from 15:00 to 17:00 was yesterday's Lightning Internal Pilot refusals, run fewest refusals first and then oldest first.

At about 17:00 the front of the queue became one Lightning source (`9fa74288`, due since 10-18 15:44) followed by four Midway sources refused by a lock just after midnight. Behind them were about 2,590 other sources at their first attempt, including today's 23 deadlock refusals.

From that point the retry could stop on every call. Two things in `20261019094914` combined to do it:

1. **The key walk stopped at the first busy key.** Clubs are walked in uuid order, and Midway's three clubs have the lowest uuids. One busy Midway key therefore deferred every item after it in the walk, including the Lightning source, which needs only its own free key.
2. **The retry read exactly five due sources**, and a deferral leaves a source's queue position unchanged. When those five waited on one busy key, the call ran nothing, the same five came back first next time, and nothing behind them was ever reached.

The page batch had the same walk. A page item that needed only a free key was deferred whenever an unrelated lower key was busy, and three such resubmissions halt the page.

The settler's own pacing (it runs in half-hour bursts and halts on a slow call) is a separate matter and is not changed here.

## What changed

- **A busy key is skipped instead of ending the walk.** Keys are still taken in club order and only ever waited for when every key already held is lower, so there is still one lock order with tournament finishes. All waits in one call share a single 1-second budget.
- **The retry looks further down the queue.** It reads up to eight times its limit of due sources (at most 200), in the same order, and runs up to its limit of those whose keys it holds. A head waiting on a busy key no longer stops anything behind it, and it runs as soon as its key is free.
- **The engine contract is unchanged.** Deferrals are reported only within the caller's limit, so the engine's check that receipts plus deferrals never exceed the limit still holds, and #7439's full-batch rule keeps draining.

Not changed: what an item credits, its receipts, refusals, retry schedule and idempotency, owner, grants and settings. There is no sweep, repair job or compensating write.

## Proof (isolated PostgreSQL 17, never production)

`scripts/qualification/chip-deadlocks.py` now has a `skipping` stage, which runs this migration's own block on production's bodies. Two new cases run against production's text (`sorted`) and this migration (`skipping`).

**The queue head waiting on a busy key.** The queue is one L source, then four M sources, then three more L sources, with M below L and M's key held throughout.

- Production's text: three calls in a row each defer all five and run nothing. The free-keyed L sources behind them never run.
- This migration: the first call runs all four L sources. After M's key is released, the next call runs the four M sources. Every commission is written exactly once.

**A batch item behind a busy key.** The page batch holds one M item and one L item.

- Production's text: both items are deferred.
- This migration: the L item runs and only the M item is deferred. Resubmitting it after the key is released accrues it once.

The 2026-10-19 deadlock pair stays fixed, and every earlier case behaves as before. The migration file was also executed whole: it goes from production's exact md5s to the measured ones, leaves the ACL unchanged, and refuses a replay.

Evidence: `docs/evidence/cash-queue-head-2026-10-19/`.

## Deploy order

Install the migration once it is approved. The engine already accepts these responses, so no engine release is needed.
