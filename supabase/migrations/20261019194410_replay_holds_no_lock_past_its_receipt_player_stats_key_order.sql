-- 20261019194410_replay_holds_no_lock_past_its_receipt_player_stats_key_order
--
-- Version reserved by scripts/new-migration.mjs on 2026-10-19 19:44 UTC. It replaces
-- 20261019155432 (same slug), merged but never installed: its preimage guard
-- refused it at 19:38 UTC because 20261019171753 had replaced the batch, and
-- this version orders after that one.
-- Owner approval 2026-10-19 10:35 Chicago: "fix the nightly 04:37 replay table
-- freeze and the player_stats deadlocks, through merged migrations installed by
-- the normal applier."
--
-- WHAT WAS WRONG (read-only on production, 2026-10-19)
--
-- A. The nightly receipt replay froze running tournaments for ~105 s.
--    pg_cron ca-terminal-receipt-replay-daily ("37 4 * * *") runs
--    fn_ca_replay_terminal_receipts(26, 4000) as ONE transaction. Each
--    receipt runs in a BEGIN/EXCEPTION subtransaction, and a subtransaction
--    that SUCCEEDS hands every lock it took to the outer transaction until the
--    whole run commits. A satellite receipt (fn_ca_satellite_cohort_receipt /
--    fn_ca_satellite_settlement_receipt) is a reader that takes a live
--    settlement's locks: the finish lane F ('ca:tournament-finish-lane:v1')
--    exclusively and both tournaments' T keys through
--    fn_ca_lock_settlement_lane_for_satellite_finish, the satellite and its
--    TARGET tournaments row FOR UPDATE, and every tournament_players row of
--    both FOR SHARE. So the first proved satellite kept its running target
--    tournament, its seats and the platform's finish lane locked for the rest
--    of the run: 04:37:00.7-04:38:46.1 UTC on 10-19, engine settlements
--    blocked on 0->26 tables (37 on 10-18), the oldest ~108 s, one hand per
--    table written ~95 s late.
--
-- B. player_stats deadlocks, 13-23 an hour since 05:00 UTC on 10-19
--    (DatabaseDeadlocksElevated); 79 of 95 in six hours are
--    fn_project_hand_side_effects (victim, "while inserting index tuple ... in
--    relation player_stats", Projection 2) against
--    fn_credit_agent_commissions_batch. The batch is one transaction over
--    several cash hands; item by item, fn_process_cash_accounting_source ->
--    apply_rakeback_player_stats upserts each contributor's player_stats row
--    and, through trg_sync_profile_total_hands, updates the profile row, and
--    keeps both to the end. So it takes them in PAGE order (the hand of player
--    b, then the hand of player a), while the projection of a hand writes the
--    same players' rows in player order (a, then b). Each held one and asked
--    for the other. Row locks alone cannot be ordered: a row the batch has not
--    yet created cannot be locked ahead, and the profile row is shared by a
--    player's rows in every club.
--
-- WHAT CHANGES (three function bodies; nothing else)
--
-- A. fn_ca_replay_terminal_receipts: a proved receipt ends by raising a
--    private sentinel (SQLSTATE CAR01) that its own inner block catches, so
--    that subtransaction is ROLLED BACK and releases every lock the receipt
--    took (rows, advisory lane keys, its transaction-local lane setting)
--    before the next receipt starts. The receipts write nothing (checked:
--    neither body nor any callee has an INSERT/UPDATE/DELETE), so rolling
--    them back undoes nothing else. The outcome is exactly the old one:
--    proved -> 'replayed', 55P03/57014 -> 'skipped_locked', anything else ->
--    'refused' with the same failure entry, the same alert raised and the
--    same alert resolved; a CAR01 the receipt itself raised is re-raised and
--    refused, never counted as proved. Each receipt now holds its locks only
--    while it runs (milliseconds), as the same receipt read by a browser does.
--    Owner, grants, SECURITY DEFINER, search_path, statement_timeout 600s and
--    lock_timeout 2s are asserted unchanged; the cron job is not touched.
--
-- B. fn_credit_agent_commissions_batch and
--    fn_project_hand_side_effects_after_post_commit_20260908 both take an
--    advisory key 'player-stats-user:<player>' for every player whose
--    player_stats (and profile) rows they will write, in player uuid order,
--    before the first such row. A row is then only ever written by these two
--    under its player's key, so neither can hold a row the other waits for.
--    The batch takes them after its club commission keys (20261019094914,
--    20261019171753) and before the first item, only for items whose club keys
--    are all held, with the club walk's discipline: a free key at once, a busy
--    one waited for only while the same 1 s budget lasts, holding only lower
--    player keys, a key not granted skipped, and an item whose players are not
--    all held deferred (writes nothing, is returned in 'deferred', and the
--    settler resubmits it before its cursor may pass it), exactly as for a
--    busy club key. Built on the installed 20261019171753 text.
--    The projection takes them
--    at the start of Projection 2 (cash only), where it used to start taking
--    the rows; it waits for a key at most as long as it used to wait for the
--    row. Batches are about five hands (cashAccountingBatchBudget.ts), so a
--    batch holds tens of keys at most. Unchanged: every value written, the
--    item order, receipts, refusals, idempotency, receipt_version 3, owner,
--    grants and settings.
--
-- NOT CHANGED: fn_retry_cash_accounting_sources, fn_process_cash_accounting_source,
-- the settler and the weekly close (another task owns them); no repair, sweep
-- or backfill (CLAUDE.md 10.12).
--
-- QUALIFIED NATIVELY: scripts/qualification/replay-locks-and-player-stats-keys.py
-- builds a private PostgreSQL 17 cluster, loads production's
-- bodies of every measured door (md5-pinned in replay-locks-and-player-stats-keys.manifest.json), runs the
-- 10-19 interleavings BEFORE, executes this migration file, and
-- runs them AFTER: the engine's hand and an unrelated finish wait for the
-- paused replay before and not after, with the same replay outcome; the batch
-- and the projection deadlock before (existing rows, new rows, profile rows
-- across clubs) and never after, with every value written once.
-- Evidence: docs/evidence/replay-locks-and-player-stats-keys-2026-10-19/.
--
-- PINNED LIVE md5(pg_get_functiondef(oid)), read 2026-10-19, and AFTER:
--   fn_ca_replay_terminal_receipts                            1d5d067c97c46776fb6c1fc5e02f0b7c -> 3370c9e5aa0f5f551f011f9fd0023786
--   fn_credit_agent_commissions_batch                         1ae9eb0e32f8169ce0cdd6b730c859a6 -> 9befae963f3b9cda25b357f60a9b53d7
--   fn_project_hand_side_effects_after_post_commit_20260908   ef3cb3725ca3a1566e0e1254830a9a63 -> cee6c2257fcc49c6c6974e5fe8832107
--
-- @live-proof: (SELECT md5(pg_get_functiondef(p.oid)) = '3370c9e5aa0f5f551f011f9fd0023786' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_ca_replay_terminal_receipts')
-- @live-proof: (SELECT md5(pg_get_functiondef(p.oid)) = '9befae963f3b9cda25b357f60a9b53d7' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_credit_agent_commissions_batch')
-- @live-proof: (SELECT md5(pg_get_functiondef(p.oid)) = 'cee6c2257fcc49c6c6974e5fe8832107' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_project_hand_side_effects_after_post_commit_20260908')

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $subs$
DECLARE
  s record; v_sig regprocedure; v_meta text; v_after text;
BEGIN
  FOR s IN SELECT * FROM (VALUES
    ('fn_ca_replay_terminal_receipts(integer,integer)', '1d5d067c97c46776fb6c1fc5e02f0b7c', '3370c9e5aa0f5f551f011f9fd0023786',
     'postgres|{postgres=X/postgres,service_role=X/postgres}|{search_path=public,statement_timeout=600s,lock_timeout=2s}|v|t',
$replay$CREATE OR REPLACE FUNCTION public.fn_ca_replay_terminal_receipts(p_hours integer DEFAULT 24, p_limit integer DEFAULT 4000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '600s'
 SET lock_timeout TO '2s'
AS $function$
DECLARE
  t record; v jsonb; v_proved boolean;
  v_ok int := 0; v_refused int := 0; v_locked int := 0; v_raised int := 0; v_resolved int := 0;
  v_fail jsonb := '[]'::jsonb;
BEGIN
  FOR t IN
    SELECT tr.id, upper(coalesce(tr.tournament_type,'')) ttype, lower(coalesce(tr.variant,'')) variant,
           (SELECT tp.user_id FROM public.tournament_players tp WHERE tp.tournament_id=tr.id AND tp.status::text='winner' ORDER BY tp.position LIMIT 1) winner,
           (SELECT s.qualifier_ids FROM public.tournament_satellite_settlements s WHERE s.tournament_id=tr.id) qids,
           EXISTS (SELECT 1 FROM public.tournament_satellite_settlements s WHERE s.tournament_id=tr.id) sat_hdr
      FROM public.tournaments tr
     WHERE tr.status='COMPLETED'
       AND tr.ended_at > now() - make_interval(hours => GREATEST(COALESCE(p_hours,24),1))
       AND upper(coalesce(tr.tournament_type,'')) IN ('MTT','SPIN','SNG','SATELLITE')
     ORDER BY CASE WHEN upper(coalesce(tr.tournament_type,''))='SATELLITE' OR lower(coalesce(tr.variant,''))='satellite' THEN 0
                   WHEN upper(coalesce(tr.tournament_type,''))='MTT' THEN 1 ELSE 2 END,
              tr.ended_at DESC
     LIMIT GREATEST(COALESCE(p_limit,4000),1)
  LOOP
    BEGIN
      -- A REPLAYED RECEIPT KEEPS NONE OF ITS LOCKS (2026-10-19). Every receipt
      -- is a reader: it writes nothing, and takes the locks a live settlement
      -- would (a satellite's: the finish lane F exclusively, both tournaments'
      -- T keys, the target's tournaments and tournament_players rows). This
      -- whole run is ONE transaction, and a subtransaction that succeeds hands
      -- its locks to the transaction until the run commits, so each proved
      -- satellite kept a running target tournament and its seats locked for
      -- the rest of the run: engine hands on those tables waited up to 108 s
      -- (04:37 UTC, 2026-10-18 and 10-19). A proved receipt now ends in its
      -- own rolled-back subtransaction, which releases every lock it took
      -- (rows, advisory keys and its transaction-local lane setting) before
      -- the next receipt starts. It wrote nothing, so nothing else is undone;
      -- a refusal is caught exactly as before.
      v_proved := false;
      BEGIN
        IF t.sat_hdr THEN
          IF t.qids IS NOT NULL AND cardinality(t.qids) > 0 THEN
            v := public.fn_ca_satellite_cohort_receipt(t.id, t.qids);
          ELSE
            v := public.fn_ca_satellite_settlement_receipt(t.id, t.winner);
          END IF;
        ELSIF t.ttype='SATELLITE' OR t.variant='satellite' THEN
          RAISE EXCEPTION 'satellite % completed without a settlement header', t.id USING ERRCODE='P0404';
        ELSE
          v := public.fn_ca_tournament_terminal_receipt(t.id, t.winner);
        END IF;
        v_proved := true;
        RAISE EXCEPTION 'terminal receipt % proved; its locks are released', t.id USING ERRCODE='CAR01';
      EXCEPTION WHEN SQLSTATE 'CAR01' THEN
        IF NOT v_proved THEN RAISE; END IF;
      END;
      v_ok := v_ok + 1;
    EXCEPTION
      WHEN lock_not_available OR query_canceled THEN
        v_locked := v_locked + 1;
      WHEN OTHERS THEN
        v_refused := v_refused + 1;
        IF jsonb_array_length(v_fail) < 50 THEN
          v_fail := v_fail || jsonb_build_object('tournament_id', t.id, 'type', t.ttype, 'code', SQLSTATE, 'error', left(SQLERRM, 240));
        END IF;
    END;
  END LOOP;

  -- One open alert per distinct refusal text; the incident bridge keys on it.
  INSERT INTO public.financial_alerts (severity, source, message, context)
  SELECT 'critical', 'fn_ca_replay_terminal_receipts',
         format('A terminal receipt no longer proves on replay: %s tournament(s) completed in the last %s h refuse with "%s" (sample %s). A receipt that stops proving will freeze the next event that reaches the same state, so this is fixed in the receipt before it does.',
                g.n, GREATEST(COALESCE(p_hours,24),1), g.err, g.sample),
         jsonb_build_object('checked_at', now(), 'hours', GREATEST(COALESCE(p_hours,24),1), 'refusal', g.err, 'count', g.n, 'sample_tournament_id', g.sample, 'samples', g.ids)
    FROM (SELECT regexp_replace(f->>'error', '[0-9a-f-]{36}', '<id>', 'g') err, count(*) n, min(f->>'tournament_id') sample,
                 jsonb_agg(f->>'tournament_id') ids
            FROM jsonb_array_elements(v_fail) f GROUP BY 1) g
   WHERE NOT EXISTS (SELECT 1 FROM public.financial_alerts fa
                      WHERE fa.source='fn_ca_replay_terminal_receipts' AND NOT fa.resolved
                        AND fa.context->>'refusal' = g.err);
  GET DIAGNOSTICS v_raised = ROW_COUNT;

  -- A refusal that no longer reproduces closes itself.
  UPDATE public.financial_alerts fa
     SET resolved = true, resolved_at = now(),
         resolution = format('Re-measured by fn_ca_replay_terminal_receipts at %s: %s receipt(s) of the last %s h replayed, none refuses with this text any more.', now(), v_ok, GREATEST(COALESCE(p_hours,24),1))
   WHERE fa.source='fn_ca_replay_terminal_receipts' AND NOT fa.resolved
     AND v_refused = 0 AND v_ok > 0
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_fail) f
                      WHERE regexp_replace(f->>'error', '[0-9a-f-]{36}', '<id>', 'g') = fa.context->>'refusal');
  GET DIAGNOSTICS v_resolved = ROW_COUNT;

  RETURN jsonb_build_object('ok', true, 'checked_at', now(), 'hours', GREATEST(COALESCE(p_hours,24),1),
    'replayed', v_ok, 'refused', v_refused, 'skipped_locked', v_locked, 'raised', v_raised, 'resolved', v_resolved, 'failures', v_fail);
END;
$function$
$replay$),
    ('fn_credit_agent_commissions_batch(jsonb)', '1ae9eb0e32f8169ce0cdd6b730c859a6', '9befae963f3b9cda25b357f60a9b53d7',
     'postgres|{postgres=X/postgres,service_role=X/postgres}|{search_path=public,statement_timeout=300s}|v|t',
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
    ('fn_project_hand_side_effects_after_post_commit_20260908(uuid)', 'ef3cb3725ca3a1566e0e1254830a9a63', 'cee6c2257fcc49c6c6974e5fe8832107',
     'postgres|{postgres=X/postgres}|{"search_path=public, pg_temp"}|v|t',
$projection$CREATE OR REPLACE FUNCTION public.fn_project_hand_side_effects_after_post_commit_20260908(p_hand_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_h public.hand_history%ROWTYPE;
  v_club uuid;
  v_date date;
  v_tourney boolean;
  v_bb numeric;
  v_diamond boolean;
  v_promo jsonb;
  v_uid uuid;
BEGIN
  IF NOT (current_user IN ('postgres','service_role')) THEN
    RAISE EXCEPTION 'fn_project_hand_side_effects is engine/service only';
  END IF;

  -- The durable outbox row is also the claim.  Locking it keeps the additive
  -- projections and its DELETE in one transaction: a crash rolls both back;
  -- a concurrent worker waits, then finds no row and cannot run them twice.
  SELECT h.* INTO v_h
    FROM public.hand_projection_outbox o
    JOIN public.hand_history h ON h.id=o.hand_id
   WHERE o.hand_id=p_hand_id
   FOR UPDATE OF o;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','not_pending','hand_id',p_hand_id);
  END IF;

  -- One table's club-member projection carries prior-stack state.  Serialise
  -- it and refuse to leapfrog an earlier durable hand from that table.
  PERFORM pg_advisory_xact_lock(hashtextextended('hand-projection:'||v_h.table_id::text,0));
  IF EXISTS (
    SELECT 1 FROM public.hand_projection_outbox earlier
     WHERE earlier.table_id=v_h.table_id
       AND earlier.hand_number<v_h.hand_number
  ) THEN
    RETURN jsonb_build_object('ok',false,'reason','predecessor_pending');
  END IF;

  SELECT t.club_id, (t.tournament_id IS NOT NULL), c.asset='diamonds'
    INTO v_club, v_tourney, v_diamond
    FROM public.tables t JOIN public.clubs c ON c.id=t.club_id WHERE t.id=v_h.table_id;
  v_tourney := COALESCE(v_tourney,false) OR (v_h.tournament_id IS NOT NULL);
  v_date := (v_h.created_at AT TIME ZONE 'UTC')::date;

  -- A seat's result for THIS hand is what it won minus what it put in. The
  -- accepted-hand envelope lists every contributor's chips in, written in the
  -- same transaction as the hand. No envelope list, no exact figure.
  SELECT c.post_commit_payload->'promo_playthrough' INTO v_promo
    FROM public.hand_atomic_commits c
   WHERE c.hand_id = v_h.id;
  IF jsonb_typeof(v_promo) IS DISTINCT FROM 'array' THEN
    v_promo := NULL;
  ELSIF v_promo = '[]'::jsonb THEN
    v_promo := NULL;
  END IF;

  -- Projection 1: club member/table/day state.  This is the current live
  -- trigger body, with NEW replaced by the immutable hand row selected above.
  IF v_club IS NOT NULL AND NOT COALESCE(v_diamond,false)
     AND public.fn_ca_launch_accounting_accepts(v_club,v_h.created_at) THEN
    WITH pl AS (
      SELECT DISTINCT ON (p->>'userId')
             (p->>'userId')::uuid AS uid, (p->>'stack')::numeric AS stack
        FROM jsonb_array_elements(coalesce(v_h.players,'[]'::jsonb)) p
       WHERE (p->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
         AND (p->>'stack') IS NOT NULL
    ), wn AS (
      SELECT (w->>'userId')::uuid AS uid, sum((w->>'amount')::numeric) AS won
        FROM jsonb_array_elements(coalesce(v_h.winners,'[]'::jsonb)) w
       WHERE (w->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       GROUP BY 1
    ), base AS (
      SELECT pl.uid, pl.stack, coalesce(wn.won,0) AS won, st.last_stack,
             (st.last_stack IS NOT NULL AND st.last_hand_number IS NOT NULL
              AND v_h.hand_number IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM public.hand_history h2
                 WHERE h2.table_id=v_h.table_id
                   AND h2.hand_number>st.last_hand_number
                   AND h2.hand_number<v_h.hand_number)) AS adjacent
        FROM pl
        LEFT JOIN wn ON wn.uid=pl.uid
        LEFT JOIN public.club_member_table_state st
          ON st.table_id=v_h.table_id AND st.user_id=pl.uid
    ), agg AS (
      SELECT count(*) AS seated,
             count(*) FILTER (WHERE last_stack IS NOT NULL) AS with_prior,
             coalesce(sum(stack-last_stack) FILTER (WHERE last_stack IS NOT NULL),0) AS dsum
        FROM base
    ), calc AS (
      SELECT b.uid,b.won,
             CASE WHEN b.last_stack IS NOT NULL THEN b.stack-b.last_stack ELSE 0 END AS delta,
             CASE WHEN a.seated=a.with_prior
                  THEN abs(a.dsum+coalesce(v_h.rake_amount,0)+coalesce(v_h.bbj_amount,0))<0.005
                  ELSE b.adjacent AND (b.stack-b.last_stack)<=b.won+0.001 END AS attributable,
             CASE WHEN v_promo IS NOT NULL
                  THEN b.won - COALESCE((SELECT sum((x->>'wagered')::numeric)
                                           FROM jsonb_array_elements(v_promo) x
                                          WHERE lower(x->>'user_id') = b.uid::text), 0)
             END AS exact_net
        FROM base b CROSS JOIN agg a
    )
    INSERT INTO public.club_member_daily_stats AS s
      (club_id,table_id,user_id,stat_date,hands_played,hands_attributed,hands_won,
       total_won,profit,biggest_pot_won,biggest_pot,topup_total)
    SELECT v_club,v_h.table_id,calc.uid,v_date,1,
           CASE WHEN v_tourney THEN 0 WHEN calc.exact_net IS NOT NULL OR calc.attributable THEN 1 ELSE 0 END,
           CASE WHEN calc.won>0 THEN 1 ELSE 0 END,
           CASE WHEN v_tourney THEN 0 ELSE calc.won END,
           CASE WHEN v_tourney THEN 0 WHEN calc.exact_net IS NOT NULL THEN calc.exact_net
                WHEN calc.attributable THEN calc.delta ELSE 0 END,
           CASE WHEN v_tourney THEN 0 ELSE calc.won END,
           CASE WHEN v_tourney THEN 0 ELSE coalesce(v_h.pot_size,0) END,
           CASE WHEN v_tourney THEN 0
                WHEN NOT calc.attributable AND calc.delta>calc.won THEN calc.delta-calc.won
                ELSE 0 END
      FROM calc
    ON CONFLICT (club_id,table_id,user_id,stat_date) DO UPDATE SET
      hands_played=s.hands_played+1,
      hands_attributed=s.hands_attributed+EXCLUDED.hands_attributed,
      hands_won=s.hands_won+EXCLUDED.hands_won,
      total_won=s.total_won+EXCLUDED.total_won,
      profit=s.profit+EXCLUDED.profit,
      biggest_pot_won=greatest(s.biggest_pot_won,EXCLUDED.biggest_pot_won),
      biggest_pot=greatest(s.biggest_pot,EXCLUDED.biggest_pot),
      topup_total=s.topup_total+EXCLUDED.topup_total,
      updated_at=now();

    INSERT INTO public.club_member_table_state AS st
      (table_id,user_id,last_stack,last_hand_number)
    SELECT DISTINCT ON (p->>'userId')
           v_h.table_id,(p->>'userId')::uuid,(p->>'stack')::numeric,v_h.hand_number
      FROM jsonb_array_elements(coalesce(v_h.players,'[]'::jsonb)) p
     WHERE (p->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       AND (p->>'stack') IS NOT NULL
    ON CONFLICT (table_id,user_id) DO UPDATE SET
      last_stack=EXCLUDED.last_stack,
      last_hand_number=EXCLUDED.last_hand_number,
      updated_at=now();

    INSERT INTO public.club_hand_daily_shard AS d
      (club_id,stat_date,shard,hands,rake,bbj,pot_total)
    VALUES (
      v_club,v_date,(pg_backend_pid()%16)::smallint,1,
      coalesce(v_h.rake_amount,0),coalesce(v_h.bbj_amount,0),coalesce(v_h.pot_size,0))
    ON CONFLICT (club_id,stat_date,shard) DO UPDATE SET
      hands=d.hands+1,
      rake=d.rake+EXCLUDED.rake,
      bbj=d.bbj+EXCLUDED.bbj,
      pot_total=d.pot_total+EXCLUDED.pot_total,
      updated_at=now();
  END IF;

  -- Projection 2: legacy player_stats fold/winnings totals (cash only).
  IF NOT COALESCE(v_diamond,false) AND v_h.tournament_id IS NULL
     AND v_club IS NOT NULL
     AND public.fn_ca_launch_accounting_accepts(v_club,v_h.created_at)
     AND jsonb_typeof(v_h.players)='array'
     AND jsonb_array_length(v_h.players)>0 THEN
    -- ONE KEY PER SEATED PLAYER, IN PLAYER ORDER, BEFORE THE ROWS (2026-10-19).
    -- The cash commission batch writes these players' player_stats and
    -- profile rows across several hands in one transaction; both take
    -- 'player-stats-user:<player>' in player order before the first such row
    -- (see fn_credit_agent_commissions_batch), so this statement never holds
    -- one player's row while the batch holds the next one's.
    FOR v_uid IN
      SELECT DISTINCT (pl->>'userId')::uuid
        FROM jsonb_array_elements(v_h.players) pl
       WHERE (pl->>'userId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       ORDER BY 1
    LOOP
      PERFORM pg_advisory_xact_lock(hashtextextended('player-stats-user:'||v_uid::text,0));
    END LOOP;
    v_bb := greatest(coalesce(v_h.big_blind,0),0);
    WITH seated AS (
      SELECT DISTINCT (pl->>'userId') AS uid
        FROM jsonb_array_elements(v_h.players) pl
       WHERE (pl->>'userId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ), won AS (
      SELECT (w->>'userId') AS uid,sum((w->>'amount')::numeric) AS amt
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(v_h.winners)='array' THEN v_h.winners ELSE '[]'::jsonb END) w
       WHERE (w->>'userId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         AND coalesce((w->>'amount')::numeric,0)>0
       GROUP BY 1
    )
    INSERT INTO public.player_stats AS ps
      (id,user_id,club_id,hands_dealt,sum_big_blind,total_winnings,updated_at)
    SELECT gen_random_uuid(),s.uid::uuid,v_club,1,v_bb,coalesce(wo.amt,0),now()
      FROM seated s LEFT JOIN won wo ON wo.uid=s.uid
     WHERE EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=s.uid::uuid)
     ORDER BY s.uid::uuid
    ON CONFLICT (user_id,club_id) DO UPDATE SET
      hands_dealt=ps.hands_dealt+EXCLUDED.hands_dealt,
      sum_big_blind=ps.sum_big_blind+EXCLUDED.sum_big_blind,
      total_winnings=ps.total_winnings+EXCLUDED.total_winnings,
      updated_at=now();
  END IF;

  -- Projection 3: positional aggregates.
  -- Positional profit has no asset dimension. Keep Diamond amounts out of
  -- that legacy aggregate; exact per-hand facts below retain its history.
  IF NOT COALESCE(v_diamond,false) THEN
    PERFORM public.fn_process_hand_position_stats(v_h.players,v_h.actions,v_h.winners);
  END IF;

  -- Projection 3b: immutable private Stats facts.
  PERFORM public.ca_project_hand_stats_facts(v_h.id);

  -- Projection 4: exact per-hand stats materialisation and player index.
  INSERT INTO public.ca_hand_player_idx(user_id,created_at,hand_id)
  SELECT DISTINCT (pl->>'userId')::uuid,v_h.created_at,v_h.id
    FROM jsonb_array_elements(coalesce(v_h.players,'[]'::jsonb)) pl
   WHERE pl->>'userId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ORDER BY 1, 3
  ON CONFLICT DO NOTHING;

  INSERT INTO public.ca_hand_player_stat AS hs (
    user_id,hand_id,created_at,is_cash,tournament_id,game_variant,
    big_blind,small_blind,n_players,seat_position,my_blind,won_amt,is_winner,
    invested_actions,aggro_cnt,call_cnt,vpip,pfr,folded,three_bet,
    three_bet_opp,faced_three_bet,folded_to_three_bet,cbet_opp,cbet_made,
    showdown,hand_secs,profit)
  SELECT
    f.user_id,f.hand_id,f.created_at,f.is_cash,f.tournament_id,f.game_variant,
    f.big_blind,f.small_blind,f.n_players,f.seat_position,f.my_blind,f.won_amt,f.is_winner,
    f.invested_actions,f.aggro_cnt,f.call_cnt,f.vpip,f.pfr,f.folded,f.three_bet,
    f.three_bet_opp,f.faced_three_bet,f.folded_to_three_bet,f.cbet_opp,f.cbet_made,
    f.showdown,f.hand_secs,f.profit
    FROM public.ca_hand_player_facts_one(v_h.id,NULL) f
  ORDER BY f.user_id, f.hand_id
  ON CONFLICT (user_id,hand_id) DO NOTHING;

  -- Projection 4b: the Diamond leaderboard's running totals (migration
  -- 20260930043000). The stat rows keep a player's newest 1,000 hands of an
  -- asset, so a window cannot be read back from them; this keeps what
  -- Projection 2 keeps for chips (cash hands, seats with a profile): hands,
  -- won, put in and the big blind, per player per UTC day, from this hand's
  -- Diamond stat rows whichever writer wrote them. Player order, as every
  -- stat writer. A chip hand never enters this branch.
  IF COALESCE(v_diamond,false) AND v_h.tournament_id IS NULL AND v_club IS NOT NULL THEN
    INSERT INTO public.ca_diamond_player_day AS dd
      (user_id,stat_date,hands_dealt,total_winnings,total_losses,sum_big_blind,updated_at)
    SELECT s.user_id,v_date,1,s.won_amt,s.invested_actions+s.my_blind,
           greatest(coalesce(v_h.big_blind,0),0),now()
      FROM public.ca_hand_player_stat s
     WHERE s.hand_id=v_h.id AND s.asset='diamonds' AND s.is_cash
       AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=s.user_id)
     ORDER BY s.user_id
    ON CONFLICT (user_id,stat_date) DO UPDATE SET
      hands_dealt=dd.hands_dealt+EXCLUDED.hands_dealt,
      total_winnings=dd.total_winnings+EXCLUDED.total_winnings,
      total_losses=dd.total_losses+EXCLUDED.total_losses,
      sum_big_blind=dd.sum_big_blind+EXCLUDED.sum_big_blind,
      updated_at=now();
  END IF;

  -- Daily Mission booking has its own durable outbox. The hand-history
  -- trigger above only inserts those rows; it never takes a player/profile
  -- lock, and this stats projector must not become a second synchronous
  -- consumer. fn_drain_daily_challenge_event_outbox owns booking exactly once.

  DELETE FROM public.hand_projection_outbox o WHERE o.hand_id=v_h.id;

  RETURN jsonb_build_object('ok',true,'hand_id',v_h.id,'hand_number',v_h.hand_number);
END;
$function$
$projection$)
  ) AS v(signature, before_md5, after_md5, meta, new_def)
  LOOP
    v_sig := ('public.' || s.signature)::regprocedure;
    IF md5(pg_get_functiondef(v_sig)) <> s.before_md5 THEN
      RAISE EXCEPTION '% is not the pinned production text (md5 %)', s.signature, md5(pg_get_functiondef(v_sig));
    END IF;
    SELECT concat_ws('|', pg_get_userbyid(p.proowner), p.proacl::text, p.proconfig::text, p.provolatile, p.prosecdef)
      INTO v_meta FROM pg_proc p WHERE p.oid = v_sig;
    IF v_meta IS DISTINCT FROM s.meta THEN
      RAISE EXCEPTION '%: owner, grants or settings are not the pinned ones (%)', s.signature, v_meta;
    END IF;
    EXECUTE s.new_def;
    v_after := pg_get_functiondef(v_sig);
    IF v_after <> s.new_def OR md5(v_after) <> s.after_md5 THEN
      RAISE EXCEPTION '% is not the text the harness measured (md5 %)', s.signature, md5(v_after);
    END IF;
    IF (SELECT concat_ws('|', pg_get_userbyid(p.proowner), p.proacl::text, p.proconfig::text, p.provolatile, p.prosecdef)
          FROM pg_proc p WHERE p.oid = v_sig) IS DISTINCT FROM v_meta
       OR has_function_privilege('anon', v_sig, 'EXECUTE')
       OR has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION '%: owner, grants or settings moved', s.signature;
    END IF;
  END LOOP;
  -- The shapes the fix is: a proved receipt rolls its own subtransaction back,
  -- and both player_stats writers take their player keys before any row.
  IF position('USING ERRCODE=''CAR01''' IN pg_get_functiondef('public.fn_ca_replay_terminal_receipts(integer,integer)'::regprocedure)) = 0
     OR position('IF NOT v_clubs<@v_held OR NOT v_users<@v_held_users THEN' IN pg_get_functiondef('public.fn_credit_agent_commissions_batch(jsonb)'::regprocedure)) = 0
     OR position('''player-stats-user:''||v_uid::text' IN pg_get_functiondef('public.fn_project_hand_side_effects_after_post_commit_20260908(uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'the installed bodies are not the qualified shapes';
  END IF;
  RAISE NOTICE 'replay releases each receipt''s locks; player_stats keys are taken in player order: three bodies changed';
END $subs$;

-- The grants production already holds, restated (asserted above and again
-- below), so the ACLs do not move; GRANT and REVOKE do not reload PostgREST's
-- schema cache. The replay and the batch stay engine/service only; the
-- projection's inner body stays callable only through its wrapper.
REVOKE ALL ON FUNCTION public.fn_ca_replay_terminal_receipts(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_replay_terminal_receipts(integer, integer) TO service_role;
REVOKE ALL ON FUNCTION public.fn_credit_agent_commissions_batch(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_credit_agent_commissions_batch(jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.fn_project_hand_side_effects_after_post_commit_20260908(uuid) FROM PUBLIC, anon, authenticated;

DO $grants$
BEGIN
  IF (SELECT p.proacl::text FROM pg_proc p WHERE p.oid = 'public.fn_ca_replay_terminal_receipts(integer,integer)'::regprocedure)
       IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}'
     OR (SELECT p.proacl::text FROM pg_proc p WHERE p.oid = 'public.fn_credit_agent_commissions_batch(jsonb)'::regprocedure)
       IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}'
     OR (SELECT p.proacl::text FROM pg_proc p WHERE p.oid = 'public.fn_project_hand_side_effects_after_post_commit_20260908(uuid)'::regprocedure)
       IS DISTINCT FROM '{postgres=X/postgres}' THEN
    RAISE EXCEPTION 'the replay, batch or projection grants moved';
  END IF;
END $grants$;

COMMIT;
