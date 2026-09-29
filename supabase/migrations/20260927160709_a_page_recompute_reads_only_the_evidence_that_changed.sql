-- ============================================================================
-- A PAGE RECOMPUTE READS ONLY THE EVIDENCE THAT CHANGED
-- ============================================================================
--
-- WHAT IS WRONG (read from production 2026-09-27, not inferred)
--
-- Every page-scoped fn_rakeback_recompute_periods call that the unaccrued-hand
-- door (20260926091232) does not answer runs fn_calculate_cash_rakeback_periods
-- over the whole club-week: the tournament gate, then three evidence counts
-- over every cash record, attribution and source of the week. On Sunday
-- 2026-09-27 that is 336,785 records, 527,470 club attributions and 527,314
-- sources for Deep Stack Society; the counts alone took 60,276 ms and
-- 3.17 M buffers (211,471 read from disk), the gate 9,368 ms (14,152 events).
-- auto_explain logged 34-288 s page calls, 830-1,350 s of database time an hour
-- between 11:00 and 14:00 UTC, while the calls hold the club-week lock.
--
-- Not one of them wrote a certificate: the last certificate of week 2026-09-21
-- is from 2026-09-26 13:38. The week holds 51 cash records with no accrual
-- batch (40 Deep Stack Society, 11 union house, 2026-09-26 13:38 onward) that
-- are older than the 200 newest records the door reads, so every fall-through
-- read the whole week to reach the same refusal.
--
-- WHY IT CAN BE EXACT WITHOUT READING THE WEEK
--
-- The three counts are sums over the week's records. A record with an accrual
-- batch is frozen: rake_records and rake_attributions refuse every change once
-- the batch exists (fn_accounting_cash_source_immutable), the batch and the
-- sources are insert-only and written together by one function
-- (fn_accrue_cash_hand_commissions), and the only other input to its share is
-- the clubs' union shape. So its share never changes.
--
-- accounting_rakeback_period_evidence_checkpoints keeps, per club-week, the
-- shares of every batch recorded before a horizon, taken as the start of the
-- oldest transaction then running, less two minutes: no batch recorded
-- earlier can still be uncommitted, and none can appear later (a batch is
-- recorded at or after its own transaction's start, now enforced). A page adds,
-- in ONE snapshot, the batches recorded since the horizon and the records with
-- no batch at all, found by a merge of two new index ranges. The totals are
-- the whole-week counts exactly. A changed clubs digest or a missing row
-- rebuilds from the week's first batch.
--
-- WHAT CHANGES
--
-- * Page calls (p_user_ids NOT NULL) only. The whole-period call - the weekly
--   close's fn_prepare_accounting_week - keeps its full verification,
--   byte-for-byte: gate first, the original week query, the original checks.
-- * A page answers the same status, the same reasons and counts, and writes
--   the same certificates (the certificate loop is untouched). One deliberate
--   difference, in refusals only and of the shape the unaccrued-hand door
--   already answers: a page refused by its cash evidence is not also sent
--   through the tournament gate, so when both would refuse it names the cash
--   reason. The first page of a club-week reads the week once to build its
--   checkpoint; every later page reads what changed.
-- * Two BEFORE INSERT guards make the two facts above refusals instead of
--   assumptions. Both hold for every existing row (verified read-only).
-- * No cron, watcher or reconciler. Nothing changes the settler, the
--   watermark, daemon_state, the settlement floors or any timeout.
--
-- STEP 1 builds three indexes CONCURRENTLY (rake_records is written every
-- hand; CLAUDE.md section 2 rule 7). STEP 2 is one transaction.
--
-- Full reasoning and measurements:
-- docs/changelog/2026-09-27-a-page-recompute-reads-only-the-evidence-that-changed.md
-- ============================================================================

-- ============================================================================
-- STEP 1 - OUTSIDE ANY TRANSACTION
-- ============================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS rake_records_cash_positive_created
  ON public.rake_records (created_at, id)
  WHERE rake_amount > 0 AND is_tournament IS NOT TRUE AND tournament_id IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS accounting_cash_accrual_batches_earned_record
  ON public.accounting_cash_accrual_batches (earned_at, rake_record_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS accounting_cash_accrual_batches_recorded
  ON public.accounting_cash_accrual_batches (recorded_at) INCLUDE (earned_at, rake_record_id);

-- ============================================================================
-- STEP 2 - ONE TRANSACTION
-- ============================================================================
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- ----------------------------------------------------------------------------
-- 2.1  PRECONDITIONS: the three indexes are built and VALID, the calculator is
--      the body this change was derived from, and nothing it adds exists yet.
-- ----------------------------------------------------------------------------
DO $pre$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(want, ', ' ORDER BY want) INTO v_bad
    FROM unnest(ARRAY['rake_records_cash_positive_created','accounting_cash_accrual_batches_earned_record',
                      'accounting_cash_accrual_batches_recorded']) want
   WHERE NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_index i ON i.indexrelid=c.oid
                      WHERE n.nspname='public' AND c.relname=want AND i.indisvalid AND i.indisready);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'STEP 1 index missing or INVALID: %. DROP INDEX CONCURRENTLY IF EXISTS it and re-run STEP 1.', v_bad USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid='public.fn_calculate_cash_rakeback_periods(uuid, date, date, uuid[])'::regprocedure
                    AND md5(p.prosrc)='80f40737e9015888f2b5c4215c383bc5') THEN
    RAISE EXCEPTION 'PERIOD_CALCULATOR_PREIMAGE_CHANGED: fn_calculate_cash_rakeback_periods is not the body this migration was derived from' USING ERRCODE='55000';
  END IF;
  IF to_regclass('public.accounting_rakeback_period_evidence_checkpoints') IS NOT NULL
     OR to_regproc('public.fn_cash_period_evidence_since') IS NOT NULL
     OR to_regproc('public.fn_accounting_commit_horizon') IS NOT NULL
     OR to_regproc('public.fn_accounting_clubs_scope_digest') IS NOT NULL
     OR to_regproc('public.fn_accounting_cash_batch_is_placed_in_time') IS NOT NULL
     OR to_regproc('public.fn_accounting_cash_source_matches_its_batch') IS NOT NULL THEN
    RAISE EXCEPTION 'EVIDENCE_CHECKPOINT_ALREADY_PRESENT: this migration has already run, or another one took its names' USING ERRCODE='55000';
  END IF;
END
$pre$;

COMMENT ON INDEX public.rake_records_cash_positive_created IS
  'The positive cash records of a week, in (created_at, id) order, so a page '
  'recompute finds the ones with no accrual batch by a merge against '
  'accounting_cash_accrual_batches_earned_record instead of reading the week. '
  'fn_cash_period_evidence_since. Do not drop it.';
COMMENT ON INDEX public.accounting_cash_accrual_batches_earned_record IS
  'Batches of a week in (earned_at, rake_record_id) order; earned_at is the '
  'record''s created_at (enforced), which is what makes the merge exact. '
  'fn_cash_period_evidence_since. Do not drop it.';
COMMENT ON INDEX public.accounting_cash_accrual_batches_recorded IS
  'Batches recorded since a checkpoint''s horizon: what a page recompute adds '
  'to the frozen counts it already holds. fn_cash_period_evidence_since.';

-- ----------------------------------------------------------------------------
-- 2.2  THE CHECKPOINT
--
-- One row per club-week, written only by the page path of
-- fn_calculate_cash_rakeback_periods under the club-week advisory lock the
-- calculator already holds. It is not a result: it holds the three week-level
-- counts contributed by every accrual batch recorded before `horizon`, which
-- can no longer change. No foreign key (CLAUDE.md section 2 rule 7).
-- ----------------------------------------------------------------------------
CREATE TABLE public.accounting_rakeback_period_evidence_checkpoints (
  club_id uuid NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  horizon timestamptz NOT NULL,
  clubs_digest text NOT NULL,
  settled_records bigint NOT NULL CHECK (settled_records >= 0),
  settled_evidence bigint NOT NULL CHECK (settled_evidence >= 0),
  settled_incomplete bigint NOT NULL CHECK (settled_incomplete >= 0),
  settled_drifted bigint NOT NULL CHECK (settled_drifted >= 0),
  built_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  advanced_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  advances bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (club_id, period_start),
  CHECK (period_end = period_start + 6)
);
ALTER TABLE public.accounting_rakeback_period_evidence_checkpoints ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.accounting_rakeback_period_evidence_checkpoints FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.accounting_rakeback_period_evidence_checkpoints TO service_role;
COMMENT ON TABLE public.accounting_rakeback_period_evidence_checkpoints IS
  'Frozen share of the three week-level cash evidence counts (evidence, '
  'incomplete, drifted) for every accrual batch recorded before horizon, per '
  'club-week, under the clubs union shape clubs_digest. Read and advanced only '
  'by the page path of fn_calculate_cash_rakeback_periods, which adds what was '
  'recorded since and the records with no batch. The whole-period call never '
  'reads it. 20260927160709.';

-- ----------------------------------------------------------------------------
-- 2.3  THE PIECES THE PAGE PATH READS
-- ----------------------------------------------------------------------------

-- Every club's id, union flag and union, as one value. The frozen shares of a
-- checkpoint depend on these and on nothing else that can change; a different
-- digest makes the page rebuild its checkpoint from the week's first batch.
CREATE FUNCTION public.fn_accounting_clubs_scope_digest()
RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
 SELECT md5(COALESCE(string_agg(c.id::text||'|'||COALESCE(c.is_union::text,'null')||'|'||COALESCE(c.union_id::text,'null'),',' ORDER BY c.id),''))
   FROM public.clubs c
$function$;

-- A time before which every transaction that could still commit a batch had
-- already ended: the start of the oldest transaction running now, or now,
-- whichever is earlier, less two minutes. A batch's recorded_at is at or after
-- its own transaction's start (accounting_cash_batch_is_placed_in_time
-- enforces it), so every batch recorded before this time is already visible to
-- the next snapshot and none can appear later. NULL - so nothing new is settled
-- - when that cannot be known: a prepared transaction exists, or the reader may
-- not see every session's transaction start.
CREATE FUNCTION public.fn_accounting_commit_horizon()
RETURNS timestamptz
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE oldest timestamptz; stamp timestamptz;
BEGIN
 IF NOT pg_catalog.pg_has_role(current_user,'pg_read_all_stats','MEMBER') THEN RETURN NULL; END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_prepared_xacts) THEN RETURN NULL; END IF;
 stamp:=clock_timestamp();
 SELECT min(a.xact_start) INTO oldest FROM pg_catalog.pg_stat_activity a WHERE a.xact_start IS NOT NULL;
 RETURN least(stamp,COALESCE(oldest,stamp))-interval '2 minutes';
END $function$;

-- The week-level counts of fn_calculate_cash_rakeback_periods, for two sets
-- of records only: those whose batch was recorded at or after p_batched_from
-- (frozen), and those with no batch at all. Every predicate is the
-- calculator's own, unchanged; a frozen record's share is additionally
-- counted as settled when its batch was recorded before p_settle_before.
-- ('infinity','-infinity') reads the batchless records alone.
--
-- STABLE, so every statement below reads the calling query's one snapshot:
-- a batch cannot land between the frozen read and the batchless read. The two
-- sets are collected first, so the counting query is planned for their real
-- size rather than for a guess about a week-long anti-join.
CREATE FUNCTION public.fn_cash_period_evidence_since(p_club_id uuid, p_from timestamptz, p_to timestamptz, p_scope_union uuid,
  p_batched_from timestamptz, p_settle_before timestamptz)
RETURNS TABLE(o_evidence bigint, o_incomplete bigint, o_drifted bigint, o_settled_records bigint,
  o_settled_evidence bigint, o_settled_incomplete bigint, o_settled_drifted bigint,
  o_unbatched_evidence bigint, o_unbatched_incomplete bigint)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
SET plan_cache_mode TO 'force_custom_plan'
SET max_parallel_workers_per_gather TO '0'
AS $function$
DECLARE frozen_ids uuid[]; frozen_settle boolean[]; unbatched_ids uuid[];
BEGIN
 IF p_club_id IS NULL OR p_from IS NULL OR p_to IS NULL OR p_batched_from IS NULL OR p_settle_before IS NULL THEN
  RAISE EXCEPTION 'invalid_cash_period_evidence_request' USING ERRCODE='22023'; END IF;
 -- earned_at is the record's created_at for every batch (enforced on insert),
 -- so these are exactly the batches of the week's records.
 SELECT COALESCE(array_agg(b.rake_record_id ORDER BY b.rake_record_id),'{}'),
        COALESCE(array_agg(b.recorded_at<p_settle_before ORDER BY b.rake_record_id),'{}')
   INTO frozen_ids,frozen_settle
   FROM public.accounting_cash_accrual_batches b
  WHERE b.earned_at>=p_from AND b.earned_at<p_to AND b.recorded_at>=p_batched_from;
 SELECT COALESCE(array_agg(r.id ORDER BY r.id),'{}') INTO unbatched_ids
   FROM public.rake_records r
  WHERE r.created_at>=p_from AND r.created_at<p_to AND r.rake_amount>0
    AND r.is_tournament IS NOT TRUE AND r.tournament_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_batches b
                    WHERE b.earned_at=r.created_at AND b.rake_record_id=r.id
                      AND b.earned_at>=p_from AND b.earned_at<p_to);
 RETURN QUERY
 WITH frozen AS MATERIALIZED (
  SELECT x.id,x.settle FROM unnest(frozen_ids,frozen_settle) AS x(id,settle)
 ), unbatched AS MATERIALIZED (
  SELECT x.id FROM unnest(unbatched_ids) AS x(id)
 ), target AS (
  SELECT f.id,f.settle,false AS unbatched FROM frozen f
  UNION ALL
  SELECT u.id,false,true FROM unbatched u
 ), week_records AS MATERIALIZED (
  SELECT r.id,r.hand_id,r.club_id,r.rake_amount,r.created_at,t.settle,t.unbatched
   FROM target t JOIN public.rake_records r ON r.id=t.id
   WHERE r.created_at>=p_from AND r.created_at<p_to AND r.rake_amount>0
     AND r.is_tournament IS NOT TRUE AND r.tournament_id IS NULL
     AND (r.hand_id IS NOT NULL OR NOT public.fn_rake_record_is_ghost_twin(r.hand_id,r.table_id,r.metadata))
 ), club_attributions AS MATERIALIZED (
  SELECT a.id,a.rake_record_id,a.hand_id,a.player_id,a.club_id,a.weighted_rake_credit
   FROM week_records w JOIN public.rake_attributions a ON a.rake_record_id=w.id
   WHERE a.club_id=p_club_id
 ), week_batches AS MATERIALIZED (
  SELECT b.rake_record_id,b.status FROM public.accounting_cash_accrual_batches b
   JOIN week_records w ON w.id=b.rake_record_id
 ), week_sources AS MATERIALIZED (
  -- Only the incomplete count reads this slice, joined by record and player,
  -- so the sources of these records are the only ones it can match.
  SELECT s.id,s.rake_record_id,s.player_id,s.club_id,s.earned_at,s.rake_credit,
   s.contract->>'attribution_id' AS c_attribution,s.contract->>'player_id' AS c_player,s.contract->>'club_id' AS c_club
   FROM week_records w JOIN public.accounting_cash_rake_sources s ON s.rake_record_id=w.id
   WHERE s.club_id=p_club_id AND s.earned_at>=p_from AND s.earned_at<p_to
 ), scoped_records AS (
  SELECT w.* FROM week_records w
   WHERE w.club_id=p_club_id
     OR EXISTS(SELECT 1 FROM club_attributions a WHERE a.rake_record_id=w.id)
     OR EXISTS(SELECT 1 FROM public.clubs house WHERE house.id=w.club_id AND house.is_union IS TRUE
        AND p_scope_union IS NOT NULL AND (house.union_id=p_scope_union OR house.id=p_scope_union))
 ), checks AS (
  SELECT r.id,r.hand_id,r.rake_amount,r.settle,r.unbatched,count(a.id) AS attribution_count,
    COALESCE(sum(a.weighted_rake_credit),0) AS attributed,
    count(a.id) FILTER(WHERE a.hand_id IS DISTINCT FROM r.hand_id OR a.club_id IS NULL
      OR a.player_id IS NULL OR a.weighted_rake_credit IS NULL OR a.weighted_rake_credit<0
      OR a.weighted_rake_credit<>round(a.weighted_rake_credit,2)
      OR (a.club_id NOT IN(SELECT c.id FROM public.clubs c WHERE c.is_union IS NOT TRUE)
       AND NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=a.club_id AND c.is_union IS TRUE
        AND EXISTS(SELECT 1 FROM public.accounting_cash_rake_sources hs
          JOIN public.accounting_cash_accrual_batches hb ON hb.rake_record_id=hs.rake_record_id
          WHERE hs.rake_record_id=r.id AND hs.player_id=a.player_id AND hs.club_id=a.club_id
           AND hs.union_id=p_scope_union AND (c.id=hs.union_id OR c.union_id=hs.union_id)
           AND hs.earned_at=r.created_at AND hs.rake_credit=a.weighted_rake_credit AND hb.status='accrued'
           AND hs.contract->>'is_union_house'='true' AND hs.contract->>'attribution_id'=a.id::text
           AND hs.contract->>'club_id'=a.club_id::text AND hs.contract->>'player_id'=a.player_id::text
           AND hs.contract->>'union_id'=hs.union_id::text)))) AS invalid_count
   FROM scoped_records r LEFT JOIN public.rake_attributions a ON a.rake_record_id=r.id
   GROUP BY r.id,r.hand_id,r.rake_amount,r.settle,r.unbatched
 ), evidence AS (
  SELECT count(*) AS n,count(*) FILTER(WHERE settle) AS n_settled,count(*) FILTER(WHERE unbatched) AS n_unbatched
   FROM checks WHERE hand_id IS NULL OR attribution_count=0
   OR invalid_count>0 OR attributed<>rake_amount OR rake_amount<>round(rake_amount,2)
 ), incomplete AS (
  SELECT count(*) AS n,count(*) FILTER(WHERE r.settle) AS n_settled,count(*) FILTER(WHERE r.unbatched) AS n_unbatched
   FROM club_attributions a JOIN week_records r ON r.id=a.rake_record_id
   LEFT JOIN week_sources s ON s.rake_record_id=r.id AND s.player_id=a.player_id
   LEFT JOIN week_batches b ON b.rake_record_id=r.id
   WHERE s.id IS NULL OR b.status IS DISTINCT FROM 'accrued' OR s.club_id IS DISTINCT FROM a.club_id
     OR s.earned_at IS DISTINCT FROM r.created_at OR s.rake_credit IS DISTINCT FROM a.weighted_rake_credit
     OR s.c_attribution IS DISTINCT FROM a.id::text
     OR s.c_player IS DISTINCT FROM a.player_id::text OR s.c_club IS DISTINCT FROM a.club_id::text
 ), drifted AS (
  -- A source exists only beside its batch and carries the same earned_at
  -- (enforced on insert), so the club-week's sources are exactly the sources
  -- of these frozen records and of the ones the checkpoint already holds.
  SELECT count(*) AS n,count(*) FILTER(WHERE f.settle) AS n_settled
   FROM public.accounting_cash_rake_sources s
   JOIN frozen f ON f.id=s.rake_record_id
   LEFT JOIN public.rake_records r ON r.id=s.rake_record_id
   LEFT JOIN public.rake_attributions a ON a.id=(s.contract->>'attribution_id')::uuid
   LEFT JOIN public.accounting_cash_accrual_batches b ON b.rake_record_id=s.rake_record_id
   WHERE s.club_id=p_club_id AND s.earned_at>=p_from AND s.earned_at<p_to
    AND (r.id IS NULL OR a.id IS NULL OR b.status IS DISTINCT FROM 'accrued'
     OR a.rake_record_id IS DISTINCT FROM s.rake_record_id OR a.hand_id IS DISTINCT FROM r.hand_id
     OR a.player_id IS DISTINCT FROM s.player_id OR a.club_id IS DISTINCT FROM s.club_id
     OR a.weighted_rake_credit IS DISTINCT FROM s.rake_credit OR s.earned_at IS DISTINCT FROM r.created_at
     OR r.is_tournament IS TRUE OR r.tournament_id IS NOT NULL
     OR NULLIF(s.contract->'union_id','null'::jsonb) IS DISTINCT FROM to_jsonb(s.union_id)
     OR NULLIF(s.contract->'coordinator_union_id','null'::jsonb) IS DISTINCT FROM to_jsonb(s.coordinator_union_id))
 )
 SELECT evidence.n,incomplete.n,drifted.n,(SELECT count(*) FROM frozen WHERE frozen.settle),
  evidence.n_settled,incomplete.n_settled,drifted.n_settled,evidence.n_unbatched,incomplete.n_unbatched
  FROM evidence,incomplete,drifted;
END $function$;

-- ----------------------------------------------------------------------------
-- 2.4  THE TWO FACTS THE CHECKPOINT RESTS ON, ENFORCED WHERE THEY ARE WRITTEN
--
-- fn_accrue_cash_hand_commissions is the only writer of both tables and
-- already writes exactly this (verified read-only on production 2026-09-27:
-- 0 of 621,250 batches and 0 of 1,625,809 sources differ). These make it a
-- refusal instead of an assumption: a batch must carry its record's
-- created_at and be recorded no earlier than its own transaction began, and a
-- source must carry its batch's earned_at. BEFORE INSERT only; both tables
-- already refuse UPDATE and DELETE.
-- ----------------------------------------------------------------------------
CREATE FUNCTION public.fn_accounting_cash_batch_is_placed_in_time()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
 IF NEW.recorded_at IS NULL OR NEW.recorded_at<now() THEN
  RAISE EXCEPTION 'cash_accrual_batch_recorded_before_its_transaction' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.rake_records r WHERE r.id=NEW.rake_record_id AND r.created_at=NEW.earned_at) THEN
  RAISE EXCEPTION 'cash_accrual_batch_earned_at_is_not_its_record' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $function$;

CREATE FUNCTION public.fn_accounting_cash_source_matches_its_batch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_batches b
                WHERE b.rake_record_id=NEW.rake_record_id AND b.earned_at=NEW.earned_at) THEN
  RAISE EXCEPTION 'cash_source_earned_at_is_not_its_batch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $function$;

CREATE TRIGGER accounting_cash_batch_is_placed_in_time BEFORE INSERT ON public.accounting_cash_accrual_batches
 FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_cash_batch_is_placed_in_time();
CREATE TRIGGER accounting_cash_source_matches_its_batch BEFORE INSERT ON public.accounting_cash_rake_sources
 FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_cash_source_matches_its_batch();

-- ----------------------------------------------------------------------------
-- 2.5  THE CALCULATOR
--
-- Byte-for-byte the installed body, with the whole-period path's gate and
-- counts wrapped unchanged in IF p_user_ids IS NULL, and the page path added
-- beside it. The certificate loop is untouched.
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
 digest_now text; evidence_cp public.accounting_rakeback_period_evidence_checkpoints%ROWTYPE; counts record;
 base_horizon timestamptz; next_horizon timestamptz; base_records bigint; base_evidence bigint; base_incomplete bigint; base_drifted bigint;
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
 IF p_user_ids IS NULL THEN
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
  -- Only this week's records reach the two counts that read this slice, so
  -- joining it to week_records is exact. Reading the club's whole history
  -- grew without bound (20260926042810).
  SELECT a.id,a.rake_record_id,a.hand_id,a.player_id,a.club_id,a.weighted_rake_credit
   FROM week_records w JOIN public.rake_attributions a ON a.rake_record_id=w.id
   WHERE a.club_id=p_club_id
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
 ELSE
 -- A PAGE READS ONLY THE EVIDENCE THAT CHANGED (20260927160709).
 -- The three week-level counts below are sums over the week's cash records.
 -- A record whose accrual batch exists is frozen: rake_records and
 -- rake_attributions refuse every change once it has one, and the batch and
 -- its sources are insert-only and written together. So its share of each
 -- count never changes while the clubs' union shape stays as it was. The
 -- checkpoint keeps those shares for every batch recorded before its horizon
 -- (a time no transaction still running had started by), and this page adds
 -- the batches recorded since and the records that have no batch yet, read in
 -- one snapshot. The totals are exactly the whole-week counts. The whole
 -- period call above keeps its own full verification.
 digest_now:=public.fn_accounting_clubs_scope_digest();
 SELECT * INTO evidence_cp FROM public.accounting_rakeback_period_evidence_checkpoints cp
  WHERE cp.club_id=p_club_id AND cp.period_start=p_period_start FOR UPDATE;
 IF FOUND AND evidence_cp.period_end=p_period_end AND evidence_cp.clubs_digest=digest_now THEN
  base_horizon:=evidence_cp.horizon;base_records:=evidence_cp.settled_records;
  base_evidence:=evidence_cp.settled_evidence;base_incomplete:=evidence_cp.settled_incomplete;base_drifted:=evidence_cp.settled_drifted;
 ELSE
  -- No checkpoint yet, or the union shape it was taken under has changed:
  -- start again from the week's first batch.
  base_horizon:='-infinity';base_records:=0;base_evidence:=0;base_incomplete:=0;base_drifted:=0;
 END IF;
 next_horizon:=public.fn_accounting_commit_horizon();
 IF next_horizon IS NULL OR next_horizon<base_horizon THEN next_horizon:=base_horizon; END IF;
 SELECT * INTO counts FROM public.fn_cash_period_evidence_since(p_club_id,v_from,v_to,scope_union,base_horizon,next_horizon);
 evidence_issues:=base_evidence+counts.o_evidence;
 incomplete_issues:=base_incomplete+counts.o_incomplete;
 drifted_issues:=base_drifted+counts.o_drifted;
 INSERT INTO public.accounting_rakeback_period_evidence_checkpoints AS cp(club_id,period_start,period_end,horizon,clubs_digest,
   settled_records,settled_evidence,settled_incomplete,settled_drifted)
  VALUES(p_club_id,p_period_start,p_period_end,next_horizon,digest_now,base_records+counts.o_settled_records,
   base_evidence+counts.o_settled_evidence,base_incomplete+counts.o_settled_incomplete,base_drifted+counts.o_settled_drifted)
  ON CONFLICT(club_id,period_start) DO UPDATE SET period_end=EXCLUDED.period_end,horizon=EXCLUDED.horizon,
   clubs_digest=EXCLUDED.clubs_digest,settled_records=EXCLUDED.settled_records,settled_evidence=EXCLUDED.settled_evidence,
   settled_incomplete=EXCLUDED.settled_incomplete,settled_drifted=EXCLUDED.settled_drifted,
   built_at=CASE WHEN base_horizon='-infinity'::timestamptz THEN clock_timestamp() ELSE cp.built_at END,
   advanced_at=clock_timestamp(),advances=cp.advances+1;
 -- Any of these refuses the page whatever the tournament gate says, so the
 -- gate is asked only when none does. Same reasons, counts and order as below.
 IF evidence_issues>0 THEN RETURN receipt||jsonb_build_object('reason','cash_earning_evidence_incomplete','source_count',evidence_issues); END IF;
 SELECT count(*) INTO issue_count FROM public.rakeback_periods rp
  WHERE rp.club_id=p_club_id AND rp.period_start<=p_period_end AND rp.period_end>=p_period_start
    AND (rp.status<>'pending' OR rp.period_start<>p_period_start OR rp.period_end<>p_period_end
      OR NOT EXISTS(SELECT 1 FROM public.accounting_rakeback_period_calculations c WHERE c.period_id=rp.id));
 IF issue_count>0 THEN RETURN receipt||jsonb_build_object('reason','legacy_or_paid_period_requires_reconciliation','period_count',issue_count); END IF;
 IF incomplete_issues>0 THEN RETURN receipt||jsonb_build_object('reason','cash_source_receipts_incomplete','source_count',incomplete_issues); END IF;
 IF drifted_issues>0 THEN RETURN receipt||jsonb_build_object('reason','cash_source_receipts_drifted','source_count',drifted_issues); END IF;
 tournament_quality:=public.fn_accounting_tournament_week_quality(p_club_id,v_from,v_to);
 IF tournament_quality->>'status' IS DISTINCT FROM 'ready' THEN
  RETURN receipt||tournament_quality||jsonb_build_object('written',0);END IF;
 END IF;

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

REVOKE ALL ON FUNCTION public.fn_calculate_cash_rakeback_periods(uuid, date, date, uuid[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_cash_period_evidence_since(uuid, timestamptz, timestamptz, uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_accounting_commit_horizon() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_accounting_clubs_scope_digest() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_accounting_cash_batch_is_placed_in_time() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_accounting_cash_source_matches_its_batch() FROM PUBLIC, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 2.6  POSTCONDITIONS
-- ----------------------------------------------------------------------------
DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.fn_calculate_cash_rakeback_periods(uuid, date, date, uuid[])'::regprocedure
                  AND md5(prosrc)='d94774ed23aa7d0937da7538c1d49dd3' AND prosecdef
                  AND proconfig=ARRAY['search_path=public','statement_timeout=300s']) THEN
    RAISE EXCEPTION 'PERIOD_CALCULATOR_POSTIMAGE: the installed body is not the proved body, or its budget moved' USING ERRCODE='55000';
  END IF;
  IF has_function_privilege('service_role','public.fn_calculate_cash_rakeback_periods(uuid, date, date, uuid[])','EXECUTE')
     OR has_function_privilege('service_role','public.fn_cash_period_evidence_since(uuid, timestamptz, timestamptz, uuid, timestamptz, timestamptz)','EXECUTE')
     OR has_function_privilege('authenticated','public.fn_accounting_commit_horizon()','EXECUTE') THEN
    RAISE EXCEPTION 'EVIDENCE_CHECKPOINT_GRANTS: a reader outside the owner can call the calculator or its pieces' USING ERRCODE='55000';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN('accounting_cash_batch_is_placed_in_time','accounting_cash_source_matches_its_batch'))<>2 THEN
    RAISE EXCEPTION 'EVIDENCE_CHECKPOINT_TRIGGERS: the two insert guards are not both installed' USING ERRCODE='55000';
  END IF;
END
$post$;

COMMIT;
