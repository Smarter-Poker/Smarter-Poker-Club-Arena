# F06 Stalled Tournaments: Recovery Of The Existing Stuck Events (2026-09-28)

Written 2026-09-28 03:30 UTC against production (engine `41b91390`, instance
`1-1cf7188d`). Nothing in this runbook has been executed. Every write below is
a reviewed migration applied through `apply-merged-migration.yml`, outside the
:50-:03 break window, one at a time, never in a retry loop (CLAUDE.md,
production DDL policy). Run it only after the Monday 09:00 UTC weekly
settlement is verified.

Every count below is a snapshot. Re-run the census (step 0) first and work
from what it says, not from this page.

## What changed since the 2026-09-27 22:00 diagnosis

| Item                                                | 22:00 09-27 | 03:20 09-28              | Why                                                                       |
| --------------------------------------------------- | ----------- | ------------------------ | ------------------------------------------------------------------------- |
| RUNNING events                                      | ~590        | 293                      | ordinary finishing                                                        |
| RUNNING, no hand for 1 h                            | 126         | 24                       | #5496 (admission binds custody), #5498 (presence), 20260927231300 (lease) |
| RUNNING with an open manager-custody transfer       | 118         | 4                        | same                                                                      |
| Dead-instance lease on a RUNNING open transfer      | 44          | 0                        | 20260927231300 (PR #5493, applied, not merged)                            |
| "Tournament data authority cannot be rebound" (2 h) | many        | 0                        | #5478, in `41b91390`                                                      |
| Elimination queue                                   | ~308        | 264 queued, oldest 441 s | capacity (this PR, Fix C)                                                 |

## 0. Census (read-only, run first and last)

```sql
-- a. Open transfers on RUNNING events, with their lease
SELECT t.transfer_id, t.tournament_id, t.successor_generation, t.created_at,
       l.instance_id, l.lease_generation = t.successor_generation AS lease_at_successor,
       round(extract(epoch FROM now() - l.heartbeat_at)) AS heartbeat_age_s,
       EXISTS (SELECT 1 FROM smarter_private.f06_manager_custody_admissions a
                WHERE a.transfer_id = t.transfer_id) AS admitted
  FROM smarter_private.f06_manager_custody_transfers t
  JOIN public.tournaments tr ON tr.id = t.tournament_id AND tr.status = 'RUNNING'
  LEFT JOIN public.engine_tournament_leases l ON l.tournament_id = t.tournament_id
 WHERE NOT EXISTS (SELECT 1 FROM smarter_private.f06_manager_custody_completions c
                    WHERE c.transfer_id = t.transfer_id);

-- b. Long-lived bare park requests on RUNNING events
SELECT o.tournament_id, o.break_id, o.source_table_id, o.created_at
  FROM smarter_private.f06_operations o
  JOIN public.tournaments t ON t.id = o.tournament_id AND t.status = 'RUNNING'
 WHERE o.state = 'park_requested' AND o.manifest IS NULL AND o.close_receipt IS NULL
   AND o.created_at < now() - interval '1 hour'
 ORDER BY o.created_at;

-- c. RUNNING events with no hand for an hour
SELECT count(*) FROM public.tournaments r
 WHERE r.status = 'RUNNING'
   AND COALESCE((SELECT max(h.created_at) FROM public.hand_history h
                  WHERE h.tournament_id = r.id), 'epoch') < now() - interval '1 hour';
```

At 03:20 UTC (a) returned four events, (b) returned `bfcfaf17`, `41eb379e`,
`66f6dcd5`, `96415d91`, and (c) returned 24.

## 1. Merge and apply what is already written, in this order

Each is applied once with `apply-merged-migration.yml`; after each, run its own
`@live-proof` lines and the census.

1. `20260927163617` (#5452, on main, NOT applied): a last-table park the door
   left continues from its never-started hand. Fixes `41eb379e` (5 Chip Spin
   PLO4, park `62269022` since 2026-09-26 04:44). Verify: its operation leaves
   `park_requested` and `hand_history` gains a row for `41eb379e`, or it
   finishes (`status = 'COMPLETED'`).
2. `20260927164653` (#5462, on main, NOT applied): the conservation sweep
   budget. Not an F06 fix; applied here only because it is merged and owed.
3. `20260927225423` (#5492, on main, NOT applied): the pending busts of three
   frozen freerolls. Engine `41b91390` already contains #5492's sweep change
   and may have recorded these busts itself. The migration asserts its counts
   and will refuse if the rows moved; read the refusal, do not force it.
4. PR #5474 (draft): `f06_source_guard` unbinds a bare `park_requested`
   operation. This is what `bfcfaf17` (DSS Thursday $5.50 NLH Turbo, decided
   since 2026-09-18 05:17, winner `f9e96cd6`) needs: every finish attempt is
   refused `F06_SOURCE_EXCLUDED` by the skeleton park `544dc515` on table
   `0cfc4303`. After it is merged and applied, the engine's own finish retries
   within one discovery pass (it logs "is decided (1 playing) - recovering the
   winner" every pass). Verify:

   ```sql
   SELECT t.status, t.ended_at, r.finish_kind, r.completed_at,
          (SELECT count(*) FROM public.tournament_payouts p WHERE p.tournament_id = t.id) AS payouts,
          (SELECT count(*) FROM public.tournament_payouts p WHERE p.tournament_id = t.id AND p.paid_at IS NULL) AS unpaid
     FROM public.tournaments t
     LEFT JOIN public.tournament_finish_receipts r ON r.tournament_id = t.id
    WHERE t.id = 'bfcfaf17-2879-4e58-b8e1-1c749ceb3b2f';
   ```

   Expect `COMPLETED`, a receipt, payouts > 0 and unpaid = 0. Then close its
   two `Tournament.atomic_finish_refused` rows with the same proof as step 5.

5. This PR (un-drafted after Monday): `20260928032017`. It changes no row; the
   lease door only narrows. Verify:

   ```sql
   SELECT md5(pg_get_functiondef(oid)), md5(prosrc), proacl
     FROM pg_proc WHERE oid = 'public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)'::regprocedure;
   -- ec62ed7afc218747201b8a5dcc8a8571 | 5a9784b9e11d8a075acc02b786c09d60 | {postgres=X/postgres,service_role=X/postgres}
   ```

   Then confirm `/health` `tournamentLease.conflictCount` does not rise and the
   engine logs no new "Standing down" for an event whose transfer is open.

## 2. The four open transfers

Engine `41b91390` retries each on every discovery pass; none needs a manual
call to be ATTEMPTED. What each is refused by decides what, if anything, is
written.

| Event                                      | Players | Admitted | Lease                      | Reserved origin permits |
| ------------------------------------------ | ------- | -------- | -------------------------- | ----------------------- |
| `21f9013b` Sunday Deep Stack Satellite $25 | 6       | yes      | live engine, successor gen | 0                       |
| `a3a95a1b` DSS Friday $5.50 NLH Turbo      | 22      | no       | none                       | 2                       |
| `5ce1a271` 5 Chip Deep Stack Spin PLO6     | 3       | no       | none                       | 0                       |
| `160eb0c9` 5 Chip Deep Stack Spin NLH      | 2       | no       | none                       | 0                       |

The three unadmitted ones fail `f06_mixed_successor_custody_unproven`
(`server/src/tournament/mixedF06Custody.ts`), which discards the database's
refusal text. Read it without writing, in one rolled-back transaction per
event as `postgres`, outside the break window:

```sql
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';
SELECT x.transfer_id,
       s -> 'pending_original_tables' AS pending_originals,
       (s - ARRAY['originals','original_evidence','pending_original_tables'])
         = (x.canonical_proof - ARRAY['originals','original_evidence','pending_original_tables']) AS canonical_unchanged
  FROM smarter_private.f06_manager_custody_transfers x,
       LATERAL smarter_private.f06_mixed_custody_snapshot(x.tournament_id, x.origin_generation, x.local_proof) s
 WHERE x.tournament_id = '<event id>'
   AND NOT EXISTS (SELECT 1 FROM smarter_private.f06_manager_custody_completions c WHERE c.transfer_id = x.transfer_id);
ROLLBACK;
```

(`f06_mixed_custody_snapshot` takes `FOR UPDATE` on the tournament row, so it
cannot run in a read-only transaction; the rollback and lock_timeout make it
harmless.)

- `pending_originals` not `[]` (expected for `a3a95a1b`, which holds 2
  reserved origin permits): admission refuses
  `F06_MIXED_ORIGINAL_DISPOSITION_REQUIRED`. The door is
  `public.fn_f06_void_stranded_mixed_original(p_tournament_id)` (20260927145449,
  owner-only, money-neutral, proves every stack from rows before writing). It
  is called only by a reviewed migration: create one with
  `node scripts/new-migration.mjs "the stranded original of a3a95a1b is voided"`
  whose body is 20260927145449's driver and postimage restricted to that one
  id, prove it first in a rolled-back transaction, then apply. The engine then
  admits the successor, completes the transfer and resumes dealing.
- `canonical_unchanged = false` (possible for `5ce1a271`, `160eb0c9`): the
  snapshot no longer matches the stored proof and admission refuses
  `F06_MIXED_CANONICAL_CHANGED`. There is no door for that. Stop and write a
  root-cause fix for the specific difference (diff the two jsonb values key
  by key in the same rolled-back transaction); do not hand-edit proof rows.
- Both fine: the refusal is `F06_MIXED_SUCCESSOR_CHANGED` (the engine's
  `p_expected` is not the stored receipt). Read the engine log line for that
  event and fix the engine's receipt read.

`21f9013b` is admitted and held live; it is in the completion step. Read its
retained error:

```bash
ssh -i ~/.ssh/hetzner_engine_key root@5.161.252.33 \
  'docker logs --since 6h club-arena-engine 2>&1 | grep -A3 "21f9013b" | tail -40'
```

A `GameServer.mixed_original_recovery_retained` line names the
`fn_f06_complete_mixed_manager_custody` refusal (`F06_MIXED_PENDING_*`,
`F06_MIXED_TABLE_SET_CHANGED`, ...). Each names the row that is still open;
resolve that row through its own door, never by deleting it.

### Verification for every transfer

```sql
SELECT c.transfer_id, c.tournament_id, c.generation, c.completed_at
  FROM smarter_private.f06_manager_custody_completions c
 WHERE c.transfer_id IN ('68929fc8-5073-474e-a95c-0f5caed63470',  -- 21f9013b
                         'a3967f17-b1c6-424b-8445-99bcc4ed55ba',  -- a3a95a1b
                         'bc3628dd-6d7c-46ff-ad10-df1593cbd490',  -- 5ce1a271
                         '114e9349-df29-4cf1-9b87-9baa724ef00c'); -- 160eb0c9
```

A transfer is recovered when it has exactly one completion row AND its event
has a `hand_history` row after `completed_at` (or is `COMPLETED`). A
completion without a subsequent hand is not recovered: read the manager's
resume error.

The six other open transfers belong to 4 COMPLETED and 2 CANCELLED events.
They hold nothing and need no action; `f06_mixed_current_admission` refuses
them by design (event not RUNNING).

## 3. Other long park requests

`66f6dcd5` (park since 09-27 01:29, last hand 09-27 15:05) and `96415d91`
(park since 09-27 20:24, last hand 21:36) logged "its break ended but the
maintenance freeze was still on 90s later; retaining the paused clock" at the
last break. Re-read them after the next thaw. If still not dealing and their
park is still bare (no manifest, no admission, no members, no attempts), they
are the #5474 shape and step 1.4 releases them.

## 4. Close the 34 stale "outcome unknown" alerts

34 unresolved `Tournament.atomic_finish_outcome_unknown` rows
(2026-09-27 10:12-15:41 UTC), one per event. At 03:20 UTC every one of the 34
events is `COMPLETED` with `ended_at`, has payout rows, and has none waiting
on `paid_at`. That is the closure proof 20260925142532 and 20260926092142
already use. Close them with a reviewed migration (new version from
`scripts/new-migration.mjs`), whose body is:

```sql
BEGIN;
SET LOCAL lock_timeout = '2s';
DO $close$
DECLARE
  c_mig constant text := '<the new version>';
  v_n int;
BEGIN
  UPDATE public.financial_alerts fa
     SET resolved = true, resolved_at = now(),
         resolution = 'Settled. The unknown finish outcome was resolved by the engine''s own idempotent retry: the tournament is COMPLETED with an ended_at, payout rows exist and none is waiting on paid_at, so nothing is owed. Same proof as 20260925142532 and 20260926092142. Migration ' || c_mig || '.'
   WHERE fa.resolved IS NOT TRUE
     AND fa.source = 'Tournament.atomic_finish_outcome_unknown'
     AND fa.created_at BETWEEN '2026-09-27 10:00Z' AND '2026-09-27 16:00Z'
     AND EXISTS (
       SELECT 1 FROM public.tournaments t
        WHERE t.id = (fa.context->>'tournament_id')::uuid
          AND t.status = 'COMPLETED' AND t.ended_at IS NOT NULL
          AND EXISTS (SELECT 1 FROM public.tournament_payouts tp WHERE tp.tournament_id = t.id)
          AND NOT EXISTS (SELECT 1 FROM public.tournament_payouts tp
                           WHERE tp.tournament_id = t.id AND tp.paid_at IS NULL));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 34 THEN
    RAISE EXCEPTION 'expected 34 settled outcome-unknown alerts, would close %', v_n;
  END IF;
END
$close$;
COMMIT;
```

Re-run the count first; if it is no longer 34, change the assertion to the
number the proof actually covers and say why in the migration header. Leave
the 8 `Tournament.atomic_finish_refused` rows alone until their events
(including `bfcfaf17`) are COMPLETED and paid, then close them with the same
proof. Verify:

```sql
SELECT count(*) FROM public.financial_alerts
 WHERE NOT resolved AND source = 'Tournament.atomic_finish_outcome_unknown';
-- 0
```

## 5. Done means

Census (a) returns only events whose transfer has a completion, (b) returns
nothing older than an hour, (c) is back to the ordinary handful of events on a
scheduled break, and `poker_tournament_elimination_scheduler_oldest_wait_ms`
stays under 120 s.
