# Horse Brain Phase 14.1 follow-up: hand review receipts have a bounded retention (2026-10-08)

**The open limit.** `public.horse_hand_review_receipts`, the replay receipt that
`fn_hhr_record_atomic` keeps for every published (hand, horse) review, was
created "never pruned" (migration `20261007020953`, PR #6352). Production read
at 2026-10-08 04:58Z: 48,705 receipts since 2026-10-07 10:01Z, about 60,000 a
day, and nothing removed them.

**Why it could not simply be pruned.** `fn_hhr_record_atomic` accepted a hand
of any age. With both the receipt and the 30-day review row gone, a resend of
the hand would insert the review again and add it to the permanent
`horse_review_rollup` a second time. The receipt living forever was the only
thing that kept a late resend `replayed`.

**The root fix.** Migration `20261008041150_horse_hand_review_receipts_retention.sql`:

- `fn_hhr_record_atomic` refuses, by name and writing nothing, to apply a row
  played more than 30 days ago: `P0001 hhr_publication_expired`. Only the
  first-time apply branch changes. A receipt that still exists answers
  `replayed` (or `hhr_identity_conflict`) whatever the hand's age, and a legacy
  review row with no receipt still answers `historical_unknown`. Live hands are
  published seconds after they settle, so no live hand is refused. The body is
  patched in place from the exact installed definition (preimage md5
  `161e5883ca636e898463e3957b1b6f45`, postimage
  `2401c9fb36c18448ab5f4bbad862443a`); configuration and privileges are
  unchanged.
- `sp_prune_horse_hand_review_receipts()` (new, `service_role` only, postimage
  md5 `65138afe0f0886cd066cfca6c3c60fe9`) deletes at most 25,000 receipts per
  call, oldest `rollup_day` first, and only a receipt whose UTC `rollup_day` is
  more than 32 days old **and** whose review row is gone. Because `rollup_day`
  is the UTC day of the same `played_at`, a pruned receipt's hand was played
  more than 32 days ago, so any later resend is refused by the horizon above:
  never a second count. `horse_review_rollup` is never touched.
- An index on `rollup_day` so the bounded delete reads only what it removes.

**Why its own function.** `sp_prune_horse_hand_reviews()` is the existing
review-retention owner, and the engine calls it through PostgREST as
`service_role`, whose `statement_timeout` is pinned at 8 s. Production
`pg_stat_statements` (2026-10-04 to 10-08): 43 calls, mean 5,177 ms, max
6,840 ms. A receipt delete added inside that one statement would spend the
remaining margin, and a timeout there would roll back the review prune too.
So `sp_prune_horse_hand_reviews()` stays byte-identical and the receipts get
their own statement and their own budget. The engine calls the new function
from the same once-per-process retention callback in `HorseHandReview.ts`,
right after the review prune. That call ships as a separate engine change once
the function is installed, because the engine release gate ("Prove The Exact
Engine Has Every Production Door") refuses a build that calls a function
production does not have.

No cron, no loop, no new job: retention rides the callback that already prunes
reviews (CLAUDE.md 10.12 names retention pruning as allowed). Nothing is
backfilled or reset. Capacity: about 10 prune calls a day, 25,000 each, against
about 60,000 receipts a day. Budget: in production the anti-join probe this
delete makes took 1.9 s for all 48,996 receipts (0.04 ms each); on a private
PostgreSQL 17 with 900,000 review rows a 50,000 batch took 0.75 s cold. The
first receipts (rollup day 2026-10-07) become eligible on 2026-11-09 UTC; until
then the prune removes nothing, by design.

**Verification.** `scripts/ci/test-horse-hand-review-atomic.py` (PostgreSQL 17,
CI `accounting_postgres` shard 4) applies the retention migration unchanged
after its 19 P14.1 cases and adds 13: receipts for hands played 45 and 40 days
ago published through the old door; the preimage refusing an existing receipt
prune and a drifted `fn_hhr_record_atomic`, rolling back; reapply refused;
`fn_hhr_record_atomic` keeping definer, configuration and privileges and
gaining exactly the horizon block, `sp_prune_horse_hand_reviews` byte-identical,
the new prune `service_role` only; the horizon (29 days 23 hours applies,
30 days 1 minute and a mixed multi-horse call refused with nothing persisted);
a 45-day-old receipt still replaying and a legacy row still
`historical_unknown`; a receipt kept while its review exists; a receipt kept
inside 32 days after its review is gone, its resend `replayed`; the receipt
prune keeping a receipt until the review prune removes its review, then
removing it, the resend refused with nothing re-inserted and the aggregate
unchanged, a second prune a no-op; the UTC day boundary (32 kept, 33 pruned, in
UTC+14 and UTC-11 sessions); the 25,000 bound, oldest first, draining to zero;
and the review prune unchanged and touching no receipt. 32 of 32 pass. Ten
deliberately broken copies of the migration each fail at least one case.

**Delivery and install.** #6464 squash-merged `267bee12` (2026-10-08T06:37:20Z);
installed by Apply Merged Migration run 37738632829 and read back from
production at 06:38Z with the exact postimage md5s above,
`sp_prune_horse_hand_reviews()` unchanged and the index valid. 55 receipts were
applied naturally through the new body in the first minute. The engine call
ships in #6484. The first natural prune is due on 2026-11-09 UTC.
