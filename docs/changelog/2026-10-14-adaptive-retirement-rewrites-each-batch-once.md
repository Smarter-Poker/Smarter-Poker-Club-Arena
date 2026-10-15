# Adaptive Retirement Rewrites Each Batch Once Per Call

## What Was Wrong

Production, 2026-10-14 23:03 UTC: horse adaptive disposal certificates were
qualifying at about 39,700 per hour while the single original retention lane
retired about 22,500 per hour. The incoming backlog stood at 926,181 hands and
was growing about 17,000 per hour. A foreground drain of the same owner could
not close it either: kept continuously busy, the lane topped out near 20 hands
per second (measured: 22 committed calls, 1,918 hands, 5,126 raw observations
in 95 seconds).

## Cause, Read From Rows

`smarter_private.retire_horse_adaptive_hand` (installed md5
`f1147867f410f36e244e8849df4ac6d7`) compacted every observation batch that
contains the hand, once per hand. Measured on production:

| Measure | Value |
| --- | --- |
| Hands per batch (average) | 197.6 |
| Canonical payload per uncompacted batch (average) | 130,553 bytes |
| Batches per hand (average) | 2.56 |
| Membership rows | 15,138,573 |

So every batch was parsed, filtered, re-serialised and re-TOASTed about 198
times over its life, roughly 330 KB of JSON rewritten per retired hand. That is
the ~50 ms per hand, the ~20 hands per second ceiling, and a large share of the
TOAST churn on `horse_adaptive_observation_batches` (5.2 GB) and the journal.
The unfinished-work payload check was measured too: zero unfinished rows, so it
is not the cost.

## The Fix

Migration `20261014231333_horse_adaptive_retirement_rewrites_each_batch_once_per_call.sql`:

- adds `smarter_private.retire_horse_adaptive_hand_deferred(uuid)`: the
  installed original body byte-for-byte except that the per-hand batch
  compaction loop is removed (proven textually by the harness);
- changes `public.fn_prune_horse_adaptive_journal()` (installed md5
  `d287d2dc4fd96d9aa2a2e179ff156ff3`) to call it, collect the hands it
  completed, and then compact each touched batch once, removing all of those
  hands' tuples in the same transaction.

Unchanged: the 250-hand / 2-second / 16 MiB budgets, the capacity lock, the
cursor and fixed high-water, statistics expiry, the receipt shape, owner,
security definer, search path, lock timeout and ACLs. The original
one-argument retire stays installed and unchanged. No job, schedule, repair or
backfill is added. The migration refuses to apply unless the three installed
function hashes are exactly the production preimage.

## Proof

`scripts/verification-harness/horse-adaptive-batch-once.py`, wired into the
existing `horse-adaptive-statistics-retention` native CI proof, builds a
production-ICU world of 40 genuine qualified horse hands whose facts share two
batches with an adjacent human tuple and one still-protected horse hand, then
runs the original per-hand path and the corrected owner from the same
template. Proven:

- batches (payload, digest, compaction flag), remaining raw, statistics,
  fences and certificate format are byte-identical to the original path;
- the protected hand keeps its raw, its pending certificate and its tuples in
  every batch; the human tuple is byte-retained in both batches;
- the original batch digest remains the replay fence;
- a repeat call is a no-op with no double statistics; releasing the protection
  completes that hand through the same owner;
- a rolled-back owner call leaves everything untouched;
- forward replay of the migration is refused; ownership and ACLs are preserved.

## Outcome On Production (2026-10-15)

What this change actually did, measured after install, so nobody relies on the
expectation above:

- **It shipped a defect.** The once-per-call batch selection matched
  certificates with `c.hand_id::text = ANY(text[])`. The cast disabled the
  certificates primary key, so from 00:07 UTC every owner call ran a sequential
  scan and hit its statement timeout. Each call rolled back whole (nothing
  partial was written), but retirement stalled until
  `20261015001555` (#6890, see
  `2026-10-15-horse-adaptive-compaction-finds-batches-through-the-hand-id-index.md`)
  compared uuid to uuid at about 01:10 UTC.
- **It did not raise throughput.** With the cast fixed, a continuous drain still
  retired about 20 hands per second, the same as the original per-hand path.
  The premise was wrong: hands taken in qualified order are scattered across
  batches (250 consecutive pending hands touched 277 distinct batches), so
  compacting once per call saved little.
- **The real fix** was `20261015022307` (#6900, see
  `2026-10-15-horse-adaptive-retirement-groups-hands-by-shared-batch.md`),
  which attempts a seed hand together with its pending batch-mates so each
  touched batch is rewritten once for many hands. Measured afterwards: about
  240 hands per 4.9-second call; the backlog fell from 1,004,430 (01:50 UTC) to
  454,210 (10:01 UTC) while about 41,000 hands an hour arrived.
- The deferred retire and the once-per-call compaction from this change remain
  the base those fixes build on, and the byte-identical harness still covers
  all three migrations.
