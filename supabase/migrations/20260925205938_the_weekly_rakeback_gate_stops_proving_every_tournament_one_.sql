-- ============================================================================
-- THE WEEKLY RAKEBACK GATE STOPS PROVING EVERY TOURNAMENT ONE AT A TIME
-- ============================================================================
--
-- WHAT IS WRONG (read from production 2026-09-25, not inferred)
--
-- daemon_state.high_water_mark for 'rakeback_settler' has stood at
-- 2026-09-22T10:37:05.499207+00 since 2026-09-22T10:37:12Z. 226,650 of the
-- week's 260,263 rake_records sit above it, so
-- fn_process_weekly_accounting_scope raises weekly_rake_source_not_fully_accrued
-- and the 2026-09-28T09:00Z union cascade would abort before Round 1.
--
-- The cursor is held for the right reason. Every cycle the settler calls
--   fn_rakeback_recompute_periods('2a1132b9-…','2026-09-21','2026-09-27', …)
-- for Deep Stack Society and the call comes back `supabase_timeout`. A failed
-- recompute must not advance the watermark (RakebackSettlerService, 2026-08-29)
-- because rake_generated selects the rakeback tier, so the settler is correct
-- and the defect is entirely in the cost of the call.
--
-- The engine's Supabase client gives up at DB_TIMEOUT_MS = 15,000 ms
-- (server/src/services/cashAccountingBatchBudget.ts). The server transaction
-- commits regardless -- accounting_period_recompute_requests for that club-week
-- shows attempts=520, last attempted_at 2026-09-25T20:43:52Z -- so the work is
-- done and thrown away every single cycle. This is the same shape as the
-- 2026-09-17 incident recorded in cashAccountingBatchBudget.ts.
--
-- MEASURED, warm, on production, for that club and week (all figures from
-- clock_timestamp() deltas inside one rolled-back read-only DO block, and from
-- EXPLAIN (ANALYZE, BUFFERS)):
--
--   fn_accounting_tournament_week_quality      50,679 ms   <-- 68% of the call
--   cash_source_receipts_incomplete count       6,721 ms   (23,095 ms cold)
--   cash_source_receipts_drifted count          ~2,000 ms  (17,885 ms cold)
--   cash_earning_evidence (checks CTE)          6,697 ms
--   the per-player certificate query            4,648 ms
--   legacy/paid period conflict count             323 ms
--                                              ---------
--                                              ~71 s warm, ~127 s cold
--
-- WHERE THE 50.7 SECONDS GO
--
-- fn_accounting_tournament_week_quality enumerates every tournament the WHOLE
-- PLATFORM recognised or settled in the week -- 12,423 of them -- and then
-- decides relevance row by row inside a PL/pgSQL loop, proving 6,953 of them
-- one at a time. Those 6,953 tournaments hold 21,257 rake_records between them
-- and ZERO refunds (verified: no is_tournament rake_records row with
-- rake_amount < 0 among the 12,423). 7.3 ms per event, almost all of it
-- structural:
--
--   * public.accounting_tournament_recognized_sources (76,934 rows) is indexed
--     on (source_id) and on (recognized_at, tournament_id). The loop looks it
--     up BY tournament_id twice per event, and tournament_id is the SECOND
--     column, so each lookup is a FULL index scan:
--         Index Scan using accounting_tournament_recognized_sources_week
--           Index Cond: (tournament_id = …)
--           Buffers: shared hit=4762   actual time=0.989  loops=20
--     238 buffers and ~1 ms to find 6 rows, 13,906 times.
--   * public.accounting_tournament_fee_sources (82,693 rows, 138 MB) has no
--     index on club_id, so the relevance EXISTS and the payable view's own
--     club filter both heap-fetch the wide `contract` column: 141,677 buffers
--     for one scan of the week.
--   * The candidate set itself is three sequential scans of unindexed
--     predicates -- tournament_rake_settlements.settled_at (202,871 rows,
--     58 MB), tournament_terminal_settlements.COALESCE(settled_at,completed_at)
--     (66,261 rows, 73 MB) and accounting_tournament_fee_recognitions
--     .recognized_at (28,751 rows) -- 2,124 ms before the loop starts.
--
-- AND IN fn_calculate_cash_rakeback_periods
--
--   * The `checks` CTE runs a correlated `NOT EXISTS (SELECT 1 FROM clubs …)`
--     once per attribution row: 417,827 bitmap heap scans of a FIVE-ROW table,
--     835,654 buffers.
--   * cash_source_receipts_incomplete is planned as a nested loop: 418,672
--     index probes into accounting_cash_rake_sources and 418,672 more into
--     accounting_cash_accrual_batches, 2,686,212 buffers, because the week
--     slice was never materialised for the planner to hash.
--   * The week's rake_records slice is scanned THREE separate times (checks,
--     receipts_incomplete, receipts_drifted): 3 x 238,049 rows, 3 x ~252,000
--     buffers, ~2.6 s each.
--   * The per-player certificate query drags the wide `contract` jsonb through
--     both sorts -- `Sort Method: external merge Disk: 162456kB` plus five
--     ~26 MB worker spills -- and probes
--     accounting_tournament_fee_sources_pkey 107,279 times (342,029 buffers)
--     for a charged_at that only the 20,189 tournament rows can have.
--
-- WHAT THIS MIGRATION DOES
--
-- It makes the same proof cheaper. It does not relax one assertion, it does
-- not widen a timeout, it does not advance or loosen the watermark hold, and
-- it adds no cron, watcher, reconciler or repair path (CLAUDE.md 10.11/10.12).
-- Every payee with a source in the week still gets a certificate, zero
-- entitlement included, so the round-3 routed_rakeback_player_period_missing
-- guard still has the completeness it depends on.
--
--   STEP 1  Eight indexes, all CONCURRENTLY, so no ledger is locked during live
--           play. The two that matter are the missing tournament_id on
--           accounting_tournament_recognized_sources and club_id on
--           accounting_tournament_fee_sources.
--
--   STEP 2  fn_accounting_tournament_week_quality keeps its loop and its exact
--           reasons, but the loop body stops issuing five queries per event.
--           One set-based pass computes, for the events that are actually in
--           scope, the three facts the gate compares against the recorded
--           recognition -- the md5 source fingerprint, the net fee and the
--           single union scope -- plus the recognised-source receipt checks.
--           For a tournament with NO refund reversal those set-computed facts
--           are algebraically identical to what
--           fn_accounting_tournament_fee_net_plan returns, so it is not
--           called. For a tournament that HAS a refund reversal, or whose
--           cheap facts disagree, the original per-event path runs unchanged,
--           net_plan included, and produces the original reason and detail.
--
--   STEP 2  fn_calculate_cash_rakeback_periods materialises the week's
--           rake_records slice ONCE in pg_temp (pg_temp is filtered out of
--           pgrst_ddl_watch, so no schema reload -- CLAUDE.md DDL policy rule
--           3 and rule 7), hashes the club's attribution and source slices
--           instead of nest-looping them, replaces the per-row clubs probe
--           with a hashed subplan over five rows, and stops carrying the
--           `contract` jsonb through the certificate sorts.
--
-- Full reasoning: docs/changelog/2026-09-25-the-weekly-rakeback-gate-stops-
-- proving-every-tournament-one-at-a-time.md
--
-- ============================================================================


-- ============================================================================
-- AFTER APPLYING -- verify by reading, not by assuming
-- ============================================================================
--
-- 1. Every STEP 1 index is present and VALID:
--
--      SELECT c.relname, i.indisvalid, i.indisready
--        FROM pg_class c JOIN pg_index i ON i.indexrelid=c.oid
--       WHERE c.relname IN ('accounting_tournament_recognized_sources_event',
--         'accounting_tournament_fee_sources_club_event',
--         'accounting_tournament_fee_sources_coordinator_event',
--         'accounting_tournament_fee_recognitions_week',
--         'tournament_rake_settlements_settled_week',
--         'tournament_terminal_settlements_settled_week',
--         'tournament_refund_entitlements_club_event',
--         'rake_attributions_club_record');
--
-- 2. The gate is cheap, and still says the same thing. In ONE call, rolled
--    back (CLAUDE.md 10.9 rule 4 -- a transaction does not span two MCP
--    calls):
--
--      DO $p$ DECLARE t timestamptz:=clock_timestamp(); q jsonb; BEGIN
--        q:=public.fn_accounting_tournament_week_quality(
--             '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3',
--             '2026-09-21 07:00:00+00','2026-09-28 07:00:00+00');
--        RAISE EXCEPTION 'PROBE % in % ms', q::text,
--          round(extract(epoch FROM clock_timestamp()-t)*1000);
--      END $p$;
--
--    Expect {"status":"ready","checked":6953} -- the same verdict and the same
--    event count as before -- in well under a second. It was 50,679 ms warm.
--
-- 3. THE SETTLER IS THE REAL TEST. Watch
--      SELECT high_water_mark, updated_at FROM public.daemon_state
--       WHERE daemon='rakeback_settler';
--    It has stood at 2026-09-22T10:37:05.499207+00 since 2026-09-22T10:37:12Z.
--    Once the recompute fits inside the engine's 15 s client budget the call
--    stops returning `supabase_timeout`, the cycle stops returning 'halted',
--    and the cursor advances again. Until the week is fully accrued the
--    recompute legitimately returns blocked/cash_source_receipts_incomplete --
--    that is a DEFERRED period to RakebackSettlerService, not a failure, so it
--    does not hold the cursor.
--
-- ============================================================================


-- ============================================================================
-- STEP 1 -- RUN THESE STATEMENTS ON THEIR OWN, OUTSIDE ANY TRANSACTION BLOCK.
-- ============================================================================
--
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction. That is a
-- considered exception to the single-transaction rule in the production DDL
-- policy, for the reason migration 20260920185803 records: rake_records and
-- rake_attributions take a row for every player in every raked hand, and a
-- plain CREATE INDEX takes SHARE for the whole build. rake_records is 2,660 MB
-- and rake_attributions 1,160 MB; locking either stalls live cash tables, and
-- CLAUDE.md DDL policy rule 7 exists because exactly that took the database
-- down for four minutes on 2026-09-08. CONCURRENTLY takes only
-- SHARE UPDATE EXCLUSIVE, so play continues while they build.
--
-- Safe to re-run: a failed CONCURRENTLY build leaves an INVALID index, which
-- the assertion in STEP 2 detects and names by index.
--
-- Do NOT run these between :50 and :03 UTC -- ca_break_window_refuses_ddl
-- refuses non-temporary DDL in the hourly break window. Check `date -u`.
--
-- Install through the Apply Merged Migration door: it sends each of these on
-- its own, outside any transaction, only with room to finish before :50, reads
-- each back VALID, and only then sends STEP 2 as one transaction
-- (scripts/ci/migration-concurrent-preamble.mjs). Nothing but these CREATE
-- INDEX CONCURRENTLY statements and comments may precede BEGIN; below.

CREATE INDEX CONCURRENTLY IF NOT EXISTS accounting_tournament_recognized_sources_event
  ON public.accounting_tournament_recognized_sources (tournament_id)
  INCLUDE (source_id, recognized_at, disposition, rake_credit);

CREATE INDEX CONCURRENTLY IF NOT EXISTS accounting_tournament_fee_sources_club_event
  ON public.accounting_tournament_fee_sources (club_id, tournament_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS accounting_tournament_fee_sources_coordinator_event
  ON public.accounting_tournament_fee_sources (coordinator_union_id, tournament_id)
  WHERE coordinator_union_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS accounting_tournament_fee_recognitions_week
  ON public.accounting_tournament_fee_recognitions (recognized_at)
  INCLUDE (tournament_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS tournament_rake_settlements_settled_week
  ON public.tournament_rake_settlements (settled_at)
  INCLUDE (tournament_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS tournament_terminal_settlements_settled_week
  ON public.tournament_terminal_settlements ((COALESCE(settled_at, completed_at)))
  INCLUDE (tournament_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS tournament_refund_entitlements_club_event
  ON public.tournament_refund_entitlements (refund_wallet_club_id, tournament_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS rake_attributions_club_record
  ON public.rake_attributions (club_id, rake_record_id)
  INCLUDE (player_id, weighted_rake_credit, hand_id);

-- ============================================================================
-- STEP 2 -- ONE TRANSACTION.
-- ============================================================================

BEGIN;

-- Fail fast rather than queue behind a live writer.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';


-- ----------------------------------------------------------------------------
-- 2.1  ASSERT STEP 1 RAN AND EVERY INDEX IS VALID
--
-- A CONCURRENTLY build that failed leaves an index behind that the planner
-- ignores, which looks exactly like this migration having been applied.
-- ----------------------------------------------------------------------------
DO $assert$
DECLARE v_missing text; v_invalid text;
BEGIN
  SELECT string_agg(want, ', ' ORDER BY want) INTO v_missing
    FROM unnest(ARRAY[
      'accounting_tournament_recognized_sources_event',
      'accounting_tournament_fee_sources_club_event',
      'accounting_tournament_fee_sources_coordinator_event',
      'accounting_tournament_fee_recognitions_week',
      'tournament_rake_settlements_settled_week',
      'tournament_terminal_settlements_settled_week',
      'tournament_refund_entitlements_club_event',
      'rake_attributions_club_record']) want
   WHERE NOT EXISTS (SELECT 1 FROM pg_class c
                      JOIN pg_namespace n ON n.oid = c.relnamespace
                     WHERE n.nspname = 'public' AND c.relname = want);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION
      'STEP 1 has not run: % missing. Create them with CREATE INDEX CONCURRENTLY, outside any transaction, before applying STEP 2.',
      v_missing USING ERRCODE = '55000';
  END IF;

  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO v_invalid
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_index i ON i.indexrelid = c.oid
   WHERE n.nspname = 'public'
     AND c.relname IN ('accounting_tournament_recognized_sources_event',
       'accounting_tournament_fee_sources_club_event',
       'accounting_tournament_fee_sources_coordinator_event',
       'accounting_tournament_fee_recognitions_week',
       'tournament_rake_settlements_settled_week',
       'tournament_terminal_settlements_settled_week',
       'tournament_refund_entitlements_club_event',
       'rake_attributions_club_record')
     AND NOT (i.indisvalid AND i.indisready);
  IF v_invalid IS NOT NULL THEN
    RAISE EXCEPTION
      'these indexes exist but are INVALID (a CONCURRENTLY build failed): %. DROP INDEX CONCURRENTLY IF EXISTS each one and re-run STEP 1.',
      v_invalid USING ERRCODE = '55000';
  END IF;

  RAISE NOTICE 'all eight STEP 1 indexes present and valid';
END
$assert$;

COMMENT ON INDEX public.accounting_tournament_recognized_sources_event IS
  'fn_accounting_tournament_week_quality reads this table BY tournament_id '
  'twice per proven event. The only other index leads on recognized_at, so '
  'each of those reads was a full index scan - 238 buffers and ~1 ms to find '
  'six rows, 13,906 times for one club-week on 2026-09-25. Do not drop it.';

COMMENT ON INDEX public.accounting_tournament_fee_sources_club_event IS
  'The club scope of the weekly tournament gate and of '
  'accounting_payable_earning_sources. Without it, filtering 82,693 fee '
  'sources by club_id heap-fetched the wide contract column - 141,677 buffers '
  'for one week. Do not drop it.';


-- ----------------------------------------------------------------------------
-- 2.2  THE BODIES BEING REPLACED ARE THE BODIES THIS WAS WRITTEN AGAINST
--
-- The two replacements below were derived from, and measured against, the
-- bodies installed on production on 2026-09-25/26. Many agents change accounting
-- functions in a day; CREATE OR REPLACE would silently overwrite a newer change
-- somebody else installed. So the transaction refuses unless each installed
-- prosrc is byte-for-byte the one this file replaces.
--
-- fn_accounting_tournament_fee_net_plan is pinned too, although it is not
-- replaced: the gate's fast path in 2.3 reproduces what net_plan returns for an
-- event with no refund reversal. If net_plan has changed, that equivalence has
-- not been re-proven, and the rewrite must not be installed over it.
--
-- prosrc (not pg_get_functiondef) is compared so the same pin holds on a native
-- rehearsal cluster, whose SET search_path renders differently.
-- ----------------------------------------------------------------------------
DO $preimage$
DECLARE v_moved text;
BEGIN
  SELECT string_agg(format('%s (installed %s, expected %s)', want.sig, COALESCE(md5(p.prosrc), 'absent'), want.body_md5), '; ' ORDER BY want.sig)
    INTO v_moved
    FROM (VALUES
      ('public.fn_accounting_tournament_week_quality(uuid,timestamp with time zone,timestamp with time zone)', '79e2a8eea9f4ca5b29f88ac4464336e5'),
      ('public.fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])',                                   '0f12fff51636d61be422a37c3b8685f8'),
      ('public.fn_accounting_tournament_fee_net_plan(uuid)',                                                  '086848bc23bc2a8f89da6732d2da80c1')
    ) AS want(sig, body_md5)
    LEFT JOIN pg_proc p ON p.oid = to_regprocedure(want.sig)
   WHERE md5(p.prosrc) IS DISTINCT FROM want.body_md5;
  IF v_moved IS NOT NULL THEN
    RAISE EXCEPTION
      'preimage moved: %. Another change reached these functions after this rewrite was written. Re-derive the rewrite from the installed bodies; never install it over them.',
      v_moved USING ERRCODE = '55000';
  END IF;
  RAISE NOTICE 'preimages match: week_quality, calculate_cash_rakeback_periods, fee_net_plan';
END
$preimage$;


-- ----------------------------------------------------------------------------
-- 2.3  THE WEEKLY TOURNAMENT GATE PROVES THE WEEK IN ONE PASS
--
-- Same loop, same order (tournament_id), same reasons, same details. What
-- changes is that the loop body no longer issues five queries per event.
--
-- One set-based pass computes, for the events that are actually in scope, the
-- facts fn_accounting_tournament_fee_net_plan would have re-derived one
-- tournament at a time:
--
--   invalid_rows    the rows net_plan refuses as tournament_fee_source_invalid
--   negative_rows   whether the event has any refund reversal at all
--   raw_total       net_plan's net_fee
--   fingerprint     net_plan's source_fingerprint
--   scope_count     what net_plan refuses as tournament_fee_game_scope_changed
--   source_union    net_plan's union_id
--   batch_bad       tournament_fee_sources_require_reconciliation
--   scope_bad       tournament_fee_source_scope_changed
--   receipt_bad / orphan_bad / earned_sum
--                   the recognised-source receipt checks, with the fast path's
--                   active set (every fee source) and empty refunded set
--
-- WHEN THE FAST PATH IS VALID, AND WHY IT IS NOT AN APPROXIMATION
--
-- net_plan's whole remaining body is the refund graph: it walks
-- `negative_ids`, and with no negative fee record that WHILE loop never
-- executes, so `refunded` is empty, `refunded_total` is 0,
-- `positive_total - 0 = raw_total` holds by construction, every remaining
-- RAISE is one of the set-computed facts above, `active_source_ids` is every
-- fee source of the event and `refunded_source_ids` is empty. The three fields
-- the gate compares -- source_fingerprint, net_fee, union_id -- are then
-- exactly the aggregates above. So for such an event calling net_plan cannot
-- change the outcome, and it is not called.
--
-- WHEN IT IS NOT VALID, NOTHING CHANGES
--
-- An event with a refund reversal, or whose cheap facts already disagree,
-- falls through to the ORIGINAL per-event path below -- net_plan included --
-- and produces the original reason and the original SQLERRM detail. On
-- production on 2026-09-25 the week held 12,423 candidate events and NOT ONE
-- of them had a refund reversal, so the slow path is rare by measurement as
-- well as by construction.
--
-- Measured effect on Deep Stack Society, week 2026-09-21, warm: 50,679 ms.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_accounting_tournament_week_quality(p_club_id uuid, p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE event record;scope_union uuid;actual_union uuid;related boolean;unknown_scope boolean;
 proof jsonb;active_ids uuid[];refunded_ids uuid[];checked int:=0;issue_count bigint;
BEGIN
 IF p_club_id IS NULL OR p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from) OR NOT isfinite(p_to) OR p_from>=p_to
 THEN RAISE EXCEPTION 'invalid_accounting_tournament_week' USING ERRCODE='22023';END IF;
 SELECT union_id INTO scope_union FROM public.clubs WHERE id=p_club_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'accounting_club_not_found' USING ERRCODE='22023';END IF;
 FOR event IN
  WITH candidates AS (
   SELECT tournament_id FROM public.accounting_tournament_fee_recognitions WHERE recognized_at>=p_from AND recognized_at<p_to
   UNION SELECT tournament_id FROM public.tournament_rake_settlements WHERE settled_at>=p_from AND settled_at<p_to
   UNION SELECT tournament_id FROM public.tournament_terminal_settlements WHERE COALESCE(settled_at,completed_at)>=p_from AND COALESCE(settled_at,completed_at)<p_to
   UNION SELECT tournament_id FROM public.tournament_cancellation_receipts WHERE settled_at>=p_from AND settled_at<p_to
   UNION SELECT tournament_id FROM public.tournament_satellite_settlements WHERE settled_at>=p_from AND settled_at<p_to
  ), ev AS (
   SELECT c.tournament_id,r.recognized_at,r.status,r.net_rake,r.union_id,r.bank_club_id,r.source_fingerprint,
    b.settled_at AS bank_at,b.amount AS bank_amount,b.union_id AS bank_union,b.club_id AS fee_bank_club
    FROM candidates c LEFT JOIN public.accounting_tournament_fee_recognitions r USING(tournament_id)
     LEFT JOIN public.tournament_rake_settlements b USING(tournament_id)
  ), fee_scope AS (
   SELECT s.tournament_id,count(*) AS fee_source_count,
    count(DISTINCT COALESCE(s.union_id::text,'private')) AS scope_count,
    min(s.union_id::text)::uuid AS one_union
    FROM public.accounting_tournament_fee_sources s
    JOIN candidates c ON c.tournament_id=s.tournament_id GROUP BY s.tournament_id
  ), club_sourced AS (
   SELECT s.tournament_id FROM public.accounting_tournament_fee_sources s WHERE s.club_id=p_club_id
   UNION
   SELECT s.tournament_id FROM public.accounting_tournament_fee_sources s
    WHERE scope_union IS NOT NULL AND s.coordinator_union_id=scope_union
  ), club_refunded AS (
   SELECT e.tournament_id FROM public.tournament_refund_entitlements e WHERE e.refund_wallet_club_id=p_club_id
  ), scoped AS (
   SELECT e.*,COALESCE(f.fee_source_count,0) AS fee_source_count,COALESCE(f.scope_count,0) AS scope_count,
    CASE WHEN f.scope_count=1 THEN f.one_union END AS source_union,
    COALESCE(e.union_id,e.bank_union,CASE WHEN f.scope_count=1 THEN f.one_union END) AS actual_union
    FROM ev e LEFT JOIN fee_scope f ON f.tournament_id=e.tournament_id
    -- The original's first CONTINUE: an event whose banked/recognised instant
    -- sits outside the week, and whose recognition is outside it too, is not
    -- this week's business at all.
    WHERE COALESCE(e.bank_at,e.recognized_at) IS NULL
       OR (COALESCE(e.bank_at,e.recognized_at)>=p_from AND COALESCE(e.bank_at,e.recognized_at)<p_to)
       OR (e.recognized_at IS NOT NULL AND e.recognized_at>=p_from AND e.recognized_at<p_to)
  ), survivors AS (
   SELECT s.* FROM scoped s
    WHERE COALESCE(s.actual_union=scope_union,false)
       OR COALESCE(s.bank_club_id=p_club_id,false)
       OR COALESCE(s.fee_bank_club=p_club_id,false)
       OR EXISTS(SELECT 1 FROM club_sourced cs WHERE cs.tournament_id=s.tournament_id)
       OR EXISTS(SELECT 1 FROM club_refunded cr WHERE cr.tournament_id=s.tournament_id)
       OR (s.actual_union IS NULL AND (s.status IS NULL OR s.status='banked_accrual_deferred')
        AND (COALESCE(s.net_rake,s.bank_amount,0)>0
         OR EXISTS(SELECT 1 FROM public.rake_records r WHERE r.tournament_id=s.tournament_id AND r.is_tournament AND r.rake_amount<>0))
        AND (NOT EXISTS(SELECT 1 FROM public.rake_records r WHERE r.tournament_id=s.tournament_id AND r.is_tournament AND r.rake_amount>0)
         OR EXISTS(SELECT 1 FROM public.rake_records r LEFT JOIN public.accounting_tournament_fee_batches b ON b.rake_record_id=r.id
          WHERE r.tournament_id=s.tournament_id AND r.is_tournament AND r.rake_amount>0
           AND (b.status IS DISTINCT FROM 'captured' OR b.source_fingerprint IS DISTINCT FROM public.fn_accounting_tournament_fee_fingerprint(r)
            OR r.rake_amount IS DISTINCT FROM(SELECT sum(s2.rake_credit) FROM public.accounting_tournament_fee_sources s2 WHERE s2.rake_record_id=r.id)))
         OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources s3 WHERE s3.tournament_id=s.tournament_id
          AND (NOT(s3.contract ? 'coordinator_union_id') OR s3.contract->'membership'->>'history_id' IS NULL
           OR s3.contract->>'club_id' IS DISTINCT FROM s3.club_id::text OR s3.contract->>'player_id' IS DISTINCT FROM s3.player_id::text))))
  ), survivor_ids AS MATERIALIZED (
   -- A CTE scan carries no index, so joining the aggregates below to
   -- `survivors` by tournament_id made the planner merge-join a FULL scan of
   -- idx_rake_records_tournament. Handing them one array instead turns every
   -- one of them into `tournament_id = ANY($1)` against the real index.
   SELECT array_agg(k.tournament_id) AS ids FROM survivors k
  ), rr AS MATERIALIZED (
   SELECT r.tournament_id,r.id,r.rake_amount,r.hand_id,public.fn_accounting_tournament_fee_fingerprint(r) AS fp
    FROM public.rake_records r
    WHERE r.is_tournament AND r.tournament_id=ANY((SELECT sid.ids FROM survivor_ids sid)::uuid[])
  ), src_sum AS (
   SELECT s.rake_record_id,sum(s.rake_credit) AS credited
    FROM public.accounting_tournament_fee_sources s JOIN rr ON rr.id=s.rake_record_id GROUP BY s.rake_record_id
  ), rr_agg AS (
   SELECT rr.tournament_id,
    count(*) FILTER(WHERE rr.rake_amount IS NULL OR rr.rake_amount<>round(rr.rake_amount,2)
      OR rr.rake_amount::text IN('NaN','Infinity','-Infinity') OR rr.hand_id IS NOT NULL) AS invalid_rows,
    count(*) FILTER(WHERE rr.rake_amount<0) AS negative_rows,
    COALESCE(sum(rr.rake_amount),0) AS raw_total,
    md5(COALESCE(string_agg(rr.fp,':' ORDER BY rr.id),'')) AS fingerprint
    FROM rr GROUP BY rr.tournament_id
  ), batch_bad AS (
   SELECT rr.tournament_id,count(*) AS bad
    FROM rr LEFT JOIN public.accounting_tournament_fee_batches b ON b.rake_record_id=rr.id
            LEFT JOIN src_sum ss ON ss.rake_record_id=rr.id
    WHERE rr.rake_amount>0
     AND ((b.status IS DISTINCT FROM 'captured' AND NOT public.fn_accounting_mixed_cutover_spin_proof_valid(rr.id))
      OR b.tournament_id IS DISTINCT FROM rr.tournament_id
      OR b.source_fingerprint IS DISTINCT FROM rr.fp
      OR b.rake_amount IS DISTINCT FROM rr.rake_amount
      OR b.rake_amount IS DISTINCT FROM ss.credited)
    GROUP BY rr.tournament_id
  ), scope_bad AS (
   SELECT s.tournament_id,count(*) AS bad
    FROM public.accounting_tournament_fee_sources s
    LEFT JOIN rr ON rr.id=s.rake_record_id AND rr.tournament_id=s.tournament_id AND rr.rake_amount>0
    WHERE s.tournament_id=ANY((SELECT sid.ids FROM survivor_ids sid)::uuid[]) AND rr.id IS NULL GROUP BY s.tournament_id
  ), receipt_bad AS (
   SELECT s.tournament_id,count(*) AS bad
    FROM public.accounting_tournament_fee_sources s JOIN survivors k ON k.tournament_id=s.tournament_id
    LEFT JOIN public.accounting_tournament_recognized_sources rs ON rs.source_id=s.id
    WHERE s.tournament_id=ANY((SELECT sid.ids FROM survivor_ids sid)::uuid[]) AND (rs.source_id IS NULL OR rs.tournament_id IS DISTINCT FROM s.tournament_id
     OR rs.recognized_at IS DISTINCT FROM k.recognized_at
     OR rs.disposition IS DISTINCT FROM 'earned'
     OR rs.rake_credit IS DISTINCT FROM s.rake_credit
     OR s.contract->>'player_id' IS DISTINCT FROM s.player_id::text
     OR s.contract->>'club_id' IS DISTINCT FROM s.club_id::text
     OR (s.contract->>'rake_credit')::numeric IS DISTINCT FROM s.rake_credit
     OR (s.contract->>'terms_at')::timestamptz IS DISTINCT FROM s.charged_at
     OR s.charged_at>k.recognized_at
     OR NULLIF(s.contract->>'union_id','')::uuid IS DISTINCT FROM s.union_id
     OR NULLIF(s.contract->>'coordinator_union_id','')::uuid IS DISTINCT FROM s.coordinator_union_id)
    GROUP BY s.tournament_id
  ), orphan_bad AS (
   SELECT rs.tournament_id,count(*) AS bad
    FROM public.accounting_tournament_recognized_sources rs
    LEFT JOIN public.accounting_tournament_fee_sources s ON s.id=rs.source_id
    WHERE rs.tournament_id=ANY((SELECT sid.ids FROM survivor_ids sid)::uuid[])
     AND (s.id IS NULL OR s.tournament_id IS DISTINCT FROM rs.tournament_id) GROUP BY rs.tournament_id
  ), earned_sum AS (
   SELECT rs.tournament_id,COALESCE(sum(rs.rake_credit),0) AS earned
    FROM public.accounting_tournament_recognized_sources rs
    WHERE rs.tournament_id=ANY((SELECT sid.ids FROM survivor_ids sid)::uuid[])
     AND rs.disposition='earned' GROUP BY rs.tournament_id
  )
  SELECT k.tournament_id,k.recognized_at,k.status,k.net_rake,k.union_id,k.bank_club_id,k.source_fingerprint,
   k.bank_at,k.bank_amount,k.bank_union,k.fee_bank_club,k.actual_union,k.source_union,k.scope_count,
   COALESCE(a.invalid_rows,0) AS invalid_rows,COALESCE(a.negative_rows,0) AS negative_rows,
   COALESCE(a.raw_total,0) AS raw_total,COALESCE(a.fingerprint,md5('')) AS fingerprint,
   COALESCE(bb.bad,0) AS batch_bad,COALESCE(sb.bad,0) AS scope_bad,COALESCE(rb.bad,0) AS receipt_bad,
   COALESCE(ob.bad,0) AS orphan_bad,COALESCE(es.earned,0) AS earned_sum
   FROM survivors k
   LEFT JOIN rr_agg a ON a.tournament_id=k.tournament_id
   LEFT JOIN batch_bad bb ON bb.tournament_id=k.tournament_id
   LEFT JOIN scope_bad sb ON sb.tournament_id=k.tournament_id
   LEFT JOIN receipt_bad rb ON rb.tournament_id=k.tournament_id
   LEFT JOIN orphan_bad ob ON ob.tournament_id=k.tournament_id
   LEFT JOIN earned_sum es ON es.tournament_id=k.tournament_id
   ORDER BY k.tournament_id
 LOOP
  actual_union:=event.actual_union;
  checked:=checked+1;
  -- `unknown_scope` is REPORTED, not decided, here: `survivors` above already
  -- filters on the identical expression, so it chose the same events either
  -- way. It is still computed VERBATIM rather than abbreviated, because the two
  -- blocked responses below carry it to a reader, and a field that is true a
  -- little more often than it used to be is a wrong answer however cheap it is.
  -- It costs nothing: only an event that is about to be RETURNED reaches it,
  -- and a RETURN ends the loop.
  unknown_scope:=false;
  IF event.status IS NULL OR event.status='banked_accrual_deferred' THEN
   unknown_scope:=actual_union IS NULL
    AND (COALESCE(event.net_rake,event.bank_amount,0)>0
     OR EXISTS(SELECT 1 FROM public.rake_records r WHERE r.tournament_id=event.tournament_id AND r.is_tournament AND r.rake_amount<>0))
    AND (NOT EXISTS(SELECT 1 FROM public.rake_records r WHERE r.tournament_id=event.tournament_id AND r.is_tournament AND r.rake_amount>0)
     OR EXISTS(SELECT 1 FROM public.rake_records r LEFT JOIN public.accounting_tournament_fee_batches b ON b.rake_record_id=r.id
      WHERE r.tournament_id=event.tournament_id AND r.is_tournament AND r.rake_amount>0
       AND (b.status IS DISTINCT FROM 'captured' OR b.source_fingerprint IS DISTINCT FROM public.fn_accounting_tournament_fee_fingerprint(r)
        OR r.rake_amount IS DISTINCT FROM(SELECT sum(s.rake_credit) FROM public.accounting_tournament_fee_sources s WHERE s.rake_record_id=r.id)))
     OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources s WHERE s.tournament_id=event.tournament_id
      AND (NOT(s.contract ? 'coordinator_union_id') OR s.contract->'membership'->>'history_id' IS NULL
       OR s.contract->>'club_id' IS DISTINCT FROM s.club_id::text OR s.contract->>'player_id' IS DISTINCT FROM s.player_id::text)));
  END IF;
  IF event.status IS NULL THEN
   RETURN jsonb_build_object('status','blocked','reason','tournament_terminal_recognition_missing','tournament_id',event.tournament_id,'unknown_scope',unknown_scope);
  END IF;
  IF event.status='banked_accrual_deferred' THEN
   RETURN jsonb_build_object('status','blocked','reason','tournament_recognition_deferred','tournament_id',event.tournament_id,'unknown_scope',unknown_scope);
  END IF;
  -- An eventual normal/satellite terminal receipt may follow a banked fee in
  -- another week. Only original fee-bank/recognition time chooses its liability.
  IF event.bank_at IS NOT NULL AND (event.bank_at IS DISTINCT FROM event.recognized_at
    OR event.bank_amount IS DISTINCT FROM event.net_rake OR event.bank_union IS DISTINCT FROM event.union_id) THEN
   RETURN jsonb_build_object('status','blocked','reason','tournament_recognition_bank_disagrees','tournament_id',event.tournament_id);
  END IF;
  IF event.negative_rows=0 AND event.invalid_rows=0 AND event.raw_total>=0
     AND event.scope_count<=1 AND event.batch_bad=0 AND event.scope_bad=0 THEN
   -- net_plan is determined for this event; see the note above 2.3.
   IF event.fingerprint IS DISTINCT FROM event.source_fingerprint
     OR event.raw_total IS DISTINCT FROM event.net_rake
     OR event.source_union IS DISTINCT FROM event.union_id
     OR (event.status='recognized') IS DISTINCT FROM(event.net_rake>0)
     OR (event.status='cancelled') IS DISTINCT FROM(event.net_rake=0) THEN
    RETURN jsonb_build_object('status','blocked','reason','tournament_recognition_disagrees_with_sources','tournament_id',event.tournament_id);
   END IF;
   IF event.receipt_bad>0 OR event.orphan_bad>0 OR event.earned_sum IS DISTINCT FROM event.net_rake THEN
    RETURN jsonb_build_object('status','blocked','reason','tournament_recognized_source_receipts_incomplete','tournament_id',event.tournament_id);
   END IF;
   CONTINUE;
  END IF;
  -- SLOW PATH, unchanged: a refund reversal, or a cheap fact that already
  -- disagrees, still gets the full per-event proof and its exact detail.
  BEGIN proof:=public.fn_accounting_tournament_fee_net_plan(event.tournament_id);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '55000' THEN
   RETURN jsonb_build_object('status','blocked','reason','tournament_net_source_evidence_invalid','detail',SQLERRM,'tournament_id',event.tournament_id);
  END;
  IF proof->>'status' IS DISTINCT FROM 'proven' OR proof->>'source_fingerprint' IS DISTINCT FROM event.source_fingerprint
    OR (proof->>'net_fee')::numeric IS DISTINCT FROM event.net_rake OR NULLIF(proof->>'union_id','')::uuid IS DISTINCT FROM event.union_id
    OR (event.status='recognized') IS DISTINCT FROM(event.net_rake>0)
    OR (event.status='cancelled') IS DISTINCT FROM(event.net_rake=0) THEN
   RETURN jsonb_build_object('status','blocked','reason','tournament_recognition_disagrees_with_sources','tournament_id',event.tournament_id);
  END IF;
  SELECT COALESCE(array_agg(value::uuid),'{}') INTO active_ids FROM jsonb_array_elements_text(proof->'active_source_ids');
  SELECT COALESCE(array_agg(value::uuid),'{}') INTO refunded_ids FROM jsonb_array_elements_text(proof->'refunded_source_ids');
  SELECT count(*) INTO issue_count FROM public.accounting_tournament_fee_sources s
   LEFT JOIN public.accounting_tournament_recognized_sources rs ON rs.source_id=s.id
   WHERE s.tournament_id=event.tournament_id AND (rs.source_id IS NULL OR rs.tournament_id IS DISTINCT FROM s.tournament_id
    OR rs.recognized_at IS DISTINCT FROM event.recognized_at
    OR NOT(s.id=ANY(active_ids||refunded_ids))
    OR rs.disposition IS DISTINCT FROM CASE WHEN s.id=ANY(active_ids) THEN 'earned' ELSE 'refunded' END
    OR rs.rake_credit IS DISTINCT FROM CASE WHEN s.id=ANY(active_ids) THEN s.rake_credit ELSE 0 END
    OR s.contract->>'player_id' IS DISTINCT FROM s.player_id::text OR s.contract->>'club_id' IS DISTINCT FROM s.club_id::text
    OR (s.contract->>'rake_credit')::numeric IS DISTINCT FROM s.rake_credit
    OR (s.contract->>'terms_at')::timestamptz IS DISTINCT FROM s.charged_at OR s.charged_at>event.recognized_at
    OR NULLIF(s.contract->>'union_id','')::uuid IS DISTINCT FROM s.union_id
    OR NULLIF(s.contract->>'coordinator_union_id','')::uuid IS DISTINCT FROM s.coordinator_union_id);
  IF issue_count>0 OR EXISTS(SELECT 1 FROM public.accounting_tournament_recognized_sources rs
   LEFT JOIN public.accounting_tournament_fee_sources s ON s.id=rs.source_id
   WHERE rs.tournament_id=event.tournament_id AND (s.id IS NULL OR s.tournament_id IS DISTINCT FROM event.tournament_id))
   OR (SELECT COALESCE(sum(rake_credit),0) FROM public.accounting_tournament_recognized_sources WHERE tournament_id=event.tournament_id AND disposition='earned') IS DISTINCT FROM event.net_rake THEN
   RETURN jsonb_build_object('status','blocked','reason','tournament_recognized_source_receipts_incomplete','tournament_id',event.tournament_id);
  END IF;
 END LOOP;
 RETURN jsonb_build_object('status','ready','checked',checked);
END $function$;

COMMENT ON FUNCTION public.fn_accounting_tournament_week_quality(uuid, timestamp with time zone, timestamp with time zone) IS
  'Weekly tournament recognition gate for one club. Same assertions, same '
  'reasons and same tournament_id order as before 2026-09-25; the per-event '
  'loop body no longer issues five queries per tournament. An event with no '
  'refund reversal and clean structural facts has its net plan determined '
  'algebraically by the set pass, so fn_accounting_tournament_fee_net_plan is '
  'not called for it; an event with a refund reversal, or whose cheap facts '
  'disagree, still takes the original per-event path including net_plan. '
  'Measured 50,679 ms warm for one club-week (6,953 proven events) before.';

-- Private to its callers, as installed: the owner alone executes it. CREATE OR
-- REPLACE keeps the existing ACL; this states it rather than relying on it.
REVOKE ALL ON FUNCTION public.fn_accounting_tournament_week_quality(uuid, timestamp with time zone, timestamp with time zone)
  FROM PUBLIC, anon, authenticated, service_role;


-- ----------------------------------------------------------------------------
-- 2.4  THE WEEK IS READ ONCE, NOT THREE TIMES, AND FIVE CLUBS ARE NOT PROBED
--      HALF A MILLION TIMES
--
-- fn_calculate_cash_rakeback_periods keeps every assertion, every reason
-- string and the order it applies them in. What changes:
--
--   * The week's rake_records slice, the club's attributions and the week's
--     accrual batches and sources are computed ONCE in MATERIALIZED CTEs and
--     reused by all three source-evidence counts, instead of the week being
--     scanned three separate times (3 x 238,049 rows, 3 x ~252,000 buffers).
--     The three counts are taken in one statement and then tested in exactly
--     the original order, so the reason returned for a bad week is unchanged.
--   * The correlated `NOT EXISTS (SELECT 1 FROM clubs c WHERE c.id=a.club_id
--     AND (c.is_union IS NOT TRUE OR …))` is split into its two exact halves:
--     NOT EXISTS(P OR Q) = NOT EXISTS(P) AND NOT EXISTS(Q). The first half is
--     a hashed membership test over five rows; the second is only reached for
--     a club that is a union, which is where the union-house evidence check
--     belongs anyway. It was 417,827 bitmap heap scans and 835,654 buffers.
--   * The certificate query stops carrying the `contract` jsonb through both
--     sorts (external merge, 162,456 kB plus five ~26 MB worker spills) and
--     stops probing accounting_tournament_fee_sources_pkey for cash rows: the
--     join key is now NULL for them, so the index scan is not entered at all.
--     342,029 buffers for a charged_at only tournament rows can have.
--
-- Nothing about the payee set changes. Every player with a source in the week
-- still produces one certificate, zero entitlement included, because the
-- GROUP BY is still over the same `accounting_payable_earning_sources` rows.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_calculate_cash_rakeback_periods(p_club_id uuid, p_period_start date, p_period_end date, p_user_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '300s'
AS $function$
DECLARE
 tournament_quality jsonb;v_from timestamptz; v_to timestamptz; cutover timestamptz; receipt jsonb;
 scope_union uuid; issue_count bigint; existing public.rakeback_periods%ROWTYPE;
 evidence_issues bigint; incomplete_issues bigint; drifted_issues bigint;
 certificate public.accounting_rakeback_period_calculations%ROWTYPE;
 player record; total_unrounded numeric; amount numeric; display_rate numeric;
 payer_kind text; payer_user uuid; coordinator_union uuid; allocations jsonb; plan jsonb;
 fingerprint text; period_id uuid; written integer:=0; confirmed integer:=0;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'accounting_period_not_authorised' USING ERRCODE='42501'; END IF;
 IF p_club_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL
    OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end)
    OR extract(isodow FROM p_period_start)<>1 OR p_period_end<>p_period_start+6
    OR (p_user_ids IS NOT NULL AND (cardinality(p_user_ids)>2000 OR array_position(p_user_ids,NULL) IS NOT NULL))
 THEN RAISE EXCEPTION 'invalid_accounting_period_request' USING ERRCODE='22023'; END IF;
 receipt:=jsonb_build_object('accounting_version',2,'club_id',p_club_id,'period_start',p_period_start,'period_end',p_period_end,'written',0,'status','blocked');
 v_from:=p_period_start::timestamp AT TIME ZONE 'America/Los_Angeles';
 v_to:=(p_period_end+1)::timestamp AT TIME ZONE 'America/Los_Angeles';
 SELECT starts_at INTO cutover FROM public.accounting_cash_accrual_cutover WHERE singleton;
 IF cutover IS NULL OR v_from<cutover THEN RETURN receipt||jsonb_build_object('reason','historical_week_before_observed_source_cutover'); END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('accounting_rakeback_period:'||p_club_id::text||':'||p_period_start::text,0));
 SELECT union_id INTO scope_union FROM public.clubs WHERE id=p_club_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'accounting_club_not_found' USING ERRCODE='22023'; END IF;
 -- Tournament fees are earned at terminal recognition. Open captured fees
 -- are excluded; deferred or missing terminal authority blocks its actual week.
 tournament_quality:=public.fn_accounting_tournament_week_quality(p_club_id,v_from,v_to);
 IF tournament_quality->>'status' IS DISTINCT FROM 'ready' THEN
  RETURN receipt||tournament_quality||jsonb_build_object('written',0);END IF;
 -- One pass over the week feeds all three source-evidence counts. They are
 -- TESTED below in the original order, so the reason a bad week reports is
 -- unchanged; only the number of times the week is read has.
 WITH week_records AS MATERIALIZED (
  SELECT r.id,r.hand_id,r.club_id,r.rake_amount,r.created_at
   FROM public.rake_records r
   WHERE r.created_at>=v_from AND r.created_at<v_to AND r.rake_amount>0
     AND r.is_tournament IS NOT TRUE AND r.tournament_id IS NULL
     -- fn_rake_record_is_ghost_twin returns false the moment hand_id is not
     -- null, so `hand_id IS NOT NULL OR NOT ghost_twin(...)` is the same
     -- predicate - but OR short-circuits, so a linked row never detoasts its
     -- metadata and never runs the function's EXISTS over
     -- idx_rake_records_table_id. 2,652 ms -> 348 ms for the week slice.
     AND (r.hand_id IS NOT NULL OR NOT public.fn_rake_record_is_ghost_twin(r.hand_id,r.table_id,r.metadata))
 ), club_attributions AS MATERIALIZED (
  SELECT a.id,a.rake_record_id,a.hand_id,a.player_id,a.club_id,a.weighted_rake_credit
   FROM public.rake_attributions a WHERE a.club_id=p_club_id
 ), week_batches AS MATERIALIZED (
  SELECT b.rake_record_id,b.status FROM public.accounting_cash_accrual_batches b
   JOIN week_records w ON w.id=b.rake_record_id
 ), week_sources AS MATERIALIZED (
  -- A source can only be the PERFECT match the count below looks for if its
  -- club_id is this club and its earned_at is the record's created_at, which
  -- is inside the week by construction. Narrowing to the club-week slice
  -- therefore preserves every perfect match and every miss, and the existing
  -- accounting_cash_rake_sources_period index serves it directly instead of
  -- detoasting `contract` for the whole table.
  SELECT s.id,s.rake_record_id,s.player_id,s.club_id,s.earned_at,s.rake_credit,
   s.contract->>'attribution_id' AS c_attribution,s.contract->>'player_id' AS c_player,s.contract->>'club_id' AS c_club
   FROM public.accounting_cash_rake_sources s
   WHERE s.club_id=p_club_id AND s.earned_at>=v_from AND s.earned_at<v_to
 ), scoped_records AS (
  SELECT w.* FROM week_records w
   WHERE w.club_id=p_club_id
     OR EXISTS(SELECT 1 FROM club_attributions a WHERE a.rake_record_id=w.id)
     OR EXISTS(SELECT 1 FROM public.clubs house WHERE house.id=w.club_id AND house.is_union IS TRUE
        AND scope_union IS NOT NULL AND (house.union_id=scope_union OR house.id=scope_union))
 ), checks AS (
  SELECT r.id,r.hand_id,r.rake_amount,count(a.id) AS attribution_count,
    COALESCE(sum(a.weighted_rake_credit),0) AS attributed,
    count(a.id) FILTER(WHERE a.hand_id IS DISTINCT FROM r.hand_id OR a.club_id IS NULL
      OR a.player_id IS NULL OR a.weighted_rake_credit IS NULL OR a.weighted_rake_credit<0
      OR a.weighted_rake_credit<>round(a.weighted_rake_credit,2)
      -- NOT EXISTS(c WHERE id=a.club_id AND (P OR Q))
      --   = NOT EXISTS(c WHERE id=a.club_id AND P) AND NOT EXISTS(c WHERE id=a.club_id AND Q)
      OR (a.club_id NOT IN(SELECT c.id FROM public.clubs c WHERE c.is_union IS NOT TRUE)
       AND NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=a.club_id AND c.is_union IS TRUE
        AND EXISTS(SELECT 1 FROM public.accounting_cash_rake_sources hs
          JOIN public.accounting_cash_accrual_batches hb ON hb.rake_record_id=hs.rake_record_id
          WHERE hs.rake_record_id=r.id AND hs.player_id=a.player_id AND hs.club_id=a.club_id
           AND hs.union_id=scope_union AND (c.id=hs.union_id OR c.union_id=hs.union_id)
           AND hs.earned_at=r.created_at AND hs.rake_credit=a.weighted_rake_credit AND hb.status='accrued'
           AND hs.contract->>'is_union_house'='true' AND hs.contract->>'attribution_id'=a.id::text
           AND hs.contract->>'club_id'=a.club_id::text AND hs.contract->>'player_id'=a.player_id::text
           AND hs.contract->>'union_id'=hs.union_id::text)))) AS invalid_count
   FROM scoped_records r LEFT JOIN public.rake_attributions a ON a.rake_record_id=r.id
   GROUP BY r.id,r.hand_id,r.rake_amount
 ), evidence AS (
  SELECT count(*) AS n FROM checks WHERE hand_id IS NULL OR attribution_count=0
   OR invalid_count>0 OR attributed<>rake_amount OR rake_amount<>round(rake_amount,2)
 ), incomplete AS (
  SELECT count(*) AS n FROM club_attributions a JOIN week_records r ON r.id=a.rake_record_id
   LEFT JOIN week_sources s ON s.rake_record_id=r.id AND s.player_id=a.player_id
   LEFT JOIN week_batches b ON b.rake_record_id=r.id
   WHERE s.id IS NULL OR b.status IS DISTINCT FROM 'accrued' OR s.club_id IS DISTINCT FROM a.club_id
     OR s.earned_at IS DISTINCT FROM r.created_at OR s.rake_credit IS DISTINCT FROM a.weighted_rake_credit
     OR s.c_attribution IS DISTINCT FROM a.id::text
     OR s.c_player IS DISTINCT FROM a.player_id::text OR s.c_club IS DISTINCT FROM a.club_id::text
 ), drifted AS (
  -- Bidirectional comparison also rejects an extra recorded source that no
  -- longer has an attribution. A matching subset is not a complete source set.
  SELECT count(*) AS n FROM public.accounting_cash_rake_sources s
   LEFT JOIN public.rake_records r ON r.id=s.rake_record_id
   LEFT JOIN public.rake_attributions a ON a.id=(s.contract->>'attribution_id')::uuid
   LEFT JOIN public.accounting_cash_accrual_batches b ON b.rake_record_id=s.rake_record_id
   WHERE s.club_id=p_club_id AND s.earned_at>=v_from AND s.earned_at<v_to
    AND (r.id IS NULL OR a.id IS NULL OR b.status IS DISTINCT FROM 'accrued'
     OR a.rake_record_id IS DISTINCT FROM s.rake_record_id OR a.hand_id IS DISTINCT FROM r.hand_id
     OR a.player_id IS DISTINCT FROM s.player_id OR a.club_id IS DISTINCT FROM s.club_id
     OR a.weighted_rake_credit IS DISTINCT FROM s.rake_credit OR s.earned_at IS DISTINCT FROM r.created_at
     OR r.is_tournament IS TRUE OR r.tournament_id IS NOT NULL
     OR NULLIF(s.contract->'union_id','null'::jsonb) IS DISTINCT FROM to_jsonb(s.union_id)
     OR NULLIF(s.contract->'coordinator_union_id','null'::jsonb) IS DISTINCT FROM to_jsonb(s.coordinator_union_id))
 )
 SELECT evidence.n,incomplete.n,drifted.n INTO evidence_issues,incomplete_issues,drifted_issues
   FROM evidence,incomplete,drifted;
 IF evidence_issues>0 THEN RETURN receipt||jsonb_build_object('reason','cash_earning_evidence_incomplete','source_count',evidence_issues); END IF;
 -- An old UTC or current-membership period remains an explicit conflict even
 -- when its numbers happen to match. Certificates establish the new writer.
 SELECT count(*) INTO issue_count FROM public.rakeback_periods rp
  WHERE rp.club_id=p_club_id AND rp.period_start<=p_period_end AND rp.period_end>=p_period_start
    AND (rp.status<>'pending' OR rp.period_start<>p_period_start OR rp.period_end<>p_period_end
      OR NOT EXISTS(SELECT 1 FROM public.accounting_rakeback_period_calculations c WHERE c.period_id=rp.id));
 IF issue_count>0 THEN RETURN receipt||jsonb_build_object('reason','legacy_or_paid_period_requires_reconciliation','period_count',issue_count); END IF;
 IF incomplete_issues>0 THEN RETURN receipt||jsonb_build_object('reason','cash_source_receipts_incomplete','source_count',incomplete_issues); END IF;
 IF drifted_issues>0 THEN RETURN receipt||jsonb_build_object('reason','cash_source_receipts_drifted','source_count',drifted_issues); END IF;

 FOR player IN
  WITH receipts AS (
   SELECT s.source_type,s.source_id,s.rake_record_id,s.player_id,s.union_id,s.coordinator_union_id,s.earned_at,s.rake_credit,
    CASE WHEN s.source_type='tournament_fee_accrual' THEN fee.charged_at ELSE s.earned_at END AS agreement_at,
    s.contract->'membership'->'terms' AS member,s.contract->'tiers'->0 AS direct,
    (s.contract->'membership'->>'history_id')::bigint AS member_history_ref,
    sum(s.rake_credit) OVER(PARTITION BY s.player_id) AS total_rake
   FROM public.accounting_payable_earning_sources s
   -- A cash row has no fee row, and a NULL join key never enters the index.
   LEFT JOIN public.accounting_tournament_fee_sources fee
     ON fee.id=CASE WHEN s.source_type='tournament_fee_accrual' THEN s.source_id END
   WHERE s.club_id=p_club_id AND s.earned_at>=v_from AND s.earned_at<v_to
     AND (p_user_ids IS NULL OR s.player_id=ANY(p_user_ids))
  ), parsed AS (
   SELECT r.*,NULLIF(r.member->>'agent_id','')::uuid AS member_agent,
    COALESCE((r.member->>'player_rakeback_pct')::numeric,0) AS deal,
    CASE WHEN NULLIF(r.member->>'agent_id','') IS NOT NULL
      THEN COALESCE((r.direct->'agreement'->'terms'->>'player_rakeback_rate')::numeric,0) ELSE 0 END AS offer,
    CASE WHEN NULLIF(r.member->>'agent_id','') IS NOT NULL THEN (r.direct->>'rate')::numeric END AS cap_rate,
    mh.id AS member_history_id,ah.id AS agent_history_id,
    mh.after_terms AS recorded_member,ah.after_terms AS recorded_agent
   FROM receipts r
   LEFT JOIN public.accounting_agreement_history mh ON mh.id=r.member_history_ref
    AND mh.entity_type='club_members' AND mh.entity_key=p_club_id::text||':'||r.player_id::text AND mh.observed_at<=r.agreement_at
   LEFT JOIN public.accounting_agreement_history ah ON ah.id=(r.direct->'agreement'->>'history_id')::bigint
    AND ah.entity_type='agents' AND ah.observed_at<=r.agreement_at
  ), rates AS (
   SELECT p.*,CASE WHEN p.deal>0 THEN p.deal WHEN p.offer>0 THEN p.offer
    WHEN p.total_rake>=10000 THEN 0.30 WHEN p.total_rake>=2000 THEN 0.20
    WHEN p.total_rake>=500 THEN 0.15 WHEN p.total_rake>=100 THEN 0.10 ELSE 0.05 END AS base_rate
   FROM parsed p
  ), effective AS (
   SELECT r.*,CASE WHEN r.cap_rate>0 THEN least(r.base_rate,greatest(r.cap_rate-0.10,0)) ELSE r.base_rate END AS applied_rate
   FROM rates r
  )
  SELECT e.player_id,max(e.total_rake) AS total_rake,sum(e.rake_credit*e.applied_rate) AS total_unrounded,
   count(*) FILTER(WHERE e.member_history_id IS NULL OR e.member IS DISTINCT FROM e.recorded_member
    OR e.member->>'club_id' IS DISTINCT FROM p_club_id::text OR e.member->>'user_id' IS DISTINCT FROM e.player_id::text
    OR COALESCE(e.member->>'status','') NOT IN('active','approved') OR e.member->>'is_active' IS DISTINCT FROM 'true') AS invalid_members,
   count(*) FILTER(WHERE e.member_agent IS NOT NULL AND (e.direct IS NULL OR e.agent_history_id IS NULL
    OR e.direct->'agreement'->'terms' IS DISTINCT FROM e.recorded_agent
    OR e.direct->>'user_id' IS DISTINCT FROM e.member_agent::text OR e.direct->>'depth' IS DISTINCT FROM '1'
    OR e.recorded_agent->>'club_id' IS DISTINCT FROM p_club_id::text OR e.recorded_agent->>'user_id' IS DISTINCT FROM e.member_agent::text
    OR e.recorded_agent->>'status' IS DISTINCT FROM 'active')) AS invalid_agents,
   count(*) FILTER(WHERE e.deal::text IN('NaN','Infinity','-Infinity') OR e.offer::text IN('NaN','Infinity','-Infinity')
    OR e.deal<0 OR e.deal>1 OR e.offer<0 OR e.offer>1
    OR (e.member_agent IS NOT NULL AND (e.cap_rate IS NULL OR e.cap_rate<0 OR e.cap_rate>1 OR e.cap_rate::text IN('NaN','Infinity','-Infinity')))) AS invalid_rates,
   count(DISTINCT COALESCE(e.member_agent::text,'club')) AS payer_count,
   count(DISTINCT COALESCE(e.coordinator_union_id::text,'standalone')) AS coordinator_count,
   min(e.member_agent::text)::uuid AS payer_user,
   min(e.coordinator_union_id::text)::uuid AS coordinator_union,
   jsonb_agg(jsonb_build_object('source_type',e.source_type,'source_id',e.source_id,'rake_record_id',e.rake_record_id,'union_id',e.union_id,
    'coordinator_union_id',e.coordinator_union_id,'rake_credit',e.rake_credit,'rate',e.applied_rate,
    'unrounded_rakeback',e.rake_credit*e.applied_rate,'earned_at',e.earned_at,'agreement_at',e.agreement_at,'membership_history_id',e.member_history_id,
    'agent_history_id',e.agent_history_id,'payer_kind',CASE WHEN e.member_agent IS NULL THEN 'club' ELSE 'agent' END,
    'payer_user_id',e.member_agent) ORDER BY e.earned_at,e.source_type,e.rake_record_id,e.source_id) AS allocations
  FROM effective e GROUP BY e.player_id ORDER BY e.player_id
 LOOP
  IF player.invalid_members>0 THEN RAISE EXCEPTION 'period_membership_contract_invalid' USING ERRCODE='55000'; END IF;
  IF player.invalid_agents>0 THEN RAISE EXCEPTION 'period_direct_agent_contract_invalid' USING ERRCODE='55000'; END IF;
  IF player.invalid_rates>0 THEN RAISE EXCEPTION 'period_observed_rate_invalid' USING ERRCODE='55000'; END IF;
  IF player.payer_count<>1 THEN RAISE EXCEPTION 'multiple_historical_payers_require_split_period' USING ERRCODE='55000'; END IF;
  IF player.coordinator_count<>1 THEN RAISE EXCEPTION 'multiple_recorded_coordinators_require_split_period' USING ERRCODE='55000'; END IF;
  total_unrounded:=player.total_unrounded;allocations:=player.allocations;payer_user:=player.payer_user;coordinator_union:=player.coordinator_union;
  payer_kind:=CASE WHEN payer_user IS NULL THEN 'club' ELSE 'agent' END;
  amount:=round(total_unrounded,2);
  display_rate:=CASE WHEN player.total_rake>0 THEN round(total_unrounded/player.total_rake,4) ELSE 0 END;
  IF amount>player.total_rake OR amount<0 THEN RAISE EXCEPTION 'period_rakeback_not_conserved' USING ERRCODE='55000'; END IF;
  fingerprint:=md5(jsonb_build_object('allocations',allocations,'rake',player.total_rake,'amount',amount,'rate',display_rate)::text);
  plan:=jsonb_build_object('player_id',player.player_id,'rake_generated',player.total_rake,
   'rakeback_amount',amount,'display_rate',display_rate,'coordinator_union_id',coordinator_union,'payer_kind',payer_kind,'payer_user_id',payer_user,
   'source_fingerprint',fingerprint,'allocations',allocations);
  SELECT * INTO existing FROM public.rakeback_periods WHERE club_id=p_club_id AND user_id=(plan->>'player_id')::uuid
    AND period_start=p_period_start AND period_end=p_period_end FOR UPDATE;
  IF FOUND THEN
   SELECT * INTO certificate FROM public.accounting_rakeback_period_calculations cert WHERE cert.period_id=existing.id ORDER BY cert.id DESC LIMIT 1;
   IF NOT FOUND OR certificate.accounting_version<>2 OR certificate.club_id IS DISTINCT FROM p_club_id
    OR certificate.player_id IS DISTINCT FROM existing.user_id OR certificate.period_start IS DISTINCT FROM p_period_start
    OR certificate.period_end IS DISTINCT FROM p_period_end
    OR existing.status<>'pending' OR existing.rake_generated IS DISTINCT FROM certificate.rake_generated
    OR existing.total_rake_paid IS DISTINCT FROM certificate.rake_generated OR existing.rakeback_rate IS DISTINCT FROM certificate.display_rate
    OR existing.rakeback_earned IS DISTINCT FROM certificate.rakeback_amount OR existing.rakeback_amount IS DISTINCT FROM certificate.rakeback_amount
   THEN RAISE EXCEPTION 'certified_period_drift_requires_reconciliation' USING ERRCODE='55000'; END IF;
   period_id:=existing.id;
   IF certificate.source_fingerprint=plan->>'source_fingerprint' THEN confirmed:=confirmed+1; CONTINUE; END IF;
   UPDATE public.rakeback_periods SET rake_generated=(plan->>'rake_generated')::numeric,total_rake_paid=(plan->>'rake_generated')::numeric,
    rakeback_rate=(plan->>'display_rate')::numeric,rakeback_earned=(plan->>'rakeback_amount')::numeric,rakeback_amount=(plan->>'rakeback_amount')::numeric
    WHERE id=period_id;
  ELSE
   INSERT INTO public.rakeback_periods(user_id,club_id,period_start,period_end,rake_generated,rakeback_rate,rakeback_earned,rakeback_amount,total_rake_paid,status)
    VALUES((plan->>'player_id')::uuid,p_club_id,p_period_start,p_period_end,(plan->>'rake_generated')::numeric,
     (plan->>'display_rate')::numeric,(plan->>'rakeback_amount')::numeric,(plan->>'rakeback_amount')::numeric,(plan->>'rake_generated')::numeric,'pending')
    RETURNING id INTO period_id;
  END IF;
  INSERT INTO public.accounting_rakeback_period_calculations(period_id,source_fingerprint,club_id,player_id,coordinator_union_id,period_start,period_end,
    rake_generated,rakeback_amount,display_rate,payer_kind,payer_user_id,source_allocations)
   VALUES(period_id,plan->>'source_fingerprint',p_club_id,(plan->>'player_id')::uuid,(plan->>'coordinator_union_id')::uuid,p_period_start,p_period_end,
    (plan->>'rake_generated')::numeric,(plan->>'rakeback_amount')::numeric,(plan->>'display_rate')::numeric,
    plan->>'payer_kind',(plan->>'payer_user_id')::uuid,plan->'allocations');
  written:=written+1;confirmed:=confirmed+1;
 END LOOP;
 RETURN receipt||jsonb_build_object('status','ready','written',written,'confirmed_players',confirmed);
EXCEPTION WHEN SQLSTATE '55000' THEN
 RETURN receipt||jsonb_build_object('reason',SQLERRM);
END $function$;

COMMENT ON FUNCTION public.fn_calculate_cash_rakeback_periods(uuid, date, date, uuid[]) IS
  'Writes one certified rakeback period per payee with a source in the club '
  'week, zero entitlement included. Same assertions, same reasons and the same '
  'order of them as before 2026-09-25; the week is now read once rather than '
  'three times, the five-row clubs table is no longer probed once per '
  'attribution, and the certificate query no longer carries the contract jsonb '
  'through its sorts. Do not reintroduce a per-row clubs lookup here.';

-- Reached only through fn_rakeback_recompute_periods; the owner alone executes
-- it, exactly as installed.
REVOKE ALL ON FUNCTION public.fn_calculate_cash_rakeback_periods(uuid, date, date, uuid[])
  FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
