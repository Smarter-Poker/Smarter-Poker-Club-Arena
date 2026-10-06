# The daily mission outbox row is locked once (2026-10-04)

Migration `20261004003924_the_daily_mission_outbox_row_is_locked_once.sql`.

## Why

The four per-minute shard jobs (`daily-missions-outbox-minute`, `-s1`, `-s2`,
`-s3`) book every Daily Missions event through
`enqueue_daily_challenge_event(uuid,text,jsonb,jsonb,jsonb,timestamptz)`. That
function reads the outbox row `FOR UPDATE` and later deletes it. The read runs
in the drain's per-player exception block (subtransaction A) and the delete in
enqueue's own exception block (subtransaction B). PostgreSQL keeps a lock taken
by one subtransaction when another subtransaction of the same transaction
updates or deletes the row by creating a MultiXact, so every drained row died
with a MultiXact xmax.

Two costs follow. `HeapTupleIsSurelyDead` returns false for a MultiXact xmax,
so index scans never mark those entries dead and no hint bit can be set: until
vacuum or page pruning removes them, every read of a drained row is a MultiXact
member lookup in the 128 kB / 256 kB SLRU caches that the rest of the database
is already starving on. And the drain creates one MultiXact per booked event.

Measured on production, read-only (cron.job_run_details, receipts per run
window, `pg_stat_get_activity` sampling, `pg_stat_get_slru` and `mxid_age`
deltas, per-call index counters):

| | value |
| --- | --- |
| before the 00:09:55 UTC resize (652 runs, 21:00 to 23:50) | 15.4 s per run; about 9 ms per event plus 20 to 25 ms per player transaction |
| after the resize (44 runs, 00:11 to 00:21) | 3.05 s per run; 2.64 ms per event plus 4.0 ms per player transaction |
| shard picker, 480 calls | 600 index entries read per call during a run and 965 after it, about 26 live; 2.0 to 2.3 ms per call, max 11.8 ms |
| MultiXact member lookups, drain window vs rest of the minute | 141,000/s vs 7,700/s |
| MultiXacts created, drain window vs rest of the minute | 2,464/s vs 119/s |
| drain window share of the database | 71% of member lookups, 74% of MultiXacts created |
| MultiXacts per booked event | 2.25 |

## The change

The outbox read loses `FOR UPDATE`. Nothing else changes: not the receipt
read, which keeps its `FOR UPDATE`, not the five-argument overload (the drain
does not call it), not the player lock, the drain procedure, the schedule or
grants.

```
-  WHERE user_id = p_user_id
-    AND event_key = p_event_key
-  FOR UPDATE;
+  WHERE user_id = p_user_id
+    AND event_key = p_event_key;
```

Why credits cannot change: the function's first statement is
`fn_lock_daily_mission_user` (player advisory lock plus `profiles FOR NO KEY
UPDATE`), and every writer of a player's outbox rows either holds it or never
changes a row the drain books. `fn_drain_daily_challenge_event_outbox_user` and
both `enqueue_daily_challenge_event` overloads hold it.
`fn_enqueue_hand_daily_missions` only inserts with `ON CONFLICT DO NOTHING`.
`fn_prune_daily_mission_operations` only deletes rows dead-lettered over 180
days ago. `cleanup_reserved_certification_account` tears down test accounts and
takes `auth.users FOR UPDATE` first, which already conflicts with the receipt
insert's foreign-key lock; without the outbox row lock that teardown also loses
a lock-order edge against the drain. The drain's skip path only changes
`attempts`, `last_error` and `next_attempt_at`, never the payload columns the
read compares, and the read feeds only that comparison and the
`record_daily_challenge_event` call.

## Proof

`scripts/ci/test-the-daily-mission-outbox-row-is-locked-once.py`, two
disposable PostgreSQL 17 clusters loaded with the md5-pinned live text of the
whole drain chain (`scripts/ci/fixtures/daily-mission-outbox-lock/`), one on
the pre-image and one with the shipped migration applied unchanged. Result in
`artifacts/daily-mission-outbox-lock/result.json`:

| case | pre-image | after |
| --- | --- | --- |
| APPLY: post md5, grants unchanged, second run refused | | `fb7a950cdbbc657b2b6a4b52b65443bf`, `{postgres=X/postgres,service_role=X/postgres}` |
| SAME: 140 receipts, 80 `user_daily_challenges` rows (54 progressed, 21 completed), revisions, outbox residue | identical | identical |
| SAME: skip/backoff rows reached, 40-day event dead-lettered | 9 | 9 |
| drained outbox rows with a MultiXact xmax | 77 of 77 | 0 |
| MultiXacts created by the drain (77 events) | 231 | 154 (exactly 77 fewer) |
| MultiXact member lookups while the drain runs | 482 | 154 |
| MultiXact member lookups when the pickers rescan the drained outbox | 77 | 0 |
| CONCUR: 4 shard drains, 3 hand writers, 2 direct enqueuers; inflow 620 | 620 booked, 0 queued, 0 errors | 620 booked, 0 queued, 0 errors |
| CONCUR: final receipts and progress | identical | identical |

The remaining two MultiXacts per event in the harness are on
`user_daily_challenges` and `daily_challenge_dashboard_revisions` rows (a key
share plus a no-key lock and update from different subtransactions) and are
the same on both clusters. This change does not touch them.

Expected effect on production: the drain stops creating about one of its 2.25
MultiXacts per event, and the picker stops paying a MultiXact lookup for every
drained row it re-reads. On the resized instance that is an estimated 15 to 20%
of the drain's own time. The larger effect is on the rest of the database,
because the drain window was 71% of all MultiXact member lookups.

## Applying

The text contains `FOR UPDATE` in the removed fragment, so the owner applies it
with Apply Merged Migration outside the :50-:03 break window. The
`@live-proof` line is
`md5(pg_get_functiondef('public.enqueue_daily_challenge_event(uuid,text,jsonb,jsonb,jsonb,timestamptz)'::regprocedure)) = 'fb7a950cdbbc657b2b6a4b52b65443bf'`.
