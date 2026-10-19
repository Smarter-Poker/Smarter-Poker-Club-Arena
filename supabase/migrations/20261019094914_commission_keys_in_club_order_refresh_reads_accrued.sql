-- 20261019094914_commission_keys_in_club_order_refresh_reads_accrued
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-19 09:49:14 UTC.
--
-- WHAT WAS WRONG (read-only on production, 2026-10-19 ~09:40 UTC)
--
-- 1. A cash commission batch deadlocks with a tournament finish.
--    fn_credit_agent_commissions_batch and fn_retry_cash_accounting_sources
--    take the club commission keys ('agent-commission:<club>') their items
--    need before the first item, in club order - but since 20261001001000
--    only while they are free: `EXIT WHEN NOT pg_try_advisory_xact_lock(...)`.
--    The first busy key ends the walk, and every key after it is then taken
--    item by item, in PAGE order, by trg_agent_commission_rollup_insert. One
--    transaction can therefore hold a higher club's key while it waits for a
--    lower one. A tournament finish (fn_complete_tournament_terminal ->
--    fn_settle_tournament_rake -> fn_recognize_accounting_tournament_fees)
--    takes the same keys source by source ordered by club_id, ascending. So:
--    the finish holds Club JAQK (a0000000-...-0001) and asks for SHARK CLUB
--    (a41434bb-...); the batch, whose walk stopped at the busy JAQK key, took
--    SHARK CLUB for its first item and asks for JAQK for its second. 40P01,
--    postgres log 2026-10-19 07:28:34, settler pid 795571 x tournament pid
--    795586. First-attempt 40P01/55P03 refusals: 4-13 a day 10-15..10-18, 31 on
--    10-19 by 09:30.
--
--    20261001001000 introduced the try-lock because a WAIT for a key outside
--    any item put the whole batch behind the role's 8 s lock_timeout and failed
--    it whole. That reason still stands - 20261003201157 (a finish waits for
--    the keys holding nothing) was reverted by 20261003232001 the same night,
--    so a finish still holds a key for the rest of its run. This migration
--    keeps "never fail the batch whole" and removes the out-of-order
--    acquisition instead.
--
-- 2. A refused source makes the union refresh claim what it cannot prove.
--    The refused item gets a durable 'blocked' receipt in
--    accounting_cash_source_work and the settler's cursor moves past it (the
--    retry queue owns it, 5 a cycle, oldest first; ~955 waiting). The open
--    week refresh, fn_union_rake_basis_refresh, reads through
--    LEAST(p_end, now(), cursor) on the stated premise that "every bank
--    receipt below the cursor has been accrued" - false for a refused one. The
--    plan check (fn_accounting_union_earned_plan_v3) then refuses the window
--    with union_cash_sources_do_not_match_bank:1 and an open financial_alerts
--    row is written every hour (since 07:35 UTC; rake_record
--    b23a0294-63d8-4311-8d18-b224e8d3cbf4, 0.95).
--
-- WHAT CHANGES
--
-- A. fn_credit_agent_commissions_batch and fn_retry_cash_accounting_sources
--    work out every club key their items need (the clubs each item's rake is
--    attributed in - the clubs fn_accounting_cash_commission_plan writes
--    commission rows for, ordered by club_id - and, for a legacy item, its
--    club) and take them in club order BEFORE the first item: a free key at
--    once, a busy key waited for at most 1 s inside its own subtransaction
--    while holding only lower keys. A finish never waits for a lower key while
--    holding a higher one, so that wait cannot close a cycle. A key not granted
--    in 1 s (55P03) or refused as a deadlock victim (40P01) ends the walk;
--    the subtransaction leaves nothing behind. Then each item runs only if
--    every one of its clubs is held. An item that does not is NOT refused: it
--    writes nothing (no receipt, no retry work, no attempt) and is returned in
--    a new 'deferred' list. The engine (RakebackSettlerService) resubmits a
--    deferred item before it may save its cursor, and holds the cursor if the
--    item is still deferred, so a deferred item can never be passed. A
--    deferred retry item keeps its existing blocked work row unchanged and is
--    the oldest due again next cycle. No item ever asks the trigger for a key
--    its transaction does not already hold, so the out-of-order acquisition
--    is gone, not merely rarer.
--    Unchanged: every receipt, the refusal contract for a genuinely refused
--    item (its durable 'blocked' receipt and retry work), idempotency, the
--    item order, receipt_version 3, the counts the engine checks
--    (ok + blocked = receipts; failed = blocked), owner, grants, SECURITY
--    DEFINER, search_path and the 300 s statement_timeout.
--
-- B. fn_union_rake_basis_refresh reads through
--    LEAST(p_end, now(), cursor, earliest banked_at of this union's
--    bank receipts in the window whose source work is still 'blocked'), so
--    its comment is true: everything below `through` has been accrued. The
--    snapshot then stops just before a refused source instead of claiming it,
--    and moves on by itself the moment the retry accrues it. The weekly
--    close's strict plan_v3 check is not touched and still refuses a week
--    with any unaccrued source. The read uses the partial index
--    accounting_cash_source_work_retry (status = 'blocked') and the bank
--    receipt primary key.
--
-- NOT CHANGED: no repair, sweep, backfill or compensating write (CLAUDE.md
-- 10.12). Nothing is credited differently: an item accrues through
-- fn_process_cash_accounting_source exactly as before, only never while its
-- transaction holds a key out of order. The freeze guards are untouched.
--
-- DEPLOY ORDER: the engine change ships FIRST. The current engine reads a
-- batch receipt whose receipts are fewer than its items as incomplete and
-- holds its cursor; it would halt (safely, nothing lost) on every deferral
-- until the new engine is live. The new engine accepts both the old receipt
-- (no 'deferred') and the new one.
--
-- QUALIFIED NATIVELY: scripts/qualification/chip-deadlocks.py runs this
-- migration's own $subs$ block on production's bodies (the 20261001001000
-- postimages it asserts below) and reproduces the 10-19 interleaving:
-- deadlock before, none after, every commission written once.
-- scripts/qualification/refresh-horizon.py runs the $refresh$ block on the
-- production body pinned below.
--
-- PINNED LIVE md5(pg_get_functiondef(oid)), read 2026-10-19, and AFTER:
--   fn_credit_agent_commissions_batch  d4572f3e1efd9c85a0025cc2906c6fae -> 33e0be86d6a2a88f18be4ec4e058cadd
--   fn_retry_cash_accounting_sources   3788581d5e8f1953663b8929b4688d0a -> e9b28c51e08c1754a475658f9720db40
--   fn_union_rake_basis_refresh        c88e99cda4f091c9e48b0f6b173651a4 -> 9fdc0af3d23759ab843ce122ecaefb03
--
-- @live-proof: (SELECT md5(pg_get_functiondef(p.oid)) = '33e0be86d6a2a88f18be4ec4e058cadd' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_credit_agent_commissions_batch')
-- @live-proof: (SELECT md5(pg_get_functiondef(p.oid)) = 'e9b28c51e08c1754a475658f9720db40' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_retry_cash_accounting_sources')
-- @live-proof: (SELECT md5(pg_get_functiondef(p.oid)) = '9fdc0af3d23759ab843ce122ecaefb03' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_union_rake_basis_refresh')

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $subs$
DECLARE
  s record; v_sig regprocedure; v_meta text; v_after text;
BEGIN
  FOR s IN SELECT * FROM (VALUES
    ('fn_credit_agent_commissions_batch(jsonb)', 'd4572f3e1efd9c85a0025cc2906c6fae', '33e0be86d6a2a88f18be4ec4e058cadd',
$batch$CREATE OR REPLACE FUNCTION public.fn_credit_agent_commissions_batch(p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '300s'
AS $function$
DECLARE it jsonb;r jsonb;receipts jsonb:='[]';record_id uuid;v_ok int:=0;v_failed int:=0;v_blocked int:=0;first_error text;v_gate uuid;
 v_n bigint;v_clubs uuid[];v_sets jsonb:='[]';v_need uuid[]:='{}';v_held uuid[]:='{}';v_deferred jsonb:='[]';v_lock_timeout text;
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
 -- at most 1 s while holding only lower keys, which no finish waits for. A key
 -- not granted in that time ends the walk, and never fails the batch whole
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
 FOREACH v_gate IN ARRAY v_need LOOP
  IF NOT pg_try_advisory_xact_lock(hashtextextended('agent-commission:'||v_gate::text,0)) THEN
   BEGIN
    v_lock_timeout:=current_setting('lock_timeout');
    PERFORM set_config('lock_timeout','1s',true);
    PERFORM pg_advisory_xact_lock(hashtextextended('agent-commission:'||v_gate::text,0));
    PERFORM set_config('lock_timeout',v_lock_timeout,true);
   EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
    EXIT;
   END;
  END IF;
  v_held:=v_held||v_gate;
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
    ('fn_retry_cash_accounting_sources(integer)', '3788581d5e8f1953663b8929b4688d0a', 'e9b28c51e08c1754a475658f9720db40',
$retry$CREATE OR REPLACE FUNCTION public.fn_retry_cash_accounting_sources(p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '300s'
AS $function$
DECLARE r jsonb;receipts jsonb:='[]';v_ok int:=0;v_blocked int:=0;v_failed int:=0;first_error text;v_parked bigint:=0;v_gate uuid;
 v_due uuid[];v_id uuid;v_clubs uuid[];v_need uuid[];v_held uuid[]:='{}';v_deferred jsonb:='[]';v_lock_timeout text;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'cash_source_not_authorised' USING ERRCODE='42501'; END IF;
 IF p_limit IS NULL OR p_limit<1 OR p_limit>200 THEN RAISE EXCEPTION 'invalid_cash_retry_limit' USING ERRCODE='22023'; END IF;
 -- EVERY COMMISSION KEY IN CLUB ORDER BEFORE THE FIRST SOURCE (2026-10-19), as
 -- fn_credit_agent_commissions_batch takes them: this retry is one transaction
 -- over many sources too. The due sources are chosen once; the keys of every
 -- club they are attributed in are taken in club order, a busy one waited for
 -- at most 1 s while holding only lower keys; a key not granted ends the walk.
 -- A source whose clubs are not all held is not run: its blocked work row is
 -- left exactly as it is (no receipt, no attempt), it is returned in
 -- 'deferred', and it is the oldest due source again next cycle.
 v_due:=ARRAY(SELECT s.rake_record_id FROM public.accounting_cash_source_work s
  WHERE s.status='blocked' AND s.next_attempt_at<=clock_timestamp()
  ORDER BY s.next_attempt_at,s.rake_record_id LIMIT p_limit);
 v_need:=ARRAY(SELECT DISTINCT a.club_id FROM public.rake_attributions a
  WHERE a.rake_record_id=ANY(v_due) AND a.club_id IS NOT NULL ORDER BY a.club_id);
 FOREACH v_gate IN ARRAY v_need LOOP
  IF NOT pg_try_advisory_xact_lock(hashtextextended('agent-commission:'||v_gate::text,0)) THEN
   BEGIN
    v_lock_timeout:=current_setting('lock_timeout');
    PERFORM set_config('lock_timeout','1s',true);
    PERFORM pg_advisory_xact_lock(hashtextextended('agent-commission:'||v_gate::text,0));
    PERFORM set_config('lock_timeout',v_lock_timeout,true);
   EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
    EXIT;
   END;
  END IF;
  v_held:=v_held||v_gate;
 END LOOP;
 -- Do not lock work rows here: all callers acquire the original hand lock
 -- first. SKIP LOCKED on work would invert that order against direct callers.
 FOREACH v_id IN ARRAY v_due LOOP
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
    IF position('EXIT WHEN NOT pg_try_advisory_xact_lock' IN v_after) > 0
       OR position('IF NOT v_clubs<@v_held THEN' IN v_after) = 0
       OR position('''deferred'',v_deferred' IN v_after) = 0 THEN
      RAISE EXCEPTION '%: an item can still take a commission key out of club order', s.signature;
    END IF;
  END LOOP;
  RAISE NOTICE 'commission keys are taken in club order: two bodies changed';
END $subs$;

DO $refresh$
DECLARE
  v_sig regprocedure := 'public.fn_union_rake_basis_refresh(uuid,timestamptz,timestamptz)'::regprocedure;
  v_def text; v_meta text; v_anchor text; v_new text;
BEGIN
  v_def := pg_get_functiondef(v_sig);
  IF md5(v_def) <> 'c88e99cda4f091c9e48b0f6b173651a4' THEN
    RAISE EXCEPTION 'fn_union_rake_basis_refresh is not the pinned text (md5 %)', md5(v_def);
  END IF;
  SELECT concat_ws('|', pg_get_userbyid(p.proowner), p.proacl::text, p.proconfig::text, p.provolatile, p.prosecdef)
    INTO v_meta FROM pg_proc p WHERE p.oid = v_sig;
  -- 1. the variable
  v_anchor := E'  v_accrued timestamptz; v_stamp jsonb; v_prev jsonb; v_win jsonb;\n';
  IF (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 THEN
    RAISE EXCEPTION 'refresh declare anchor count';
  END IF;
  v_new := replace(v_def, v_anchor,
    E'  v_accrued timestamptz; v_stamp jsonb; v_prev jsonb; v_win jsonb; v_unaccrued timestamptz;\n');
  -- 2. the horizon
  v_anchor := E'  v_through := LEAST(p_end, now(), v_accrued);\n';
  IF (length(v_new) - length(replace(v_new, v_anchor, ''))) / length(v_anchor) <> 1 THEN
    RAISE EXCEPTION 'refresh horizon anchor count';
  END IF;
  v_new := replace(v_new, v_anchor, v_anchor
    || E'  -- A REFUSED SOURCE BELOW THE CURSOR IS NOT ACCRUED (2026-10-19). The settler\n'
    || E'  -- moves its cursor past a source whose accrual was refused (a durable\n'
    || E'  -- \'blocked\' receipt the retry queue owns), so the cursor alone does not\n'
    || E'  -- prove what lies below it. Stop before the first of this union\'s bank\n'
    || E'  -- receipts in the window whose source work is still blocked; the horizon\n'
    || E'  -- moves on by itself when the retry accrues it.\n'
    || E'  SELECT min(c.banked_at) INTO v_unaccrued\n'
    || E'    FROM public.accounting_cash_source_work w\n'
    || E'    JOIN public.accounting_cash_bank_receipts c ON c.rake_record_id = w.rake_record_id\n'
    || E'   WHERE w.status = \'blocked\' AND c.union_id = p_union_id\n'
    || E'     AND c.banked_at >= p_start AND c.banked_at < v_through;\n'
    || E'  v_through := LEAST(v_through, v_unaccrued);\n');
  -- 3. the outcome names it when it is what holds the window
  v_anchor := E'    RETURN jsonb_build_object(\'success\', false, \'error\', \'accrual_not_yet_in_window\',\n'
           || E'                              \'accrued_through\', v_accrued);\n';
  IF (length(v_new) - length(replace(v_new, v_anchor, ''))) / length(v_anchor) <> 1 THEN
    RAISE EXCEPTION 'refresh outcome anchor count';
  END IF;
  v_new := replace(v_new, v_anchor,
              E'    RETURN jsonb_build_object(\'success\', false, \'error\', \'accrual_not_yet_in_window\',\n'
           || E'                              \'accrued_through\', v_accrued, \'unaccrued_from\', v_unaccrued);\n');
  -- 4. and so does a written snapshot
  v_anchor := E'                            \'accrued_through\', v_accrued,\n'
           || E'                            \'compute_ms\', (extract(epoch from clock_timestamp() - v_t0) * 1000)::int);\n';
  IF (length(v_new) - length(replace(v_new, v_anchor, ''))) / length(v_anchor) <> 1 THEN
    RAISE EXCEPTION 'refresh result anchor count';
  END IF;
  v_new := replace(v_new, v_anchor,
              E'                            \'accrued_through\', v_accrued, \'unaccrued_from\', v_unaccrued,\n'
           || E'                            \'compute_ms\', (extract(epoch from clock_timestamp() - v_t0) * 1000)::int);\n');
  EXECUTE v_new;
  IF pg_get_functiondef(v_sig) <> v_new THEN
    RAISE EXCEPTION 'refresh postimage differs from the substituted text';
  END IF;
  IF md5(v_new) <> '9fdc0af3d23759ab843ce122ecaefb03' THEN
    RAISE EXCEPTION 'refresh is not the text the harness measured (md5 %)', md5(v_new);
  END IF;
  IF (SELECT concat_ws('|', pg_get_userbyid(p.proowner), p.proacl::text, p.proconfig::text, p.provolatile, p.prosecdef)
        FROM pg_proc p WHERE p.oid = v_sig) IS DISTINCT FROM v_meta
     OR v_meta <> 'postgres|{postgres=X/postgres,service_role=X/postgres}|{search_path=public}|v|t' THEN
    RAISE EXCEPTION 'fn_union_rake_basis_refresh: owner, grants or settings moved (%)', v_meta;
  END IF;
END $refresh$;

COMMIT;
