-- ===========================================================================
--  ROUND 3 READS ITS SCOPE'S WEEK OF SOURCES ONCE
-- ===========================================================================
--
-- Launch-gate sweep, 2026-10-03. From the auto_explain log of the Midway
-- close of 2026-10-01 22:43-23:51Z (job 391, auto_explain.log_min_duration
-- 60 s, log_nested_statements on), round 3
-- (fn_settle_accounting_rakeback_stage, union fade0000-...-0001, week
-- 2026-09-21) ran 1,379 s of the 68-minute transaction:
--   * 887 s: INSERT INTO _rr3_periods_v4 - the periods of the week, locked
--     FOR UPDATE. A period whose club is outside scope.club_ids (382 Deep
--     Stack Society periods) is admitted when
--     EXISTS(source of this scope, its club, its player, in the week). The
--     generic plan walks the club's whole week of the period index for every
--     such period: one probe measured 19.8 s cold (4,304 heap rows of the
--     player plus all 100,268 recognised tournament sources of the week).
--   * 240 s: the missing-period check, which reads the scope's whole week of
--     sources again (heap, for contract->>'is_union_house') right after the
--     set path read the same rows into _rr3_week_v4.
-- The week closing 2026-10-05 carries ~2.3x those sources.
--
-- WHAT CHANGES (fn_settle_accounting_rakeback_stage only; three exact
-- anchors on the 2026-10-03 preimage):
--   1. The periods statement reads, in the same statement (same snapshot),
--      the clubs of those outside periods (pclubs) and the scope's (club,
--      player) pairs of the week for exactly those clubs (pairs), and admits
--      an outside period whose club is in pclubs by membership in pairs. A
--      period whose club is not in pclubs (only possible for a row changed
--      under EvalPlanQual) still evaluates the original EXISTS. Same rows,
--      same lock order (ORDER BY ... FOR UPDATE OF rp: rp is the only table
--      the original locked).
--   2. _rr3_week_v4 also keeps contract->>'is_union_house' as written
--      (house_text, no cast), and when the set path admitted the book
--      (v4_ok) the missing-period check reads those rows instead of the
--      view; otherwise it runs the original query. Same predicate, same
--      cast; the rows were read under this scope's week lock, which every
--      accrual of the week shares, so no source of the week can be committed
--      in between.
-- No rate, payee, amount, rounding, routing or source set changes; the
-- fallback loop is untouched.
--
-- PROOF (production, read-only, week 2026-09-21, the original EXISTS written
-- as its textbook IN form):
--   Midway scope: old 598 periods md5 f1ce5dd0410a2b4705dbdef3e9dd197c,
--     new 598 md5 f1ce5dd0410a2b4705dbdef3e9dd197c (new 21.8 s cold).
--   Deep Stack scope: old 382 md5 ef4eb70f10c670c5f22047b0a984fb9a (17.5 s),
--     new 382 md5 ef4eb70f10c670c5f22047b0a984fb9a (6 ms).
--
-- @live-proof: position('pairs AS MATERIALIZED' in pg_get_functiondef('public.fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)'::regprocedure)) > 0
-- @live-proof: position('COALESCE((rs.house_text)::boolean,false) IS FALSE' in pg_get_functiondef('public.fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)'::regprocedure)) > 0
-- ===========================================================================
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $mig$
DECLARE s regprocedure:='public.fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)'::regprocedure;
 d text;
 x1 text:=$n$  INSERT INTO pg_temp._rr3_periods_v4 SELECT row_number() OVER(ORDER BY x.club_id,x.user_id,x.id),x.*
   FROM (SELECT rp.* FROM public.rakeback_periods rp WHERE rp.period_start<=to_date AND rp.period_end>=from_date
  AND (rp.club_id=ANY(scope.club_ids)
    OR EXISTS(SELECT 1 FROM public.accounting_payable_earning_sources rs WHERE rs.club_id=rp.club_id AND rs.player_id=rp.user_id
      AND (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club)) AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end))
  ORDER BY rp.club_id,rp.user_id,rp.id FOR UPDATE) x;$n$;
 y1 text:=$n$  -- WEEKLY CLOSE SCALE (20261003): a period of a club outside scope.club_ids
  -- is admitted when this scope earned from its player in the week. Those
  -- (club, player) pairs are read once, for exactly the clubs of such
  -- periods, in this same statement, instead of a scan of the club's whole
  -- week of sources per period (887 s in the 2026-10-01 Midway close: 382
  -- standalone periods). A period whose club is not in that set (only a row
  -- changed under EvalPlanQual) still asks the sources directly.
  INSERT INTO pg_temp._rr3_periods_v4 SELECT row_number() OVER(ORDER BY x.club_id,x.user_id,x.id),x.*
   FROM (WITH pclubs AS MATERIALIZED (SELECT DISTINCT p2.club_id FROM public.rakeback_periods p2
      WHERE p2.period_start<=to_date AND p2.period_end>=from_date AND p2.club_id IS NOT NULL AND (p2.club_id=ANY(scope.club_ids)) IS NOT TRUE),
    pairs AS MATERIALIZED (SELECT DISTINCT rs.club_id,rs.player_id FROM public.accounting_payable_earning_sources rs
      WHERE rs.club_id IN(SELECT pc.club_id FROM pclubs pc)
      AND (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club)) AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end)
   SELECT rp.* FROM public.rakeback_periods rp WHERE rp.period_start<=to_date AND rp.period_end>=from_date
  AND (rp.club_id=ANY(scope.club_ids)
    OR CASE WHEN rp.club_id IN(SELECT pc.club_id FROM pclubs pc)
     THEN EXISTS(SELECT 1 FROM pairs q WHERE q.club_id=rp.club_id AND q.player_id=rp.user_id)
     ELSE EXISTS(SELECT 1 FROM public.accounting_payable_earning_sources rs WHERE rs.club_id=rp.club_id AND rs.player_id=rp.user_id
      AND (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club)) AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end) END)
  ORDER BY rp.club_id,rp.user_id,rp.id FOR UPDATE OF rp) x;$n$;
 x2 text:=$n$   CREATE TEMP TABLE IF NOT EXISTS _rr3_week_v4(source_type text,source_id uuid,club_id uuid,player_id uuid,coordinator_union_id uuid,earned_at timestamptz,
    rake_credit numeric,rake_record_id uuid,agent_text text,PRIMARY KEY(source_type,source_id)) ON COMMIT DROP;
   TRUNCATE pg_temp._rr3_week_v4;
   INSERT INTO pg_temp._rr3_week_v4 SELECT rs.source_type,rs.source_id,rs.club_id,rs.player_id,rs.coordinator_union_id,rs.earned_at,rs.rake_credit,rs.rake_record_id,
    rs.contract->'membership'->'terms'->>'agent_id'
    FROM public.accounting_payable_earning_sources rs WHERE rs.earned_at>=p_period_start AND rs.earned_at<p_period_end
     AND (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club));
$n$;
 y2 text:=$n$   CREATE TEMP TABLE IF NOT EXISTS _rr3_week_v4(source_type text,source_id uuid,club_id uuid,player_id uuid,coordinator_union_id uuid,earned_at timestamptz,
    rake_credit numeric,rake_record_id uuid,agent_text text,house_text text,PRIMARY KEY(source_type,source_id)) ON COMMIT DROP;
   TRUNCATE pg_temp._rr3_week_v4;
   -- house_text (20261003): the source's is_union_house as written, read in
   -- this one pass so the missing-period check below need not read the week
   -- of sources again.
   INSERT INTO pg_temp._rr3_week_v4 SELECT rs.source_type,rs.source_id,rs.club_id,rs.player_id,rs.coordinator_union_id,rs.earned_at,rs.rake_credit,rs.rake_record_id,
    rs.contract->'membership'->'terms'->>'agent_id',rs.contract->>'is_union_house'
    FROM public.accounting_payable_earning_sources rs WHERE rs.earned_at>=p_period_start AND rs.earned_at<p_period_end
     AND (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club));
$n$;
 x3 text:=$n$ IF EXISTS(SELECT 1 FROM public.accounting_payable_earning_sources rs WHERE (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club))
   AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end
   AND COALESCE((rs.contract->>'is_union_house')::boolean,false) IS FALSE
   AND NOT EXISTS(SELECT 1 FROM pg_temp._routed_player_items i WHERE i.club_id=rs.club_id AND i.user_id=rs.player_id))
 THEN RAISE EXCEPTION 'routed_rakeback_player_period_missing' USING ERRCODE='55000'; END IF;$n$;
 y3 text:=$n$ -- 20261003: when the set path admitted the book, _rr3_week_v4 holds exactly
 -- these rows (same predicate, read under this scope's week lock, which every
 -- accrual of the week shares), so they are not read a second time.
 IF (CASE WHEN v4_ok THEN EXISTS(SELECT 1 FROM pg_temp._rr3_week_v4 rs
    WHERE COALESCE((rs.house_text)::boolean,false) IS FALSE
     AND NOT EXISTS(SELECT 1 FROM pg_temp._routed_player_items i WHERE i.club_id=rs.club_id AND i.user_id=rs.player_id))
  ELSE EXISTS(SELECT 1 FROM public.accounting_payable_earning_sources rs WHERE (rs.coordinator_union_id=p_union_id OR (standalone_club IS NOT NULL AND rs.coordinator_union_id IS NULL AND rs.club_id=standalone_club))
   AND rs.earned_at>=p_period_start AND rs.earned_at<p_period_end
   AND COALESCE((rs.contract->>'is_union_house')::boolean,false) IS FALSE
   AND NOT EXISTS(SELECT 1 FROM pg_temp._routed_player_items i WHERE i.club_id=rs.club_id AND i.user_id=rs.player_id)) END)
 THEN RAISE EXCEPTION 'routed_rakeback_player_period_missing' USING ERRCODE='55000'; END IF;$n$;
BEGIN
 d:=pg_get_functiondef(s);
 IF md5(d)<>'413b4887556881e1a1de0a4c2d20abd1' THEN RAISE EXCEPTION 'rakeback stage preimage %',md5(d); END IF;
 IF (length(d)-length(replace(d,x1,'')))/length(x1)<>1 THEN RAISE EXCEPTION 'rakeback stage anchor 1 count'; END IF;
 IF (length(d)-length(replace(d,x2,'')))/length(x2)<>1 THEN RAISE EXCEPTION 'rakeback stage anchor 2 count'; END IF;
 IF (length(d)-length(replace(d,x3,'')))/length(x3)<>1 THEN RAISE EXCEPTION 'rakeback stage anchor 3 count'; END IF;
 d:=replace(replace(replace(d,x1,y1),x2,y2),x3,y3);
 EXECUTE d;
 IF pg_get_functiondef(s)<>d THEN RAISE EXCEPTION 'rakeback stage postimage differs from the substituted text'; END IF;
END
$mig$;

COMMIT;
