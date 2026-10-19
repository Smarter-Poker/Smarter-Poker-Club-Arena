-- 20261019214727_a_cash_source_call_fits_the_engines_patience
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-19 21:47:27 UTC.
-- It replaces 20261019190103 (same slug), merged in #7485 but never installed:
-- its preimage guard refused it at 21:44 UTC (apply run 39329770170, nothing
-- committed) because 20261019194410 had replaced fn_credit_agent_commissions_batch
-- in the meantime (installed 2026-10-19, md5 9befae96). The never-installed
-- 20261019190103 file is removed. Owner approval: Dan approved installing
-- #7485's database change; this migration is that change, rebuilt on the
-- installed batch.
--
-- WHAT WAS WRONG (read-only on production, 2026-10-19 17:02-17:30 UTC)
--
-- The engine's rakeback settler gives every database call 15 s
-- (DB_TIMEOUT_MS) and then abandons it; the database finishes the call anyway,
-- but the settler halts its page. At 17:02 one fn_credit_agent_commissions_batch
-- call of five cash sources ran 16.1 s: items 2 and 3 each waited the engine
-- role's whole 8 s lock_timeout on a profiles row (the agents foreign-key check
-- in fn_post_accounting_commission_source) held by one transaction that also
-- held a union_wallets row from ~17:02:20 to 17:03:05 and stalled 141 raked
-- hands. Nothing bounded the call as a whole, so any two items behind one long
-- holder exceed the engine's budget. The settler cursor then sat at 16:23:59
-- until 17:29:59.
--
-- WHAT CHANGES (fn_credit_agent_commissions_batch, fn_retry_cash_accounting_sources)
--
-- * Each item waits at most 2 s for any lock (never longer than the session's
--   own lock_timeout). A blocked item is refused durably exactly as before -
--   a 'blocked' receipt and its retry work - only after 2 s instead of 8 s.
-- * The call starts no item after 8 s from its start, and no item's lock wait
--   reaches past that point. An item not started is deferred exactly like one
--   whose commission or player keys are not held (no receipt, no attempt); the
--   engine resubmits a deferred page item before its cursor may pass it, and a
--   deferred retry stays first in its queue. 8 s is inside 0.6 x the engine's
--   15 s (BATCH_BUDGET_FRACTION), so a call always returns inside its patience.
-- * The session's lock_timeout is restored before the call returns.
--
-- KEPT EXACTLY: 20261019194410's player-stats key walk in the batch (every
-- 'player-stats-user:<player>' key in player order after the club keys, the
-- shared 1 s budget, a busy key skipped, its items deferred), and
-- 20261019171753's club key walk and retry window. 20261019194410 did not touch
-- fn_retry_cash_accounting_sources (its header: "NOT CHANGED"). What an item
-- credits, its receipts, refusals and idempotency, the response shape, owner,
-- grants and settings are unchanged. No sweep or repair (CLAUDE.md 10.12).
--
-- EITHER ORDER. The batch accepts either installed text and lands on the body
-- built on it:
--   20261019194410 postimage 9befae963f3b9cda25b357f60a9b53d7 -> 1c9d9ff9cfb2803f05223c703f61f09b (194410's walk + this budget)
--   20261019171753 postimage 1ae9eb0e32f8169ce0cdd6b730c859a6 -> 6c9a388585158521f0ac36300d5124fd (this budget alone; 194410's
--     projection half is not there to pair with its batch half)
-- Any other text is refused. The retry accepts 20261019171753's postimage only.
--
-- DEPLOY ORDER: after 20261019194410 (installed). Independent of the engine
-- change of #7485 (the settler's backoff, resubmission and retry drain), which
-- already accepts these responses; either may ship first.
--
-- QUALIFIED NATIVELY: scripts/qualification/chip-deadlocks.py runs this
-- migration's $subs$ block (stage 'budgeted', after 20261019194410's batch is
-- installed in stage 'keyed') over the production bodies, with every earlier
-- stage, the held-rows cases and the retry backlog drain; and
-- scripts/qualification/replay-locks-and-player-stats-keys.py (20261019194410's
-- own harness) runs its interleavings again with this file applied after it.
--
-- PINNED md5(pg_get_functiondef(oid)) BEFORE -> AFTER, read live 2026-10-19 21:46 UTC
-- (prosrc md5: batch c99362ad1b5164e9b455f27c213e156d, retry 35e2337d10fc7051a1feefd046425707):
--   fn_credit_agent_commissions_batch  9befae963f3b9cda25b357f60a9b53d7 -> 1c9d9ff9cfb2803f05223c703f61f09b
--                                      1ae9eb0e32f8169ce0cdd6b730c859a6 -> 6c9a388585158521f0ac36300d5124fd
--   fn_retry_cash_accounting_sources   779590b67fc21e95504a9827f1289207 -> df10ba64229df0c99918dad77f39aec7
--
-- @live-proof: (SELECT md5(pg_get_functiondef(p.oid)) = '1c9d9ff9cfb2803f05223c703f61f09b' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_credit_agent_commissions_batch')
-- @live-proof: (SELECT md5(pg_get_functiondef(p.oid)) = 'df10ba64229df0c99918dad77f39aec7' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_retry_cash_accounting_sources')

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $subs$
DECLARE
  s record; v_sig regprocedure; v_meta text; v_after text; v_sigs text[]; v_one text; v_subs jsonb;
BEGIN
  SELECT jsonb_agg(jsonb_build_object('signature', v.signature, 'before_md5', v.before_md5,
                                      'after_md5', v.after_md5, 'new_def', v.new_def))
    INTO v_subs
    FROM (VALUES
    ('fn_credit_agent_commissions_batch(jsonb)', '9befae963f3b9cda25b357f60a9b53d7', '1c9d9ff9cfb2803f05223c703f61f09b',
$batch$CREATE OR REPLACE FUNCTION public.fn_credit_agent_commissions_batch(p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '300s'
AS $function$
DECLARE it jsonb;r jsonb;receipts jsonb:='[]';record_id uuid;v_ok int:=0;v_failed int:=0;v_blocked int:=0;first_error text;v_gate uuid;
 v_n bigint;v_clubs uuid[];v_sets jsonb:='[]';v_need uuid[]:='{}';v_held uuid[]:='{}';v_deferred jsonb:='[]';v_lock_timeout text;v_wait_until timestamptz;
 v_users uuid[];v_usets jsonb:='[]';v_need_users uuid[]:='{}';v_held_users uuid[]:='{}';v_user uuid;
 v_call_deadline timestamptz;v_item_lock_ms bigint;v_session_lock_timeout text;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'cash_source_not_authorised' USING ERRCODE='42501'; END IF;
 IF p_items IS NULL OR jsonb_typeof(p_items)<>'array' OR jsonb_array_length(p_items)>2000 THEN
  RETURN jsonb_build_object('ok',0,'failed',0,'error','p_items must be a jsonb array of at most 2000 items'); END IF;
 -- THE CALL FITS THE ENGINE'S PATIENCE (2026-10-19, 20261019214727). The engine
 -- gives a call 15 s and then abandons it (the database finishes it anyway and
 -- the page halts). Inside an item every lock wait used the session's 8 s
 -- lock_timeout, so two items behind one long-held row - 2026-10-19 17:02, a
 -- union_wallets/profiles holder of ~45 s after the break - made a 16.1 s call.
 -- Each item now waits at most 2 s for a lock (never longer than the session
 -- allows) and the call starts no item after 8 s; such an item is deferred
 -- exactly like one whose keys are not held. A blocked item is still refused
 -- durably (its retry work is unchanged), only sooner.
 v_session_lock_timeout:=current_setting('lock_timeout');
 v_item_lock_ms:=CASE WHEN extract(epoch FROM v_session_lock_timeout::interval)>0
  THEN LEAST(2000,ceil(extract(epoch FROM v_session_lock_timeout::interval)*1000)::bigint) ELSE 2000 END;
 v_call_deadline:=clock_timestamp()+interval '8 seconds';
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
  -- The players whose player_stats rows (and, through
  -- trg_sync_profile_total_hands, profile rows) the item writes: the
  -- contributors of its rake, as fn_accounting_cash_commission_plan reads them.
  v_users:=ARRAY(SELECT DISTINCT a.player_id FROM public.rake_attributions a
    WHERE a.player_id IS NOT NULL AND a.rake_record_id=CASE WHEN it->>'source_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN CASE it->>'source_type' WHEN 'cash_rake_record' THEN (it->>'source_id')::uuid
       WHEN 'rake_settlement' THEN (SELECT h.id FROM public.rake_records h WHERE h.hand_id=(it->>'source_id')::uuid ORDER BY h.id LIMIT 1)
      END END ORDER BY a.player_id);
  v_usets:=v_usets||jsonb_build_array(to_jsonb(v_users));
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
 -- EVERY PLAYER KEY IN PLAYER ORDER, AFTER THE CLUB KEYS AND BEFORE THE FIRST
 -- ITEM (2026-10-19, 20261019194410). Each item writes its contributors'
 -- player_stats rows (apply_rakeback_player_stats) and, through
 -- trg_sync_profile_total_hands, their profile rows, and this transaction keeps
 -- them to its end. Item by item that is page order: the hand of player b, then
 -- the hand of player a. The hand projection
 -- (fn_project_hand_side_effects_after_post_commit_20260908) writes the same rows
 -- for a hand's players in player order, a then b, so each held one and asked
 -- for the other: 79 of the 95 deadlocks in the six hours to 11:00 UTC on
 -- 2026-10-19. Both now take 'player-stats-user:<player>' for every player whose
 -- rows they write, in player order, before the first such row; a row is only
 -- ever written under its player's key, so neither can hold a row the other is
 -- waiting for. Only the items whose club keys are all held need theirs. The
 -- walk is the club walk's: a busy key is waited for only while the same 1 s
 -- budget lasts, holding only lower player keys (a projection holding a key
 -- waits for no lower one), and a key not granted is skipped; an item whose
 -- players are not all held is deferred exactly as for a club key.
 FOR v_n IN 1..jsonb_array_length(p_items) LOOP
  IF ARRAY(SELECT g::uuid FROM jsonb_array_elements_text(v_sets->(v_n::int-1)) g)<@v_held THEN
   v_need_users:=v_need_users||ARRAY(SELECT g::uuid FROM jsonb_array_elements_text(v_usets->(v_n::int-1)) g);
  END IF;
 END LOOP;
 v_need_users:=ARRAY(SELECT DISTINCT g FROM unnest(v_need_users) g ORDER BY g);
 FOREACH v_user IN ARRAY v_need_users LOOP
  IF pg_try_advisory_xact_lock(hashtextextended('player-stats-user:'||v_user::text,0)) THEN
   v_held_users:=v_held_users||v_user;
  ELSIF clock_timestamp()<v_wait_until THEN
   BEGIN
    v_lock_timeout:=current_setting('lock_timeout');
    PERFORM set_config('lock_timeout',
     GREATEST(1,ceil(extract(epoch FROM v_wait_until-clock_timestamp())*1000))::bigint::text||'ms',true);
    PERFORM pg_advisory_xact_lock(hashtextextended('player-stats-user:'||v_user::text,0));
    PERFORM set_config('lock_timeout',v_lock_timeout,true);
    v_held_users:=v_held_users||v_user;
   EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
    NULL;
   END;
  END IF;
 END LOOP;
 FOR it,v_n IN SELECT value,ordinality FROM jsonb_array_elements(p_items) WITH ORDINALITY LOOP
  v_clubs:=ARRAY(SELECT g::uuid FROM jsonb_array_elements_text(v_sets->(v_n::int-1)) g);
  v_users:=ARRAY(SELECT g::uuid FROM jsonb_array_elements_text(v_usets->(v_n::int-1)) g);
  IF NOT v_clubs<@v_held OR NOT v_users<@v_held_users THEN
   v_deferred:=v_deferred||jsonb_build_array(it->'source_id');
   CONTINUE;
  END IF;
  IF clock_timestamp()>=v_call_deadline THEN
   v_deferred:=v_deferred||jsonb_build_array(it->'source_id');
   CONTINUE;
  END IF;
  PERFORM set_config('lock_timeout',LEAST(v_item_lock_ms,
   GREATEST(1,ceil(extract(epoch FROM v_call_deadline-clock_timestamp())*1000)::bigint))::text||'ms',true);
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
 PERFORM set_config('lock_timeout',v_session_lock_timeout,true);
 RETURN jsonb_build_object('receipt_version',3,'ok',v_ok,'failed',v_failed,'blocked',v_blocked,'first_error',first_error,'receipts',receipts,
  'deferred',v_deferred);
END $function$
$batch$),
    ('fn_credit_agent_commissions_batch(jsonb)', '1ae9eb0e32f8169ce0cdd6b730c859a6', '6c9a388585158521f0ac36300d5124fd',
$batchonly$CREATE OR REPLACE FUNCTION public.fn_credit_agent_commissions_batch(p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '300s'
AS $function$
DECLARE it jsonb;r jsonb;receipts jsonb:='[]';record_id uuid;v_ok int:=0;v_failed int:=0;v_blocked int:=0;first_error text;v_gate uuid;
 v_n bigint;v_clubs uuid[];v_sets jsonb:='[]';v_need uuid[]:='{}';v_held uuid[]:='{}';v_deferred jsonb:='[]';v_lock_timeout text;v_wait_until timestamptz;
 v_call_deadline timestamptz;v_item_lock_ms bigint;v_session_lock_timeout text;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'cash_source_not_authorised' USING ERRCODE='42501'; END IF;
 IF p_items IS NULL OR jsonb_typeof(p_items)<>'array' OR jsonb_array_length(p_items)>2000 THEN
  RETURN jsonb_build_object('ok',0,'failed',0,'error','p_items must be a jsonb array of at most 2000 items'); END IF;
 -- THE CALL FITS THE ENGINE'S PATIENCE (2026-10-19, 20261019214727). The engine
 -- gives a call 15 s and then abandons it (the database finishes it anyway and
 -- the page halts). Inside an item every lock wait used the session's 8 s
 -- lock_timeout, so two items behind one long-held row - 2026-10-19 17:02, a
 -- union_wallets/profiles holder of ~45 s after the break - made a 16.1 s call.
 -- Each item now waits at most 2 s for a lock (never longer than the session
 -- allows) and the call starts no item after 8 s; such an item is deferred
 -- exactly like one whose keys are not held. A blocked item is still refused
 -- durably (its retry work is unchanged), only sooner.
 v_session_lock_timeout:=current_setting('lock_timeout');
 v_item_lock_ms:=CASE WHEN extract(epoch FROM v_session_lock_timeout::interval)>0
  THEN LEAST(2000,ceil(extract(epoch FROM v_session_lock_timeout::interval)*1000)::bigint) ELSE 2000 END;
 v_call_deadline:=clock_timestamp()+interval '8 seconds';
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
  IF clock_timestamp()>=v_call_deadline THEN
   v_deferred:=v_deferred||jsonb_build_array(it->'source_id');
   CONTINUE;
  END IF;
  PERFORM set_config('lock_timeout',LEAST(v_item_lock_ms,
   GREATEST(1,ceil(extract(epoch FROM v_call_deadline-clock_timestamp())*1000)::bigint))::text||'ms',true);
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
 PERFORM set_config('lock_timeout',v_session_lock_timeout,true);
 RETURN jsonb_build_object('receipt_version',3,'ok',v_ok,'failed',v_failed,'blocked',v_blocked,'first_error',first_error,'receipts',receipts,
  'deferred',v_deferred);
END $function$
$batchonly$),
    ('fn_retry_cash_accounting_sources(integer)', '779590b67fc21e95504a9827f1289207', 'df10ba64229df0c99918dad77f39aec7',
$retry$CREATE OR REPLACE FUNCTION public.fn_retry_cash_accounting_sources(p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '300s'
AS $function$
DECLARE r jsonb;receipts jsonb:='[]';v_ok int:=0;v_blocked int:=0;v_failed int:=0;first_error text;v_parked bigint:=0;v_gate uuid;
 v_due uuid[];v_id uuid;v_clubs uuid[];v_need uuid[];v_held uuid[]:='{}';v_deferred jsonb:='[]';v_lock_timeout text;v_wait_until timestamptz;
 v_call_deadline timestamptz;v_item_lock_ms bigint;v_session_lock_timeout text;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'cash_source_not_authorised' USING ERRCODE='42501'; END IF;
 IF p_limit IS NULL OR p_limit<1 OR p_limit>200 THEN RAISE EXCEPTION 'invalid_cash_retry_limit' USING ERRCODE='22023'; END IF;
 -- THE CALL FITS THE ENGINE'S PATIENCE (2026-10-19, 20261019214727). The engine
 -- gives a call 15 s and then abandons it (the database finishes it anyway and
 -- the page halts). Inside an item every lock wait used the session's 8 s
 -- lock_timeout, so two items behind one long-held row - 2026-10-19 17:02, a
 -- union_wallets/profiles holder of ~45 s after the break - made a 16.1 s call.
 -- Each item now waits at most 2 s for a lock (never longer than the session
 -- allows) and the call starts no item after 8 s; such an item is deferred
 -- exactly like one whose keys are not held. A blocked item is still refused
 -- durably (its retry work is unchanged), only sooner.
 v_session_lock_timeout:=current_setting('lock_timeout');
 v_item_lock_ms:=CASE WHEN extract(epoch FROM v_session_lock_timeout::interval)>0
  THEN LEAST(2000,ceil(extract(epoch FROM v_session_lock_timeout::interval)*1000)::bigint) ELSE 2000 END;
 v_call_deadline:=clock_timestamp()+interval '8 seconds';
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
  IF clock_timestamp()>=v_call_deadline THEN
   v_deferred:=v_deferred||jsonb_build_array(v_id::text);
   CONTINUE;
  END IF;
  PERFORM set_config('lock_timeout',LEAST(v_item_lock_ms,
   GREATEST(1,ceil(extract(epoch FROM v_call_deadline-clock_timestamp())*1000)::bigint))::text||'ms',true);
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
 PERFORM set_config('lock_timeout',v_session_lock_timeout,true);
 SELECT count(*) INTO v_parked FROM public.accounting_cash_source_work
  WHERE status='blocked' AND next_attempt_at='infinity'::timestamptz;
 RETURN jsonb_build_object('receipt_version',3,'ok',v_ok,'blocked',v_blocked,'failed',v_failed+v_blocked,'terminal_parked',v_parked,
  'first_error',first_error,'receipts',receipts,'deferred',v_deferred);
END $function$
$retry$)
    ) AS v(signature, before_md5, after_md5, new_def);
  -- Exactly one accepted preimage per function must be the installed text.
  v_sigs := ARRAY(SELECT DISTINCT x.signature FROM jsonb_to_recordset(v_subs) AS x(signature text) ORDER BY 1);
  FOREACH v_one IN ARRAY v_sigs LOOP
    v_sig := ('public.' || v_one)::regprocedure;
    IF (SELECT count(*) FROM jsonb_to_recordset(v_subs) AS x(signature text, before_md5 text)
         WHERE x.signature = v_one AND x.before_md5 = md5(pg_get_functiondef(v_sig))) <> 1 THEN
      RAISE EXCEPTION '% is not a pinned text (md5 %)', v_one, md5(pg_get_functiondef(v_sig));
    END IF;
  END LOOP;
  FOR s IN SELECT x.* FROM jsonb_to_recordset(v_subs) AS x(signature text, before_md5 text, after_md5 text, new_def text)
            WHERE x.before_md5 = md5(pg_get_functiondef(('public.' || x.signature)::regprocedure))
            ORDER BY x.signature
  LOOP
    v_sig := ('public.' || s.signature)::regprocedure;
    SELECT concat_ws('|', pg_get_userbyid(p.proowner), p.proacl::text, p.proconfig::text, p.provolatile, p.prosecdef)
      INTO v_meta FROM pg_proc p WHERE p.oid = v_sig;
    EXECUTE s.new_def;
    v_after := pg_get_functiondef(v_sig);
    IF v_after <> s.new_def OR md5(v_after) <> s.after_md5 THEN
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
    IF position('v_call_deadline:=clock_timestamp()+interval ''8 seconds'';' IN v_after) = 0
       OR position('IF clock_timestamp()>=v_call_deadline THEN' IN v_after) = 0
       OR position('PERFORM set_config(''lock_timeout'',v_session_lock_timeout,true);' IN v_after) = 0 THEN
      RAISE EXCEPTION '%: a call can still outlast the engine''s budget', s.signature;
    END IF;
    IF s.before_md5 = '9befae963f3b9cda25b357f60a9b53d7'
       AND position('IF NOT v_clubs<@v_held OR NOT v_users<@v_held_users THEN' IN v_after) = 0 THEN
      RAISE EXCEPTION '%: 20261019194410''s player key walk was lost', s.signature;
    END IF;
  END LOOP;
  RAISE NOTICE 'a cash source call fits the engine''s patience: two bodies changed';
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
