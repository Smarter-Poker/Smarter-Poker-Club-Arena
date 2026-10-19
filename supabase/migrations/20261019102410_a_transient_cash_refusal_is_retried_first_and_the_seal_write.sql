-- 20261019102410_a_transient_cash_refusal_is_retried_first_and_the_seal_write.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A TRANSIENT CASH REFUSAL IS RETRIED FIRST, THE WEEK'S SEAL WRITES SEVERAL
-- PAGES A TICK, AND THE ENGINE'S 8 S PROBE LEAVES THE CLOSE TO ITS TICK.
-- Full account: docs/changelog/2026-10-19-a-lock-refusal-is-not-a-day-in-the-queue.md
--
-- Read on production 2026-10-19 09:40-10:30 UTC:
--
-- 1. Fourteen Midway Union cash rake receipts (31.41 chips, earned 2026-10-17
--    00:16 to 2026-10-19 07:15) had no accrual batch. Thirteen were refused once
--    by a lock (8 deadlock 40P01 on two clubs' agent-commission keys, 5 lock
--    timeout 55P03) and then waited in accounting_cash_source_work behind ~900
--    older-due Lightning Internal Pilot refusals: fn_retry_cash_accounting_sources
--    takes CASH_RETRY_LIMIT (5) rows a cycle, oldest next_attempt_at first, so a
--    source refused once by a lock queued behind every row still waiting on
--    missing commission attribution (attempt 3 retries were reaching rows due
--    2026-10-18 04:27 at 09:33 on 2026-10-19). A rolled-back replay of the
--    fourteen through fn_process_cash_accounting_source accrued ten, three hit
--    a fresh deadlock and one is refused for a reason no retry can change
--    (cash_commission_hierarchy_invalid_at_earning, rake record a6eaf5e8, left
--    as it is: see the changelog).
--    a) fn_process_cash_accounting_source retries its own subtransaction after
--       a deadlock, at most three times, before it refuses. The subtransaction
--       rollback releases the item's commission keys, so the other transaction
--       proceeds. A lock refusal (40P01, 55P03, 40001) that still remains is
--       due again after 15 s per attempt (at most 300 s), not 60 s per attempt.
--    b) fn_retry_cash_accounting_sources takes the rows with the FEWEST
--       refusals first (attempts, then due time), in its key walk and its loop.
--       A burst of sources waiting on evidence can no longer hold every slot.
--
-- 2. The weekly close of 2026-10-12..19 could not start: its original
--    inventory checkpoint (4,520,200 rows) is published through bounded
--    committed pages (20261012200734), and fn_union_pnl_inventory_seal_advance
--    wrote ONE page per call - 16,893 rows, 14.5 MB of WAL, 0.7 s - and job 272
--    calls it once per five-minute tick: 253,306 rows after 1 h 45 min, about
--    21 hours still to go. It now keeps writing pages in the same call while
--    rows remain past the durable cursor, until 384 MB of WAL has been written
--    since the call began (a quarter of Realtime's 1.5 GB slot-lag cutoff from
--    20261012134146), 45 s pass, or 64 pages are written. A rolled-back replay
--    against production wrote 18 pages (304,029 rows) in 11.1 s. Publication
--    still happens on a later tick, after the final page committed; the page
--    writer, its checks and its checksum are unchanged.
--
-- 3. The settler calls fn_union_settlement_cascade_due every cycle as
--    service_role (statement_timeout 8s). Without job 272's chunked settings
--    that call runs the full scope scan, which a rolled-back call measured past
--    50 s, so it was cancelled at 8 s (pg_stat_statements max 8,056 ms) while it
--    held the scheduler lock job 272 needs. A call without the chunked tick's
--    settings and with under a minute of statement budget now visits no scope
--    and returns the zero-scope receipt the engine already accepts.
--
-- No ledger row, receipt, invoice, payment or historical record is written or
-- rewritten. Each function is replaced from its exact installed preimage.
-- @live-proof: (md5(pg_get_functiondef('public.fn_process_cash_accounting_source(uuid)'::regprocedure))='460e4b0a936b41246548cb0a9efc9f7f' AND md5(pg_get_functiondef('public.fn_retry_cash_accounting_sources(integer)'::regprocedure))='0ab1bf9282426f348c034785513724e0' AND md5(pg_get_functiondef('public.fn_union_pnl_inventory_seal_advance(timestamptz,boolean)'::regprocedure))='c2550f8714fede1047ed2efcf396d697' AND md5(pg_get_functiondef('public.fn_union_settlement_cascade_due()'::regprocedure))='9b9b4ad4bd11c9456ddf1e63509b6780')
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $admit_cash_retry$
DECLARE refusal text;
BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' OR auth.uid() IS NOT NULL
  OR NULLIF(current_setting('request.jwt.claims',true),'') IS NOT NULL
  OR NULLIF(current_setting('request.jwt.claim.role',true),'') IS NOT NULL
  OR NULLIF(current_setting('ca.break_window_migration_override',true),'') IS NOT NULL
 THEN RAISE EXCEPTION 'cash_retry_operator_refused';END IF;
 refusal:=public.fn_ca_break_window_refuses_migrations(now());
 IF refusal IS NOT NULL OR public.fn_platform_frozen() IS DISTINCT FROM false
  OR public.fn_active_maintenance_release_boundary() IS NOT NULL
 THEN RAISE EXCEPTION 'cash_retry_window_refused';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0))
  OR NOT pg_try_advisory_xact_lock(hashtextextended('union-pnl-inventory-checkpoint',0))
 THEN RAISE EXCEPTION 'cash_retry_scheduler_owned';END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261019102410')
 THEN RAISE EXCEPTION 'cash_retry_history_replay';END IF;
 IF md5(pg_get_functiondef('public.fn_process_cash_accounting_source(uuid)'::regprocedure))<>'b7fc736283913d209244082467eae64c'
 THEN RAISE EXCEPTION 'cash_retry_exact_preimage_required:%','fn_process_cash_accounting_source';END IF;
 IF md5(pg_get_functiondef('public.fn_retry_cash_accounting_sources(integer)'::regprocedure))<>'3788581d5e8f1953663b8929b4688d0a'
 THEN RAISE EXCEPTION 'cash_retry_exact_preimage_required:%','fn_retry_cash_accounting_sources';END IF;
 IF md5(pg_get_functiondef('public.fn_union_pnl_inventory_seal_advance(timestamptz,boolean)'::regprocedure))<>'c8fde7360b3696f1e11db11613e91ba6'
 THEN RAISE EXCEPTION 'cash_retry_exact_preimage_required:%','fn_union_pnl_inventory_seal_advance';END IF;
 IF md5(pg_get_functiondef('public.fn_union_settlement_cascade_due()'::regprocedure))<>'3b3c3281bc9a51f3acf79039c17b8f2b'
 THEN RAISE EXCEPTION 'cash_retry_exact_preimage_required:%','fn_union_settlement_cascade_due';END IF;
END $admit_cash_retry$;

CREATE OR REPLACE FUNCTION public.fn_process_cash_accounting_source(p_rake_record_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE r public.rake_records%ROWTYPE;w public.accounting_cash_source_work%ROWTYPE;
 receipt public.accounting_cash_source_receipts%ROWTYPE; fingerprint text;result jsonb;credits jsonb:='[]';
 status_value text:='accrued';reason_value text;state_value text;detail_value text;scope jsonb;
 player record;club record;week_start date;next_attempt bigint; applied boolean; v_terminal boolean:=false; v_try int:=0;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'cash_source_not_authorised' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM public.rake_records WHERE id=p_rake_record_id;
 IF NOT FOUND OR COALESCE(r.is_tournament,false) OR r.tournament_id IS NOT NULL THEN
  RAISE EXCEPTION 'cash_source_record_required' USING ERRCODE='22023'; END IF;
 -- Share the existing hand authority. Nothing locks work rows before this.
 PERFORM pg_advisory_xact_lock(hashtextextended(CASE WHEN r.hand_id IS NULL THEN 'accounting_cash_source:'||r.id::text
  ELSE 'accounting_cash_hand:'||r.hand_id::text END,0));
 SELECT * INTO r FROM public.rake_records WHERE id=p_rake_record_id FOR SHARE;
 SELECT md5(jsonb_build_object('id',r.id,'hand',r.hand_id,'club',r.club_id,'rake',r.rake_amount,
  'earned_at',r.created_at,'metadata',r.metadata,'attributions',COALESCE(jsonb_agg(
   jsonb_build_array(a.id,a.hand_id,a.player_id,a.club_id,a.weighted_rake_credit) ORDER BY a.id),'[]'::jsonb))::text)
  INTO fingerprint FROM public.rake_attributions a WHERE a.rake_record_id=r.id;
 SELECT * INTO w FROM public.accounting_cash_source_work WHERE rake_record_id=r.id;
 IF w.status='accrued' AND w.source_fingerprint=fingerprint THEN
  SELECT * INTO receipt FROM public.accounting_cash_source_receipts WHERE id=w.receipt_id;
  RETURN receipt.result||jsonb_build_object('duplicate',true);
 END IF;
 IF NOT public.fn_ca_launch_accounting_accepts(r.club_id,r.created_at) THEN
  RETURN jsonb_build_object('status','waived','recorded',false,'reason','owner_directed_launch_waiver','rake_record_id',r.id,'earned_at',r.created_at);
 END IF;
 next_attempt:=COALESCE(w.attempts,0)+1;
 -- A DEADLOCK IS RETRIED INSIDE ITS OWN TRANSACTION (20261019102410). The
 -- block below is a subtransaction: a deadlock rolls back only this item's
 -- writes and releases the commission keys it took, so the other transaction
 -- proceeds and the same evidence is tried again here, at most three times,
 -- instead of being refused into the retry queue behind every other refusal.
 <<item>> LOOP
 v_try:=v_try+1;
 BEGIN
  IF r.hand_id IS NULL OR NOT isfinite(r.created_at) OR r.rake_amount IS NULL OR r.rake_amount<=0
   OR r.rake_amount::text IN('NaN','Infinity','-Infinity') OR r.rake_amount<>round(r.rake_amount,2)
   OR (SELECT count(*) FROM public.rake_records WHERE hand_id=r.hand_id)<>1 THEN
   RAISE EXCEPTION 'cash_source_identity_or_amount_invalid' USING ERRCODE='23514'; END IF;
  result:=public.fn_accrue_cash_hand_commissions(r.hand_id);
  IF result->>'status'='legacy_unverified' AND result->>'recorded'='true' THEN
   status_value:='blocked';reason_value:='cash_source_legacy_unverified';state_value:='55000';v_terminal:=true;
  ELSE
   IF result->>'status' IS DISTINCT FROM 'accrued' OR result->>'recorded' IS DISTINCT FROM 'true'
    OR result->>'source_version' IS DISTINCT FROM '2'
    OR NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_batches WHERE rake_record_id=r.id AND status='accrued') THEN
    RAISE EXCEPTION 'cash_source_accrual_receipt_invalid' USING ERRCODE='23514'; END IF;
   week_start:=(public.fn_union_week_start(r.created_at) AT TIME ZONE 'America/Los_Angeles')::date;
   FOR player IN SELECT * FROM public.accounting_cash_rake_sources WHERE rake_record_id=r.id ORDER BY club_id,player_id LOOP
    applied:=public.apply_rakeback_player_stats(r.id,player.player_id,player.club_id,1,player.rake_credit);
    IF NOT EXISTS(SELECT 1 FROM public.rakeback_stats_applied a WHERE a.rake_record_id=r.id AND a.user_id=player.player_id
      AND a.hands=1 AND a.rake=player.rake_credit) THEN
     RAISE EXCEPTION 'cash_source_player_stats_receipt_invalid' USING ERRCODE='23514'; END IF;
    credits:=credits||jsonb_build_array(jsonb_build_object('player_id',player.player_id,'club_id',player.club_id,
      'rake_credit',player.rake_credit,'period_start',week_start,'period_end',week_start+6));
   END LOOP;
   IF jsonb_array_length(credits)=0 THEN RAISE EXCEPTION 'cash_source_contributor_receipts_missing' USING ERRCODE='23514'; END IF;
   -- Queue the existing complete-week calculator; do not invent another
   -- calculator or depend on a later hand arriving to repair this source.
   FOR club IN SELECT DISTINCT club_id FROM public.accounting_cash_rake_sources WHERE rake_record_id=r.id ORDER BY club_id LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('accounting_rakeback_period:'||club.club_id::text||':'||week_start::text,0));
    INSERT INTO public.accounting_period_recompute_requests(club_id,period_start,period_end)
     VALUES(club.club_id,week_start,week_start+6)
     ON CONFLICT(club_id,period_start,period_end) DO UPDATE SET last_requested_at=clock_timestamp(),status='pending',reason=NULL;
   END LOOP;
  END IF;
 EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS reason_value=MESSAGE_TEXT,state_value=RETURNED_SQLSTATE,detail_value=PG_EXCEPTION_DETAIL;
  status_value:='blocked';credits:='[]';v_terminal:=false;
 END;
 EXIT item WHEN status_value IS DISTINCT FROM 'blocked' OR v_terminal OR state_value IS DISTINCT FROM '40P01' OR v_try>=3;
 status_value:='accrued';reason_value:=NULL;state_value:=NULL;detail_value:=NULL;result:=NULL;credits:='[]';
 END LOOP item;
 scope:=public.fn_cash_source_refusal_scope(r.id);
 receipt.id:=gen_random_uuid();
 result:=jsonb_build_object('receipt_version',3,'receipt_id',receipt.id,'rake_record_id',r.id,'hand_id',r.hand_id,
  'earned_at',r.created_at,'status',status_value,'recorded',true,'attempt',next_attempt,
  'source_fingerprint',fingerprint,'reason',reason_value,'sqlstate',state_value,'scope',scope,'credits',credits);
 INSERT INTO public.accounting_cash_source_receipts(id,rake_record_id,attempt,earned_at,source_fingerprint,status,reason,sqlstate,error_detail,scope,result)
  VALUES(receipt.id,r.id,next_attempt,r.created_at,fingerprint,status_value,reason_value,state_value,detail_value,scope,result);
 INSERT INTO public.accounting_cash_source_work(rake_record_id,receipt_id,source_fingerprint,status,attempts,next_attempt_at)
  VALUES(r.id,receipt.id,fingerprint,status_value,next_attempt,CASE WHEN v_terminal THEN 'infinity'::timestamptz
   -- A lock refusal (deadlock, lock timeout, serialization) is retried soon.
   WHEN status_value='blocked' AND state_value IN('40P01','55P03','40001') THEN clock_timestamp()+make_interval(secs=>LEAST(300,15*next_attempt)::int)
   ELSE clock_timestamp()+make_interval(secs=>LEAST(3600,60*next_attempt)::int) END)
  ON CONFLICT(rake_record_id) DO UPDATE SET receipt_id=EXCLUDED.receipt_id,source_fingerprint=EXCLUDED.source_fingerprint,
   status=EXCLUDED.status,attempts=EXCLUDED.attempts,next_attempt_at=EXCLUDED.next_attempt_at;
 RETURN result;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_retry_cash_accounting_sources(p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '300s'
AS $function$
DECLARE w record;r jsonb;receipts jsonb:='[]';v_ok int:=0;v_blocked int:=0;v_failed int:=0;first_error text;v_parked bigint:=0;v_gate uuid;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'cash_source_not_authorised' USING ERRCODE='42501'; END IF;
 IF p_limit IS NULL OR p_limit<1 OR p_limit>200 THEN RAISE EXCEPTION 'invalid_cash_retry_limit' USING ERRCODE='22023'; END IF;
 -- EVERY FREE CLUB COMMISSION KEY FIRST, IN CLUB ORDER, WITHOUT WAITING (2026-10-01),
 -- as fn_credit_agent_commissions_batch takes them: this retry is one transaction
 -- over many sources too, and a wait here would fail all of them at the role's
 -- lock_timeout. Read from the rows the loop below selects; the rest are taken
 -- item by item in the trigger.
 FOR v_gate IN SELECT DISTINCT a.club_id FROM public.rake_attributions a
   WHERE a.rake_record_id = ANY (ARRAY(SELECT s.rake_record_id FROM public.accounting_cash_source_work s
     WHERE s.status='blocked' AND s.next_attempt_at<=clock_timestamp()
     ORDER BY s.attempts,s.next_attempt_at,s.rake_record_id LIMIT p_limit))
     AND a.club_id IS NOT NULL ORDER BY a.club_id LOOP
  EXIT WHEN NOT pg_try_advisory_xact_lock(hashtextextended('agent-commission:'||v_gate::text,0));
 END LOOP;
 -- Do not lock work rows here: all callers acquire the original hand lock
 -- first. SKIP LOCKED on work would invert that order against direct callers.
 -- THE FEWEST REFUSALS GO FIRST (20261019102410). Oldest-due-first let a
 -- burst of sources still waiting on missing evidence hold every slot of
 -- every cycle while a source refused once by a lock waited a day behind it.
 FOR w IN SELECT rake_record_id FROM public.accounting_cash_source_work WHERE status='blocked'
  AND next_attempt_at<=clock_timestamp() ORDER BY attempts,next_attempt_at,rake_record_id LIMIT p_limit LOOP
  BEGIN
   r:=public.fn_process_cash_accounting_source(w.rake_record_id);receipts:=receipts||jsonb_build_array(r);
   IF r->>'status'='accrued' THEN v_ok:=v_ok+1; ELSE v_blocked:=v_blocked+1; END IF;
  EXCEPTION WHEN OTHERS THEN v_failed:=v_failed+1;first_error:=COALESCE(first_error,SQLERRM);END;
 END LOOP;
 SELECT count(*) INTO v_parked FROM public.accounting_cash_source_work
  WHERE status='blocked' AND next_attempt_at='infinity'::timestamptz;
 RETURN jsonb_build_object('receipt_version',3,'ok',v_ok,'blocked',v_blocked,'failed',v_failed+v_blocked,'terminal_parked',v_parked,
  'first_error',first_error,'receipts',receipts);
END $function$;

CREATE OR REPLACE FUNCTION public.fn_union_pnl_inventory_seal_advance(p_at timestamp with time zone, p_verify boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- Seals a closed week's original inventory six hours at a time (see the
-- migration header); returns status 'sealing' while layers remain.
DECLARE origin public.union_pnl_inventory_capture%ROWTYPE; book timestamptz; v_base timestamptz; v_prior public.union_pnl_inventory_checkpoints%ROWTYPE;
 g record; began timestamptz:=clock_timestamp(); t0 timestamptz; done_any boolean:=false; n_layers int; n_done int;
 v_rows bigint; v_issues bigint; v_rows_md5 text; v_issues_md5 text; v_max bigint; v_projection jsonb; v_ms bigint; v_lr bigint; v_li bigint;
 v_wal0 pg_lsn:=pg_current_wal_insert_lsn(); v_pages int; c_kind text; c_source text; c_row uuid; c_event bigint;
BEGIN
 SELECT * INTO origin FROM public.union_pnl_inventory_capture WHERE singleton;
 IF NOT FOUND THEN RAISE EXCEPTION 'inventory_capture_missing' USING ERRCODE='55000'; END IF;
 IF p_at IS NULL OR NOT isfinite(p_at) OR p_at<>public.fn_union_week_start(p_at) OR p_at>clock_timestamp() OR p_at<=origin.captured_at THEN
  RAISE EXCEPTION 'closed_original_week_boundary_required' USING ERRCODE='22023'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'inventory_requires_fresh_read_committed_snapshot' USING ERRCODE='25000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('union-pnl-inventory-checkpoint',0));
 SELECT * INTO v_prior FROM public.union_pnl_inventory_checkpoints WHERE boundary=p_at;
 IF FOUND AND NOT p_verify THEN
  RETURN jsonb_build_object('status','already_sealed','boundary',p_at,'base_boundary',v_prior.base_boundary,'row_count',v_prior.row_count,
   'issue_count',v_prior.issue_count,'rows_md5',v_prior.rows_md5,'result_md5',v_prior.result_md5,'legacy_verified',v_prior.legacy_verified);
 END IF;
 IF p_verify AND NOT FOUND THEN RAISE EXCEPTION 'inventory_verify_needs_a_sealed_week' USING ERRCODE='22023'; END IF;
 book:=public.fn_union_week_start(origin.captured_at);
 WHILE book<p_at LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('union-pnl-inventory:'||extract(epoch FROM book)::bigint::text,0));
  book:=public.fn_union_week_start(book+interval '8 days');
 END LOOP;
 SELECT c.boundary INTO v_base FROM public.union_pnl_inventory_checkpoints c WHERE c.boundary<p_at ORDER BY c.boundary DESC LIMIT 1;
 -- A week with no base seals in one go, as before.
 IF v_base IS NULL THEN
  IF p_verify THEN RAISE EXCEPTION 'inventory_verify_needs_a_base' USING ERRCODE='22023'; END IF;
  RETURN public.fn_union_pnl_inventory_checkpoint_seal(p_at,false);
 END IF;
 -- Staging holds one week at a time; layers made for another base are stale.
 IF NOT EXISTS(SELECT 1 FROM public.union_pnl_inventory_seal_layers l WHERE l.boundary=p_at)
  OR EXISTS(SELECT 1 FROM public.union_pnl_inventory_seal_layers l WHERE l.boundary=p_at AND l.base_boundary IS DISTINCT FROM v_base) THEN
  TRUNCATE public.union_pnl_inventory_seal_layers, public.union_pnl_inventory_seal_layer_rows, public.union_pnl_inventory_seal_layer_issues;
 END IF;
 CREATE TEMP TABLE IF NOT EXISTS _inv_layer(o_kind text,o_source_name text,o_row_id uuid,o_event_id bigint,o_first_operation text,o_after_row jsonb) ON COMMIT DROP;
 SELECT count(*) INTO n_layers FROM generate_series(v_base,p_at-interval '1 microsecond',interval '6 hours') s;
 FOR g IN SELECT s AS layer_start,LEAST(s+interval '6 hours',p_at) AS layer_end
   FROM generate_series(v_base,p_at-interval '1 microsecond',interval '6 hours') s ORDER BY 1 LOOP
  CONTINUE WHEN EXISTS(SELECT 1 FROM public.union_pnl_inventory_seal_layers l WHERE l.boundary=p_at AND l.layer_end=g.layer_end);
  IF done_any AND clock_timestamp()>began+interval '90 seconds' THEN
   SELECT count(*) INTO n_done FROM public.union_pnl_inventory_seal_layers l WHERE l.boundary=p_at;
   RETURN jsonb_build_object('status','sealing','boundary',p_at,'base_boundary',v_base,'layers',n_layers,'layers_done',n_done);
  END IF;
  t0:=clock_timestamp();
  TRUNCATE pg_temp._inv_layer;
  INSERT INTO pg_temp._inv_layer SELECT * FROM public.fn_union_pnl_inventory_layer_state(v_base,p_at,g.layer_start,g.layer_end);
  INSERT INTO public.union_pnl_inventory_seal_layer_rows(boundary,source_name,row_id,layer_end,latest_event_id,first_operation,after_row)
   SELECT p_at,o_source_name,o_row_id,g.layer_end,o_event_id,o_first_operation,o_after_row FROM pg_temp._inv_layer WHERE o_kind='row';
  GET DIAGNOSTICS v_lr=ROW_COUNT;
  INSERT INTO public.union_pnl_inventory_seal_layer_issues(boundary,source_name,row_id,layer_end,event_id)
   SELECT p_at,o_source_name,o_row_id,g.layer_end,o_event_id FROM pg_temp._inv_layer WHERE o_kind='issue';
  GET DIAGNOSTICS v_li=ROW_COUNT;
  INSERT INTO public.union_pnl_inventory_seal_layers(boundary,layer_end,layer_start,base_boundary,row_count,issue_count,layer_ms)
  VALUES(p_at,g.layer_end,g.layer_start,v_base,v_lr,v_li,(extract(epoch FROM clock_timestamp()-t0)*1000)::bigint);
  done_any:=true;
 END LOOP;
 IF done_any AND clock_timestamp()>began+interval '60 seconds' THEN
  RETURN jsonb_build_object('status','sealing','boundary',p_at,'base_boundary',v_base,'layers',n_layers,'layers_done',n_layers);
 END IF;
 -- The week: base rows no layer touched, and each touched row as of its
 -- latest layer; issues likewise.
 IF NOT p_verify AND public.fn_union_pnl_inventory_snapshot_restore(p_at,v_base) THEN
  SELECT h.row_count,h.issue_count,h.rows_md5,h.issues_md5,h.max_event_id INTO v_rows,v_issues,v_rows_md5,v_issues_md5,v_max FROM public.union_pnl_inventory_seal_snapshot_head h WHERE h.boundary=p_at;
 ELSE
 IF to_regclass('pg_temp.union_pnl_inventory_seal') IS NOT NULL THEN EXECUTE 'DROP TABLE pg_temp.union_pnl_inventory_seal'; END IF;
 CREATE TEMP TABLE union_pnl_inventory_seal ON COMMIT DROP AS
  WITH lt AS MATERIALIZED (SELECT DISTINCT ON (l.source_name,l.row_id) l.source_name sn,l.row_id rid,l.layer_end,l.latest_event_id eid,l.first_operation fop,l.after_row
    FROM public.union_pnl_inventory_seal_layer_rows l WHERE l.boundary=p_at ORDER BY l.source_name,l.row_id,l.layer_end DESC)
  SELECT 'row'::text o_kind,lt.sn o_source_name,lt.rid o_row_id,lt.eid o_event_id,lt.fop o_first_operation,lt.after_row o_after_row FROM lt
  UNION ALL
  SELECT 'row',r.source_name,r.row_id,r.latest_event_id,r.first_operation,r.after_row FROM public.union_pnl_inventory_published_rows r
   WHERE r.boundary=v_base AND NOT EXISTS(SELECT 1 FROM lt WHERE lt.sn=r.source_name AND lt.rid=r.row_id)
  UNION ALL
  SELECT 'issue',li.source_name,li.row_id,li.event_id,NULL::text,NULL::jsonb FROM lt JOIN public.union_pnl_inventory_seal_layer_issues li
   ON li.boundary=p_at AND li.layer_end=lt.layer_end AND li.source_name=lt.sn AND li.row_id=lt.rid
  UNION ALL
  SELECT 'issue',ci.source_name,ci.row_id,ci.event_id,NULL,NULL FROM public.union_pnl_inventory_published_issues ci
   WHERE ci.boundary=v_base AND NOT EXISTS(SELECT 1 FROM lt WHERE lt.sn=ci.source_name AND lt.rid=ci.row_id);
 -- From here on, exactly fn_union_pnl_inventory_checkpoint_seal.
 EXECUTE $q$SELECT count(*) FILTER(WHERE o_kind='row'),count(*) FILTER(WHERE o_kind='issue'),
   NULL::text,
   md5(COALESCE(string_agg(concat_ws('|',o_source_name,o_row_id,o_event_id),E'\n'
    ORDER BY o_source_name,o_row_id,o_event_id) FILTER(WHERE o_kind='issue'),'')),
   max(o_event_id) FILTER(WHERE o_kind='row')
  FROM pg_temp.union_pnl_inventory_seal$q$ INTO v_rows,v_issues,v_rows_md5,v_issues_md5,v_max;
 -- THE ROWS HASH IS TAKEN BUCKET BY BUCKET (2026-10-12): one string of every
 -- row passed the 1 GB limit of a value at ~3M rows (54000). Each bucket (one
 -- source, the first two hex digits of row_id) is hashed in row order, and the
 -- bucket hashes are hashed in the same order.
 -- Weeks up to 2026-10-05 were sealed whole; a verify of one recomputes that hash.
 IF p_verify AND p_at<='2026-10-05 07:00:00+00'::timestamptz THEN
  EXECUTE $q$SELECT md5(COALESCE(string_agg(concat_ws('|',o_source_name,o_row_id,o_event_id,o_first_operation,COALESCE(o_after_row::text,'~')),E'\n'
    ORDER BY o_source_name,o_row_id),'')) FROM pg_temp.union_pnl_inventory_seal WHERE o_kind='row'$q$ INTO v_rows_md5;
 ELSE
  EXECUTE $q$SELECT md5(COALESCE(string_agg(x.h,E'\n' ORDER BY x.sn,x.b),'')) FROM (SELECT o_source_name sn,left(o_row_id::text,2) b,
    md5(string_agg(concat_ws('|',o_source_name,o_row_id,o_event_id,o_first_operation,COALESCE(o_after_row::text,'~')),E'\n'
     ORDER BY o_source_name,o_row_id)) h
    FROM pg_temp.union_pnl_inventory_seal WHERE o_kind='row' GROUP BY 1,2) x$q$ INTO v_rows_md5;
 END IF;
 IF NOT p_verify THEN PERFORM public.fn_union_pnl_inventory_snapshot_save(p_at,v_base,v_rows,v_issues,v_rows_md5,v_issues_md5,v_max); END IF;
 END IF;
 IF p_verify THEN
  EXECUTE 'DROP TABLE pg_temp.union_pnl_inventory_seal';
  RETURN jsonb_build_object('status',CASE WHEN v_rows=v_prior.row_count AND v_issues=v_prior.issue_count AND v_rows_md5=v_prior.rows_md5
     AND v_issues_md5=v_prior.issues_md5 AND v_max IS NOT DISTINCT FROM v_prior.max_event_id THEN 'verified' ELSE 'differs' END,
   'boundary',p_at,'base_boundary',v_base,'layers',n_layers,'row_count',v_rows,'issue_count',v_issues,'rows_md5',v_rows_md5,'issues_md5',v_issues_md5,'max_event_id',v_max,
   'sealed',jsonb_build_object('row_count',v_prior.row_count,'issue_count',v_prior.issue_count,'rows_md5',v_prior.rows_md5,'issues_md5',v_prior.issues_md5,'max_event_id',v_prior.max_event_id));
 END IF;
 -- THE FINAL COPY IS A BOUNDED COMMITTED PAGE (20261012).
 IF NOT public.fn_union_pnl_inventory_seal_write_page(p_at,v_base) THEN
  -- SEVERAL BOUNDED PAGES A TICK, INSIDE A WAL SPAN (20261019102410). One
  -- page (~17,000 rows, ~14.5 MB of WAL, ~0.7 s) per five-minute tick put the
  -- 4.52M-row week of 2026-10-19 about 21 hours from its close. Keep writing
  -- pages while rows remain past the durable cursor, until 384 MB of WAL has
  -- been written since this call began (a quarter of Realtime's 1.5 GB slot
  -- lag cutoff), 45 s have passed, or 64 pages are written. Publication still
  -- waits for a later tick, after the final page committed.
  v_pages:=1;
  LOOP
   EXIT WHEN v_pages>=64 OR clock_timestamp()>began+interval '45 seconds'
    OR pg_wal_lsn_diff(pg_current_wal_insert_lsn(),v_wal0)>=402653184;
   SELECT b.last_kind,b.last_source,b.last_row,b.last_event INTO c_kind,c_source,c_row,c_event
    FROM public.union_pnl_inventory_seal_builds b WHERE b.boundary=p_at;
   EXIT WHEN c_kind IS NULL OR NOT EXISTS(SELECT 1 FROM pg_temp.union_pnl_inventory_seal s
    WHERE (s.o_kind,s.o_source_name,s.o_row_id,s.o_event_id)>(c_kind,c_source,c_row,c_event));
   EXIT WHEN public.fn_union_pnl_inventory_seal_write_page(p_at,v_base);
   v_pages:=v_pages+1;
  END LOOP;
  EXECUTE 'DROP VIEW pg_temp.union_pnl_inventory_seal';
  RETURN jsonb_build_object('status','sealing','boundary',p_at,'base_boundary',v_base,'stage','committed_build_page','pages',v_pages);
 END IF;
 EXECUTE 'DROP VIEW pg_temp.union_pnl_inventory_seal';
 v_projection:=public.fn_union_pnl_inventory_build_population(p_at,p_at);
 SELECT COALESCE(sum(l.layer_ms),0)+(extract(epoch FROM clock_timestamp()-began)*1000)::bigint INTO v_ms FROM public.union_pnl_inventory_seal_layers l WHERE l.boundary=p_at;
 INSERT INTO public.union_pnl_inventory_checkpoints(boundary,base_boundary,max_event_id,row_count,issue_count,rows_md5,issues_md5,result_md5,legacy_verified,seal_ms)
 VALUES(p_at,v_base,v_max,v_rows,v_issues,v_rows_md5,v_issues_md5,md5(v_projection::text),false,v_ms);
 RETURN jsonb_build_object('status','sealed','boundary',p_at,'base_boundary',v_base,'max_event_id',v_max,'row_count',v_rows,'issue_count',v_issues,
  'rows_md5',v_rows_md5,'result_md5',md5(v_projection::text),'legacy_verified',false,'layers',n_layers,
  'result_issues',jsonb_array_length(v_projection->'issues'),'seal_ms',v_ms);
END $function$;

CREATE OR REPLACE FUNCTION public.fn_union_settlement_cascade_due()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_advance jsonb; v_promo jsonb;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 -- THE ENGINE'S 8 S PROBE LEAVES THE CLOSE TO ITS TICK (20261019102410). The
 -- settler calls this every cycle as service_role (statement_timeout 8s). Its
 -- unchunked path is the full scope scan, which now takes over 50 s, so the
 -- call was cancelled at 8 s (max 8,056 ms in pg_stat_statements) while it
 -- held the scheduler lock that job 272's tick needs. A call without the
 -- chunked tick's settings and with less than a minute of statement budget
 -- visits no scope; job 272 (union-weekly-rakeback-close) owns the close.
 IF COALESCE(current_setting('app.weekly_accounting_chunked',true),'')<>'on'
  AND current_setting('statement_timeout') NOT IN('0','0ms')
  AND current_setting('statement_timeout')::interval<interval '60 seconds' THEN
  RETURN jsonb_build_object('success',true,'checked',0,'failed',0,'visited_scopes',0,'more_remaining',true,
   'observed_at',clock_timestamp(),'detail','[]'::jsonb,'deferred_to','union-weekly-rakeback-close');
 END IF;
 -- THE ROUND-2 WINDOWS ADVANCE ON THEIR OWN TICK (20261015181721): a book
 -- whose round-2 windows are all that is missing has them proved with the
 -- whole statement, and this tick visits no scope; otherwise as before.
 v_promo:=public.fn_midway_weekly_horse_promo_due();
 IF v_promo->>'advanced'='true' OR v_promo->>'owns_tick'='true' THEN RETURN v_promo;END IF;
 v_advance:=public.fn_accounting_close_windows_advance_due();
 IF v_advance IS NOT NULL THEN RETURN v_advance; END IF;
 RETURN public.fn_process_weekly_accounting(NULL);
END $function$;

DO $verify_cash_retry$
BEGIN
 IF md5(pg_get_functiondef('public.fn_process_cash_accounting_source(uuid)'::regprocedure))<>'460e4b0a936b41246548cb0a9efc9f7f'
 THEN RAISE EXCEPTION 'cash_retry_exact_postimage_required:%','fn_process_cash_accounting_source';END IF;
 IF md5(pg_get_functiondef('public.fn_retry_cash_accounting_sources(integer)'::regprocedure))<>'0ab1bf9282426f348c034785513724e0'
 THEN RAISE EXCEPTION 'cash_retry_exact_postimage_required:%','fn_retry_cash_accounting_sources';END IF;
 IF md5(pg_get_functiondef('public.fn_union_pnl_inventory_seal_advance(timestamptz,boolean)'::regprocedure))<>'c2550f8714fede1047ed2efcf396d697'
 THEN RAISE EXCEPTION 'cash_retry_exact_postimage_required:%','fn_union_pnl_inventory_seal_advance';END IF;
 IF md5(pg_get_functiondef('public.fn_union_settlement_cascade_due()'::regprocedure))<>'9b9b4ad4bd11c9456ddf1e63509b6780'
 THEN RAISE EXCEPTION 'cash_retry_exact_postimage_required:%','fn_union_settlement_cascade_due';END IF;
END $verify_cash_retry$;
COMMIT;
