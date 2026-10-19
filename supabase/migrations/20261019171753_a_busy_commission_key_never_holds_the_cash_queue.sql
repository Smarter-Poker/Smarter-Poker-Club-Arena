-- 20261019171753_a_busy_commission_key_never_holds_the_cash_queue
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-19 17:17:53 UTC.
--
-- WHAT WAS WRONG (read-only on production, 2026-10-19 17:13-17:20 UTC)
--
-- 20261019094914 (installed 15:11) makes the cash batch and the refusal retry
-- take their club commission keys in club order before the first item and
-- DEFER an item whose keys they do not hold. Two parts of it combine into a
-- queue that a single busy key can stop:
--
-- 1. The key walk ENDED at the first key still busy after 1 s. Everything
--    after it in club order was then deferred, including items that need none
--    of the busy clubs. Midway Union's keys are the lowest uuids (2a1132b9,
--    a0000000-...-0001, a41434bb); Lightning Internal Pilot is e14bc9f7. So one
--    busy Midway key deferred every Lightning item in the same call.
-- 2. fn_retry_cash_accounting_sources chose exactly p_limit due sources (5 at
--    the engine's budget), fewest refusals first, and a deferral leaves a
--    source's work row unchanged. When those five wait on one busy key, the
--    call runs nothing, the same five come back first on the next call, and
--    nothing behind them is reached. Nothing ages or rotates them.
--
-- Measured: the retry drained yesterday's Lightning refusals in order through
-- the afternoon (attempt-2 receipts: 65 accrued 15:00-16:00, 85 accrued 16:00,
-- 5 accrued 17:00:17, all club e14bc9f7, all due before 2026-10-18 15:44).
-- At 17:00 the head became 9fa74288 (Lightning, due since 2026-10-18 15:44)
-- followed by four Midway sources refused by a lock between 00:02 and 00:11
-- (attempts 1). Those five now share a call whose need set spans both unions:
-- any busy Midway key defers all five, and with them the ~2,590 attempt-1
-- sources due behind them (the 23 deadlock refusals of today among them).
-- The batch has the same walk: a page item that needs only a free key was
-- deferred whenever a lower, unrelated key was busy, and three such
-- resubmissions halt the page (RakebackSettlerService CASH_DEFERRAL_RESUBMITS).
--
-- WHAT CHANGES
--
-- A. Both functions: a busy key is skipped, not the end of the walk. Keys are
--    still taken in club order and only ever waited for while every held key
--    is lower (ascending with gaps is still one total order, so no new cycle
--    with a finish, which takes its keys in the same order). The waits share
--    one 1 s budget per call (it was 1 s, once). An item runs only if every
--    one of its clubs is held; otherwise it is deferred exactly as before.
-- B. The retry reads a window of LEAST(200, 8 x p_limit) due sources in the
--    same order (fewest refusals, then due time) and runs up to p_limit of
--    those whose keys it holds. A deferred head can no longer hold the queue:
--    the call goes on to the next sources whose keys are free. Deferrals are
--    reported only within the caller's bound (receipts + deferred <= p_limit),
--    so the engine's response contract and its full-batch drain rule
--    (#7439) are unchanged; an unreported deferral is left exactly as every
--    deferral is.
--
-- NOT CHANGED: fn_process_cash_accounting_source (20261019102410), what an
-- item credits, its receipts, refusals, retry schedule and idempotency, the
-- response shape, owner, grants and settings, and the engine. No sweep, repair
-- or compensating write (CLAUDE.md 10.12). The refusal flood of
-- accounting_terms_not_observed since 15:43 (owned by PR #7458) is not touched;
-- it sits behind the older refusals in the same order and is no longer able
-- to hold anything in front of it.
--
-- DEPLOY ORDER: database only. The engine already accepts these responses.
--
-- QUALIFIED NATIVELY: scripts/qualification/chip-deadlocks.py runs this
-- migration's $subs$ block on the production bodies (sorted -> skipping) and
-- reproduces the starvation: a head of five sources waiting on a busy club key
-- with free-keyed sources behind it. Production's text runs none of them in
-- any number of calls; this text runs the free-keyed ones every call.
--
-- PINNED LIVE md5(pg_get_functiondef(oid)), read 2026-10-19 17:17 UTC, and AFTER:
--   fn_credit_agent_commissions_batch  33e0be86d6a2a88f18be4ec4e058cadd -> 1ae9eb0e32f8169ce0cdd6b730c859a6
--   fn_retry_cash_accounting_sources   0a5daa862601baaf365972ac6b577e6a -> 779590b67fc21e95504a9827f1289207
--
-- @live-proof: (SELECT md5(pg_get_functiondef(p.oid)) = '1ae9eb0e32f8169ce0cdd6b730c859a6' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_credit_agent_commissions_batch')
-- @live-proof: (SELECT md5(pg_get_functiondef(p.oid)) = '779590b67fc21e95504a9827f1289207' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_retry_cash_accounting_sources')

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $subs$
DECLARE
  s record; v_sig regprocedure; v_meta text; v_after text;
BEGIN
  FOR s IN SELECT * FROM (VALUES
    ('fn_credit_agent_commissions_batch(jsonb)', '33e0be86d6a2a88f18be4ec4e058cadd', '1ae9eb0e32f8169ce0cdd6b730c859a6',
$batch$CREATE OR REPLACE FUNCTION public.fn_credit_agent_commissions_batch(p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '300s'
AS $function$
DECLARE it jsonb;r jsonb;receipts jsonb:='[]';record_id uuid;v_ok int:=0;v_failed int:=0;v_blocked int:=0;first_error text;v_gate uuid;
 v_n bigint;v_clubs uuid[];v_sets jsonb:='[]';v_need uuid[]:='{}';v_held uuid[]:='{}';v_deferred jsonb:='[]';v_lock_timeout text;v_wait_until timestamptz;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'cash_source_not_authorised' USING ERRCODE='42501'; END IF;
 IF p_items IS NULL OR jsonb_typeof(p_items)<>'array' OR jsonb_array_length(p_items)>2000 THEN
  RETURN jsonb_build_object('ok',0,'failed',0,'error','p_items must be a jsonb array of at most 2000 items'); END IF;
 -- EVERY COMMISSION KEY IN CLUB ORDER BEFORE THE FIRST ITEM; AN ITEM WHOSE KEYS
 -- ARE NOT ALL HELD WAITS FOR THE NEXT CALL (2026-10-19). This batch is one
 -- transaction over many hands and keeps each item's rows and keys to its end.
 -- An item's commission rows take the 'agent-commission:<club>' key of each
 -- club its rake is attributed in (trg_agent_commission_rollup_insert), and a
 -- tournament finish takes the same keys in club order. Taking them item by
 -- item, in page order, held a later club while waiting for an earlier one:
 -- 40P01 against a finish (2026-10-19 07:28:34). So the keys every item needs
 -- are taken here, in club order: a free key at once, a busy one waited for
 -- within one 1 s budget while holding only lower keys, which no finish waits
 -- for. A key not granted is skipped (below) and never fails the batch whole
 -- (2026-10-01 00:07:30). An item whose clubs are not all held is not run and
 -- not refused: it writes nothing and is returned in 'deferred', and the
 -- settler submits it again before its cursor may pass it.
 FOR it IN SELECT value FROM jsonb_array_elements(p_items) LOOP
  v_clubs:=ARRAY(SELECT DISTINCT c.club_id FROM (
    SELECT a.club_id FROM public.rake_attributions a
     WHERE a.rake_record_id=CASE WHEN it->>'source_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN CASE it->>'source_type' WHEN 'cash_rake_record' THEN (it->>'source_id')::uuid
       WHEN 'rake_settlement' THEN (SELECT h.id FROM public.rake_records h WHERE h.hand_id=(it->>'source_id')::uuid ORDER BY h.id LIMIT 1)
      END END
    UNION ALL
    SELECT CASE WHEN it->>'club_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (it->>'club_id')::uuid END
     WHERE NOT COALESCE(it->>'source_type' IN('cash_rake_record','rake_settlement'),false)
   ) c WHERE c.club_id IS NOT NULL ORDER BY c.club_id);
  v_sets:=v_sets||jsonb_build_array(to_jsonb(v_clubs));
  v_need:=v_need||v_clubs;
 END LOOP;
 v_need:=ARRAY(SELECT DISTINCT g FROM unnest(v_need) g ORDER BY g);
 -- A BUSY KEY IS SKIPPED, NOT THE END OF THE WALK (2026-10-19, 20261019171753).
 -- Ending the walk at the first busy key deferred every item behind it in club
 -- order, including items that need none of the busy clubs: one busy Midway key
 -- (the lowest uuids) deferred every Lightning item, every call. The walk now
 -- goes on past a busy key. Keys are still only ever waited for in club order,
 -- and only for a key above every key already held, so the gaps keep one total
 -- order; the waits share one 1 s budget per call.
 v_wait_until:=clock_timestamp()+interval '1 second';
 FOREACH v_gate IN ARRAY v_need LOOP
  IF pg_try_advisory_xact_lock(hashtextextended('agent-commission:'||v_gate::text,0)) THEN
   v_held:=v_held||v_gate;
  ELSIF clock_timestamp()<v_wait_until THEN
   BEGIN
    v_lock_timeout:=current_setting('lock_timeout');
    PERFORM set_config('lock_timeout',
     GREATEST(1,ceil(extract(epoch FROM v_wait_until-clock_timestamp())*1000))::bigint::text||'ms',true);
    PERFORM pg_advisory_xact_lock(hashtextextended('agent-commission:'||v_gate::text,0));
    PERFORM set_config('lock_timeout',v_lock_timeout,true);
    v_held:=v_held||v_gate;
   EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
    NULL;
   END;
  END IF;
 END LOOP;
 FOR it,v_n IN SELECT value,ordinality FROM jsonb_array_elements(p_items) WITH ORDINALITY LOOP
  v_clubs:=ARRAY(SELECT g::uuid FROM jsonb_array_elements_text(v_sets->(v_n::int-1)) g);
  IF NOT v_clubs<@v_held THEN
   v_deferred:=v_deferred||jsonb_build_array(it->'source_id');
   CONTINUE;
  END IF;
  BEGIN
   IF it->>'source_type' IN('cash_rake_record','rake_settlement') THEN
    IF it->>'source_type'='cash_rake_record' THEN record_id:=(it->>'source_id')::uuid;
    ELSE
     SELECT id INTO STRICT record_id FROM public.rake_records WHERE hand_id=(it->>'source_id')::uuid;
     -- Keep the legacy caller's scope validation. A batched user cannot move
     -- one contributor's recorded earning into a different club.
     IF NOT EXISTS(SELECT 1 FROM public.rake_attributions WHERE rake_record_id=record_id
      AND player_id=(it->>'user_id')::uuid AND club_id=(it->>'club_id')::uuid
      AND weighted_rake_credit=(it->>'rake_credit')::numeric) THEN
      RAISE EXCEPTION 'cash_source_legacy_input_not_proven' USING ERRCODE='23514'; END IF;
    END IF;
    r:=public.fn_process_cash_accounting_source(record_id);receipts:=receipts||jsonb_build_array(r);
    IF r->>'status'='accrued' THEN v_ok:=v_ok+1;
    ELSE v_failed:=v_failed+1;v_blocked:=v_blocked+1;first_error:=COALESCE(first_error,r->>'reason'); END IF;
   ELSE
    PERFORM public.credit_agent_commission_from_rake((it->>'user_id')::uuid,(it->>'club_id')::uuid,
     COALESCE((it->>'rake_credit')::numeric,0),it->>'source_type',NULLIF(it->>'source_id','')::uuid,it->>'notes');
    v_ok:=v_ok+1;
   END IF;
  EXCEPTION WHEN OTHERS THEN v_failed:=v_failed+1;first_error:=COALESCE(first_error,SQLERRM);
  END;
 END LOOP;
 RETURN jsonb_build_object('receipt_version',3,'ok',v_ok,'failed',v_failed,'blocked',v_blocked,'first_error',first_error,'receipts',receipts,
  'deferred',v_deferred);
END $function$
$batch$),
    ('fn_retry_cash_accounting_sources(integer)', '0a5daa862601baaf365972ac6b577e6a', '779590b67fc21e95504a9827f1289207',
$retry$CREATE OR REPLACE FUNCTION public.fn_retry_cash_accounting_sources(p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '300s'
AS $function$
DECLARE r jsonb;receipts jsonb:='[]';v_ok int:=0;v_blocked int:=0;v_failed int:=0;first_error text;v_parked bigint:=0;v_gate uuid;
 v_due uuid[];v_id uuid;v_clubs uuid[];v_need uuid[];v_held uuid[]:='{}';v_deferred jsonb:='[]';v_lock_timeout text;v_wait_until timestamptz;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'cash_source_not_authorised' USING ERRCODE='42501'; END IF;
 IF p_limit IS NULL OR p_limit<1 OR p_limit>200 THEN RAISE EXCEPTION 'invalid_cash_retry_limit' USING ERRCODE='22023'; END IF;
 -- EVERY COMMISSION KEY IN CLUB ORDER BEFORE THE FIRST SOURCE (2026-10-19), as
 -- fn_credit_agent_commissions_batch takes them: this retry is one transaction
 -- over many sources too. The due sources are chosen once; the keys of every
 -- club they are attributed in are taken in club order, a busy one waited for
 -- within one 1 s budget while holding only lower keys; a key not granted is
 -- skipped (below).
 -- A source whose clubs are not all held is not run: its blocked work row is
 -- left exactly as it is (no receipt, no attempt), it is returned in
 -- 'deferred', and it is among the first due sources again next cycle.
 -- A DEFERRED HEAD NEVER HOLDS THE QUEUE (2026-10-19, 20261019171753). The call
 -- reads a window of eight times p_limit due sources (at most 200), in the same
 -- order, and runs up to p_limit of those whose keys it holds. Before, it read
 -- exactly p_limit: when all of them waited on one busy key, the call ran
 -- nothing, the same sources came back first next call, and nothing behind
 -- them was ever reached.
 -- THE FEWEST REFUSALS GO FIRST (20261019102410). Oldest-due-first let a
 -- burst of sources still waiting on missing evidence hold every slot of
 -- every cycle while a source refused once by a lock waited a day behind it.
 v_due:=ARRAY(SELECT s.rake_record_id FROM public.accounting_cash_source_work s
  WHERE s.status='blocked' AND s.next_attempt_at<=clock_timestamp()
  ORDER BY s.attempts,s.next_attempt_at,s.rake_record_id LIMIT LEAST(200,p_limit*8));
 v_need:=ARRAY(SELECT DISTINCT a.club_id FROM public.rake_attributions a
  WHERE a.rake_record_id=ANY(v_due) AND a.club_id IS NOT NULL ORDER BY a.club_id);
 -- A BUSY KEY IS SKIPPED, NOT THE END OF THE WALK (2026-10-19, 20261019171753).
 -- Ending the walk at the first busy key deferred every item behind it in club
 -- order, including items that need none of the busy clubs: one busy Midway key
 -- (the lowest uuids) deferred every Lightning item, every call. The walk now
 -- goes on past a busy key. Keys are still only ever waited for in club order,
 -- and only for a key above every key already held, so the gaps keep one total
 -- order; the waits share one 1 s budget per call.
 v_wait_until:=clock_timestamp()+interval '1 second';
 FOREACH v_gate IN ARRAY v_need LOOP
  IF pg_try_advisory_xact_lock(hashtextextended('agent-commission:'||v_gate::text,0)) THEN
   v_held:=v_held||v_gate;
  ELSIF clock_timestamp()<v_wait_until THEN
   BEGIN
    v_lock_timeout:=current_setting('lock_timeout');
    PERFORM set_config('lock_timeout',
     GREATEST(1,ceil(extract(epoch FROM v_wait_until-clock_timestamp())*1000))::bigint::text||'ms',true);
    PERFORM pg_advisory_xact_lock(hashtextextended('agent-commission:'||v_gate::text,0));
    PERFORM set_config('lock_timeout',v_lock_timeout,true);
    v_held:=v_held||v_gate;
   EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
    NULL;
   END;
  END IF;
 END LOOP;
 -- Do not lock work rows here: all callers acquire the original hand lock
 -- first. SKIP LOCKED on work would invert that order against direct callers.
 FOREACH v_id IN ARRAY v_due LOOP
  EXIT WHEN v_ok+v_blocked+v_failed>=p_limit;
  v_clubs:=ARRAY(SELECT DISTINCT a.club_id FROM public.rake_attributions a
   WHERE a.rake_record_id=v_id AND a.club_id IS NOT NULL ORDER BY a.club_id);
  IF NOT v_clubs<@v_held THEN
   v_deferred:=v_deferred||jsonb_build_array(v_id::text);
   CONTINUE;
  END IF;
  BEGIN
   r:=public.fn_process_cash_accounting_source(v_id);receipts:=receipts||jsonb_build_array(r);
   IF r->>'status'='accrued' THEN v_ok:=v_ok+1; ELSE v_blocked:=v_blocked+1; END IF;
  EXCEPTION WHEN OTHERS THEN v_failed:=v_failed+1;first_error:=COALESCE(first_error,SQLERRM);END;
 END LOOP;
 -- Deferrals are reported within the bound the caller asked for (receipts plus
 -- deferrals never exceed p_limit); a deferred source not reported is left
 -- exactly as it is, like every deferred source.
 v_deferred:=COALESCE((SELECT jsonb_agg(x.e ORDER BY x.n) FROM jsonb_array_elements(v_deferred) WITH ORDINALITY x(e,n)
  WHERE x.n<=p_limit-(v_ok+v_blocked+v_failed)),'[]'::jsonb);
 SELECT count(*) INTO v_parked FROM public.accounting_cash_source_work
  WHERE status='blocked' AND next_attempt_at='infinity'::timestamptz;
 RETURN jsonb_build_object('receipt_version',3,'ok',v_ok,'blocked',v_blocked,'failed',v_failed+v_blocked,'terminal_parked',v_parked,
  'first_error',first_error,'receipts',receipts,'deferred',v_deferred);
END $function$
$retry$)
  ) AS x(signature, before_md5, after_md5, new_def)
  LOOP
    v_sig := ('public.' || s.signature)::regprocedure;
    IF md5(pg_get_functiondef(v_sig)) <> s.before_md5 THEN
      RAISE EXCEPTION '% is not the pinned text (md5 %)', s.signature, md5(pg_get_functiondef(v_sig));
    END IF;
    SELECT concat_ws('|', pg_get_userbyid(p.proowner), p.proacl::text, p.proconfig::text, p.provolatile, p.prosecdef)
      INTO v_meta FROM pg_proc p WHERE p.oid = v_sig;
    EXECUTE s.new_def;
    v_after := pg_get_functiondef(v_sig);
    IF md5(v_after) <> s.after_md5 THEN
      RAISE EXCEPTION '% is not the text the harness measured (md5 %)', s.signature, md5(v_after);
    END IF;
    IF (SELECT concat_ws('|', pg_get_userbyid(p.proowner), p.proacl::text, p.proconfig::text, p.provolatile, p.prosecdef)
          FROM pg_proc p WHERE p.oid = v_sig) IS DISTINCT FROM v_meta
       OR v_meta <> 'postgres|{postgres=X/postgres,service_role=X/postgres}|{search_path=public,statement_timeout=300s}|v|t'
       OR has_function_privilege('anon', v_sig, 'EXECUTE')
       OR has_function_privilege('authenticated', v_sig, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION '%: owner, grants or settings moved (%)', s.signature, v_meta;
    END IF;
    IF position('    EXIT;' IN v_after) > 0
       OR position('ELSIF clock_timestamp()<v_wait_until THEN' IN v_after) = 0
       OR position('IF NOT v_clubs<@v_held THEN' IN v_after) = 0 THEN
      RAISE EXCEPTION '%: a busy commission key still ends the walk', s.signature;
    END IF;
  END LOOP;
  IF position('LIMIT LEAST(200,p_limit*8));' IN pg_get_functiondef('public.fn_retry_cash_accounting_sources(integer)'::regprocedure)) = 0
     OR position('EXIT WHEN v_ok+v_blocked+v_failed>=p_limit;' IN pg_get_functiondef('public.fn_retry_cash_accounting_sources(integer)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'the retry still reads only p_limit due sources';
  END IF;
  RAISE NOTICE 'a busy commission key never holds the cash queue: two bodies changed';
END $subs$;

-- Both stay engine-only. These restate the grants production already holds
-- (asserted above and again below), so the ACL does not move; GRANT and REVOKE
-- do not reload PostgREST's schema cache.
REVOKE ALL ON FUNCTION public.fn_credit_agent_commissions_batch(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_credit_agent_commissions_batch(jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.fn_retry_cash_accounting_sources(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_retry_cash_accounting_sources(integer) TO service_role;

DO $grants$
BEGIN
  IF (SELECT p.proacl::text FROM pg_proc p WHERE p.oid = 'public.fn_credit_agent_commissions_batch(jsonb)'::regprocedure)
       IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}'
     OR (SELECT p.proacl::text FROM pg_proc p WHERE p.oid = 'public.fn_retry_cash_accounting_sources(integer)'::regprocedure)
       IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'the cash source grants moved';
  END IF;
END $grants$;

COMMIT;
