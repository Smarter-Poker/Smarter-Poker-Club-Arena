-- 20261003121635_a_close_attempt_that_prepared_a_long_week_pays_in_the_next.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A CLOSE ATTEMPT THAT PREPARED A LONG WEEK PAYS IN THE NEXT
--
-- Follows 20261003101805_the_weekly_close_commits_one_round_at_a_time and
-- 20261003105926_a_close_attempt_stops_after_one_long_step. A chunked close
-- attempt prepares its book (fn_prepare_accounting_week) and then, in the same
-- transaction, pays the next round. Measured on 2026-10-03 for the week
-- 2026-09-21..28 (rolled-back jobs 419-422): Deep Stack Society's preparation
-- took 285 s (one fresh weekly recompute) and its round 2 114 s; Midway's round
-- 2 took 167 s and its round 3 54 s. At the ~2.3x volume of the week closing
-- 2026-10-05 a standalone club's first attempt would prepare for ~11 minutes
-- and then pay round 2 for ~4 more, past job 272's 720 s statement timeout, so
-- it would only finish on the 50-minute fallback budget, in one ~15 minute
-- transaction; Midway's attempt that proves the club rows and recomputes its
-- clubs would likewise carry round 1 on top.
--
-- WHAT CHANGES, ONLY IN A CHUNKED CLOSE (app.weekly_accounting_chunked, set by
-- job 272): when an attempt's preparation succeeded after doing durable work of
-- its own - a P&L step it proved and kept, or a weekly recompute it recorded
-- for one of the book's clubs (accounting_period_recompute_requests) - and more
-- than 60 seconds have passed since the attempt began, the attempt ends there
-- as a committed 'prepared' step: run row 'running', nothing paid, no failure
-- and no alert. The next attempt reuses those receipts (the preparation's own
-- proven-current reuse, unchanged) and pays the round. An attempt whose
-- preparation only reused receipts never stops this way, however long it took,
-- so the close always moves forward. A paid-scope replay (round 3 committed)
-- never stops this way either.
--
-- @live-proof: position('''prepared''' in pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure)) > 0
-- @live-proof: to_regprocedure('public.fn_accounting_close_prepared_long(uuid,uuid,timestamptz,timestamptz)') IS NOT NULL
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '90s';

CREATE FUNCTION public.fn_accounting_close_prepared_long(p_union_id uuid, p_club_id uuid, p_from timestamptz, p_to timestamptz)
 RETURNS boolean
 LANGUAGE sql
 VOLATILE
 SET search_path TO 'public'
AS $f$
 SELECT COALESCE(current_setting('app.weekly_accounting_chunked',true),'')='on'
    AND NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'') IS NOT NULL
    AND clock_timestamp()>NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'')::timestamptz
        -COALESCE(NULLIF(current_setting('app.weekly_accounting_scope_budget',true),''),'8 minutes')::interval
        +interval '60 seconds'
    AND (current_setting('app.accounting_close_certified',true)='on'
     OR EXISTS(SELECT 1 FROM public.accounting_period_recompute_requests q
         WHERE q.attempted_at>=now()
           AND q.period_start=(p_from AT TIME ZONE 'America/Los_Angeles')::date
           AND q.period_end=(p_to AT TIME ZONE 'America/Los_Angeles')::date-1
           AND q.club_id IN (SELECT c.club_id FROM public.fn_accounting_week_clubs(p_union_id,p_club_id,p_from,p_to) c)))
$f$;
REVOKE ALL ON FUNCTION public.fn_accounting_close_prepared_long(uuid,uuid,timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.fn_accounting_close_prepared_long(uuid,uuid,timestamptz,timestamptz) IS
  'Chunked weekly close (20261003): true inside a chunked close attempt that has run for more than 60 seconds and whose preparation did durable work of its own (a P&L step it proved and kept, or a weekly recompute it recorded for one of the book''s clubs), so the attempt ends as a committed prepared step and the next attempt pays.';

DO $mig$
DECLARE s regprocedure; d text; a text; r text;
BEGIN
 -- scheduler
 s:='public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure;
 d:=pg_get_functiondef(s);
 IF md5(d)<>'d02595b5d3c4c91971e47d6dfb106ead' THEN RAISE EXCEPTION 'scheduler preimage %',md5(d); END IF;
 a:=$a$            'union_id',v_union.id,'period_start',v_from,'period_end',v_end);
        ELSE
$a$;
 r:=$r$            'union_id',v_union.id,'period_start',v_from,'period_end',v_end);
        -- CHUNKED CLOSE (20261003, prepared): a preparation that did durable
        -- work of its own (a P&L step it kept, a weekly recompute it recorded)
        -- for more than 60 seconds ends this attempt as a committed step; the
        -- next attempt reuses those receipts and pays.
        ELSIF v_chunked AND v_preparation->>'success'='true' AND v_preparation->>'paid_scope_replay' IS DISTINCT FROM 'true'
          AND public.fn_accounting_close_prepared_long(v_union.id,NULL,v_from,v_end) THEN
          v_result:=jsonb_build_object('success',false,'chunk_committed',true,'committed_round',0,'stage','prepared',
            'union_id',v_union.id,'period_start',v_from,'period_end',v_end);
        ELSE
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'scheduler anchor 1 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$          IF v_preparation->>'success' IS DISTINCT FROM 'true' THEN
            RAISE EXCEPTION 'weekly_accounting_calculation_incomplete' USING DETAIL=v_preparation::text;END IF;
          PERFORM public.fn_assert_cash_commission_period(NULL,v_club.id,v_from,v_end);
$a$;
 r:=$r$          IF v_preparation->>'success' IS DISTINCT FROM 'true' THEN
            RAISE EXCEPTION 'weekly_accounting_calculation_incomplete' USING DETAIL=v_preparation::text;END IF;
          -- CHUNKED CLOSE (20261003, prepared): as for a union book.
          IF v_chunked AND public.fn_accounting_close_prepared_long(NULL,v_club.id,v_from,v_end) THEN
            v_result:=jsonb_build_object('success',false,'chunk_committed',true,'committed_round',0,'stage','prepared','scope_kind','club','scope_id',v_club.id,
              'period_start',v_from,'period_end',v_end);
          ELSE
          PERFORM public.fn_assert_cash_commission_period(NULL,v_club.id,v_from,v_end);
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'scheduler anchor 2 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$'club_weekly_statements',v_statements,'accounting_version',3);
          END IF;
          END IF;
$a$;
 r:=$r$'club_weekly_statements',v_statements,'accounting_version',3);
          END IF;
          END IF;
          END IF;
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'scheduler anchor 3 count'; END IF;
 d:=replace(d,a,r);
 EXECUTE d;
 IF pg_get_functiondef(s)<>d THEN RAISE EXCEPTION 'scheduler postimage differs from the substituted text'; END IF;
END
$mig$;

COMMIT;
