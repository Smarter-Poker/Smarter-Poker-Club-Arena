# Horse Brain Phase 14.1 follow-up: hand review receipts have a bounded retention (2026-10-08)

**The open limit.** `public.horse_hand_review_receipts`, the replay receipt that
`fn_hhr_record_atomic` keeps for every published (hand, horse) review, was
created "never pruned" (migration `20261007020953`, PR #6352). Production read
at 2026-10-08 04:08Z: 46,590 receipts since 2026-10-07 10:01Z, about 60,000 a
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
  `315906962e9854aa3054b9ad4bc8ae79`); configuration and privileges are
  unchanged.
- `sp_prune_horse_hand_reviews()`, the existing owner of review retention that
  the engine already calls (`HorseHandReview.ts`, once per process), also
  deletes at most 50,000 receipts per call, oldest `rollup_day` first, and only
  a receipt whose UTC `rollup_day` is more than 32 days old **and** whose review
  row is gone. Because `rollup_day` is the UTC day of the same `played_at`, a
  pruned receipt's hand was played more than 31 days ago, so any later resend
  is refused by the horizon above: never a second count. Its four existing
  statements are unchanged; its return value adds the receipts removed
  (preimage md5 `d3972fedf8264f57f0ad39737faba044`, postimage
  `ea26b896e3d95a70ed10ba86473c7e72`).
- An index on `rollup_day` so the bounded delete reads only what it removes.

No cron, no loop, no new job: retention rides the owner that already prunes
reviews (CLAUDE.md 10.12 names retention pruning as allowed). Nothing is
backfilled or reset and `horse_review_rollup` is never touched. Engine releases
ran 4 to 13 times a day from 2026-10-03 to 10-07, and each process calls the
prune once, so 50,000 per call clears about 60,000 a day with room. The first
receipts (rollup day 2026-10-07) become eligible on 2026-11-09 UTC; until then
the table keeps growing as before and the prune removes nothing, by design.

**Verification.** `scripts/ci/test-horse-hand-review-atomic.py` (PostgreSQL 17,
CI `accounting_postgres` shard 4) now applies the retention migration
unchanged after its 19 P14.1 cases and adds 13: receipts for hands played 45
and 40 days ago published through the old door; the preimage refusing a
changed prune and rolling back; reapply refused; unchanged definer,
configuration and privileges, with the atomic body gaining exactly the horizon
block; the horizon (29 days 23 hours applies, 30 days 1 minute and a mixed
multi-horse call refused with nothing persisted); a 45-day-old receipt still
replaying and a legacy row still `historical_unknown`; a receipt kept while its
review exists; a receipt kept inside 32 days after its review is gone, its
resend `replayed`; the review leaving retention and its receipt pruned in the
same call, the resend refused with nothing re-inserted and the aggregate
unchanged, a second prune a no-op; the UTC day boundary (32 kept, 33 pruned, in
UTC+14 and UTC-11 sessions); the 50,000 bound, oldest first, draining to zero;
and the prune's existing review and day-table retention unchanged. 32 of 32
pass. Eight deliberately broken copies of the migration each fail at least one
case.
