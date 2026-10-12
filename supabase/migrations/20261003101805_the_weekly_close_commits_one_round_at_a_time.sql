-- 20261003101805_the_weekly_close_commits_one_round_at_a_time.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE WEEKLY CLOSE COMMITS ONE ROUND AT A TIME
--
-- Cron job 272 (union-weekly-rakeback-close) closed each book in ONE
-- transaction: the Midway close of 2026-10-01 held one for 68 minutes
-- (4,090 s, auto_explain job 391) and the Deep Stack Society close of
-- 2026-09-29 one for 21 minutes (1,264 s), pinning the xmin horizon of a
-- WAL-saturated database the whole time. The week closing 2026-10-05 carries
-- ~2.3x the sources (receipts per day this week 46k, 55k, 61k, 73k, 83k),
-- which put that transaction at 1.5-2 hours. Decided 2026-10-03 (Dan has
-- delegated settlement decisions to the agents): each money round commits in
-- its own bounded transaction, resumed from the rounds' own receipts.
--
-- WHAT CHANGES, ONLY WHEN app.weekly_accounting_chunked = 'on' (set by job
-- 272's command below; unset, every function here behaves exactly as before):
--
--  1. fn_union_settlement_cascade returns after a round that moved money,
--     with {"success":false,"chunk_committed":true,"committed_round":N}:
--     round 1 (after its own conservation; its union wallet debit is posted
--     inside round 1 by its original undeferred path, because a pending debit
--     is a transaction-local setting that cannot outlive the transaction);
--     round 2 (only with zero shortfalls); round 3 (only after the shortfall,
--     pending-player-period and conservation tests the unchunked close
--     applies). The next attempt skips each committed round by its receipt:
--     round 1 by union_rakeback_log ('already_executed', unchanged), rounds 2
--     and 3 by accounting_routed_settlement_runs (answered as the stage
--     answers a duplicate, without re-reading the week). Every attempt first
--     re-runs the book's barrier, accrual, refusal and preparation checks.
--     Marking the period settled, ECO, round 4 square-ups, credit invoices,
--     club statements: only in the attempt that finds rounds 1-3 committed.
--  2. fn_process_weekly_accounting_scope keeps a chunk's run row 'running'
--     with that receipt (no failure, no alert), returns more_remaining, and
--     does the same for the standalone club stages (bank + round 2, round 3,
--     then credit invoices / settled period / statements). An attempt that
--     ran out of its time budget files a 'warning', not a critical alert.
--  3. fn_prepare_accounting_week answers the paid-scope replay of a committed
--     round 3 from its receipt, as the cascade does.
--  4. The union P&L evidence (fn_union_pnl_evidence_report; 13-18 minutes for
--     one week at 1x) and the earned plan (164-654 s measured 2026-10-03) are
--     proved step by step: each problem-free step is kept in
--     accounting_close_certificates for the rest of that close (12 hours), and
--     an attempt with less than 6 minutes of its 9-minute budget left after a
--     step it proved stops with a 'warming' report (not ready, nothing paid);
--     the scheduler records that attempt as a committed 'certifying' step.
--     Steps: opening boundary, closing boundary, original flows, touched
--     registrations, earned plan, club rows. A step that found a problem is
--     never kept.
--  5. Job 272 runs every 5 minutes. It visits the scheduler only in the
--     original :40 slot or while a book has a committed chunk in progress, so
--     an idle tick reads two small tables. Statement timeout 720 s and scope
--     budget 9 minutes; 3600 s and 50 minutes (one transaction, the old shape)
--     when the inventory seal is due or a scope's last visit ran out of its
--     statement time, so a close that cannot be chunked still finishes.
--
-- WHAT DOES NOT CHANGE: rates, payees, amounts, rounding, routing, which
-- sources count, the receipts each round writes, and every refusal. A round
-- is never paid twice: rounds 2 and 3 are found by their unique receipt key,
-- round 1 by union_rakeback_log and its final ca_settlements row.
--
-- WHAT IT TRADES (stated to the coordinator): money that rounds move stays
-- committed when a later round fails (it was rolled back before), and each
-- payee's own paid invoice is delivered when its round commits, as it always
-- is for a payee (fn_deliver_accounting_invoice). A club or agent can spend a
-- round's money before the next round's attempt locks it; that round then
-- refuses on funding exactly as it always would.
--
-- @live-proof: position('CHUNKED CLOSE (20261003)' in pg_get_functiondef('public.fn_union_settlement_cascade(uuid,timestamptz,timestamptz)'::regprocedure)) > 0
-- @live-proof: position('app.weekly_accounting_chunked' in pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure)) > 0
-- @live-proof: position('fn_accounting_close_certificate(''pnl_clubs''' in pg_get_functiondef('public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)'::regprocedure)) > 0
-- @live-proof: (SELECT schedule='*/5 * * * *' AND position('app.weekly_accounting_chunked' in command)>0 FROM cron.job WHERE jobname='union-weekly-rakeback-close')
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '90s';

-- The certificates a chunked close keeps between its attempts. Read and written
-- only by the three functions below, only inside a chunked union close attempt.
CREATE TABLE public.accounting_close_certificates (
  kind text NOT NULL CHECK (kind IN ('earned_plan','pnl_boundary','pnl_flows','pnl_touched','pnl_clubs')),
  union_id uuid NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  value jsonb NOT NULL,
  certified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (kind, union_id, period_start, period_end)
);
ALTER TABLE public.accounting_close_certificates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_close_certificates FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.accounting_close_certificates IS
  'Chunked weekly close (20261003): a proved, problem-free step of a closed week''s union close (earned plan, P&L boundaries, flows, touched registrations, club rows), kept for the later attempts of the same close. Read only inside a chunked close attempt, for 12 hours after it was proved.';

CREATE FUNCTION public.fn_accounting_close_certificate(p_kind text, p_union_id uuid, p_start timestamptz, p_end timestamptz)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $f$
 SELECT c.value FROM public.accounting_close_certificates c
  WHERE COALESCE(current_setting('app.weekly_accounting_chunked',true),'')='on'
    AND current_setting('app.accounting_close_memo',true)='on'
    AND c.kind=p_kind AND c.union_id=p_union_id AND c.period_start=p_start AND c.period_end=p_end
    AND c.certified_at>=p_end AND c.certified_at>clock_timestamp()-interval '12 hours'
$f$;
REVOKE ALL ON FUNCTION public.fn_accounting_close_certificate(text,uuid,timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.fn_accounting_close_certificate(text,uuid,timestamptz,timestamptz) IS
  'Chunked weekly close (20261003): the kept value of one proved step, only inside a chunked union close attempt (app.weekly_accounting_chunked and app.accounting_close_memo on), only if proved after the period closed and within 12 hours; NULL everywhere else.';

CREATE FUNCTION public.fn_accounting_close_certify(p_kind text, p_union_id uuid, p_start timestamptz, p_end timestamptz, p_value jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $f$
BEGIN
 IF COALESCE(current_setting('app.weekly_accounting_chunked',true),'')<>'on'
  OR current_setting('app.accounting_close_memo',true) IS DISTINCT FROM 'on'
  OR p_value IS NULL OR p_end>clock_timestamp() THEN RETURN; END IF;
 DELETE FROM public.accounting_close_certificates WHERE certified_at<clock_timestamp()-interval '8 days';
 INSERT INTO public.accounting_close_certificates(kind,union_id,period_start,period_end,value,certified_at)
 VALUES(p_kind,p_union_id,p_start,p_end,p_value,clock_timestamp())
 ON CONFLICT(kind,union_id,period_start,period_end) DO UPDATE SET value=EXCLUDED.value,certified_at=EXCLUDED.certified_at;
 PERFORM set_config('app.accounting_close_certified','on',true);
END $f$;
REVOKE ALL ON FUNCTION public.fn_accounting_close_certify(text,uuid,timestamptz,timestamptz,jsonb) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.fn_accounting_close_certify(text,uuid,timestamptz,timestamptz,jsonb) IS
  'Chunked weekly close (20261003): keeps one proved, problem-free step of a closed week''s union close for the later attempts of that close; does nothing outside a chunked union close attempt.';

CREATE FUNCTION public.fn_accounting_close_warm_stop()
 RETURNS boolean
 LANGUAGE sql
 VOLATILE
 SET search_path TO 'public'
AS $f$
 SELECT COALESCE(current_setting('app.weekly_accounting_chunked',true),'')='on'
    AND current_setting('app.accounting_close_certified',true)='on'
    AND NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'') IS NOT NULL
    AND clock_timestamp()>NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'')::timestamptz-interval '6 minutes'
$f$;
REVOKE ALL ON FUNCTION public.fn_accounting_close_warm_stop() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.fn_accounting_close_warm_stop() IS
  'Chunked weekly close (20261003): true when this attempt proved and kept a step and has less than 6 minutes of its scope budget left, so the P&L evidence report stops with status warming and the next attempt continues.';

DO $mig$
DECLARE s regprocedure; d text; a text; r text; j bigint; c text;
BEGIN
 -- cascade
 s:='public.fn_union_settlement_cascade(uuid,timestamptz,timestamptz)'::regprocedure;
 d:=pg_get_functiondef(s);
 IF md5(d)<>'54afb66f9cbe3dc0ba581fa9a44e344d' THEN RAISE EXCEPTION 'cascade preimage %',md5(d); END IF;
 a:=$a$  v_pending jsonb; v_posted record;
$a$;
 r:=$r$  v_pending jsonb; v_posted record;
  -- CHUNKED CLOSE (20261003): set by job 272's tick; see
  -- fn_process_weekly_accounting_scope. Off, this function is unchanged.
  v_chunked boolean := COALESCE(current_setting('app.weekly_accounting_chunked', true), '') = 'on';
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'cascade anchor 1 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$  PERFORM set_config('app.union_close_defer_rake_debit', p_union_id::text || ':'
    || to_char(v_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || '..'
    || to_char(v_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), true);
$a$;
 r:=$r$  -- CHUNKED CLOSE (20261003): a round that commits in its own transaction
  -- posts its own union wallet debit (round 1's original undeferred path):
  -- a pending debit is a transaction-local setting and cannot outlive it.
  PERFORM set_config('app.union_close_defer_rake_debit', CASE WHEN v_chunked THEN '' ELSE p_union_id::text || ':'
    || to_char(v_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || '..'
    || to_char(v_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') END, true);
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'cascade anchor 2 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$              || 'agents out of a treasury the union has not funded.'))::text;
  END IF;
$a$;
 r:=$r$              || 'agents out of a treasury the union has not funded.'))::text;
  END IF;

  -- CHUNKED CLOSE (20261003): a round that moved money ends this attempt
  -- here; it commits with its receipts (union_rakeback_log, the final
  -- ca_settlements row, union_settlement_rounds round 1) and the next attempt
  -- skips it by them ('already_executed'). Nothing after this point - no
  -- period is marked settled, no statement or square-up is issued - until
  -- the attempt that finds every round committed.
  IF v_chunked AND v_r1->>'success' = 'true' THEN
    RETURN jsonb_build_object('success', false, 'chunk_committed', true, 'committed_round', 1,
      'union_id', p_union_id, 'period_start', v_from, 'period_end', v_to,
      'round1_union_to_clubs', v_r1);
  END IF;
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'cascade anchor 3 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$  v_r2 := public.fn_settle_round2_club_to_agents(p_union_id, v_from, v_to);
$a$;
 r:=$r$  -- CHUNKED CLOSE (20261003): a round 2 an earlier attempt committed is
  -- answered from its own receipt - exactly what the stage returns for it
  -- as a duplicate - instead of reading the whole week again to prove it.
  -- Every attempt has first re-run the book's barrier, accrual, refusal and
  -- preparation checks, under which no source of this closed week can change.
  IF v_chunked THEN
    SELECT r.result||jsonb_build_object('duplicate',true) INTO v_r2 FROM public.accounting_routed_settlement_runs r
     WHERE r.scope_kind='union' AND r.scope_id=p_union_id AND r.period_start=v_from AND r.period_end=v_to AND r.round_no=2;
  END IF;
  IF v_r2 IS NULL THEN
  v_r2 := public.fn_settle_round2_club_to_agents(p_union_id, v_from, v_to);
  END IF;
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'cascade anchor 4 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$      'note', 'Rounds 3 and 4 were not run.'))::text;
  END IF;
$a$;
 r:=$r$      'note', 'Rounds 3 and 4 were not run.'))::text;
  END IF;

  -- CHUNKED CLOSE (20261003): round 2 commits on its own only with no
  -- shortfall, exactly what the unchunked close would have kept; the next
  -- attempt finds its receipt (accounting_routed_settlement_runs round 2)
  -- and the stage returns it as a duplicate.
  IF v_chunked AND v_r2->>'duplicate' IS DISTINCT FROM 'true' THEN
    IF (v_r2->>'shortfalls')::numeric <> 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'union_settlement_incomplete', DETAIL = (jsonb_build_object('success',false,'union_id',p_union_id,
        'error','recipient_shortfalls_remaining','period_start',v_from,'period_end',v_to,
        'round1_union_to_clubs',v_r1,'round2_club_to_agents',v_r2))::text;
    END IF;
    RETURN jsonb_build_object('success', false, 'chunk_committed', true, 'committed_round', 2,
      'union_id', p_union_id, 'period_start', v_from, 'period_end', v_to,
      'round1_union_to_clubs', v_r1, 'round2_club_to_agents', v_r2);
  END IF;
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'cascade anchor 5 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$  v_r3 := public.fn_settle_round3_agents_to_players(p_union_id, v_from, v_to);
$a$;
 r:=$r$  -- CHUNKED CLOSE (20261003): the same for a committed round 3.
  IF v_chunked THEN
    SELECT r.result||jsonb_build_object('duplicate',true) INTO v_r3 FROM public.accounting_routed_settlement_runs r
     WHERE r.scope_kind='union' AND r.scope_id=p_union_id AND r.period_start=v_from AND r.period_end=v_to AND r.round_no=3;
  END IF;
  IF v_r3 IS NULL THEN
  v_r3 := public.fn_settle_round3_agents_to_players(p_union_id, v_from, v_to);
  END IF;
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'cascade anchor 6 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$  PERFORM public.fn_union_settlement_conservation_assert(
            p_union_id, v_from, v_to, v_r1, v_r2, v_r3);
$a$;
 r:=$r$  PERFORM public.fn_union_settlement_conservation_assert(
            p_union_id, v_from, v_to, v_r1, v_r2, v_r3);

  -- CHUNKED CLOSE (20261003): round 3 commits on its own only after every
  -- test the unchunked close applies to it - no shortfall, no pending player
  -- period, conservation asserted - and the attempt that finds all three
  -- rounds committed repeats those tests before it settles the period.
  IF v_chunked AND v_r3->>'duplicate' IS DISTINCT FROM 'true' THEN
    RETURN jsonb_build_object('success', false, 'chunk_committed', true, 'committed_round', 3,
      'union_id', p_union_id, 'period_start', v_from, 'period_end', v_to,
      'round1_union_to_clubs', v_r1, 'round2_club_to_agents', v_r2,
      'round3_agents_to_players', v_r3);
  END IF;
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'cascade anchor 7 count'; END IF;
 d:=replace(d,a,r);
 EXECUTE d;
 IF pg_get_functiondef(s)<>d THEN RAISE EXCEPTION 'cascade postimage differs from the substituted text'; END IF;
 -- scheduler
 s:='public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure;
 d:=pg_get_functiondef(s);
 IF md5(d)<>'89eb91df6635f987e523ccfe4008c8c5' THEN RAISE EXCEPTION 'scheduler preimage %',md5(d); END IF;
 a:=$a$  v_now timestamptz := clock_timestamp();
$a$;
 r:=$r$  v_now timestamptz := clock_timestamp();
  -- CHUNKED CLOSE (20261003): job 272 sets app.weekly_accounting_chunked.
  -- Each attempt then commits at most one money round of one book (the
  -- cascade or the standalone stages return 'chunk_committed'), the run row
  -- stays 'running' with that receipt, and the next tick continues from the
  -- rounds' own receipts. Unset, nothing below changes.
  v_chunked boolean := COALESCE(current_setting('app.weekly_accounting_chunked',true),'')='on';
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'scheduler anchor 1 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$          OR (SELECT count(*) FROM jsonb_array_elements(v_scope_result->'detail')d WHERE d->'result'->'success' IS DISTINCT FROM 'true'::jsonb)<>v_scope_failed
$a$;
 r:=$r$          OR (SELECT count(*) FROM jsonb_array_elements(v_scope_result->'detail')d WHERE d->'result'->'success' IS DISTINCT FROM 'true'::jsonb
            AND d->'result'->'chunk_committed' IS DISTINCT FROM 'true'::jsonb)<>v_scope_failed
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'scheduler anchor 2 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$        IF v_preparation->>'success' IS DISTINCT FROM 'true' THEN
          RAISE EXCEPTION 'weekly_accounting_calculation_incomplete' USING DETAIL=v_preparation::text;
        END IF;
        IF EXISTS(SELECT 1 FROM public.rake_records rr LEFT JOIN public.daemon_state ds ON ds.daemon='rakeback_settler'
$a$;
 r:=$r$        -- CHUNKED CLOSE: a preparation that stopped while its book's P&L
        -- certificates are still being proved (fn_union_pnl_evidence_report
        -- 'warming': the steps proved so far are kept, nothing is paid) ends
        -- this attempt as a committed step, not a failure.
        IF v_chunked AND v_preparation->>'success' IS DISTINCT FROM 'true'
          AND jsonb_typeof(v_preparation->'problems')='array' AND jsonb_array_length(v_preparation->'problems')=1
          AND v_preparation#>'{problems,0,pnl_evidence,issues}'='["union_pnl_certification_in_progress"]'::jsonb THEN
          v_result:=jsonb_build_object('success',false,'chunk_committed',true,'committed_round',0,'stage','certifying',
            'union_id',v_union.id,'period_start',v_from,'period_end',v_end);
        ELSE
        IF v_preparation->>'success' IS DISTINCT FROM 'true' THEN
          RAISE EXCEPTION 'weekly_accounting_calculation_incomplete' USING DETAIL=v_preparation::text;
        END IF;
        IF EXISTS(SELECT 1 FROM public.rake_records rr LEFT JOIN public.daemon_state ds ON ds.daemon='rakeback_settler'
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'scheduler anchor 3 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$          v_result:=public.fn_union_settlement_cascade(v_union.id,v_from,v_end);
          PERFORM public.fn_weekly_accounting_deadline_check();
          IF v_result->>'success' IS DISTINCT FROM 'true' THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='union_settlement_incomplete',DETAIL=v_result::text;
          END IF;
        END IF;
$a$;
 r:=$r$          v_result:=public.fn_union_settlement_cascade(v_union.id,v_from,v_end);
          -- CHUNKED CLOSE: a committed round ends this attempt (it is not a
          -- failure and is not rolled back for the time it took).
          IF v_result->>'chunk_committed' IS DISTINCT FROM 'true' THEN
          PERFORM public.fn_weekly_accounting_deadline_check();
          IF v_result->>'success' IS DISTINCT FROM 'true' THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='union_settlement_incomplete',DETAIL=v_result::text;
          END IF;
          END IF;
        END IF;
        END IF;
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'scheduler anchor 4 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$      UPDATE public.union_accounting_runs
         SET status=CASE WHEN v_result->>'success'='true' THEN 'complete' ELSE 'failed' END,
             finished_at=clock_timestamp(),result=v_result
       WHERE union_id=v_union.id AND period_start=v_from AND period_end=v_end;
$a$;
 r:=$r$      UPDATE public.union_accounting_runs
         SET status=CASE WHEN v_result->>'success'='true' THEN 'complete' WHEN v_result->>'chunk_committed'='true' THEN 'running' ELSE 'failed' END,
             finished_at=clock_timestamp(),result=v_result
       WHERE union_id=v_union.id AND period_start=v_from AND period_end=v_end;
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'scheduler anchor 5 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$      IF v_result->>'success' IS DISTINCT FROM 'true' THEN
        v_failed:=v_failed+1;
        -- Report a new failure or a changed failure, not the same alert every tick.
$a$;
 r:=$r$      IF v_result->>'success' IS DISTINCT FROM 'true' AND v_result->>'chunk_committed' IS DISTINCT FROM 'true' THEN
        v_failed:=v_failed+1;
        -- Report a new failure or a changed failure, not the same alert every tick.
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'scheduler anchor 6 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$          VALUES ('union_accounting_scheduler','critical','Weekly union accounting is incomplete',
$a$;
 r:=$r$          -- CHUNKED CLOSE: an attempt that ran out of its 9-minute budget left
          -- nothing half-done (it rolled back to its last committed round)
          -- and the next tick retries it with the large budget; that is a
          -- warning, not an incident. Out of the large budget it is critical.
          VALUES ('union_accounting_scheduler',CASE WHEN v_chunked AND NOT v_tick_budget_large AND v_result->>'error'='weekly_scope_time_budget_exhausted' THEN 'warning' ELSE 'critical' END,'Weekly union accounting is incomplete',
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'scheduler anchor 7 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$      -- Resolve an older period before posting a later one for the same union.
      IF v_result->>'success' IS DISTINCT FROM 'true' THEN EXIT; END IF;
$a$;
 r:=$r$      -- CHUNKED CLOSE: the next round of this book is the next tick's.
      IF v_result->>'chunk_committed'='true' THEN
        RETURN jsonb_build_object('success',v_failed=0,'checked',v_checked,'failed',v_failed,
          'more_remaining',true,'detail',v_results);
      END IF;
      -- Resolve an older period before posting a later one for the same union.
      IF v_result->>'success' IS DISTINCT FROM 'true' THEN EXIT; END IF;
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'scheduler anchor 8 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$          v_stage2:=public.fn_settle_accounting_commission_stage('club',v_club.id,v_from,v_end);
          PERFORM public.fn_weekly_accounting_deadline_check();
          v_stage3:=public.fn_settle_accounting_rakeback_stage('club',v_club.id,v_from,v_end);
          PERFORM public.fn_weekly_accounting_deadline_check();
$a$;
 r:=$r$          -- CHUNKED CLOSE (20261003): a round an earlier attempt committed is
          -- answered from its own receipt (what the stage returns for it as a
          -- duplicate) instead of reading the week again.
          v_stage2:=NULL; v_stage3:=NULL;
          IF v_chunked THEN
            SELECT r.result||jsonb_build_object('duplicate',true) INTO v_stage2 FROM public.accounting_routed_settlement_runs r
             WHERE r.scope_kind='club' AND r.scope_id=v_club.id AND r.period_start=v_from AND r.period_end=v_end AND r.round_no=2;
            SELECT r.result||jsonb_build_object('duplicate',true) INTO v_stage3 FROM public.accounting_routed_settlement_runs r
             WHERE r.scope_kind='club' AND r.scope_id=v_club.id AND r.period_start=v_from AND r.period_end=v_end AND r.round_no=3;
          END IF;
          IF v_stage2 IS NULL THEN
          v_stage2:=public.fn_settle_accounting_commission_stage('club',v_club.id,v_from,v_end);
          END IF;
          -- CHUNKED CLOSE: a round 2 or round 3 that paid commits on its own
          -- (after the same receipt tests the unchunked path applies to it);
          -- the next tick finds its receipt and the stage returns it as a
          -- duplicate. Credit invoices, the settled period and the weekly
          -- statements wait for the attempt that finds both rounds committed.
          IF v_chunked AND v_stage2->>'duplicate' IS DISTINCT FROM 'true' THEN
            IF v_stage2->>'success' IS DISTINCT FROM 'true' OR v_stage2->>'routing_version' IS DISTINCT FROM '3'
              OR v_stage2->>'source_version' IS DISTINCT FROM '2' OR v_stage2->'shortfalls' IS DISTINCT FROM '0'::jsonb
              OR NOT EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r WHERE r.scope_kind='club' AND r.scope_id=v_club.id
                AND r.period_start=v_from AND r.period_end=v_end AND r.round_no=2 AND r.result=(v_stage2-'duplicate')) THEN
              RAISE EXCEPTION 'weekly_routing_receipt_not_confirmed' USING ERRCODE='23514';END IF;
            v_result:=jsonb_build_object('success',false,'chunk_committed',true,'committed_round',2,'scope_kind','club','scope_id',v_club.id,
              'period_start',v_from,'period_end',v_end,'round2',v_stage2);
          ELSE
          PERFORM public.fn_weekly_accounting_deadline_check();
          IF v_stage3 IS NULL THEN
          v_stage3:=public.fn_settle_accounting_rakeback_stage('club',v_club.id,v_from,v_end);
          END IF;
          IF v_chunked AND v_stage3->>'duplicate' IS DISTINCT FROM 'true' THEN
            IF v_stage3->>'success' IS DISTINCT FROM 'true' OR v_stage3->>'routing_version' IS DISTINCT FROM '3'
              OR v_stage3->>'source_version' IS DISTINCT FROM '2' OR v_stage3->'shortfalls' IS DISTINCT FROM '0'::jsonb
              OR NOT EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r WHERE r.scope_kind='club' AND r.scope_id=v_club.id
                AND r.period_start=v_from AND r.period_end=v_end AND r.round_no=3 AND r.result=(v_stage3-'duplicate')) THEN
              RAISE EXCEPTION 'weekly_routing_receipt_not_confirmed' USING ERRCODE='23514';END IF;
            v_result:=jsonb_build_object('success',false,'chunk_committed',true,'committed_round',3,'scope_kind','club','scope_id',v_club.id,
              'period_start',v_from,'period_end',v_end,'round2',v_stage2-'duplicate','round3',v_stage3);
          ELSE
          PERFORM public.fn_weekly_accounting_deadline_check();
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'scheduler anchor 9 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$            'round2',v_stage2-'duplicate','round3',v_stage3-'duplicate','credit_invoices',v_credit,'club_weekly_statements',v_statements,'accounting_version',3);
$a$;
 r:=$r$            'round2',v_stage2-'duplicate','round3',v_stage3-'duplicate','credit_invoices',v_credit,'club_weekly_statements',v_statements,'accounting_version',3);
          END IF;
          END IF;
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'scheduler anchor 10 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$        UPDATE public.union_accounting_runs SET status=CASE WHEN v_result->>'success'='true' THEN 'complete' ELSE 'failed' END,
          finished_at=clock_timestamp(),result=v_result WHERE standalone_club_id=v_club.id AND period_start=v_from AND period_end=v_end;
$a$;
 r:=$r$        UPDATE public.union_accounting_runs SET status=CASE WHEN v_result->>'success'='true' THEN 'complete' WHEN v_result->>'chunk_committed'='true' THEN 'running' ELSE 'failed' END,
          finished_at=clock_timestamp(),result=v_result WHERE standalone_club_id=v_club.id AND period_start=v_from AND period_end=v_end;
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'scheduler anchor 11 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$        IF v_result->>'success' IS DISTINCT FROM 'true' THEN
          v_failed:=v_failed+1;
          IF public.fn_accounting_failure_identity(v_previous) IS DISTINCT FROM public.fn_accounting_failure_identity(v_result) THEN
            INSERT INTO public.financial_alerts(source,severity,message,context) VALUES('weekly_club_accounting','critical','Weekly club accounting is incomplete',
$a$;
 r:=$r$        IF v_result->>'success' IS DISTINCT FROM 'true' AND v_result->>'chunk_committed' IS DISTINCT FROM 'true' THEN
          v_failed:=v_failed+1;
          IF public.fn_accounting_failure_identity(v_previous) IS DISTINCT FROM public.fn_accounting_failure_identity(v_result) THEN
            INSERT INTO public.financial_alerts(source,severity,message,context) VALUES('weekly_club_accounting',CASE WHEN v_chunked AND NOT v_tick_budget_large AND v_result->>'error'='weekly_scope_time_budget_exhausted' THEN 'warning' ELSE 'critical' END,'Weekly club accounting is incomplete',
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'scheduler anchor 12 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$        v_results:=v_results||jsonb_build_array(jsonb_build_object('club_id',v_club.id,'period_start',v_from,'period_end',v_end,'result',v_result));
        IF v_result->>'success' IS DISTINCT FROM 'true' THEN EXIT;END IF;
$a$;
 r:=$r$        v_results:=v_results||jsonb_build_array(jsonb_build_object('club_id',v_club.id,'period_start',v_from,'period_end',v_end,'result',v_result));
        IF v_result->>'chunk_committed'='true' THEN
          RETURN jsonb_build_object('success',v_failed=0,'checked',v_checked,'failed',v_failed,'more_remaining',true,'detail',v_results);
        END IF;
        IF v_result->>'success' IS DISTINCT FROM 'true' THEN EXIT;END IF;
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'scheduler anchor 13 count'; END IF;
 d:=replace(d,a,r);
 EXECUTE d;
 IF pg_get_functiondef(s)<>d THEN RAISE EXCEPTION 'scheduler postimage differs from the substituted text'; END IF;
 -- prepare
 s:='public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)'::regprocedure;
 d:=pg_get_functiondef(s);
 IF md5(d)<>'217f0e8444ce2e50ecf465f2be04feb8' THEN RAISE EXCEPTION 'prepare preimage %',md5(d); END IF;
 a:=$a$  source_check:=public.fn_settle_accounting_rakeback_stage('union',p_union_id,p_from,p_to);
$a$;
 r:=$r$  -- CHUNKED CLOSE (20261003): inside a chunked attempt (job 272 sets
  -- app.weekly_accounting_chunked) a round 3 an earlier attempt committed is
  -- answered from its own receipt, as the cascade answers it, instead of
  -- reading the whole week again to prove it a duplicate.
  IF COALESCE(current_setting('app.weekly_accounting_chunked',true),'')='on' THEN
   SELECT r.result||jsonb_build_object('duplicate',true) INTO source_check FROM public.accounting_routed_settlement_runs r
    WHERE r.scope_kind='union' AND r.scope_id=p_union_id AND r.round_no=3 AND r.period_start=p_from AND r.period_end=p_to;
  ELSE
  source_check:=public.fn_settle_accounting_rakeback_stage('union',p_union_id,p_from,p_to);
  END IF;
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'prepare anchor 1 count'; END IF;
 d:=replace(d,a,r);
 EXECUTE d;
 IF pg_get_functiondef(s)<>d THEN RAISE EXCEPTION 'prepare postimage differs from the substituted text'; END IF;
 -- evidence report
 s:='public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)'::regprocedure;
 d:=pg_get_functiondef(s);
 IF md5(d)<>'dc4c34a5db70f81222a231c3a2a32406' THEN RAISE EXCEPTION 'evidence report preimage %',md5(d); END IF;
 a:=$a$ v_inv boolean; v_cash boolean; v_credit boolean;
$a$;
 r:=$r$ v_inv boolean; v_cash boolean; v_credit boolean;
 v_cert jsonb;
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'evidence report anchor 1 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$ v_open:=public.fn_union_pnl_boundary(p_union_id,p_start);
 v_close:=public.fn_union_pnl_boundary(p_union_id,p_end);
$a$;
 r:=$r$ -- CHUNKED CLOSE CERTIFICATES (20261003): inside a chunked union close attempt
 -- each expensive read below that found nothing wrong is kept, once proved,
 -- in accounting_close_certificates for the rest of that close of this
 -- closed week (fn_accounting_close_certificate / fn_accounting_close_certify;
 -- both do nothing anywhere else). An attempt whose time budget is spent
 -- after a step it had to prove returns 'warming' - not ready, nothing
 -- certified for payment - and the next attempt continues from the kept
 -- steps. A step that found a problem is never kept: it is proved again.
 v_open:=public.fn_accounting_close_certificate('pnl_boundary',p_union_id,p_start,p_start);
 IF v_open IS NULL THEN
  v_open:=public.fn_union_pnl_boundary(p_union_id,p_start);
  IF v_open->>'status'='ready' THEN PERFORM public.fn_accounting_close_certify('pnl_boundary',p_union_id,p_start,p_start,v_open); END IF;
 END IF;
 IF public.fn_accounting_close_warm_stop() THEN RETURN jsonb_build_object('report_version',1,'status','warming','basis_certified',false,'payment_authorized',false,'union_id',p_union_id,'period_start',p_start,'period_end',p_end,'issues',jsonb_build_array('union_pnl_certification_in_progress'),'all_players_included',false); END IF;
 v_close:=public.fn_accounting_close_certificate('pnl_boundary',p_union_id,p_end,p_end);
 IF v_close IS NULL THEN
  v_close:=public.fn_union_pnl_boundary(p_union_id,p_end);
  IF v_close->>'status'='ready' THEN PERFORM public.fn_accounting_close_certify('pnl_boundary',p_union_id,p_end,p_end,v_close); END IF;
 END IF;
 IF public.fn_accounting_close_warm_stop() THEN RETURN jsonb_build_object('report_version',1,'status','warming','basis_certified',false,'payment_authorized',false,'union_id',p_union_id,'period_start',p_start,'period_end',p_end,'issues',jsonb_build_array('union_pnl_certification_in_progress'),'all_players_included',false); END IF;
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'evidence report anchor 2 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$ SELECT count(*) FILTER(WHERE NOT f.valid),COALESCE(jsonb_agg(to_jsonb(f)),'[]') INTO v_bad,v_flows
  FROM public.fn_union_pnl_original_flow_evidence(p_union_id,p_start,p_end) f;
$a$;
 r:=$r$ v_cert:=public.fn_accounting_close_certificate('pnl_flows',p_union_id,p_start,p_end);
 IF v_cert IS NOT NULL THEN
  v_bad:=(v_cert->>'bad')::bigint; v_flows:=v_cert->'flows';
 ELSE
 SELECT count(*) FILTER(WHERE NOT f.valid),COALESCE(jsonb_agg(to_jsonb(f)),'[]') INTO v_bad,v_flows
  FROM public.fn_union_pnl_original_flow_evidence(p_union_id,p_start,p_end) f;
  IF v_bad=0 THEN PERFORM public.fn_accounting_close_certify('pnl_flows',p_union_id,p_start,p_end,jsonb_build_object('bad',v_bad,'flows',v_flows)); END IF;
 END IF;
 IF public.fn_accounting_close_warm_stop() THEN RETURN jsonb_build_object('report_version',1,'status','warming','basis_certified',false,'payment_authorized',false,'union_id',p_union_id,'period_start',p_start,'period_end',p_end,'issues',jsonb_build_array('union_pnl_certification_in_progress'),'all_players_included',false); END IF;
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'evidence report anchor 3 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$ WITH touched AS MATERIALIZED (
  SELECT w.registration_id row_id,w.touched_tournament_id tournament_id
$a$;
 r:=$r$ v_cert:=public.fn_accounting_close_certificate('pnl_touched',p_union_id,p_start,p_end);
 IF v_cert IS NOT NULL THEN
  v_bad:=(v_cert->>'bad')::bigint;
 ELSE
 WITH touched AS MATERIALIZED (
  SELECT w.registration_id row_id,w.touched_tournament_id tournament_id
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'evidence report anchor 4 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$  OR COALESCE(e.has_other,false);
$a$;
 r:=$r$  OR COALESCE(e.has_other,false);
  IF v_bad=0 THEN PERFORM public.fn_accounting_close_certify('pnl_touched',p_union_id,p_start,p_end,jsonb_build_object('bad',v_bad)); END IF;
 END IF;
 IF public.fn_accounting_close_warm_stop() THEN RETURN jsonb_build_object('report_version',1,'status','warming','basis_certified',false,'payment_authorized',false,'union_id',p_union_id,'period_start',p_start,'period_end',p_end,'issues',jsonb_build_array('union_pnl_certification_in_progress'),'all_players_included',false); END IF;
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'evidence report anchor 5 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$ PERFORM public.fn_accounting_union_earned_plan(p_union_id,p_start,p_end);
$a$;
 r:=$r$ PERFORM public.fn_accounting_union_earned_plan(p_union_id,p_start,p_end);
 IF public.fn_accounting_close_warm_stop() THEN RETURN jsonb_build_object('report_version',1,'status','warming','basis_certified',false,'payment_authorized',false,'union_id',p_union_id,'period_start',p_start,'period_end',p_end,'issues',jsonb_build_array('union_pnl_certification_in_progress'),'all_players_included',false); END IF;
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'evidence report anchor 6 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$ WITH flows AS MATERIALIZED (SELECT * FROM jsonb_to_recordset(v_flows)
$a$;
 r:=$r$ v_cert:=public.fn_accounting_close_certificate('pnl_clubs',p_union_id,p_start,p_end);
 IF v_cert IS NOT NULL THEN
  v_clubs:=v_cert->'clubs'; v_cash_reconciled:=(v_cert->>'cash_reconciled')::boolean; v_rows:=(v_cert->>'rows')::bigint;
  v_cash_rake:=(v_cert->>'cash_rake')::numeric; v_hands:=(v_cert->>'hands')::bigint; v_accepted_rake:=(v_cert->>'accepted_rake')::numeric;
 ELSE
 WITH flows AS MATERIALIZED (SELECT * FROM jsonb_to_recordset(v_flows)
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'evidence report anchor 7 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$  INTO v_clubs,v_cash_reconciled,v_rows,v_cash_rake,v_hands,v_accepted_rake FROM complete q;
$a$;
 r:=$r$  INTO v_clubs,v_cash_reconciled,v_rows,v_cash_rake,v_hands,v_accepted_rake FROM complete q;
  IF v_cash_reconciled AND v_accepted_rake IS NOT DISTINCT FROM v_cash_rake THEN
   PERFORM public.fn_accounting_close_certify('pnl_clubs',p_union_id,p_start,p_end,jsonb_build_object('clubs',v_clubs,
    'cash_reconciled',v_cash_reconciled,'rows',v_rows,'cash_rake',v_cash_rake,'hands',v_hands,'accepted_rake',v_accepted_rake));
  END IF;
 END IF;
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'evidence report anchor 8 count'; END IF;
 d:=replace(d,a,r);
 EXECUTE d;
 IF pg_get_functiondef(s)<>d THEN RAISE EXCEPTION 'evidence report postimage differs from the substituted text'; END IF;
 -- earned plan
 s:='public.fn_accounting_union_earned_plan(uuid,timestamptz,timestamptz)'::regprocedure;
 d:=pg_get_functiondef(s);
 IF md5(d)<>'76a1dd43e9cbb3b47a0420429b7ca8b3' THEN RAISE EXCEPTION 'earned plan preimage %',md5(d); END IF;
 a:=$a$  IF memo ? memo_key THEN RETURN memo->memo_key; END IF;
 END IF;
$a$;
 r:=$r$  IF memo ? memo_key THEN RETURN memo->memo_key; END IF;
 END IF;
 -- CHUNKED CLOSE CERTIFICATE (20261003): inside a chunked union close attempt a
 -- plan proved by an earlier attempt of this close is answered from
 -- accounting_close_certificates; one proved here is kept there. Off
 -- everywhere else (fn_accounting_close_certificate returns NULL).
 plan:=public.fn_accounting_close_certificate('earned_plan',p_union_id,p_start,p_end);
 IF plan IS NULL THEN
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'earned plan anchor 1 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$ IF plan IS NULL THEN plan:=public.fn_accounting_union_earned_plan_v3(p_union_id,p_start,p_end); END IF;
$a$;
 r:=$r$ IF plan IS NULL THEN plan:=public.fn_accounting_union_earned_plan_v3(p_union_id,p_start,p_end); END IF;
  PERFORM public.fn_accounting_close_certify('earned_plan',p_union_id,p_start,p_end,plan);
 END IF;
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'earned plan anchor 2 count'; END IF;
 d:=replace(d,a,r);
 EXECUTE d;
 IF pg_get_functiondef(s)<>d THEN RAISE EXCEPTION 'earned plan postimage differs from the substituted text'; END IF;
 -- attempt_begin
 s:='public.fn_weekly_accounting_attempt_begin(boolean)'::regprocedure;
 d:=pg_get_functiondef(s);
 IF md5(d)<>'fecd456f7bdadb751c058f7c78a3cc29' THEN RAISE EXCEPTION 'attempt_begin preimage %',md5(d); END IF;
 a:=$a$ PERFORM set_config('app.accounting_cash_refusal_memo','',true);
$a$;
 r:=$r$ PERFORM set_config('app.accounting_cash_refusal_memo','',true);
 PERFORM set_config('app.accounting_close_certified','',true);
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'attempt_begin anchor 1 count'; END IF;
 d:=replace(d,a,r);
 EXECUTE d;
 IF pg_get_functiondef(s)<>d THEN RAISE EXCEPTION 'attempt_begin postimage differs from the substituted text'; END IF;
 -- attempt_end
 s:='public.fn_weekly_accounting_attempt_end()'::regprocedure;
 d:=pg_get_functiondef(s);
 IF md5(d)<>'9fd829e7f49c1ca187b1fa539d1f5186' THEN RAISE EXCEPTION 'attempt_end preimage %',md5(d); END IF;
 a:=$a$ PERFORM set_config('app.accounting_cash_refusal_memo','',true);
$a$;
 r:=$r$ PERFORM set_config('app.accounting_cash_refusal_memo','',true);
 PERFORM set_config('app.accounting_close_certified','',true);
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'attempt_end anchor 1 count'; END IF;
 d:=replace(d,a,r);
 EXECUTE d;
 IF pg_get_functiondef(s)<>d THEN RAISE EXCEPTION 'attempt_end postimage differs from the substituted text'; END IF;
 -- job 272
 SELECT jobid INTO j FROM cron.job WHERE jobname='union-weekly-rakeback-close';
 IF j IS NULL THEN RAISE EXCEPTION 'cron job union-weekly-rakeback-close missing' USING ERRCODE='55000'; END IF;
 SELECT command INTO c FROM cron.job WHERE jobid=j;
 IF c IS DISTINCT FROM 'SET statement_timeout=''6600s''; SET app.weekly_accounting_attempt_budget=''1''; SET app.weekly_accounting_scope_budget=''100 minutes''; SELECT public.fn_union_settlement_cascade_due();' THEN
  RAISE EXCEPTION 'preimage mismatch: union-weekly-rakeback-close command' USING ERRCODE='55000'; END IF;
 PERFORM cron.alter_job(j, schedule:='*/5 * * * *',
  command:='SELECT set_config(''statement_timeout'',CASE WHEN x.big THEN ''3600s'' ELSE ''720s'' END,false),set_config(''app.weekly_accounting_attempt_budget'',''1'',false),set_config(''app.weekly_accounting_scope_budget'',CASE WHEN x.big THEN ''50 minutes'' ELSE ''9 minutes'' END,false),set_config(''app.weekly_accounting_chunked'',''on'',false) FROM (SELECT NOT EXISTS(SELECT 1 FROM public.union_pnl_inventory_checkpoints c WHERE c.boundary=public.fn_union_week_start(now())) OR EXISTS(SELECT 1 FROM public.weekly_accounting_scheduler_visits v WHERE v.last_outcome=''statement_timeout'' AND v.last_visit_at>now()-interval ''3 hours'') OR EXISTS(SELECT 1 FROM public.union_accounting_runs q WHERE q.status=''failed'' AND q.result->>''error''=''weekly_scope_time_budget_exhausted'' AND q.finished_at>now()-interval ''3 hours'') AS big) x; SELECT CASE WHEN extract(minute FROM now()) BETWEEN 40 AND 44 OR EXISTS(SELECT 1 FROM public.union_accounting_runs q WHERE q.status=''running'' AND q.result->>''chunk_committed''=''true'') OR EXISTS(SELECT 1 FROM public.union_accounting_runs q WHERE q.status=''failed'' AND q.result->>''error''=''weekly_scope_time_budget_exhausted'' AND q.finished_at>now()-interval ''3 hours'') THEN public.fn_union_settlement_cascade_due() END;',
  active:=true);
END
$mig$;

COMMIT;
