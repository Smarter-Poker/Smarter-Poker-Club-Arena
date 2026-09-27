# A pruned hand is not an unfinished one (2026-09-27)

Migration `20260927145821_a_pruned_hand_is_not_an_unfinished_one.sql`.

## What happened

`smarter_private.hand_submissions` keeps every original settlement request for
ever (it is immutable). `sp_prune_hand_history` deletes the
`hand_atomic_commits` row of every horse-only hand at eight days (the retention
Dan set on 2026-09-17; unchanged). `fn_ca_resume_hand_submission`, which the
engine asks at every table admission, picks the table's lowest submission whose
own completed commit is missing. From 2026-09-26 22:02 UTC, eight days after the
first submission was retained, every pruned horse hand read as an unfinished
retained original, and the door refused `HAND_SUBMISSION_HANDOFF_STATE_CHANGED`
on every ask, because later commits exist at the table.

Measured read-only on production, 2026-09-27: 245,536 such submissions at 2,686
tables, 84 of them live; PostgREST 500s on `/rpc/fn_ca_resume_hand_submission`
went from roughly a thousand an hour to about 16,500 an hour from 2026-09-27
00:00; running cash tables with seated players and pruned submissions stopped
committing hands after the 23:55 break. The engine had not been replaced since
2026-09-26 14:06, so the next replacement would re-admit every table against
the same refusal.

## What changed

1. The door skips only an empty commit coordinate with a later commit on the
   same table and no `reserved` permit: a hand its own handoff can never
   continue. A different commit at the coordinate, pending post-commit work, a
   reserved permit and an empty coordinate with no later commit are selected
   exactly as before. The financial handoff is byte for byte the
   `20260926091630` body.
2. Retention keeps the last commit of every live table
   (`smarter_private.live_table_last_commit_retained`, beside the F06 boundary
   guard), so the proof in (1) survives a table that sits idle for eight days.

No hand is settled, voided or reconstructed, and no money moves.

## Proof

`scripts/ci/test-pruned-hand-is-not-unfinished-postgres.py` builds a disposable
PostgreSQL cluster with the production bodies pinned by md5, reproduces the
refusal and the retention of a live table's last commit on the pre-image,
applies the migration as written, and proves the post-image for both known
retention bodies. It runs in CI (accounting shard 3). Law:
`tests/a-pruned-hand-is-not-an-unfinished-one.law.test.ts`.
